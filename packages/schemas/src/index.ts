import { z } from 'zod';

// ============================================================================
// PLATFORMS AND CAPABILITY STATES
// ============================================================================

export const PlatformSchema = z.enum(['web', 'mobile', 'desktop', 'api', 'game']);
export type Platform = z.infer<typeof PlatformSchema>;

export const CapabilityStateSchema = z.enum([
  'AVAILABLE',    // Fully installed, configured, and executable
  'UNAVAILABLE',  // Installed but runtime/server/device is currently stopped/offline
  'UNSUPPORTED',  // Not supported on this host OS or target environment
  'BLOCKED'       // Missing mandatory dependencies, permissions, or credentials
]);
export type CapabilityState = z.infer<typeof CapabilityStateSchema>;

export const CapabilityDescriptorSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: PlatformSchema,
  state: CapabilityStateSchema,
  reason: z.string().optional(),
  requiredTools: z.array(z.string()).default([]),
  missingTools: z.array(z.string()).default([]),
  version: z.string().optional(),
  metadata: z.record(z.any()).default({}),
});
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

// ============================================================================
// ACTIONS AND ASSERTIONS
// ============================================================================

export const ActionTypeSchema = z.enum([
  'navigate',
  'click',
  'doubleClick',
  'fill',
  'type',
  'clear',
  'pressKey',
  'hover',
  'tap',
  'scroll',
  'wait',
  'snapshot',
  'rapidClicks',     // for robustness testing
  'evaluate',
  'custom'
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ActionSpecSchema = z.object({
  type: ActionTypeSchema,
  target: z.string().optional(), // Selector, XPath, Accessibility ID, or coordinate
  value: z.any().optional(),    // Text to type, URL, timeout ms, etc.
  timeoutMs: z.number().optional().default(10000),
  description: z.string().optional(),
  metadata: z.record(z.any()).default({}),
});
export type ActionSpec = z.infer<typeof ActionSpecSchema>;

export const AssertionTypeSchema = z.enum([
  'elementVisible',
  'elementHidden',
  'elementExists',
  'elementTextEquals',
  'elementTextContains',
  'elementDisabled',
  'elementEnabled',
  'elementCount',
  'urlMatches',
  'titleMatches',
  'status200',
  'consoleClean',           // Zero unhandled console errors
  'noNetworkFailures',      // Zero unhandled HTTP 4xx/5xx requests
  'noVisualRegression',     // Screenshot matches baseline within threshold
  'noAccessibilityViolations', // WCAG a11y violations == 0
  'custom'
]);
export type AssertionType = z.infer<typeof AssertionTypeSchema>;

export const AssertionSpecSchema = z.object({
  type: AssertionTypeSchema,
  target: z.string().optional(),
  expected: z.any().optional(),
  tolerance: z.number().optional(), // Visual diff percentage, timing threshold, etc.
  message: z.string().optional(),
  critical: z.boolean().default(true),
  metadata: z.record(z.any()).default({}),
});
export type AssertionSpec = z.infer<typeof AssertionSpecSchema>;

// ============================================================================
// TEST CASE, SCENARIO & TEST PLAN
// ============================================================================

export const TestStepSchema = z.object({
  id: z.string(),
  description: z.string(),
  action: ActionSpecSchema.optional(),
  assertion: AssertionSpecSchema.optional(),
  continueOnFailure: z.boolean().default(false),
});
export type TestStep = z.infer<typeof TestStepSchema>;

export const TestCaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(''),
  platform: PlatformSchema,
  viewport: z.object({
    width: z.number(),
    height: z.number(),
  }).optional(),
  steps: z.array(TestStepSchema),
  timeoutMs: z.number().default(60000),
  retries: z.number().default(0),
  tags: z.array(z.string()).default([]),
  expectedOutcome: z.enum(['PASS', 'FAIL']).default('PASS'),
});
export type TestCase = z.infer<typeof TestCaseSchema>;

export const TestPlanSchema = z.object({
  planId: z.string(),
  name: z.string(),
  targetApp: z.string(),
  platform: PlatformSchema,
  environment: z.string().default('local'),
  scenarios: z.array(TestCaseSchema),
  createdAt: z.string().datetime(),
  metadata: z.record(z.any()).default({}),
});
export type TestPlan = z.infer<typeof TestPlanSchema>;

// ============================================================================
// EVIDENCE
// ============================================================================

export const EvidenceTypeSchema = z.enum([
  'SCREENSHOT',
  'PERCEPTUAL_DIFF',
  'DOM_SNAPSHOT',
  'CONSOLE_LOG',
  'NETWORK_HAR',
  'SYSTEM_LOG',
  'AXE_A11Y_REPORT',
  'PERF_METRICS',
  'TRACE'
]);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const EvidenceArtifactSchema = z.object({
  id: z.string(),
  type: EvidenceTypeSchema,
  path: z.string(),
  sha256: z.string(),
  sizeBytes: z.number(),
  mimeType: z.string(),
  capturedAt: z.string().datetime(),
  description: z.string().default(''),
  metadata: z.record(z.any()).default({}),
});
export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

// ============================================================================
// FINDINGS AND DEFECTS
// ============================================================================

