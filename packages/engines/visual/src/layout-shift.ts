import type { Finding, FindingSeverity, Platform } from '@agentic-qa/schemas';
import type { LayoutCheckResult, LayoutIssue, LayoutIssueType } from './types.js';
import {
  parseHtml,
  flattenElements,
  getElementSelector,
  ParsedElement,
} from './utils/dom-parser.js';

export class LayoutShiftDetector {
  /**
   * Executes in-browser evaluation to detect layout shifts, horizontal overflow,
   * and clipped elements on a live Playwright or Puppeteer page.
   */
  async detectPageLayout(
    page: any,
    options: { platform?: Platform; testCaseId?: string } = {}
  ): Promise<LayoutCheckResult> {
    const rawResult: {
      scrollWidth: number;
      clientWidth: number;
      scrollHeight: number;
      clientHeight: number;
      hasHorizontalOverflow: boolean;
      issues: LayoutIssue[];
    } = await page.evaluate(() => {
      const docEl = document.documentElement;
      const body = document.body;

      const clientWidth = docEl.clientWidth || window.innerWidth;
      const scrollWidth = Math.max(docEl.scrollWidth, body ? body.scrollWidth : 0);
      const clientHeight = docEl.clientHeight || window.innerHeight;
      const scrollHeight = Math.max(docEl.scrollHeight, body ? body.scrollHeight : 0);

      const hasHorizontalOverflow = scrollWidth > clientWidth + 1;
      const issues: Array<{
        type: 'HORIZONTAL_OVERFLOW' | 'CLIPPED_ELEMENT' | 'OFFSCREEN_CONTROL';
        selector: string;
        tagName: string;
        details: string;
        rect: { x: number; y: number; width: number; height: number };
        computedStyles?: Record<string, string>;
      }> = [];

      function getSelector(el: Element): string {
        if (el.id) return `#${el.id}`;
        let sel = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const cls = el.className.trim().split(/\s+/).filter(Boolean);
          if (cls.length > 0) sel += `.${cls.slice(0, 2).join('.')}`;
        }
        if (el.parentElement && el.parentElement.id) {
          return `#${el.parentElement.id} > ${sel}`;
        }
        return sel;
      }

      const allElements = Array.from(document.querySelectorAll('*'));

      // 1. Audit Horizontal Overflow Culprits
      if (hasHorizontalOverflow) {
        const ignoredTags = new Set(['html', 'body', 'head', 'script', 'style', 'meta', 'link']);
        for (const el of allElements) {
          const tag = el.tagName.toLowerCase();
          if (ignoredTags.has(tag)) continue;

          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            continue;
          }

          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.right > clientWidth + 2) {
            const overflowPx = Math.round(rect.right - clientWidth);
            issues.push({
              type: 'HORIZONTAL_OVERFLOW',
              selector: getSelector(el),
              tagName: tag,
              details: `Element extends ${overflowPx}px beyond viewport width (${clientWidth}px). Bounding right: ${Math.round(rect.right)}px.`,
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              computedStyles: {
                width: style.width,
                maxWidth: style.maxWidth,
                position: style.position,
              },
            });
          }
        }
      }

      // 2. Audit Clipped Elements (Hidden overflow with truncated scroll content)
      const nonContainerTags = new Set(['html', 'body', 'svg', 'canvas', 'img', 'video', 'iframe', 'script', 'style', 'head']);
      for (const el of allElements) {
        const tag = el.tagName.toLowerCase();
        if (nonContainerTags.has(tag)) continue;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const isHiddenY = style.overflowY === 'hidden' || style.overflow === 'hidden';
        const isHiddenX = style.overflowX === 'hidden' || style.overflow === 'hidden';

        const hasVerticalClip = isHiddenY && el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 4;
        const hasHorizontalClip = isHiddenX && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 4;

        if (hasVerticalClip || hasHorizontalClip) {
          const rect = el.getBoundingClientRect();
          issues.push({
            type: 'CLIPPED_ELEMENT',
            selector: getSelector(el),
            tagName: tag,
            details: hasVerticalClip
              ? `Vertical clipping: scrollHeight (${el.scrollHeight}px) exceeds clientHeight (${el.clientHeight}px) with overflow: hidden`
              : `Horizontal clipping: scrollWidth (${el.scrollWidth}px) exceeds clientWidth (${el.clientWidth}px) with overflow: hidden`,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            computedStyles: {
              overflow: style.overflow,
              overflowX: style.overflowX,
              overflowY: style.overflowY,
              textOverflow: style.textOverflow,
            },
          });
        }
      }

