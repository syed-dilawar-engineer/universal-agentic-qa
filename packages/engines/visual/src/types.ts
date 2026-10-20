import type { Finding, EvidenceArtifact, Platform } from '@agentic-qa/schemas';

// ============================================================================
// VISUAL DIFF ENGINE TYPES
// ============================================================================

export interface MaskRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
  category?: 'timestamp' | 'banner' | 'avatar' | 'dynamic' | 'custom';
}

export interface DynamicMaskRule {
  name: string;
  category: 'timestamp' | 'banner' | 'avatar' | 'custom';
  selector?: string;
  region?: MaskRegion;
}

export interface VisualDiffOptions {
  /**
   * Maximum allowed fraction of mismatched pixels (0.0 to 1.0).
   * Default is 0.01 (1.0% tolerance).
   */
  diffThreshold?: number;

  /**
   * Perceptual color difference threshold for pixelmatch (0.0 to 1.0).
   * Smaller values are more sensitive. Default is 0.1.
   */
  perceptualThreshold?: number;

  /**
   * Whether to detect and ignore anti-aliased pixels. Default is true.
   */
  includeAA?: boolean;

  /**
   * Color for highlighting mismatched pixels: [r, g, b]. Default is [255, 0, 0] (red).
   */
  diffColor?: [number, number, number];

  /**
   * Regions to mask / exclude from comparison.
   */
  masks?: MaskRegion[];

  /**
   * Explicit flag to update or create the baseline image if missing or mismatched.
   * If false, visual diff will NEVER auto-approve new baselines.
   */
  updateBaselines?: boolean;

  /**
   * File path where the visual diff image (PNG) should be saved.
   */
  outputDiffPath?: string;

  /**
   * Target platform for generating findings. Default is 'web'.
   */
  platform?: Platform;

  /**
   * Associated test case ID.
   */
  testCaseId?: string;
}

export interface VisualDiffResult {
  /**
   * True if visual diff passes within the configured diffThreshold.
   * NEVER true if baseline or candidate image is missing.
   */
  passed: boolean;

  /**
   * Percentage of mismatched pixels (0.0 to 100.0).
   */
  mismatchPercentage: number;

  /**
   * Ratio of mismatched pixels (0.0 to 1.0).
   */
  mismatchRatio: number;

  /**
   * Count of mismatched pixels.
   */
  mismatchPixels: number;

  /**
   * Total pixel count considered in the comparison canvas.
   */
  totalPixels: number;

  /**
   * Configured mismatch tolerance threshold fraction (e.g. 0.01).
   */
  diffThreshold: number;

  /**
   * Path to the saved diff image, if outputDiffPath was provided.
   */
  diffImagePath?: string;

  /**
   * Raw PNG buffer of the visual diff highlighting mismatches.
   */
  diffImageBuffer?: Buffer;

  /**
   * Baseline image path (if file comparison was used).
   */
  baselinePath?: string;

  /**
   * Candidate image path (if file comparison was used).
   */
  candidatePath?: string;

  /**
   * True if a new baseline was created because updateBaselines was true.
   */
  baselineCreated?: boolean;

  /**
   * Masked regions applied during comparison.
   */
  maskedRegions: MaskRegion[];

  /**
   * Image dimensions.
   */
  dimensions: {
    baseline?: { width: number; height: number };
    candidate?: { width: number; height: number };
    diff: { width: number; height: number };
  };

  /**
   * Error or failure message if image was missing or comparison failed.
   */
  error?: string;

  /**
   * Structured finding generated if the visual diff failed.
   */
  finding?: Finding;

  /**
   * Evidence artifact for the diff image.
   */
  evidenceArtifact?: EvidenceArtifact;
}

// ============================================================================
// ACCESSIBILITY ENGINE TYPES
// ============================================================================

export type A11yImpact = 'critical' | 'serious' | 'moderate' | 'minor';

export interface A11yViolationNode {
  target: string;
  html: string;
  failureSummary: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface A11yViolation {
  id: string;
  ruleId: string;
  description: string;
  help: string;
  helpUrl: string;
  impact: A11yImpact;
  wcagTags: string[];
  nodes: A11yViolationNode[];
}

export interface A11yAuditOptions {
  /**
   * WCAG standards to audit against. Default: ['wcag2a', 'wcag2aa', 'wcag21aa']
   */
  standards?: string[];

  /**
   * Minimum tap target size in pixels (width, height).
   * WCAG 2.1 AAA / 2.2 AA recommend 44x44 or 48x48. Default is 44x44.
   */
  minTapTargetSize?: { width: number; height: number };

  /**
   * Target platform for generating findings. Default is 'web'.
   */
  platform?: Platform;

  /**
   * Associated test case ID.
   */
  testCaseId?: string;

  /**
   * Whether to include passed / inapplicable rules in the result. Default is false.
   */
  includePassed?: boolean;
}

export interface A11yAuditResult {
  passed: boolean;
  violations: A11yViolation[];
  findings: Finding[];
  summary: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
  evidenceArtifact?: EvidenceArtifact;
}

// ============================================================================
// LAYOUT SHIFT AND OVERFLOW TYPES
// ============================================================================

export type LayoutIssueType =
  | 'HORIZONTAL_OVERFLOW'
  | 'CLIPPED_ELEMENT'
  | 'OFFSCREEN_CONTROL'
  | 'UNEXPECTED_SHIFT';

export interface LayoutIssue {
  type: LayoutIssueType;
  selector: string;
  tagName: string;
  details: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  computedStyles?: Record<string, string>;
}

export interface LayoutCheckResult {
  passed: boolean;
  hasHorizontalOverflow: boolean;
  hasClippedElements: boolean;
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  issues: LayoutIssue[];
  findings: Finding[];
}
