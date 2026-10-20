import { describe, it, expect } from 'vitest';
import { LayoutShiftDetector } from '../layout-shift.js';
import { FindingSchema } from '@agentic-qa/schemas';

describe('LayoutShiftDetector', () => {
  const detector = new LayoutShiftDetector();

  describe('detectDomLayout', () => {
    it('detects horizontal overflow when element width exceeds viewport width', () => {
      // 375px mobile viewport, element with width: 600px
      const html = `
        <div class="container">
          <div id="wide-card" style="width: 600px; min-width: 600px;">
            Wide desktop content
          </div>
        </div>
      `;

      const result = detector.detectDomLayout(html, {
        viewport: { width: 375, height: 667 },
      });

      expect(result.passed).toBe(false);
      expect(result.hasHorizontalOverflow).toBe(true);
      expect(result.scrollWidth).toBe(600);
      expect(result.clientWidth).toBe(375);
      expect(result.issues.some((i) => i.type === 'HORIZONTAL_OVERFLOW')).toBe(true);

      const overflowIssue = result.issues.find((i) => i.type === 'HORIZONTAL_OVERFLOW')!;
      expect(overflowIssue.details).toContain('600px');
      expect(overflowIssue.selector).toContain('#wide-card');

      // Verify findings adhere to FindingSchema
      expect(result.findings.length).toBeGreaterThan(0);
      const finding = result.findings[0];
      expect(finding.severity).toBe('HIGH');
      expect(FindingSchema.safeParse(finding).success).toBe(true);
    });

    it('passes when all elements fit inside viewport width', () => {
      const html = `
        <div class="responsive-card" style="width: 320px;">
          Clean responsive mobile card
        </div>
      `;

      const result = detector.detectDomLayout(html, {
        viewport: { width: 375, height: 667 },
      });

      expect(result.passed).toBe(true);
      expect(result.hasHorizontalOverflow).toBe(false);
      expect(result.hasClippedElements).toBe(false);
      expect(result.issues).toHaveLength(0);
      expect(result.findings).toHaveLength(0);
    });

    it('detects clipped child elements when parent has overflow: hidden', () => {
      const html = `
        <div id="parent-box" style="width: 200px; overflow: hidden;">
          <div id="oversized-child" style="width: 450px;">
            Content that gets clipped by parent container
          </div>
        </div>
      `;

      const result = detector.detectDomLayout(html, {
        viewport: { width: 375, height: 667 },
      });

      expect(result.passed).toBe(false);
      expect(result.hasClippedElements).toBe(true);
      expect(result.issues.some((i) => i.type === 'CLIPPED_ELEMENT')).toBe(true);

      const clippedIssue = result.issues.find((i) => i.type === 'CLIPPED_ELEMENT')!;
      expect(clippedIssue.details).toContain('exceeds parent container width (200px)');
      expect(clippedIssue.details).toContain('overflow: hidden');

      const finding = result.findings.find((f) => f.metadata.issueType === 'CLIPPED_ELEMENT');
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('MEDIUM');
      expect(FindingSchema.safeParse(finding).success).toBe(true);
    });

    it('detects un-ellipsized clipped nowrap text', () => {
      const longText = 'This is a very long text string that will surely truncate in a narrow container';
      const html = `
        <p id="nowrap-text" style="width: 100px; white-space: nowrap;">
          ${longText}
        </p>
      `;

      const result = detector.detectDomLayout(html, {
        viewport: { width: 375, height: 667 },
      });

      expect(result.passed).toBe(false);
      expect(result.hasClippedElements).toBe(true);
      expect(result.issues.some((i) => i.type === 'CLIPPED_ELEMENT')).toBe(true);
    });
  });
});
