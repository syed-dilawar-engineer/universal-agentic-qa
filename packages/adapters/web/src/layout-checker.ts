import type { Page } from 'playwright';
import { LayoutCheckResult, LayoutIssue } from './types.js';

/**
 * Script executed inside the browser page to audit layout issues:
 * 1. Horizontal overflow (scrollWidth > clientWidth)
 * 2. Clipped elements (overflow: hidden with scrollHeight > clientHeight)
 * 3. Offscreen controls (interactive controls outside visible viewport bounds)
 */
export async function checkPageLayout(page: Page): Promise<LayoutCheckResult> {
  return await page.evaluate((): LayoutCheckResult => {
    const docEl = document.documentElement;
    const body = document.body;

    const clientWidth = docEl.clientWidth || window.innerWidth;
    const scrollWidth = Math.max(docEl.scrollWidth, body ? body.scrollWidth : 0);
    const clientHeight = docEl.clientHeight || window.innerHeight;
    const scrollHeight = Math.max(docEl.scrollHeight, body ? body.scrollHeight : 0);

    const hasHorizontalOverflow = scrollWidth > clientWidth + 1;
    const issues: LayoutIssue[] = [];

    // Helper to generate a clean, readable CSS selector
    function getSelector(el: Element): string {
      if (el.id) return `#${el.id}`;
      let selector = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const classes = el.className
          .trim()
          .split(/\s+/)
          .filter((c) => Boolean(c) && !c.includes(':') && !c.includes('/'));
        if (classes.length > 0) {
          selector += `.${classes.slice(0, 2).join('.')}`;
        }
      }
      if (el.parentElement && el.parentElement.id) {
        return `#${el.parentElement.id} > ${selector}`;
      }
      return selector;
    }

    const allElements = Array.from(document.querySelectorAll('*'));

    // 1. Audit Horizontal Overflow Culprits
    if (hasHorizontalOverflow) {
      for (const el of allElements) {
        const tag = el.tagName.toLowerCase();
        if (['html', 'body', 'head', 'script', 'style', 'meta', 'link'].includes(tag)) {
          continue;
        }

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          continue;
        }

        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.right > clientWidth + 2) {
          const overflowPixels = Math.round(rect.right - clientWidth);
          issues.push({
            type: 'HORIZONTAL_OVERFLOW',
            selector: getSelector(el),
            tagName: tag,
            details: `Element extends ${overflowPixels}px beyond viewport width (${clientWidth}px). Bounding right: ${Math.round(rect.right)}px.`,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          });
        }
      }
    }

    // 2. Audit Clipped Elements (Hidden overflow with truncated scroll content)
    const mediaTags = new Set(['html', 'body', 'svg', 'canvas', 'img', 'video', 'iframe', 'script', 'style', 'head']);
    for (const el of allElements) {
      const tag = el.tagName.toLowerCase();
      if (mediaTags.has(tag)) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const isHiddenY = style.overflowY === 'hidden' || style.overflow === 'hidden';
      const isHiddenX = style.overflowX === 'hidden' || style.overflow === 'hidden';

      const hasVerticalClip = isHiddenY && el.clientHeight > 0 && (el.scrollHeight > el.clientHeight + 4);
      const hasHorizontalClip = isHiddenX && el.clientWidth > 0 && (el.scrollWidth > el.clientWidth + 4);

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
        });
      }
    }

    // 3. Audit Offscreen Controls
    const controlSelector = 'button, input:not([type="hidden"]), select, textarea, a[href], [role="button"], [role="link"], [role="checkbox"], [tabindex="0"]';
    const controls = Array.from(document.querySelectorAll(controlSelector));

    for (const ctrl of controls) {
      const tag = ctrl.tagName.toLowerCase();
      const style = window.getComputedStyle(ctrl);

      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0' ||
        ctrl.getAttribute('aria-hidden') === 'true' ||
        ctrl.hasAttribute('disabled')
      ) {
        continue;
      }

      const rect = ctrl.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      // Offscreen detection:
      // Controls positioned horizontally out of view (left < -50 or right <= 0 or left >= clientWidth)
      // Or positioned vertically offscreen via negative coordinates (top < -50)
      // Or fixed-position controls positioned offscreen
      const isHorizontallyOffscreen = rect.right <= 0 || rect.left >= clientWidth || rect.left <= -50;
      const isNegativeTopOffscreen = rect.top <= -50;
      const isFixedOffscreen =
        style.position === 'fixed' &&
        (rect.bottom <= 0 || rect.top >= clientHeight || rect.right <= 0 || rect.left >= clientWidth);

      if (isHorizontallyOffscreen || isNegativeTopOffscreen || isFixedOffscreen) {
        issues.push({
          type: 'OFFSCREEN_CONTROL',
          selector: getSelector(ctrl),
          tagName: tag,
          details: `Interactive control is outside visible bounds at (x: ${Math.round(rect.x)}, y: ${Math.round(rect.y)}, w: ${Math.round(rect.width)}, h: ${Math.round(rect.height)})`,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        });
      }
    }

    return {
      hasIssues: hasHorizontalOverflow || issues.length > 0,
      horizontalOverflow: hasHorizontalOverflow,
      issues,
      metrics: {
        clientWidth,
        scrollWidth,
        clientHeight,
        scrollHeight,
      },
    };
  });
}
