import crypto from 'node:crypto';
import {
  Platform,
  CapabilityDescriptor,
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
} from '@agentic-qa/schemas';
import { PlatformAdapter, ActionResult, AssertionResult } from '@agentic-qa/core';

export interface MockAdapterOptions {
  id?: string;
  name?: string;
  platform?: Platform;
  state?: 'AVAILABLE' | 'BLOCKED' | 'UNSUPPORTED' | 'UNAVAILABLE';
  missingTools?: string[];
  assertionOverrides?: Record<string, { passed: boolean; message?: string; actual?: any }>;
}

export class MockPlatformAdapter implements PlatformAdapter {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;
  private state: 'AVAILABLE' | 'BLOCKED' | 'UNSUPPORTED' | 'UNAVAILABLE';
  private missingTools: string[];
  private assertionOverrides: Record<string, { passed: boolean; message?: string; actual?: any }>;
  public initialized = false;
  public actionsExecuted: ActionSpec[] = [];
  public assertionsExecuted: AssertionSpec[] = [];

  constructor(options: MockAdapterOptions = {}) {
    this.id = options.id ?? 'mock-adapter';
    this.name = options.name ?? 'Mock Platform Adapter';
    this.platform = options.platform ?? 'web';
    this.state = options.state ?? 'AVAILABLE';
    this.missingTools = options.missingTools ?? (this.state === 'BLOCKED' ? ['chromium'] : []);
    this.assertionOverrides = options.assertionOverrides ?? {};
  }

  setState(state: 'AVAILABLE' | 'BLOCKED' | 'UNSUPPORTED' | 'UNAVAILABLE', missing: string[] = []): void {
    this.state = state;
    this.missingTools = missing;
  }

  setAssertionOverride(
    assertionType: string,
    result: { passed: boolean; message?: string; actual?: any }
  ): void {
    this.assertionOverrides[assertionType] = result;
  }

  async getCapability(): Promise<CapabilityDescriptor> {
    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: this.state,
      reason:
        this.state === 'BLOCKED'
          ? `Missing required tools: ${this.missingTools.join(', ')}`
          : this.state === 'UNSUPPORTED'
            ? `Platform ${this.platform} is not supported on this host`
            : undefined,
      requiredTools: this.platform === 'web' ? ['chromium'] : ['node'],
      missingTools: this.missingTools,
      metadata: { mock: true },
    };
  }

  async initialize(options?: Record<string, any>): Promise<void> {
    this.initialized = true;
  }

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    this.actionsExecuted.push(action);
    if (action.type === 'custom' && action.value === 'fail') {
      return {
        success: false,
        durationMs: 15,
        error: 'Simulated custom action failure',
      };
    }
    return {
      success: true,
      durationMs: 10,
      output: { action: action.type, target: action.target },
    };
  }

  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    this.assertionsExecuted.push(assertion);

    if (this.assertionOverrides[assertion.type]) {
      const override = this.assertionOverrides[assertion.type];
      return {
        passed: override.passed,
        durationMs: 5,
        actual: override.actual ?? 'simulated-actual',
        expected: assertion.expected,
        message: override.message ?? (override.passed ? undefined : 'Simulated assertion failure'),
      };
    }

    // Default behavior: elementVisible with expected: false fails if not overridden
    if (assertion.type === 'elementVisible' && assertion.expected === false) {
      return {
        passed: false,
        actual: 'visible',
        expected: false,
        durationMs: 5,
        message: 'Expected element to be hidden, but it was visible.',
      };
    }

    return {
      passed: true,
      durationMs: 5,
      actual: assertion.expected,
      expected: assertion.expected,
    };
  }

  async captureEvidence(type: string, description: string = ''): Promise<EvidenceArtifact> {
    const rawContent = `MOCK_EVIDENCE_CONTENT_${Date.now()}`;
    const hash = crypto.createHash('sha256').update(rawContent).digest('hex');

    return {
      id: `ev-mock-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: (type as any) || 'SCREENSHOT',
      path: `/tmp/mock-evidence-${Date.now()}.txt`,
      sha256: hash,
      sizeBytes: rawContent.length,
      mimeType: type === 'SCREENSHOT' ? 'image/png' : 'text/plain',
      capturedAt: new Date().toISOString(),
      description,
      metadata: { rawContent },
    };
  }

  async teardown(): Promise<void> {
    this.initialized = false;
  }
}
