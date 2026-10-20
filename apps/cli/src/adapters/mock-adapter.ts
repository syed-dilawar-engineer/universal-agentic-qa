import {
  PlatformAdapter,
  ActionResult,
  AssertionResult,
} from '@agentic-qa/core';
import {
  Platform,
  CapabilityDescriptor,
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
} from '@agentic-qa/schemas';

export interface MockAdapterOptions {
  id?: string;
  name?: string;
  platform?: Platform;
  state?: 'AVAILABLE' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'BLOCKED';
  reason?: string;
  missingTools?: string[];
  failAssertions?: boolean;
  failActions?: boolean;
}

export class CliMockAdapter implements PlatformAdapter {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;

  private state: 'AVAILABLE' | 'UNAVAILABLE' | 'UNSUPPORTED' | 'BLOCKED';
  private reason?: string;
  private missingTools: string[];
  private failAssertions: boolean;
  private failActions: boolean;

  constructor(options: MockAdapterOptions = {}) {
    this.id = options.id || 'mock-adapter';
    this.name = options.name || 'Mock Test Adapter';
    this.platform = options.platform || 'web';
    this.state = options.state || 'AVAILABLE';
    this.reason = options.reason;
    this.missingTools = options.missingTools || (this.state === 'BLOCKED' ? ['mock-dependency'] : []);
    this.failAssertions = options.failAssertions ?? false;
    this.failActions = options.failActions ?? false;
  }

  async getCapability(): Promise<CapabilityDescriptor> {
    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: this.state,
      reason: this.reason || (this.state === 'BLOCKED' ? 'Missing mock dependency' : undefined),
      requiredTools: ['mock-tool'],
      missingTools: this.missingTools,
      version: '1.0.0',
      metadata: { mock: true },
    };
  }

  async initialize(): Promise<void> {}

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    if (this.failActions) {
      return {
        success: false,
        durationMs: 5,
        error: `Simulated action failure for ${action.type}`,
      };
    }
    return { success: true, durationMs: 5 };
  }

  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    if (this.failAssertions) {
      return {
        passed: false,
        durationMs: 5,
        expected: assertion.expected ?? true,
        actual: false,
        message: `Simulated assertion failure: ${assertion.type} failed`,
      };
    }
    return {
      passed: true,
      durationMs: 5,
      expected: assertion.expected ?? true,
      actual: assertion.expected ?? true,
    };
  }

  async captureEvidence(type: string, description?: string): Promise<EvidenceArtifact> {
    return {
      id: `ev-mock-${Date.now()}`,
      type: (type as any) || 'SCREENSHOT',
      path: '/tmp/mock-evidence.png',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sizeBytes: 128,
      mimeType: 'image/png',
      capturedAt: new Date().toISOString(),
      description: description || 'Mock evidence snapshot',
      metadata: {},
    };
  }

  async teardown(): Promise<void> {}
}
