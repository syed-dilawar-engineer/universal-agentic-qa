import {
  ActionSpec,
  ActionSpecSchema,
  AssertionSpec,
  AssertionSpecSchema,
  EvidenceArtifact,
  Finding,
  Platform,
} from '@agentic-qa/schemas';
import { z } from 'zod';

/**
 * Creates a fully validated ActionSpec applying default values.
 */
export function createActionSpec(spec: z.input<typeof ActionSpecSchema>): ActionSpec {
  return ActionSpecSchema.parse(spec);
}

/**
 * Creates a fully validated AssertionSpec applying default values.
 */
export function createAssertionSpec(spec: z.input<typeof AssertionSpecSchema>): AssertionSpec {
  return AssertionSpecSchema.parse(spec);
}


// ============================================================================
// RAPID INTERACTION RUNNER TYPES
// ============================================================================

export interface RapidInteractionOptions {
  /** Target button selector, ID, or locator */
  targetButton: string;
  /** Number of rapid activation events to attempt (default: 500) */
  rapidClickCount?: number;
  /** Initial trigger action that should initiate submission/debouncing */
  triggerAction?: ActionSpec;
  /** Dispatch strategy: 'burst' (batched concurrency) | 'sequential' | 'native' (default: 'burst') */
  dispatchMode?: 'burst' | 'sequential' | 'native';
  /** Batch size when running burst mode (default: 50) */
  batchSize?: number;
  /** Timeout in ms to evaluate UI responsiveness / hang (default: 5000) */
  hangThresholdMs?: number;
  /** Optional custom check for duplicate submissions on the server/client */
  checkDuplicateSubmissions?: () => Promise<{ duplicateDetected: boolean; count: number; details?: string }>;
}

export interface RapidInteractionResult {
  passed: boolean;
  targetButton: string;
  initialState: {
    exists: boolean;
    enabled: boolean;
  };
  eventsIssued: number;
  eventsAccepted: number;
  eventsRejected: number;
  buttonDisabledAfterTrigger: boolean;
  duplicateSubmissionsDetected: boolean;
  duplicateCount: number;
  uiHung: boolean;
  hangDurationMs: number;
  unhandledExceptions: string[];
  durationMs: number;
  finding?: Finding;
  evidence: EvidenceArtifact[];
}

// ============================================================================
// MONKEY EXPLORER TYPES
// ============================================================================

export interface MonkeyStep {
  stepNumber: number;
  stateBefore: string;
  action: ActionSpec;
  stateAfter: string;
  durationMs: number;
  success: boolean;
  error?: string;
  timestamp: string;
}

export interface MonkeyError {
  stepNumber: number;
  state: string;
  action: ActionSpec;
  error: string;
  timestamp: string;
}

export interface MonkeyExplorerOptions {
  /** Maximum actions before terminating exploration (default: 50) */
  maxActions?: number;
  /** Exploration timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Reproducible random seed (default: 42) */
  seed?: number;
  /** List of interactable selectors to target if dynamic extraction is not used */
  interactableSelectors?: string[];
  /** Optional dynamic provider for available interactables in a given state */
  elementProvider?: (state: string) => Promise<string[]>;
  /** Custom state extractor function returning a state hash/string */
  stateExtractor?: () => Promise<string>;
  /** Action types allowed during exploration (default: click, fill, scroll, hover, pressKey, wait) */
  allowedActions?: Array<'click' | 'fill' | 'scroll' | 'hover' | 'pressKey' | 'wait'>;
  /** Hook called after every step */
  onStep?: (step: MonkeyStep) => void;
}

export interface MonkeyExplorerResult {
  passed: boolean;
  seed: number;
  totalActions: number;
  visitedStates: string[];
  stateTransitionCount: number;
  trace: MonkeyStep[];
  errorsCaught: MonkeyError[];
  findings: Finding[];
  durationMs: number;
}

// ============================================================================
// BOUNDARY FUZZER TYPES
// ============================================================================

export type FuzzCategory =
  | 'sql_injection'
  | 'xss'
  | 'unicode'
  | 'long_string'
  | 'numeric_boundary'
  | 'null_bytes';

export interface FuzzPayload {
  id: string;
  name: string;
  category: FuzzCategory;
  value: string;
  description: string;
  expectedBehavior?: string;
}

export interface FuzzPayloadResult {
  payload: FuzzPayload;
  success: boolean;
  handledGracefully: boolean;
  statusCode?: number;
  error?: string;
  durationMs: number;
  finding?: Finding;
}

export interface BoundaryFuzzerOptions {
  /** Selector for the target text input to fuzz */
  targetInput: string;
  /** Optional selector to trigger form submission after entering payload */
  submitTarget?: string;
  /** Optional custom submit action */
  submitAction?: ActionSpec;
  /** Categories of payloads to test (default: all) */
  categories?: FuzzCategory[];
  /** Max number of payloads to test (default: all matching categories) */
  fuzzIterations?: number;
  /** Custom payloads to append or override */
  customPayloads?: FuzzPayload[];
  /** Custom validator hook to determine whether input was handled gracefully */
  validateGracefulHandling?: (
    payload: FuzzPayload,
    actionResult: { success: boolean; error?: string }
  ) => Promise<{ handledGracefully: boolean; reason?: string }>;
}

export interface BoundaryFuzzerResult {
  passed: boolean;
  targetInput: string;
  totalTested: number;
  passedCount: number;
  failedCount: number;
  payloadResults: FuzzPayloadResult[];
  findings: Finding[];
  durationMs: number;
}
