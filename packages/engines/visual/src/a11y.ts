import axeCore from 'axe-core';
import type { Finding, FindingSeverity, Platform } from '@agentic-qa/schemas';
import type {
  A11yAuditOptions,
  A11yAuditResult,
  A11yViolation,
  A11yViolationNode,
  A11yImpact,
} from './types.js';
import {
  parseColor,
  calculateContrastRatio,
  isContrastSufficient,
} from './utils/color.js';
import {
  parseHtml,
  flattenElements,
  getElementSelector,
  ParsedElement,
} from './utils/dom-parser.js';

// Standard valid ARIA roles per W3C ARIA 1.2
const VALID_ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'button', 'cell',
  'checkbox', 'columnheader', 'combobox', 'command', 'composite', 'complementary',
  'contentinfo', 'definition', 'dialog', 'directory', 'document', 'feed', 'figure',
  'form', 'grid', 'gridcell', 'group', 'heading', 'img', 'input', 'landmark', 'link',
  'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note',
  'option', 'presentation', 'progressbar', 'radio', 'radiogroup', 'range', 'region',
  'roledescription', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search',
  'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'structure', 'switch',
  'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'timer', 'toolbar',
  'tooltip', 'tree', 'treegrid', 'treeitem', 'widget', 'window',
]);

export class AccessibilityEngine {
  private defaultStandards: string[];
  private defaultMinTapTarget: { width: number; height: number };

  constructor(options: {
    standards?: string[];
    minTapTargetSize?: { width: number; height: number };
  } = {}) {
    this.defaultStandards = options.standards ?? [
      'wcag2a',
      'wcag2aa',
      'wcag21aa',
    ];
    this.defaultMinTapTarget = options.minTapTargetSize ?? {
      width: 44,
      height: 44,
    };
  }

  /**
   * Audits an HTML string against WCAG 2.1 AA rules using the built-in deterministic scanner.
   */
  auditHtml(html: string, options: A11yAuditOptions = {}): A11yAuditResult {
    const minTarget = options.minTapTargetSize ?? this.defaultMinTapTarget;
    const platform = options.platform ?? 'web';
    const parsedRoots = parseHtml(html);
    const elements = flattenElements(parsedRoots);

    const violations: A11yViolation[] = [];

    // 1. Audit Alt Text (WCAG 1.1.1)
    this.checkAltText(elements, violations);

    // 2. Audit Form Labels (WCAG 1.3.1, 3.3.2, 4.1.2)
    this.checkFormLabels(elements, violations);

    // 3. Audit ARIA Roles and Attributes (WCAG 4.1.2)
    this.checkAriaRolesAndStates(elements, violations);

    // 4. Audit Color Contrast (WCAG 1.4.3)
    this.checkColorContrast(elements, violations);

    // 5. Audit Tap Targets (WCAG 2.1 AAA 2.5.5 / WCAG 2.2 AA 2.5.8)
    this.checkTapTargets(elements, violations, minTarget);

    // 6. Audit Document Structure & Language (WCAG 3.1.1, 2.4.2)
    this.checkDocumentStructure(elements, violations);

    // 7. Audit Button Accessible Names (WCAG 4.1.2)
    this.checkButtonNames(elements, violations);

    // Format violations into structured Findings
    const findings = violations.flatMap((v) =>
      this.formatViolationToFindings(v, platform, options.testCaseId)
    );

    const summary = {
      critical: violations.filter((v) => v.impact === 'critical').length,
      serious: violations.filter((v) => v.impact === 'serious').length,
      moderate: violations.filter((v) => v.impact === 'moderate').length,
      minor: violations.filter((v) => v.impact === 'minor').length,
      total: violations.length,
    };

    return {
      passed: violations.length === 0,
      violations,
      findings,
      summary,
    };
  }

