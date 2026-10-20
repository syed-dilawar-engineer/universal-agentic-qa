import {
  EvidenceType,
  EvidenceArtifact,
  Finding,
  TestCaseResult,
  TestPlan,
  QARunReport,
  Platform,
} from '@agentic-qa/schemas';

export interface EvidenceStoreOptions {
  /** Directory where artifact files are saved. Defaults to '.qa-output/evidence'. */
  baseDir?: string;
  /** Automatically persist index file to disk on write. Defaults to true. */
  autoPersistIndex?: boolean;
  /** Name of the index JSON file. Defaults to 'evidence-index.json'. */
  indexFileName?: string;
}

export interface StoreArtifactOptions {
  /** Type of evidence artifact */
  type: EvidenceType;
  /** Content buffer, uint8array, or utf-8 string */
  content: Buffer | Uint8Array | string;
  /** Optional custom filename (sanitized to prevent directory traversal) */
  filename?: string;
  /** Optional MIME type override */
  mimeType?: string;
  /** Human-readable description */
  description?: string;
  /** Arbitrary metadata */
  metadata?: Record<string, any>;
  /** ISO datetime when captured (defaults to now) */
  capturedAt?: string;
  /** Explicit artifact ID (generated if omitted) */
  id?: string;
}

export interface ArtifactIntegrityResult {
  id: string;
  valid: boolean;
  expectedSha256: string;
  actualSha256?: string;
  path: string;
  error?: string;
}

export interface ArtifactQueryFilter {
  type?: EvidenceType;
  testCaseId?: string;
  stepId?: string;
  tag?: string;
  mimeType?: string;
  since?: string | Date;
  until?: string | Date;
}

export interface TrustScorerWeights {
  /** Weight for deterministic assertions (default 0.35) */
  assertions?: number;
  /** Weight for evidence backing (default 0.25) */
  evidence?: number;
  /** Weight for test/finding reproducibility (default 0.20) */
  reproducibility?: number;
  /** Weight for execution coverage (default 0.20) */
  coverage?: number;
}

export interface TrustScorerOptions {
  /** Weights for trust score dimensions (must sum to ~1.0) */
  weights?: TrustScorerWeights;
  /** Penalty points deducted per unverified assertion (default 15) */
  unverifiedAssertionPenalty?: number;
  /** Penalty points deducted per missing baseline (default 20) */
  missingBaselinePenalty?: number;
  /** Penalty points deducted per confirmed finding without evidence (default 25) */
  unbackedConfirmedFindingPenalty?: number;
  /** Maximum total honesty penalty deduction (default 100) */
  maxHonestyPenalty?: number;
}

export interface TrustScoreInput {
  testResults: TestCaseResult[];
  evidence: EvidenceArtifact[];
  findings?: Finding[];
  testPlan?: TestPlan;
  /** Explicit count of unverified assertions (e.g. assertions with no concrete validation) */
  unverifiedAssertionsCount?: number;
  /** Explicit count of missing baselines (e.g. visual diff without baseline image) */
  missingBaselinesCount?: number;
  /** Explicit count of flaky attempts across runs */
  flakyAttemptsCount?: number;
}

export interface MarkdownReportOptions {
  /** Include clickable links to evidence artifacts (default true) */
  includeEvidenceLinks?: boolean;
  /** Include log excerpts for failed tests and findings (default true) */
  includeLogSnippets?: boolean;
  /** Base URL or relative path prefix for evidence links */
  evidenceBaseUrl?: string;
  /** Custom report title */
  title?: string;
}

export interface HtmlReportOptions {
  /** Embed screenshots and logs inline as base64/text for a single self-contained file (default true) */
  embedArtifacts?: boolean;
  /** Custom dashboard title */
  title?: string;
  /** Base directory where evidence files are stored if embedArtifacts is false */
  evidenceBaseDir?: string;
}
