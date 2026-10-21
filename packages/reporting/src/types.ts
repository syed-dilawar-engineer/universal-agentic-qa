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
