import { describe, it, expect } from 'vitest';
import { AccessibilityEngine } from '../a11y.js';
import { FindingSchema } from '@agentic-qa/schemas';

describe('AccessibilityEngine', () => {
  const engine = new AccessibilityEngine();

  describe('WCAG 1.1.1: Alt Text', () => {
    it('detects images missing alt attributes', () => {
      const html = `
        <div>
          <img src="banner.png" id="hero-img">
          <img src="avatar.png" alt="User avatar">
        </div>
      `;

      const result = engine.auditHtml(html);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.id === 'image-alt')).toBe(true);

      const altViolation = result.violations.find((v) => v.id === 'image-alt')!;
      expect(altViolation.nodes).toHaveLength(1);
      expect(altViolation.nodes[0].target).toContain('#hero-img');
      expect(altViolation.impact).toBe('critical');

      // Verify findings
      const finding = result.findings.find((f) => f.metadata.ruleId === 'image-alt');
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('CRITICAL');
      expect(FindingSchema.safeParse(finding).success).toBe(true);
    });

    it('passes decorative images with role="presentation"', () => {
      const html = `
        <div>
          <img src="decorator.png" role="presentation">
          <img src="icon.png" alt="">
        </div>
      `;

      const result = engine.auditHtml(html);
      expect(result.violations.some((v) => v.id === 'image-alt')).toBe(false);
    });

    it('detects input type="image" missing alt', () => {
      const html = `<input type="image" src="submit.png" id="submit-btn">`;
      const result = engine.auditHtml(html);

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.id === 'image-alt')).toBe(true);
    });
  });

  describe('WCAG 1.3.1 & 4.1.2: Form Labels', () => {
    it('detects input elements without labels', () => {
      const html = `
        <form>
          <input type="text" id="unlabeled-email" name="email">
        </form>
      `;

      const result = engine.auditHtml(html);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.id === 'label')).toBe(true);

      const labelFinding = result.findings.find((f) => f.metadata.ruleId === 'label');
      expect(labelFinding).toBeDefined();
      expect(labelFinding!.severity).toBe('CRITICAL');
      expect(labelFinding!.reproductionSteps.length).toBeGreaterThan(0);
      expect(FindingSchema.safeParse(labelFinding).success).toBe(true);
    });

    it('passes inputs with associated <label for="...">', () => {
      const html = `
        <form>
          <label for="user-email">Email Address</label>
          <input type="email" id="user-email" name="email">
        </form>
      `;

      const result = engine.auditHtml(html);
      expect(result.violations.some((v) => v.id === 'label')).toBe(false);
    });

    it('passes inputs with aria-label or aria-labelledby', () => {
      const html = `
        <form>
          <input type="search" aria-label="Search site">
          <span id="tel-lbl">Phone</span>
          <input type="tel" aria-labelledby="tel-lbl">
        </form>
      `;

      const result = engine.auditHtml(html);
      expect(result.violations.some((v) => v.id === 'label')).toBe(false);
    });
  });

  describe('WCAG 4.1.2: ARIA Roles & Attributes', () => {
    it('detects invalid ARIA roles', () => {
      const html = `<div role="clickable-card">Click me</div>`;
      const result = engine.auditHtml(html);

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.id === 'aria-roles')).toBe(true);
    });

    it('detects missing required ARIA states (e.g. aria-checked on checkbox)', () => {
      const html = `<div role="checkbox" id="terms-box">Accept terms</div>`;
      const result = engine.auditHtml(html);

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.id === 'aria-required-attr')).toBe(true);

      const finding = result.findings.find((f) => f.metadata.ruleId === 'aria-required-attr');
      expect(finding).toBeDefined();
      expect(FindingSchema.safeParse(finding).success).toBe(true);
    });

    it('detects interactive elements hidden with aria-hidden="true"', () => {
      const html = `<button aria-hidden="true">Hidden action</button>`;
      const result = engine.auditHtml(html);

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.id === 'aria-hidden-focus')).toBe(true);
    });
  });

  describe('WCAG 1.4.3: Color Contrast', () => {
    it('detects insufficient color contrast on text', () => {
      // Light gray on white = ~1.6:1 contrast (well below 4.5:1 required)
      const html = `
        <div style="background-color: #ffffff;">
          <p style="color: #cccccc;">Faint grey text</p>
        </div>
      `;

      const result = engine.auditHtml(html);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.id === 'color-contrast')).toBe(true);

      const contrastFinding = result.findings.find((f) => f.metadata.ruleId === 'color-contrast');
      expect(contrastFinding).toBeDefined();
      expect(contrastFinding!.severity).toBe('HIGH');
      expect(contrastFinding!.actualBehavior).toContain('insufficient color contrast');
      expect(FindingSchema.safeParse(contrastFinding).success).toBe(true);
    });

    it('passes high-contrast text', () => {
      // Black on white = 21:1 contrast
      const html = `
        <div style="background-color: #ffffff;">
          <p style="color: #000000;">Crisp black text</p>
        </div>
      `;

      const result = engine.auditHtml(html);
      expect(result.violations.some((v) => v.id === 'color-contrast')).toBe(false);
    });
  });

  describe('WCAG 2.1 / 2.2: Tap Target Size', () => {
    it('detects undersized touch targets (< 44x44px)', () => {
      const html = `
        <div>
          <button id="small-btn" style="width: 24px; height: 24px;">X</button>
        </div>
      `;

      const result = engine.auditHtml(html);
      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.id === 'target-size')).toBe(true);

      const targetFinding = result.findings.find((f) => f.metadata.ruleId === 'target-size');
      expect(targetFinding).toBeDefined();
      expect(targetFinding!.actualBehavior).toContain('is below 44x44px requirement');
      expect(FindingSchema.safeParse(targetFinding).success).toBe(true);
    });

    it('passes touch targets >= 44x44px', () => {
      const html = `
        <div>
          <button id="proper-btn" style="width: 48px; height: 48px;">Menu</button>
        </div>
      `;

      const result = engine.auditHtml(html);
      expect(result.violations.some((v) => v.id === 'target-size')).toBe(false);
    });

    it('exempts inline anchor links inside paragraphs and spans per WCAG 2.5.5 / 2.5.8 exemption', () => {
      const html = `
        <div>
          <p>
            Please review our <a href="/terms" style="width: 20px; height: 16px;">terms of service</a> for details.
          </p>
          <span>
            Contact <a href="/help" style="width: 15px; height: 14px;">support</a> anytime.
          </span>
        </div>
      `;

      const result = engine.auditHtml(html);
      expect(result.violations.some((v) => v.id === 'target-size')).toBe(false);
    });

    it('flags non-inline standalone anchor links below 44x44px', () => {
      const html = `
        <div>
          <a href="/standalone" style="width: 20px; height: 20px;">Link</a>
        </div>
      `;

      const result = engine.auditHtml(html);
      expect(result.violations.some((v) => v.id === 'target-size')).toBe(true);
    });
  });

  describe('Button Accessible Names', () => {
    it('detects empty button with no accessible text', () => {
      const html = `<button id="icon-only-btn"></button>`;
      const result = engine.auditHtml(html);

      expect(result.passed).toBe(false);
      expect(result.violations.some((v) => v.id === 'button-name')).toBe(true);

      const finding = result.findings.find((f) => f.metadata.ruleId === 'button-name');
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe('CRITICAL');
      expect(FindingSchema.safeParse(finding).success).toBe(true);
    });
  });
});