      return {
        scrollWidth,
        clientWidth,
        scrollHeight,
        clientHeight,
        hasHorizontalOverflow,
        issues,
      };
    });

    const hasClipped = rawResult.issues.some((i) => i.type === 'CLIPPED_ELEMENT');
    const passed = !rawResult.hasHorizontalOverflow && !hasClipped;

    const findings = this.createFindingsFromIssues(
      rawResult.issues,
      options.platform ?? 'web',
      options.testCaseId
    );

    return {
      passed,
      hasHorizontalOverflow: rawResult.hasHorizontalOverflow,
      hasClippedElements: hasClipped,
      scrollWidth: rawResult.scrollWidth,
      clientWidth: rawResult.clientWidth,
      scrollHeight: rawResult.scrollHeight,
      clientHeight: rawResult.clientHeight,
      issues: rawResult.issues,
      findings,
    };
  }

  /**
   * Static DOM analysis to detect horizontal overflow and clipped elements without a live browser.
   */
  detectDomLayout(
    html: string,
    options: {
      viewport?: { width: number; height: number };
      platform?: Platform;
      testCaseId?: string;
    } = {}
  ): LayoutCheckResult {
    const viewport = options.viewport ?? { width: 375, height: 667 };
    const platform = options.platform ?? 'web';
    const parsedRoots = parseHtml(html);
    const elements = flattenElements(parsedRoots);

    const issues: LayoutIssue[] = [];
    let maxComputedWidth = viewport.width;

    for (const el of elements) {
      const widthVal = this.parseDimension(el.style['width'] || el.attributes['width']);
      const minWidthVal = this.parseDimension(el.style['minwidth'] || el.style['minWidth']);

      // Check fixed width larger than viewport (e.g. width: 600px on 375px viewport)
      const effectiveWidth = Math.max(widthVal ?? 0, minWidthVal ?? 0);
      if (effectiveWidth > viewport.width) {
        maxComputedWidth = Math.max(maxComputedWidth, effectiveWidth);
        issues.push({
          type: 'HORIZONTAL_OVERFLOW',
          selector: getElementSelector(el),
          tagName: el.tagName,
          details: `Element specifies width (${effectiveWidth}px) exceeding viewport width (${viewport.width}px).`,
          rect: { x: 0, y: 0, width: effectiveWidth, height: 0 },
          computedStyles: { width: `${effectiveWidth}px` },
        });
      }

      // Check clipped elements: parent has overflow: hidden and fixed dimensions smaller than child
      const overflow = el.style['overflow'] || el.style['overflowX'] || el.style['overflow-x'];
      if (overflow === 'hidden' && widthVal) {
        for (const child of el.children) {
          const childWidth = this.parseDimension(child.style['width'] || child.attributes['width']);
          if (childWidth && childWidth > widthVal) {
            issues.push({
              type: 'CLIPPED_ELEMENT',
              selector: getElementSelector(child),
              tagName: child.tagName,
              details: `Child element width (${childWidth}px) exceeds parent container width (${widthVal}px) with overflow: hidden. Content is clipped.`,
              rect: { x: 0, y: 0, width: childWidth, height: 0 },
            });
          }
        }
      }

      // Check text clipping: white-space: nowrap with fixed container width
      const whiteSpace = el.style['whitespace'] || el.style['whiteSpace'];
      const textOverflow = el.style['textoverflow'] || el.style['textOverflow'];
      if (whiteSpace === 'nowrap' && widthVal && textOverflow !== 'ellipsis') {
        const textLen = el.textContent.trim().length;
        // Approximation: ~8px per character average
        const estimatedTextPx = textLen * 8;
        if (estimatedTextPx > widthVal + 20) {
          issues.push({
            type: 'CLIPPED_ELEMENT',
            selector: getElementSelector(el),
            tagName: el.tagName,
            details: `Text element with white-space: nowrap and length ${textLen} chars (~${estimatedTextPx}px) exceeds width (${widthVal}px) without ellipsis.`,
            rect: { x: 0, y: 0, width: widthVal, height: 0 },
          });
        }
      }
    }

    const hasHorizontalOverflow = maxComputedWidth > viewport.width;
    const hasClipped = issues.some((i) => i.type === 'CLIPPED_ELEMENT');
    const passed = !hasHorizontalOverflow && !hasClipped;

    const findings = this.createFindingsFromIssues(issues, platform, options.testCaseId);

    return {
      passed,
      hasHorizontalOverflow,
      hasClippedElements: hasClipped,
      scrollWidth: maxComputedWidth,
      clientWidth: viewport.width,
      scrollHeight: viewport.height,
      clientHeight: viewport.height,
      issues,
      findings,
    };
  }

  private parseDimension(val?: string): number | null {
    if (!val) return null;
    const match = val.trim().match(/^(\d+(?:\.\d+)?)(?:px)?$/);
    return match ? parseFloat(match[1]) : null;
  }

  private createFindingsFromIssues(
    issues: LayoutIssue[],
    platform: Platform,
    testCaseId?: string
  ): Finding[] {
    return issues.map((issue, idx) => {
      const severity: FindingSeverity =
        issue.type === 'HORIZONTAL_OVERFLOW' ? 'HIGH' : 'MEDIUM';

      return {
        id: `FIND-LAYOUT-${issue.type}-${Date.now()}-${idx}`,
        title: `Layout Defect: ${issue.type} detected on ${issue.selector}`,
        description: issue.details,
        severity,
        status: 'CONFIRMED',
        fixVerification: 'UNVERIFIED',
        platform,
        testCaseId,
        preconditions: ['Target page rendered in viewport'],
        reproductionSteps: [
          `1. Render application layout at current viewport width`,
          `2. Inspect element at selector: "${issue.selector}"`,
          `3. Observe layout failure: ${issue.details}`,
        ],
        expectedBehavior:
          issue.type === 'HORIZONTAL_OVERFLOW'
            ? 'Element must stay within viewport boundaries without horizontal scrolling (scrollWidth <= clientWidth)'
            : 'Content must not be truncated or clipped by bounding containers without explicit text-overflow handling',
        actualBehavior: issue.details,
        evidenceIds: [],
        reproducibilityCount: 1,
        reproducibilitySuccessRate: 1.0,
        detectedAt: new Date().toISOString(),
        metadata: {
          issueType: issue.type,
          selector: issue.selector,
          tagName: issue.tagName,
          rect: issue.rect,
          computedStyles: issue.computedStyles,
        },
      };
    });
  }
}
