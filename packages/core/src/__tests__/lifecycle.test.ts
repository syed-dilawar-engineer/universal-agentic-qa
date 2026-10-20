import { describe, it, expect } from 'vitest';
import {
  CapabilityRegistry,
  RunLifecycle,
  PlatformAdapter,
  QABlockedError,
  QAUnsupportedError,
} from '../index.js';
import {
  Platform,
  CapabilityDescriptor,
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
  TestPlan,
} from '@agentic-qa/schemas';

class MockWebAdapter implements PlatformAdapter {
  readonly id = 'mock-web';
  readonly name = 'Mock Web Adapter';
  readonly platform: Platform = 'web';

  constructor(private state: 'AVAILABLE' | 'BLOCKED' | 'UNSUPPORTED' = 'AVAILABLE') {}

  async getCapability(): Promise<CapabilityDescriptor> {
    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: this.state,
      reason: this.state === 'BLOCKED' ? 'Missing chromium binary' : undefined,
      requiredTools: ['chromium'],
      missingTools: this.state === 'BLOCKED' ? ['chromium'] : [],
      metadata: {},
    };
  }

  async initialize(): Promise<void> {}
  async executeAction(action: ActionSpec) {
    return { success: true, durationMs: 10 };
  }
  async executeAssertion(assertion: AssertionSpec) {
    if (assertion.type === 'elementVisible' && assertion.expected === false) {
      return { passed: false, durationMs: 5, actual: 'visible', message: 'Element was visible' };
    }
    return { passed: true, durationMs: 5 };
  }
  async captureEvidence(type: string): Promise<EvidenceArtifact> {
    return {
      id: `ev-${Date.now()}`,
      type: 'SCREENSHOT',
      path: '/tmp/test.png',
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sizeBytes: 1024,
      mimeType: 'image/png',
      capturedAt: new Date().toISOString(),
      description: 'test screenshot',
      metadata: {},
    };
  }
  async teardown(): Promise<void> {}
}

describe('CapabilityRegistry', () => {
  it('registers and resolves available adapters', async () => {
    const registry = new CapabilityRegistry();
    const adapter = new MockWebAdapter('AVAILABLE');
    registry.registerAdapter(adapter);

    const caps = await registry.probeAllCapabilities();
    expect(caps).toHaveLength(1);
    expect(caps[0].state).toBe('AVAILABLE');

    const resolved = await registry.resolveAdapterForTarget('web');
    expect(resolved.id).toBe('mock-web');
  });

  it('throws QAUnsupportedError when no adapter exists for platform', async () => {
    const registry = new CapabilityRegistry();
    await expect(registry.resolveAdapterForTarget('game')).rejects.toThrow(
      QAUnsupportedError
    );
  });
});

describe('RunLifecycle', () => {
  const plan: TestPlan = {
    planId: 'plan-1',
    name: 'Sample Web Test',
    targetApp: 'https://example.com',
    platform: 'web',
    environment: 'local',
    createdAt: new Date().toISOString(),
    metadata: {},
    scenarios: [
      {
        id: 'test-1',
        title: 'Check button click',
        description: 'Clicks button and verifies visibility',
        platform: 'web',
        timeoutMs: 5000,
        retries: 0,
        tags: ['smoke'],
        expectedOutcome: 'PASS',
        steps: [
          {
            id: 'step-1',
            description: 'Click button',
            action: { type: 'click', target: '#btn', timeoutMs: 1000, metadata: {} },
            continueOnFailure: false,
          },
          {
            id: 'step-2',
            description: 'Check element hidden',
            assertion: { type: 'elementVisible', expected: false, critical: true, metadata: {} },
            continueOnFailure: false,
          },
        ],
      },
    ],
  };

  it('blocks execution truthfully when adapter capability is BLOCKED', async () => {
    const blockedAdapter = new MockWebAdapter('BLOCKED');
    const caps = [await blockedAdapter.getCapability()];
    const lifecycle = new RunLifecycle(blockedAdapter, plan, caps);

    await expect(lifecycle.execute()).rejects.toThrow(QABlockedError);
  });

  it('executes test, captures failure assertion and produces finding with evidence', async () => {
    const availableAdapter = new MockWebAdapter('AVAILABLE');
    const caps = [await availableAdapter.getCapability()];
    const lifecycle = new RunLifecycle(availableAdapter, plan, caps);

    const report = await lifecycle.execute();
    expect(report.overallStatus).toBe('FAILED');
    expect(report.summary.failed).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].severity).toBe('HIGH');
    expect(report.findings[0].status).toBe('CONFIRMED');
    expect(report.evidence).toHaveLength(1);
  });
});
