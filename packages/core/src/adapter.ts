import {
  Platform,
  CapabilityDescriptor,
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
} from '@agentic-qa/schemas';

export interface ActionResult {
  success: boolean;
  durationMs: number;
  output?: any;
  error?: string;
}

export interface AssertionResult {
  passed: boolean;
  expected?: any;
  actual?: any;
  durationMs: number;
  message?: string;
  evidenceId?: string;
}

export interface PlatformAdapter {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;

  /**
   * Honest probe of local system environment, binaries, tools, permissions.
   */
  getCapability(): Promise<CapabilityDescriptor>;

  /**
   * Initializes session / browser / driver / emulator.
   */
  initialize(options?: Record<string, any>): Promise<void>;

  /**
   * Executes a typed action on the target application.
   */
  executeAction(action: ActionSpec): Promise<ActionResult>;

  /**
   * Evaluates a deterministic assertion against the application state.
   */
  executeAssertion(assertion: AssertionSpec): Promise<AssertionResult>;

  /**
   * Captures raw evidence (screenshot, DOM, log, network trace).
   */
  captureEvidence(type: string, description?: string): Promise<EvidenceArtifact>;

  /**
   * Teardown and cleanup of resources.
   */
  teardown(): Promise<void>;
}