export const FindingSeveritySchema = z.enum([
  'CRITICAL', // Complete crash, data loss, security exposure, blocking core flow
  'HIGH',     // Major functional breakdown, critical user action blocked
  'MEDIUM',   // Secondary feature defect, significant visual layout flaw
  'LOW',      // Minor glitch, subtle styling imperfection
  'INFO'      // Non-blocking recommendation or diagnostic note
]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingStatusSchema = z.enum([
  'CONFIRMED',      // Deterministically reproduced with evidence
  'SUSPECTED',      // Observed once or flagged by heuristic, not yet reproducible
  'BLOCKED',        // Could not complete verification due to environment/permission block
  'NOT_REPRODUCED', // Attempted reproduction failed to observe defect
  'FIX_VERIFIED',   // Confirmed fixed via passing regression rerun
  'FIX_FAILED'      // Regression rerun failed; defect remains present
]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FixVerificationStatusSchema = z.enum([
  'UNVERIFIED',     // Proposed fix not yet executed against test suite
  'VERIFIED',       // Fix executed and regression passed
  'FAILED'          // Fix executed and regression failed
]);
export type FixVerificationStatus = z.infer<typeof FixVerificationStatusSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  severity: FindingSeveritySchema,
  status: FindingStatusSchema,
  fixVerification: FixVerificationStatusSchema.default('UNVERIFIED'),
  platform: PlatformSchema,
  testCaseId: z.string().optional(),
  preconditions: z.array(z.string()).default([]),
  reproductionSteps: z.array(z.string()),
  expectedBehavior: z.string(),
  actualBehavior: z.string(),
  evidenceIds: z.array(z.string()).default([]),
  reproducibilityCount: z.number().default(1),
  reproducibilitySuccessRate: z.number().min(0).max(1).default(1.0),
  logsExcerpt: z.string().optional(),
  detectedAt: z.string().datetime(),
  verifiedAt: z.string().datetime().optional(),
  metadata: z.record(z.any()).default({}),
});
export type Finding = z.infer<typeof FindingSchema>;

// ============================================================================
// EXECUTION RESULTS & TRUST SCORING
// ============================================================================

export const StepExecutionResultSchema = z.object({
  stepId: z.string(),
  status: z.enum(['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED']),
  durationMs: z.number(),
  error: z.string().optional(),
  evidenceIds: z.array(z.string()).default([]),
});
export type StepExecutionResult = z.infer<typeof StepExecutionResultSchema>;

export const TestCaseResultSchema = z.object({
  testCaseId: z.string(),
  title: z.string(),
  status: z.enum(['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'ERROR']),
  durationMs: z.number(),
  stepResults: z.array(StepExecutionResultSchema),
  error: z.string().optional(),
  evidenceIds: z.array(z.string()).default([]),
  attemptCount: z.number().default(1),
});
export type TestCaseResult = z.infer<typeof TestCaseResultSchema>;

export const TrustScoreSchema = z.object({
  score: z.number().min(0).max(100), // 0 to 100
  deterministicAssertionsCount: z.number(),
  evidenceArtifactsCount: z.number(),
  reproducibilityScore: z.number().min(0).max(100),
  coverageScore: z.number().min(0).max(100),
  honestyPenalty: z.number().default(0), // Penalty if assertions claimed without proof
  summary: z.string(),
});
export type TrustScore = z.infer<typeof TrustScoreSchema>;

export const QARunReportSchema = z.object({
  runId: z.string(),
  projectName: z.string(),
  targetApp: z.string(),
  platform: PlatformSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number(),
  overallStatus: z.enum(['PASSED', 'FAILED', 'BLOCKED', 'PARTIAL']),
  summary: z.object({
    totalTests: z.number(),
    passed: z.number(),
    failed: z.number(),
    blocked: z.number(),
    skipped: z.number(),
    error: z.number(),
  }),
  trustScore: TrustScoreSchema,
  capabilities: z.array(CapabilityDescriptorSchema),
  testResults: z.array(TestCaseResultSchema),
  findings: z.array(FindingSchema),
  evidence: z.array(EvidenceArtifactSchema),
  environmentInfo: z.record(z.any()),
});
export type QARunReport = z.infer<typeof QARunReportSchema>;

// ============================================================================
// CONFIGURATION SCHEMA
// ============================================================================

export const QAConfigSchema = z.object({
  name: z.string().default('agentic-qa-project'),
  version: z.string().default('1.0.0'),
  target: z.object({
    platform: PlatformSchema.default('web'),
    url: z.string().optional(),
    appPath: z.string().optional(),
    bundleId: z.string().optional(),
    packageName: z.string().optional(),
  }),
  viewports: z.array(z.object({
    name: z.string(),
    width: z.number(),
    height: z.number(),
  })).default([
    { name: 'mobile-sm', width: 320, height: 568 },
    { name: 'mobile-md', width: 375, height: 667 },
    { name: 'mobile-lg', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
    { name: 'desktop', width: 1440, height: 900 }
  ]),
  outputDir: z.string().default('.qa-output'),
  limits: z.object({
    maxTestDurationMs: z.number().default(120000),
    maxActionsPerTest: z.number().default(1000),
    maxReproductionAttempts: z.number().default(5),
  }).default({}),
  visual: z.object({
    diffThreshold: z.number().min(0).max(1).default(0.01), // 1% mismatch tolerance
    updateBaselines: z.boolean().default(false),
  }).default({}),
  accessibility: z.object({
    enabled: z.boolean().default(true),
    standards: z.array(z.string()).default(['wcag2a', 'wcag2aa', 'wcag21aa']),
  }).default({}),
  robustness: z.object({
    rapidClickCount: z.number().default(500),
    fuzzIterations: z.number().default(50),
    randomSeed: z.number().default(42),
  }).default({}),
});
export type QAConfig = z.infer<typeof QAConfigSchema>;
