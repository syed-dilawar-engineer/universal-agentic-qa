import { z } from 'zod';
import {
  Platform,
  PlatformSchema,
  CapabilityDescriptor,
  CapabilityDescriptorSchema,
  TestPlan,
  TestPlanSchema,
  TestCase,
  TestCaseSchema,
  QARunReport,
  QARunReportSchema,
  EvidenceArtifact,
  EvidenceArtifactSchema,
  Finding,
  FindingSchema,
} from '@agentic-qa/schemas';
import type { CapabilityRegistry } from '@agentic-qa/core';
import type { RunStorage } from './storage.js';

// ============================================================================
// TOOL NAMES
// ============================================================================

export const TOOL_NAMES = {
  DISCOVER_CAPABILITIES: 'qa_discover_capabilities',
  INSPECT_TARGET: 'qa_inspect_target',
  CREATE_PLAN: 'qa_create_plan',
  EXECUTE_TEST: 'qa_execute_test',
  GET_EVIDENCE: 'qa_get_evidence',
  GENERATE_REPORT: 'qa_generate_report',
  VERIFY_FIX: 'qa_verify_fix',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

// ============================================================================
// CONSTANTS
// ============================================================================

export const DEFAULT_MAX_OUTPUT_CHARS = 30000;
export const DEFAULT_TOOL_TIMEOUT_MS = 60000;
export const DEFAULT_EVIDENCE_MAX_BYTES = 500000; // 500 KB limit for inline evidence

// ============================================================================
// SERVER CONTEXT
// ============================================================================

export interface McpServerContext {
  registry: CapabilityRegistry;
  storage: RunStorage;
  maxOutputLength?: number;
}

// ============================================================================
// TOOL SCHEMAS & TYPES
// ============================================================================

// 1. qa_discover_capabilities
export const DiscoverCapabilitiesInputShape = {
  platform: PlatformSchema.optional().describe('Filter capabilities by target platform (web, mobile, desktop, api, game)'),
  forceRefresh: z.boolean().optional().default(false).describe('Force active probe of system binaries and running drivers'),
  detailed: z.boolean().optional().default(true).describe('Include verbose diagnostic metadata and tool paths'),
};
export const DiscoverCapabilitiesInputSchema = z.object(DiscoverCapabilitiesInputShape);
export type DiscoverCapabilitiesInput = z.input<typeof DiscoverCapabilitiesInputSchema>;

export interface DiscoverCapabilitiesOutput {
  timestamp: string;
  readiness: 'ALL_READY' | 'PARTIALLY_READY' | 'NOT_READY';
  summary: {
    total: number;
    available: number;
    unavailable: number;
    unsupported: number;
    blocked: number;
  };
  capabilities: CapabilityDescriptor[];
  recommendations: string[];
}

// 2. qa_inspect_target
export const InspectTargetInputShape = {
  target: z.string().min(1, 'Target URL or local filesystem path is required').describe('Target URL (e.g. https://example.com) or local application path'),
  platform: PlatformSchema.optional().describe('Explicit target platform override; if omitted, automatically inferred'),
  timeoutMs: z.number().positive().max(30000).optional().default(10000).describe('Network probe timeout in milliseconds (max 30000)'),
};
export const InspectTargetInputSchema = z.object(InspectTargetInputShape);
export type InspectTargetInput = z.input<typeof InspectTargetInputSchema>;

export interface InspectTargetOutput {
  target: string;
  inferredPlatform: Platform;
  targetType: 'URL' | 'LOCAL_DIRECTORY' | 'LOCAL_FILE' | 'UNKNOWN';
  reachable: boolean;
  statusCode?: number;
  contentType?: string;
  responseTimeMs?: number;
  frameworkHints: string[];
  details: Record<string, any>;
  recommendations: string[];
  error?: string;
}

// 3. qa_create_plan
export const CreatePlanInputShape = {
  action: z.enum(['generate', 'validate']).describe("Action: 'generate' to build a structured plan or 'validate' to verify an existing plan"),
  targetApp: z.string().optional().describe('Target application URL or path (required for generation)'),
  platform: PlatformSchema.optional().default('web').describe('Platform for the generated test plan'),
  planType: z.enum(['smoke', 'regression', 'accessibility', 'robustness', 'custom']).optional().default('smoke').describe('Template pattern for generated plan'),
  name: z.string().optional().describe('Human-readable name for the plan'),
  plan: z.record(z.any()).optional().describe('Test plan object to validate (required when action=validate)'),
  scenarios: z.array(z.record(z.any())).optional().describe('Custom scenarios to include in the plan'),
};
export const CreatePlanInputSchema = z.object(CreatePlanInputShape);
export type CreatePlanInput = z.input<typeof CreatePlanInputSchema>;

export interface CreatePlanOutput {
  valid: boolean;
  action: 'generate' | 'validate';
  plan?: TestPlan;
  errors?: Array<{ path: string; message: string; code?: string }>;
  scenarioCount?: number;
  summary?: string;
}

// 4. qa_execute_test
export const ExecuteTestInputShape = {
  plan: z.record(z.any()).optional().describe('Test plan object conforming to TestPlanSchema'),
  planId: z.string().optional().describe('Identifier of previously registered or created test plan'),
  targetApp: z.string().optional().describe('Target app override'),
  platform: PlatformSchema.optional().describe('Platform override'),
  adapterId: z.string().optional().describe('Specific platform adapter ID to execute with'),
  timeoutMs: z.number().positive().max(300000).optional().default(60000).describe('Test execution timeout in milliseconds (default 60s, max 5m)'),
  maxOutputLength: z.number().positive().max(50000).optional().default(DEFAULT_MAX_OUTPUT_CHARS).describe('Max characters returned in MCP response to prevent token explosion'),
};
export const ExecuteTestInputSchema = z.object(ExecuteTestInputShape);
export type ExecuteTestInput = z.input<typeof ExecuteTestInputSchema>;

export interface ExecuteTestOutput {
  runId: string;
  overallStatus: 'PASSED' | 'FAILED' | 'BLOCKED' | 'PARTIAL';
  durationMs: number;
  summary: {
    totalTests: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: number;
    error: number;
  };
  trustScore: {
    score: number;
    deterministicAssertionsCount: number;
    evidenceArtifactsCount: number;
    summary: string;
  };
  findingsCount: number;
  findings: Finding[];
  evidenceIds: string[];
  reportTruncated: boolean;
  fullReportId: string;
}

// 5. qa_get_evidence
export const GetEvidenceInputShape = {
  evidenceId: z.string().min(1, 'evidenceId is required').describe('ID of the evidence artifact to retrieve'),
  runId: z.string().optional().describe('Optional run ID for scoped lookup'),
  encoding: z.enum(['base64', 'utf8', 'metadata_only']).optional().default('metadata_only').describe('Encoding format for artifact data (metadata_only, utf8, base64)'),
  maxBytes: z.number().positive().max(5000000).optional().default(DEFAULT_EVIDENCE_MAX_BYTES).describe('Maximum bytes of artifact payload to return (max 5MB)'),
};
export const GetEvidenceInputSchema = z.object(GetEvidenceInputShape);
export type GetEvidenceInput = z.input<typeof GetEvidenceInputSchema>;

export interface GetEvidenceOutput {
  found: boolean;
  artifact?: EvidenceArtifact;
  verifiedChecksum: boolean;
  actualSha256?: string;
  data?: string;
  truncated?: boolean;
  error?: string;
}

// 6. qa_generate_report
export const GenerateReportInputShape = {
  runId: z.string().optional().describe('Run ID of the QA execution; defaults to the most recent run'),
  report: z.record(z.any()).optional().describe('Inline QARunReport object to format directly'),
  format: z.enum(['markdown', 'json', 'summary']).optional().default('markdown').describe('Output presentation format'),
  includeEvidence: z.boolean().optional().default(true).describe('Whether to list evidence artifact references'),
  maxFindings: z.number().positive().optional().default(50).describe('Maximum findings to include in formatted output'),
};
export const GenerateReportInputSchema = z.object(GenerateReportInputShape);
export type GenerateReportInput = z.input<typeof GenerateReportInputSchema>;

export interface GenerateReportOutput {
  format: 'markdown' | 'json' | 'summary';
  runId: string;
  content: string;
  overallStatus: string;
  trustScore: number;
}

// 7. qa_verify_fix
export const VerifyFixInputShape = {
  findingId: z.string().min(1, 'findingId is required').describe('ID of the defect finding to verify as fixed'),
  targetApp: z.string().optional().describe('Target application URL or path where the fix is deployed (defaults to original target)'),
  testCase: z.record(z.any()).optional().describe('Explicit test case for verification; if omitted, reconstructed from finding reproduction steps'),
  adapterId: z.string().optional().describe('Platform adapter ID to use for verification'),
  timeoutMs: z.number().positive().max(300000).optional().default(60000).describe('Verification test timeout in milliseconds'),
};
export const VerifyFixInputSchema = z.object(VerifyFixInputShape);
export type VerifyFixInput = z.input<typeof VerifyFixInputSchema>;

export interface VerifyFixOutput {
  findingId: string;
  verified: boolean;
  previousStatus: string;
  newStatus: string;
  fixVerification: 'VERIFIED' | 'FAILED' | 'UNVERIFIED';
  runId: string;
  durationMs: number;
  message: string;
  evidenceIds: string[];
}