  /**
   * Audits a Playwright or Puppeteer Page using axe-core and layout scanners.
   */
  async auditPage(page: any, options: A11yAuditOptions = {}): Promise<A11yAuditResult> {
    const minTarget = options.minTapTargetSize ?? this.defaultMinTapTarget;
    const platform = options.platform ?? 'web';

    // Inject and execute axe-core in the page context
    const axeResults = await page.evaluate(
      (axeSource: string, standards: string[]) => {
        // Evaluate axe-core if not already defined
        if (typeof (window as any).axe === 'undefined') {
          eval(axeSource);
        }
        return (window as any).axe.run({
          runOnly: {
            type: 'tag',
            values: standards,
          },
        });
      },
      axeCore.source,
      options.standards ?? this.defaultStandards
    );

    const violations: A11yViolation[] = (axeResults.violations || []).map(
      (v: any) => ({
        id: v.id,
        ruleId: v.id,
        description: v.description,
        help: v.help,
        helpUrl: v.helpUrl,
        impact: (v.impact as A11yImpact) || 'moderate',
        wcagTags: v.tags || [],
        nodes: (v.nodes || []).map((node: any) => ({
          target: Array.isArray(node.target) ? node.target.join(' ') : String(node.target),
          html: node.html || '',
          failureSummary: node.failureSummary || v.help,
        })),
      })
    );

    // Also run tap target size check inside browser (WCAG 2.2 AAA 44x44 CSS px)
    const tapTargetIssues = await page.evaluate(
      (minW: number, minH: number) => {
        const issues: Array<{ selector: string; html: string; width: number; height: number }> = [];
        const interactive = document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]');
        for (const el of Array.from(interactive)) {
          // Exemption for inline anchor links inside paragraphs/spans (WCAG 2.5.5 / 2.5.8 exemption)
          if (el.tagName.toLowerCase() === 'a') {
            const parent = el.parentElement;
            const parentTag = parent?.tagName?.toLowerCase();
            const isInlineProse =
              Boolean(el.closest('p, span')) ||
              parentTag === 'p' ||
              parentTag === 'span';
            if (isInlineProse) {
              continue; // Exempt inline prose links
            }
          }

          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            if (rect.width < minW || rect.height < minH) {
              issues.push({
                selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''),
                html: el.outerHTML.slice(0, 150),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              });
            }
          }
        }
        return issues;
      },
      minTarget.width,
      minTarget.height
    );

    if (tapTargetIssues.length > 0) {
      violations.push({
        id: 'target-size',
        ruleId: 'target-size',
        description: `Interactive elements must have a touch target size of at least ${minTarget.width}x${minTarget.height}px per WCAG 2.2 AAA (2.5.5 / 2.5.8)`,
        help: 'Ensure touch targets are large enough (44x44 CSS px) to easily activate without mis-taps',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/target-size.html',
        impact: 'serious',
        wcagTags: ['wcag21aa', 'wcag22aaa', 'wcag255', 'wcag258'],
        nodes: tapTargetIssues.map((t: any) => ({
          target: t.selector,
          html: t.html,
          failureSummary: `Target size ${t.width}x${t.height}px is below ${minTarget.width}x${minTarget.height}px requirement.`,
          rect: { x: 0, y: 0, width: t.width, height: t.height },
        })),
      });
    }

    const findings = violations.flatMap((v) =>
      this.formatViolationToFindings(v, platform, options.testCaseId)
    );

    const summary = {
      critical: violations.filter((v) => v.impact === 'critical').length,
      serious: violations.filter((v) => v.impact === 'serious').length,
      moderate: violations.filter((v) => v.impact === 'moderate').length,
      minor: violations.filter((v) => v.impact === 'minor').length,
      total: violations.length,
    };

    return {
      passed: violations.length === 0,
      violations,
      findings,
      summary,
    };
  }

  // ============================================================================
  // RULE CHECK IMPLEMENTATIONS
  // ============================================================================

  /**
   * 1. WCAG 1.1.1: Non-text Content (Alt text checks)
   */
  private checkAltText(elements: ParsedElement[], violations: A11yViolation[]): void {
    const invalidNodes: A11yViolationNode[] = [];

    for (const el of elements) {
      // <img> tag
      if (el.tagName === 'img') {
        const alt = el.attributes['alt'];
        const role = el.attributes['role'];
        const isDecorative = role === 'presentation' || role === 'none';

        if (alt === undefined && !isDecorative) {
          invalidNodes.push({
            target: getElementSelector(el),
            html: el.outerHTML,
            failureSummary: 'Element does not have an alt attribute or decorative role="presentation".',
          });
        } else if (alt === '' && el.parent && el.parent.tagName === 'a') {
          // Wrapped in a link with no other text
          if (!el.parent.textContent.trim()) {
            invalidNodes.push({
              target: getElementSelector(el.parent),
              html: el.parent.outerHTML,
              failureSummary: 'Link containing only an image with empty alt attribute has no accessible name.',
            });
          }
        }
      }

      // <input type="image">
      if (el.tagName === 'input' && el.attributes['type'] === 'image') {
        if (!el.attributes['alt'] && !el.attributes['aria-label']) {
          invalidNodes.push({
            target: getElementSelector(el),
            html: el.outerHTML,
            failureSummary: 'Image submit button missing alt or aria-label attribute.',
          });
        }
      }

      // <area>
      if (el.tagName === 'area' && !el.attributes['alt']) {
        invalidNodes.push({
          target: getElementSelector(el),
          html: el.outerHTML,
          failureSummary: 'Image map area missing alt attribute.',
        });
      }
    }

    if (invalidNodes.length > 0) {
      violations.push({
        id: 'image-alt',
        ruleId: 'image-alt',
        description: 'Images and graphic elements must have alternate text providing equal meaning',
        help: 'Provide descriptive alt text for informative images, or alt="" for decorative images',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html',
        impact: 'critical',
        wcagTags: ['wcag2a', 'wcag111'],
        nodes: invalidNodes,
      });
    }
  }

  /**
   * 2. WCAG 1.3.1 & 4.1.2: Form Labels
   */
  private checkFormLabels(elements: ParsedElement[], violations: A11yViolation[]): void {
    const invalidNodes: A11yViolationNode[] = [];
    const nonInputTypes = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

    // Build label id lookup
    const labelForMap = new Set<string>();
    for (const el of elements) {
      if (el.tagName === 'label' && el.attributes['for']) {
        labelForMap.add(el.attributes['for']);
      }
    }

    for (const el of elements) {
      if (el.tagName === 'input' || el.tagName === 'select' || el.tagName === 'textarea') {
        const type = el.attributes['type']?.toLowerCase() || 'text';
        if (nonInputTypes.has(type)) continue;

        const hasId = Boolean(el.attributes['id']);
        const hasMatchingLabel = hasId && labelForMap.has(el.attributes['id']);
        const isInsideLabel = this.isAncestorTag(el, 'label');
        const hasAriaLabel = Boolean(el.attributes['aria-label']);
        const hasAriaLabelledBy = Boolean(el.attributes['aria-labelledby']);
        const hasTitle = Boolean(el.attributes['title']);

        if (!hasMatchingLabel && !isInsideLabel && !hasAriaLabel && !hasAriaLabelledBy && !hasTitle) {
          invalidNodes.push({
            target: getElementSelector(el),
            html: el.outerHTML,
            failureSummary: `Form control <${el.tagName}> does not have an associated <label>, aria-label, or title.`,
          });
        }
      }
    }

    if (invalidNodes.length > 0) {
      violations.push({
        id: 'label',
        ruleId: 'label',
        description: 'Every form element must have a programmatically determined label',
        help: 'Ensure form input has a <label for="...">, aria-label, or enclosing <label>',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html',
        impact: 'critical',
        wcagTags: ['wcag2a', 'wcag131', 'wcag412'],
        nodes: invalidNodes,
      });
    }
  }

  /**
   * 3. WCAG 4.1.2: ARIA Roles & Attributes
   */
  private checkAriaRolesAndStates(elements: ParsedElement[], violations: A11yViolation[]): void {
    const invalidRoleNodes: A11yViolationNode[] = [];
    const missingAttrNodes: A11yViolationNode[] = [];
    const hiddenFocusNodes: A11yViolationNode[] = [];
    const seenIds = new Map<string, ParsedElement>();
    const duplicateIdNodes: A11yViolationNode[] = [];

    const focusableTags = new Set(['button', 'input', 'select', 'textarea']);

    for (const el of elements) {
      // Check ID uniqueness
      if (el.attributes['id']) {
        const id = el.attributes['id'];
        if (seenIds.has(id)) {
          duplicateIdNodes.push({
            target: `#${id}`,
            html: el.outerHTML,
            failureSummary: `Duplicate id attribute "${id}" found in document.`,
          });
        } else {
          seenIds.set(id, el);
        }
      }

      // Check role validity
      if (el.attributes['role']) {
        const role = el.attributes['role'].trim().toLowerCase();
        if (!VALID_ARIA_ROLES.has(role)) {
          invalidRoleNodes.push({
            target: getElementSelector(el),
            html: el.outerHTML,
            failureSummary: `ARIA role "${role}" is not a valid W3C ARIA role.`,
          });
        }

        // Required ARIA attributes
        if (role === 'checkbox' || role === 'switch') {
          if (!el.attributes['aria-checked']) {
            missingAttrNodes.push({
              target: getElementSelector(el),
              html: el.outerHTML,
              failureSummary: `Role "${role}" requires aria-checked attribute ("true", "false", or "mixed").`,
            });
          }
        } else if (role === 'slider') {
          if (!el.attributes['aria-valuenow']) {
            missingAttrNodes.push({
              target: getElementSelector(el),
              html: el.outerHTML,
              failureSummary: 'Role "slider" requires aria-valuenow attribute.',
            });
          }
        } else if (role === 'combobox') {
          if (!el.attributes['aria-expanded']) {
            missingAttrNodes.push({
              target: getElementSelector(el),
              html: el.outerHTML,
              failureSummary: 'Role "combobox" requires aria-expanded attribute.',
            });
          }
        }
      }

      // aria-hidden on focusable elements
      if (el.attributes['aria-hidden'] === 'true') {
        const isInteractive =
          focusableTags.has(el.tagName) ||
          (el.tagName === 'a' && Boolean(el.attributes['href'])) ||
          Boolean(el.attributes['tabindex']);

        if (isInteractive) {
          hiddenFocusNodes.push({
            target: getElementSelector(el),
            html: el.outerHTML,
            failureSummary: 'Interactive focusable element is hidden from assistive technologies with aria-hidden="true".',
          });
        }
      }
    }

    if (invalidRoleNodes.length > 0) {
      violations.push({
        id: 'aria-roles',
        ruleId: 'aria-roles',
        description: 'ARIA roles must conform to valid W3C ARIA specifications',
        help: 'Ensure all role attribute values are valid ARIA role tokens',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html',
        impact: 'serious',
        wcagTags: ['wcag2a', 'wcag412'],
        nodes: invalidRoleNodes,
      });
    }

    if (missingAttrNodes.length > 0) {
      violations.push({
        id: 'aria-required-attr',
        ruleId: 'aria-required-attr',
        description: 'Elements with ARIA roles must possess all required ARIA attributes',
        help: 'Provide mandatory ARIA states and properties (e.g. aria-checked for checkboxes)',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html',
        impact: 'critical',
        wcagTags: ['wcag2a', 'wcag412'],
        nodes: missingAttrNodes,
      });
    }

    if (hiddenFocusNodes.length > 0) {
      violations.push({
        id: 'aria-hidden-focus',
        ruleId: 'aria-hidden-focus',
        description: 'Focusable elements must not be hidden using aria-hidden="true"',
        help: 'Remove aria-hidden="true" from focusable elements or remove them from keyboard focus',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html',
        impact: 'serious',
        wcagTags: ['wcag2a', 'wcag412'],
        nodes: hiddenFocusNodes,
      });
    }

    if (duplicateIdNodes.length > 0) {
      violations.push({
        id: 'duplicate-id-active',
        ruleId: 'duplicate-id-active',
        description: 'Every id attribute in the document must be unique',
        help: 'Ensure each id value is unique to allow assistive technologies to reference elements correctly',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/parsing.html',
        impact: 'moderate',
        wcagTags: ['wcag2a', 'wcag411'],
        nodes: duplicateIdNodes,
      });
    }
  }

  /**
   * 4. WCAG 1.4.3: Color Contrast
   */
  private checkColorContrast(elements: ParsedElement[], violations: A11yViolation[]): void {
    const invalidNodes: A11yViolationNode[] = [];

    for (const el of elements) {
      const colorStr = el.style['color'];
      const bgStr = this.findInheritedBackgroundColor(el);

      if (colorStr && bgStr && (el.textContent.trim() || el.tagName === 'button' || el.tagName === 'a')) {
        const fg = parseColor(colorStr);
        const bg = parseColor(bgStr);

        if (fg && bg && bg.a > 0) {
          const ratio = calculateContrastRatio(fg, bg);
          const fontSize = parseFloat(el.style['fontsize'] || el.style['fontSize'] || '16');
          const fontWeight = el.style['fontweight'] || el.style['fontWeight'] || 'normal';
          const isBold = fontWeight === 'bold' || parseInt(fontWeight, 10) >= 700;
          const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && isBold);

          if (!isContrastSufficient(ratio, { isLargeText })) {
            const required = isLargeText ? '3.0:1' : '4.5:1';
            invalidNodes.push({
              target: getElementSelector(el),
              html: el.outerHTML,
              failureSummary: `Element has insufficient color contrast of ${ratio.toFixed(2)}:1 (foreground: ${colorStr}, background: ${bgStr}). Expected minimum ${required}.`,
            });
          }
        }
      }
    }

    if (invalidNodes.length > 0) {
      violations.push({
        id: 'color-contrast',
        ruleId: 'color-contrast',
        description: 'Text elements must have sufficient color contrast against their background',
        help: 'Ensure text contrast ratio is at least 4.5:1 for normal text or 3.0:1 for large text',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html',
        impact: 'serious',
        wcagTags: ['wcag2aa', 'wcag143'],
        nodes: invalidNodes,
      });
    }
  }

  /**
   * 5. WCAG 2.1 AAA 2.5.5 / WCAG 2.2 AA/AAA 2.5.8: Tap Target Size (44x44 CSS px)
   */
  private checkTapTargets(
    elements: ParsedElement[],
    violations: A11yViolation[],
    minTarget: { width: number; height: number }
  ): void {
    const invalidNodes: A11yViolationNode[] = [];
    const interactiveTags = new Set(['button', 'input', 'select', 'textarea']);

    for (const el of elements) {
      const isInteractive =
        interactiveTags.has(el.tagName) ||
        (el.tagName === 'a' && Boolean(el.attributes['href'])) ||
        el.attributes['role'] === 'button';

      if (isInteractive) {
        // Exemption for inline anchor links inside paragraphs/spans (WCAG 2.5.5 / 2.5.8 exemption)
        if (el.tagName === 'a') {
          let curr = el.parent;
          let isInlineProse = false;
          while (curr) {
            if (curr.tagName === 'p' || curr.tagName === 'span') {
              isInlineProse = true;
              break;
            }
            curr = curr.parent;
          }
          if (isInlineProse) {
            continue; // Exempt inline prose links from 44x44 target size check
          }
        }

        const widthVal = parseFloat(el.style['width'] || el.attributes['width'] || '');
        const heightVal = parseFloat(el.style['height'] || el.attributes['height'] || '');

        if (!isNaN(widthVal) && !isNaN(heightVal)) {
          if (widthVal < minTarget.width || heightVal < minTarget.height) {
            invalidNodes.push({
              target: getElementSelector(el),
              html: el.outerHTML,
              failureSummary: `Interactive target size ${widthVal}x${heightVal}px is below ${minTarget.width}x${minTarget.height}px requirement.`,
              rect: { x: 0, y: 0, width: widthVal, height: heightVal },
            });
          }
        }
      }
    }

    if (invalidNodes.length > 0) {
      violations.push({
        id: 'target-size',
        ruleId: 'target-size',
        description: `Interactive touch targets must be at least ${minTarget.width}x${minTarget.height}px per WCAG 2.2 AAA`,
        help: 'Ensure interactive elements have adequate bounding dimensions (44x44 CSS px) to prevent accidental activation',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/target-size.html',
        impact: 'serious',
        wcagTags: ['wcag21aa', 'wcag22aaa', 'wcag255', 'wcag258'],
        nodes: invalidNodes,
      });
    }
  }

  /**
   * 6. WCAG 3.1.1 & 2.4.2: Document Structure (HTML lang, Title)
   */
  private checkDocumentStructure(elements: ParsedElement[], violations: A11yViolation[]): void {
    const htmlEl = elements.find((e) => e.tagName === 'html');
    if (htmlEl && !htmlEl.attributes['lang']) {
      violations.push({
        id: 'html-has-lang',
        ruleId: 'html-has-lang',
        description: 'The <html> element must have a valid lang attribute',
        help: 'Specify the primary language of the document (e.g. <html lang="en">)',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/language-of-page.html',
        impact: 'serious',
        wcagTags: ['wcag2a', 'wcag311'],
        nodes: [
          {
            target: 'html',
            html: htmlEl.outerHTML,
            failureSummary: '<html> element is missing the lang attribute.',
          },
        ],
      });
    }

    const hasHead = elements.some((e) => e.tagName === 'head');
    if (hasHead) {
      const titleEl = elements.find((e) => e.tagName === 'title');
      if (!titleEl || !titleEl.textContent.trim()) {
        violations.push({
          id: 'document-title',
          ruleId: 'document-title',
          description: 'Document must have a <title> element that describes its topic or purpose',
          help: 'Provide a non-empty <title> inside the document <head>',
          helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/page-titled.html',
          impact: 'moderate',
          wcagTags: ['wcag2a', 'wcag242'],
          nodes: [
            {
              target: 'head',
              html: '<head>',
              failureSummary: 'Document is missing a <title> element.',
            },
          ],
        });
      }
    }
  }

  /**
   * 7. WCAG 4.1.2: Button Accessible Name
   */
  private checkButtonNames(elements: ParsedElement[], violations: A11yViolation[]): void {
    const invalidNodes: A11yViolationNode[] = [];

    for (const el of elements) {
      if (el.tagName === 'button' || el.attributes['role'] === 'button') {
        const hasText = Boolean(el.textContent.trim());
        const hasAriaLabel = Boolean(el.attributes['aria-label']);
        const hasAriaLabelledBy = Boolean(el.attributes['aria-labelledby']);
        const hasTitle = Boolean(el.attributes['title']);

        // Check if has img child with alt
        const hasImageWithAlt = el.children.some(
          (c) => c.tagName === 'img' && Boolean(c.attributes['alt'])
        );

        if (!hasText && !hasAriaLabel && !hasAriaLabelledBy && !hasTitle && !hasImageWithAlt) {
          invalidNodes.push({
            target: getElementSelector(el),
            html: el.outerHTML,
            failureSummary: 'Button has no accessible text or label.',
          });
        }
      }
    }

    if (invalidNodes.length > 0) {
      violations.push({
        id: 'button-name',
        ruleId: 'button-name',
        description: 'Buttons must have discernible, accessible text',
        help: 'Provide visible text inside the button, or an aria-label attribute',
        helpUrl: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html',
        impact: 'critical',
        wcagTags: ['wcag2a', 'wcag412'],
        nodes: invalidNodes,
      });
    }
  }

  // ============================================================================
  // FORMATTING & UTILITIES
  // ============================================================================

  private isAncestorTag(el: ParsedElement, tagName: string): boolean {
    let curr = el.parent;
    while (curr) {
      if (curr.tagName === tagName) return true;
      curr = curr.parent;
    }
    return false;
  }

  private findInheritedBackgroundColor(el: ParsedElement): string | null {
    let curr: ParsedElement | undefined = el;
    while (curr) {
      const bg = curr.style['backgroundcolor'] || curr.style['backgroundColor'] || curr.style['background'];
      if (bg && bg !== 'transparent') {
        return bg;
      }
      curr = curr.parent;
    }
    return 'white'; // Default document background fallback
  }

  private mapImpactToSeverity(impact: A11yImpact): FindingSeverity {
    switch (impact) {
      case 'critical':
        return 'CRITICAL';
      case 'serious':
        return 'HIGH';
      case 'moderate':
        return 'MEDIUM';
      case 'minor':
      default:
        return 'LOW';
    }
  }

  private formatViolationToFindings(
    violation: A11yViolation,
    platform: Platform,
    testCaseId?: string
  ): Finding[] {
    const severity = this.mapImpactToSeverity(violation.impact);

    return violation.nodes.map((node, idx) => {
      return {
        id: `FIND-A11Y-${violation.ruleId}-${Date.now()}-${idx}`,
        title: `WCAG Violation: ${violation.description} on ${node.target}`,
        description: `${violation.help}. ${node.failureSummary}`,
        severity,
        status: 'CONFIRMED',
        fixVerification: 'UNVERIFIED',
        platform,
        testCaseId,
        preconditions: ['Target document loaded and rendered in viewport'],
        reproductionSteps: [
          `1. Inspect element using selector: "${node.target}"`,
          `2. HTML snippet: ${node.html.slice(0, 200)}`,
          `3. Observe accessibility failure: ${node.failureSummary}`,
          `4. Consult WCAG guidelines: ${violation.helpUrl}`,
        ],
        expectedBehavior: `Element conforms to WCAG 2.1 AA rule: ${violation.ruleId} (${violation.help})`,
        actualBehavior: node.failureSummary,
        evidenceIds: [],
        reproducibilityCount: 1,
        reproducibilitySuccessRate: 1.0,
        detectedAt: new Date().toISOString(),
        metadata: {
          ruleId: violation.ruleId,
          impact: violation.impact,
          wcagTags: violation.wcagTags,
          targetSelector: node.target,
          helpUrl: violation.helpUrl,
          rect: node.rect,
        },
      };
    });
  }
}
