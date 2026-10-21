import { describe, it, expect, vi } from 'vitest';
import {
  PlatformAdapter,
  ActionResult,
} from '@agentic-qa/core';
import {
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
  CapabilityDescriptor,
  Platform,
  FindingSchema,
} from '@agentic-qa/schemas';
import {
  RapidInteractionRunner,
  MonkeyExplorer,
  BoundaryFuzzer,
  DEFAULT_FUZZ_PAYLOADS,
  SeededRandom,
} from '../index.js';

/**
 * Mock Platform Adapter for robustness testing.
 */
class MockRobustnessAdapter implements PlatformAdapter {
  readonly id = 'mock-robustness';
  readonly name = 'Mock Robustness Adapter';
  readonly platform: Platform = 'web';

  public buttonExists = true;
  public buttonEnabled = true;
  public buttonDisabledAfterFirstClick = true;
  public clicksReceived = 0;
  public failClicksWhenDisabled = true;
  public simulateHangOnProbe = false;
  public consoleErrors: string[] = [];
  public networkErrors: string[] = [];
  public currentState = '/home';
  public actionHistory: ActionSpec[] = [];

  async getCapability(): Promise<CapabilityDescriptor> {
    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: 'AVAILABLE',
      requiredTools: [],
      missingTools: [],
      metadata: {},
    };
  }

  async initialize(): Promise<void> {}

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    this.actionHistory.push(action);

    if (action.type === 'click') {
      this.clicksReceived++;
      // If button should be disabled after first click (the trigger action)
      if (this.buttonDisabledAfterFirstClick && this.clicksReceived >= 1) {
        this.buttonEnabled = false;
        if (this.clicksReceived > 1 && this.failClicksWhenDisabled) {
          return {
            success: false,
            durationMs: 1,
            error: 'Element is disabled and cannot be clicked',
          };
        }
      }
      return { success: true, durationMs: 1 };
    }

    if (action.type === 'rapidClicks') {
      const count = Number(action.value) || 500;
      this.clicksReceived += count;
      if (this.buttonDisabledAfterFirstClick) {
        this.buttonEnabled = false;
        return {
          success: true,
          durationMs: 10,
          output: {
            eventsIssued: count,
            eventsAccepted: 0,
            eventsRejected: count,
          },
        };
      }
      return {
        success: true,
        durationMs: 10,
        output: {
          eventsIssued: count,
          eventsAccepted: count,
          eventsRejected: 0,
        },
      };
    }

    if (action.type === 'fill' || action.type === 'clear' || action.type === 'type') {
      return { success: true, durationMs: 1 };
    }

    if (action.type === 'evaluate') {
      return { success: true, durationMs: 1, output: this.currentState };
    }

    return { success: true, durationMs: 1 };
  }

  async executeAssertion(assertion: AssertionSpec) {
    if (assertion.type === 'elementExists') {
      if (this.simulateHangOnProbe) {
        // Delay beyond hangThresholdMs (e.g. 200ms vs 50ms threshold)
        await new Promise((r) => setTimeout(r, 200));
      }
      return { passed: this.buttonExists, durationMs: 1 };
    }

    if (assertion.type === 'elementEnabled') {
      return { passed: this.buttonEnabled, durationMs: 1 };
    }

    if (assertion.type === 'elementDisabled') {
      return { passed: !this.buttonEnabled, durationMs: 1 };
    }

    if (assertion.type === 'consoleClean') {
      const hasErrors = this.consoleErrors.length > 0;
      return {
        passed: !hasErrors,
        durationMs: 1,
        message: hasErrors ? this.consoleErrors.join('; ') : undefined,
      };
    }

    if (assertion.type === 'noNetworkFailures') {
      const hasErrors = this.networkErrors.length > 0;
      return {
        passed: !hasErrors,
        durationMs: 1,
        message: hasErrors ? this.networkErrors.join('; ') : undefined,
      };
    }

    return { passed: true, durationMs: 1 };
  }

  async captureEvidence(type: string, description?: string): Promise<EvidenceArtifact> {
    return {
      id: `ev-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: 'SCREENSHOT',
      path: '/tmp/robustness-evidence.png',
      sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      sizeBytes: 2048,
      mimeType: 'image/png',
      capturedAt: new Date().toISOString(),
      description: description ?? 'Robustness test evidence screenshot',
      metadata: {},
    };
  }

  async teardown(): Promise<void> {}
}

// ============================================================================
// SEEDED RANDOM TESTS
// ============================================================================

describe('SeededRandom', () => {
  it('generates identical sequence given identical seed', () => {
    const rng1 = new SeededRandom(12345);
    const rng2 = new SeededRandom(12345);

    const seq1 = Array.from({ length: 10 }, () => rng1.next());
    const seq2 = Array.from({ length: 10 }, () => rng2.next());

    expect(seq1).toEqual(seq2);
  });

  it('generates different sequence given different seed', () => {
    const rng1 = new SeededRandom(111);
    const rng2 = new SeededRandom(999);

    const seq1 = Array.from({ length: 10 }, () => rng1.next());
    const seq2 = Array.from({ length: 10 }, () => rng2.next());

    expect(seq1).not.toEqual(seq2);
  });

  it('resets correctly to initial seed', () => {
    const rng = new SeededRandom(42);
    const firstRun = [rng.next(), rng.next(), rng.next()];

    rng.reset();
    const secondRun = [rng.next(), rng.next(), rng.next()];

    expect(firstRun).toEqual(secondRun);
  });

  it('picks elements uniformly and shuffles deterministically', () => {
    const rng = new SeededRandom(777);
    const items = ['alpha', 'beta', 'gamma', 'delta'];
    const picked = rng.pick(items);
    expect(items).toContain(picked);

    const shuffled = rng.shuffle(items);
    expect(shuffled).toHaveLength(items.length);
    expect(shuffled.sort()).toEqual([...items].sort());
  });

  it('calculates AWS Full Jitter backoff within bounds and deterministically', () => {
    const rng = new SeededRandom(42);
    const baseMs = 100;
    const capMs = 10000;

    for (let attempt = 0; attempt < 10; attempt++) {
      const backoff = rng.backoffWithFullJitter(attempt, baseMs, capMs);
      expect(backoff).toBeGreaterThanOrEqual(0);
      expect(backoff).toBeLessThanOrEqual(capMs);
      const expectedMax = Math.min(capMs, baseMs * Math.pow(2, attempt));
      expect(backoff).toBeLessThanOrEqual(expectedMax);
    }

    // Huge attempt should be capped at capMs
    const capped = rng.backoffWithFullJitter(50, 100, 2000);
    expect(capped).toBeLessThanOrEqual(2000);
    expect(capped).toBeGreaterThanOrEqual(0);

    // Negative attempt should be clamped safely
    const negative = rng.backoffWithFullJitter(-5, 100, 2000);
    expect(negative).toBeLessThanOrEqual(100);
    expect(negative).toBeGreaterThanOrEqual(0);
  });

  it('picks weighted elements proportionally and validates inputs', () => {
    const rng = new SeededRandom(12345);
    const items = [
      { item: 'rare', weight: 1 },
      { item: 'common', weight: 99 },
    ];

    const counts: Record<string, number> = { rare: 0, common: 0 };
    for (let i = 0; i < 500; i++) {
      const choice = rng.pickWeighted(items);
      counts[choice]++;
    }

    expect(counts.common).toBeGreaterThan(counts.rare * 10);

    expect(() => rng.pickWeighted([])).toThrow('Cannot pick from an empty array');
    expect(() =>
      rng.pickWeighted([
        { item: 'a', weight: 0 },
        { item: 'b', weight: -1 },
      ])
    ).toThrow('Total weight must be positive');
  });
});

// ============================================================================
// RAPID INTERACTION RUNNER TESTS
// ============================================================================

describe('RapidInteractionRunner', () => {
  it('passes when 500 rapid clicks are properly debounced and rejected', async () => {
    const adapter = new MockRobustnessAdapter();
    adapter.buttonDisabledAfterFirstClick = true;
    adapter.failClicksWhenDisabled = true;

    const runner = new RapidInteractionRunner(adapter);
    const result = await runner.run({
      targetButton: '#submit-order',
      rapidClickCount: 500,
      dispatchMode: 'burst',
      batchSize: 50,
      hangThresholdMs: 2000,
    });

    expect(result.passed).toBe(true);
    expect(result.eventsIssued).toBe(500);
    expect(result.eventsAccepted).toBe(0);
    expect(result.eventsRejected).toBe(500);
    expect(result.buttonDisabledAfterTrigger).toBe(true);
    expect(result.duplicateSubmissionsDetected).toBe(false);
    expect(result.uiHung).toBe(false);
    expect(result.finding).toBeUndefined();
  });

  it('detects debouncing failure when button accepts rapid duplicate clicks', async () => {
    const adapter = new MockRobustnessAdapter();
    // Simulate flawed button: stays enabled and accepts all clicks
    adapter.buttonDisabledAfterFirstClick = false;
    adapter.buttonEnabled = true;

    const runner = new RapidInteractionRunner(adapter);
    const result = await runner.run({
      targetButton: '#checkout-btn',
      rapidClickCount: 500,
      dispatchMode: 'burst',
      batchSize: 50,
      hangThresholdMs: 2000,
    });

    expect(result.passed).toBe(false);
    expect(result.eventsIssued).toBe(500);
    expect(result.eventsAccepted).toBe(500);
    expect(result.eventsRejected).toBe(0);
    expect(result.duplicateSubmissionsDetected).toBe(true);
    expect(result.duplicateCount).toBe(500);
    expect(result.finding).toBeDefined();

    // Verify finding adheres to FindingSchema
    const parsedFinding = FindingSchema.parse(result.finding);
    expect(parsedFinding.status).toBe('CONFIRMED');
    expect(parsedFinding.severity).toBe('CRITICAL');
    expect(parsedFinding.title).toContain('Debouncing failed');
    expect(parsedFinding.reproductionSteps.length).toBeGreaterThan(3);
    expect(parsedFinding.metadata.eventsAccepted).toBe(500);
  });

  it('detects UI hang during responsiveness probe', async () => {
    const adapter = new MockRobustnessAdapter();
    adapter.simulateHangOnProbe = true;

    const runner = new RapidInteractionRunner(adapter);
    const result = await runner.run({
      targetButton: '#heavy-action-btn',
      rapidClickCount: 50,
      hangThresholdMs: 50, // Short timeout to trigger hang quickly in test
    });

    expect(result.passed).toBe(false);
    expect(result.uiHung).toBe(true);
    expect(result.finding).toBeDefined();

    const parsedFinding = FindingSchema.parse(result.finding);
    expect(parsedFinding.status).toBe('CONFIRMED');
    expect(parsedFinding.severity).toBe('CRITICAL');
    expect(parsedFinding.title).toContain('UI hung');
  });

  it('detects unhandled console exceptions thrown during rapid interaction burst', async () => {
    const adapter = new MockRobustnessAdapter();
    adapter.consoleErrors = ['Uncaught TypeError: Cannot read property "id" of undefined'];

    const runner = new RapidInteractionRunner(adapter);
    const result = await runner.run({
      targetButton: '#submit-form',
      rapidClickCount: 100,
      hangThresholdMs: 2000,
    });

    expect(result.passed).toBe(false);
    expect(result.unhandledExceptions.length).toBeGreaterThan(0);
    expect(result.finding).toBeDefined();

    const parsedFinding = FindingSchema.parse(result.finding);
    expect(parsedFinding.status).toBe('CONFIRMED');
    expect(parsedFinding.actualBehavior).toContain('Cannot read property "id" of undefined');
  });

  it('handles non-existent target button with CONFIRMED finding', async () => {
    const adapter = new MockRobustnessAdapter();
    adapter.buttonExists = false;

    const runner = new RapidInteractionRunner(adapter);
    const result = await runner.run({
      targetButton: '#missing-btn',
    });

    expect(result.passed).toBe(false);
    expect(result.initialState.exists).toBe(false);
    expect(result.eventsIssued).toBe(0);
    expect(result.finding).toBeDefined();

    const parsedFinding = FindingSchema.parse(result.finding);
    expect(parsedFinding.status).toBe('CONFIRMED');
    expect(parsedFinding.severity).toBe('CRITICAL');
    expect(parsedFinding.title).toContain('Target button not found');
  });

  it('supports native rapidClicks dispatch mode', async () => {
    const adapter = new MockRobustnessAdapter();
    adapter.buttonDisabledAfterFirstClick = true;

    const runner = new RapidInteractionRunner(adapter);
    const result = await runner.run({
      targetButton: '#native-btn',
      rapidClickCount: 500,
      dispatchMode: 'native',
    });

    expect(result.passed).toBe(true);
    expect(result.eventsIssued).toBe(500);
    expect(result.eventsAccepted).toBe(0);
    expect(result.eventsRejected).toBe(500);
  });

  it('supports sequential dispatch mode with custom duplicate detector callback', async () => {
    const adapter = new MockRobustnessAdapter();
    adapter.buttonDisabledAfterFirstClick = true;

    const runner = new RapidInteractionRunner(adapter);
    let checkCalled = false;

    const result = await runner.run({
      targetButton: '#seq-btn',
      rapidClickCount: 20,
      dispatchMode: 'sequential',
      checkDuplicateSubmissions: async () => {
        checkCalled = true;
        return { duplicateDetected: false, count: 0 };
      },
    });

    expect(checkCalled).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.eventsIssued).toBe(20);
  });

  it('does not produce false positive debouncing failure when driver succeeds on disabled button', async () => {
    const adapter = new MockRobustnessAdapter();
    adapter.buttonDisabledAfterFirstClick = true;
    // Driver dispatch returns success: true even though button is disabled (e.g. Playwright force click / mobile pointer)
    adapter.failClicksWhenDisabled = false;

    const runner = new RapidInteractionRunner(adapter);
    const result = await runner.run({
      targetButton: '#submit-btn',
      rapidClickCount: 50,
      dispatchMode: 'burst',
      batchSize: 10,
    });

    // Should NOT falsely claim debouncing failed
    expect(result.passed).toBe(true);
    expect(result.buttonDisabledAfterTrigger).toBe(true);
    expect(result.duplicateSubmissionsDetected).toBe(false);
    expect(result.eventsRejected).toBe(50);
    expect(result.eventsAccepted).toBe(0);
    expect(result.finding).toBeUndefined();
  });

  it('checks UI responsiveness on body and does not false-hang if target button navigates away', async () => {
    const adapter = new MockRobustnessAdapter();
    adapter.buttonDisabledAfterFirstClick = true;

    // After click, target button disappears (e.g. navigation / unmounted form)
    const origAssertion = adapter.executeAssertion.bind(adapter);
    adapter.executeAssertion = async (assertion: AssertionSpec) => {
      if (assertion.type === 'elementExists' && assertion.target === '#navigating-btn') {
        // Target button is now gone
        return { passed: false, durationMs: 1 };
      }
      return origAssertion(assertion);
    };

    const runner = new RapidInteractionRunner(adapter);
    const result = await runner.run({
      targetButton: '#navigating-btn',
      rapidClickCount: 10,
    });

    expect(result.uiHung).toBe(false);
  });
});

// ============================================================================
// MONKEY EXPLORER TESTS
// ============================================================================

describe('MonkeyExplorer', () => {
  it('produces 100% reproducible execution trace given identical seed', async () => {
    const adapter1 = new MockRobustnessAdapter();
    const explorer1 = new MonkeyExplorer(adapter1);
    const res1 = await explorer1.run({
      maxActions: 20,
      seed: 9999,
      interactableSelectors: ['#btn1', '#btn2', '#input1', '#link1'],
    });

    const adapter2 = new MockRobustnessAdapter();
    const explorer2 = new MonkeyExplorer(adapter2);
    const res2 = await explorer2.run({
      maxActions: 20,
      seed: 9999,
      interactableSelectors: ['#btn1', '#btn2', '#input1', '#link1'],
    });

    expect(res1.totalActions).toBe(20);
    expect(res2.totalActions).toBe(20);

    const actions1 = res1.trace.map((s) => ({ type: s.action.type, target: s.action.target }));
    const actions2 = res2.trace.map((s) => ({ type: s.action.type, target: s.action.target }));
    expect(actions1).toEqual(actions2);
  });

  it('strictly respects maxActions bound', async () => {
    const adapter = new MockRobustnessAdapter();
    const explorer = new MonkeyExplorer(adapter);
    const result = await explorer.run({
      maxActions: 12,
      seed: 42,
    });

    expect(result.totalActions).toBe(12);
    expect(result.trace).toHaveLength(12);
  });

  it('strictly respects timeoutMs bound', async () => {
    const adapter = new MockRobustnessAdapter();
    // Simulate slow action
    const origExecute = adapter.executeAction.bind(adapter);
    adapter.executeAction = async (action: ActionSpec) => {
      await new Promise((r) => setTimeout(r, 60));
      return origExecute(action);
    };

    const explorer = new MonkeyExplorer(adapter);
    const result = await explorer.run({
      maxActions: 1000,
      timeoutMs: 150, // Should terminate well before 1000 actions
      seed: 42,
    });

    expect(result.totalActions).toBeLessThan(10);
    expect(result.durationMs).toBeGreaterThanOrEqual(100);
  });

  it('tracks visited states and state transitions accurately', async () => {
    const adapter = new MockRobustnessAdapter();
    let counter = 0;
    const states = ['/dashboard', '/settings', '/profile', '/billing'];

    const explorer = new MonkeyExplorer(adapter);
    const result = await explorer.run({
      maxActions: 15,
      seed: 42,
      stateExtractor: async () => {
        counter++;
        return states[counter % states.length];
      },
    });

    expect(result.visitedStates.length).toBeGreaterThan(1);
    expect(result.stateTransitionCount).toBeGreaterThan(0);
  });

  it('correctly records distinct stateBefore and stateAfter across transitions in trace', async () => {
    const adapter = new MockRobustnessAdapter();
    let counter = 0;
    const states = ['/login', '/dashboard', '/profile', '/settings'];

    const explorer = new MonkeyExplorer(adapter);
    const result = await explorer.run({
      maxActions: 6,
      seed: 42,
      stateExtractor: async () => {
        counter++;
        return states[counter % states.length];
      },
    });

    expect(result.stateTransitionCount).toBeGreaterThan(0);
    // Find steps where state transition happened
    const transitionSteps = result.trace.filter((s) => s.stateBefore !== s.stateAfter);
    expect(transitionSteps.length).toBeGreaterThan(0);
    for (const step of transitionSteps) {
      expect(step.stateBefore).not.toBe(step.stateAfter);
    }
  });

  it('disambiguates generic button selectors to avoid Playwright strict mode collisions', async () => {
    const adapter = new MockRobustnessAdapter();
    adapter.executeAction = async (action: ActionSpec) => {
      if (action.type === 'evaluate') {
        return {
          success: true,
          durationMs: 1,
          output: ['#btn-submit', '[data-testid="cancel-btn"]', 'button >> nth=2'],
        };
      }
      return { success: true, durationMs: 1 };
    };

    const explorer = new MonkeyExplorer(adapter);
    const disambiguated = await (explorer as any).resolveSpecificTarget('button', new SeededRandom(42));
    expect(['#btn-submit', '[data-testid="cancel-btn"]', 'button >> nth=2']).toContain(disambiguated);
  });

  it('catches console crash during exploration and creates CONFIRMED finding with trace', async () => {
    const adapter = new MockRobustnessAdapter();
    let stepCount = 0;

    // Trigger console error at step 5
    const origExecute = adapter.executeAction.bind(adapter);
    adapter.executeAction = async (action: ActionSpec) => {
      stepCount++;
      if (stepCount === 5) {
        adapter.consoleErrors = ['Uncaught ReferenceError: secretToken is not defined'];
      }
      return origExecute(action);
    };

    const explorer = new MonkeyExplorer(adapter);
    const result = await explorer.run({
      maxActions: 10,
      seed: 1234,
    });

    expect(result.passed).toBe(false);
    expect(result.errorsCaught.length).toBeGreaterThan(0);
    expect(result.findings.length).toBeGreaterThan(0);

    const finding = result.findings[0];
    const parsedFinding = FindingSchema.parse(finding);
    expect(parsedFinding.status).toBe('CONFIRMED');
    expect(parsedFinding.severity).toBe('HIGH');
    expect(parsedFinding.title).toContain('Application error during exploratory monkey test');
    expect(parsedFinding.actualBehavior).toContain('secretToken is not defined');
    expect(parsedFinding.metadata.seed).toBe(1234);
  });
});

// ============================================================================
// BOUNDARY FUZZER TESTS
// ============================================================================

describe('BoundaryFuzzer', () => {
  it('covers all 6 required categories in DEFAULT_FUZZ_PAYLOADS', () => {
    const categories = new Set(DEFAULT_FUZZ_PAYLOADS.map((p) => p.category));
    expect(categories.has('sql_injection')).toBe(true);
    expect(categories.has('xss')).toBe(true);
    expect(categories.has('unicode')).toBe(true);
    expect(categories.has('long_string')).toBe(true);
    expect(categories.has('numeric_boundary')).toBe(true);
    expect(categories.has('null_bytes')).toBe(true);

    // Verify 100KB string payload is present
    const long100kb = DEFAULT_FUZZ_PAYLOADS.find((p) => p.id === 'LONG-01');
    expect(long100kb).toBeDefined();
    expect(long100kb!.value.length).toBe(102400); // 100 KB
  });

  it('passes when inputs are handled gracefully with zero crashes', async () => {
    const adapter = new MockRobustnessAdapter();
    const fuzzer = new BoundaryFuzzer(adapter);

    const result = await fuzzer.run({
      targetInput: '#user-email',
      submitTarget: '#submit-btn',
      fuzzIterations: 10,
    });

    expect(result.passed).toBe(true);
    expect(result.totalTested).toBe(10);
    expect(result.passedCount).toBe(10);
    expect(result.failedCount).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it('detects unhandled 500 server crash on SQL injection payload', async () => {
    const adapter = new MockRobustnessAdapter();

    // Hook adapter to trigger 500 error when SQL injection payload is entered
    const origExecuteAction = adapter.executeAction.bind(adapter);
    adapter.executeAction = async (action: ActionSpec) => {
      if (action.type === 'fill' && typeof action.value === 'string' && action.value.includes("' OR '1'='1")) {
        adapter.networkErrors = ['HTTP 500 Internal Server Error: unhandled database syntax error'];
      }
      return origExecuteAction(action);
    };

    const fuzzer = new BoundaryFuzzer(adapter);
    const result = await fuzzer.run({
      targetInput: '#search-query',
      categories: ['sql_injection'],
      fuzzIterations: 3,
    });

    expect(result.passed).toBe(false);
    expect(result.failedCount).toBeGreaterThan(0);
    expect(result.findings.length).toBeGreaterThan(0);

    const finding = result.findings[0];
    const parsedFinding = FindingSchema.parse(finding);
    expect(parsedFinding.status).toBe('CONFIRMED');
    expect(parsedFinding.severity).toBe('CRITICAL');
    expect(parsedFinding.title).toContain('Unhandled failure on sql_injection payload');
    expect(parsedFinding.actualBehavior).toContain('500');
    expect(parsedFinding.reproductionSteps[1]).toContain("' OR '1'='1");
  });

  it('detects unhandled console crash on XSS payload', async () => {
    const adapter = new MockRobustnessAdapter();

    const origExecuteAction = adapter.executeAction.bind(adapter);
    adapter.executeAction = async (action: ActionSpec) => {
      if (action.type === 'fill' && typeof action.value === 'string' && action.value.includes('<script>')) {
        adapter.consoleErrors = ['Uncaught SyntaxError: Unexpected token <'];
      }
      return origExecuteAction(action);
    };

    const fuzzer = new BoundaryFuzzer(adapter);
    const result = await fuzzer.run({
      targetInput: '#comment-text',
      categories: ['xss'],
      fuzzIterations: 2,
    });

    expect(result.passed).toBe(false);
    expect(result.findings.length).toBeGreaterThan(0);

    const finding = result.findings[0];
    const parsedFinding = FindingSchema.parse(finding);
    expect(parsedFinding.status).toBe('CONFIRMED');
    expect(parsedFinding.title).toContain('Unhandled failure on xss payload');
  });

  it('tests 100KB long string payload without memory crashes', async () => {
    const adapter = new MockRobustnessAdapter();
    const fuzzer = new BoundaryFuzzer(adapter);

    const result = await fuzzer.run({
      targetInput: '#bio',
      categories: ['long_string'],
      fuzzIterations: 1,
    });

    expect(result.totalTested).toBe(1);
    expect(result.payloadResults[0].payload.id).toBe('LONG-01');
    expect(result.payloadResults[0].payload.value.length).toBe(102400);
    expect(result.passed).toBe(true);
  });

  it('supports custom payloads and custom validation callback', async () => {
    const adapter = new MockRobustnessAdapter();
    const fuzzer = new BoundaryFuzzer(adapter);

    const customPayload = {
      id: 'CUSTOM-01',
      name: 'Custom format string attack',
      category: 'null_bytes' as const,
      value: '%08x.%08x.%08x',
      description: 'Format string leak attempt',
    };

    const result = await fuzzer.run({
      targetInput: '#custom-field',
      customPayloads: [customPayload],
      fuzzIterations: 1,
      validateGracefulHandling: async (payload) => {
        if (payload.id === 'CUSTOM-01') {
          return { handledGracefully: false, reason: 'Custom rule rejected format specifiers' };
        }
        return { handledGracefully: true };
      },
    });

    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].description).toContain('Custom rule rejected format specifiers');
  });

  it('tests unicode category payloads including RTL and Zalgo', async () => {
    const adapter = new MockRobustnessAdapter();
    const fuzzer = new BoundaryFuzzer(adapter);

    const result = await fuzzer.run({
      targetInput: '#display-name',
      categories: ['unicode'],
    });

    expect(result.passed).toBe(true);
    expect(result.totalTested).toBeGreaterThanOrEqual(5);
    const zalgoResult = result.payloadResults.find((r) => r.payload.id === 'UNICODE-04');
    expect(zalgoResult).toBeDefined();
    expect(zalgoResult?.handledGracefully).toBe(true);
  });

  it('tests numeric_boundary category payloads including negative numbers', async () => {
    const adapter = new MockRobustnessAdapter();
    const fuzzer = new BoundaryFuzzer(adapter);

    const result = await fuzzer.run({
      targetInput: '#quantity',
      categories: ['numeric_boundary'],
    });

    expect(result.passed).toBe(true);
    expect(result.totalTested).toBeGreaterThanOrEqual(6);
    const negativeNum = result.payloadResults.find((r) => r.payload.id === 'NUM-01');
    expect(negativeNum).toBeDefined();
    expect(negativeNum?.payload.value).toBe('-1');
  });

  it('tests null_bytes category payloads including CRLF injection', async () => {
    const adapter = new MockRobustnessAdapter();
    const fuzzer = new BoundaryFuzzer(adapter);

    const result = await fuzzer.run({
      targetInput: '#header-field',
      categories: ['null_bytes'],
    });

    expect(result.passed).toBe(true);
    expect(result.totalTested).toBeGreaterThanOrEqual(5);
    const nullByte = result.payloadResults.find((r) => r.payload.id === 'NULL-01');
    expect(nullByte?.payload.value).toBe('\0');
  });

  it('supports custom submitAction and detects server crash on submit', async () => {
    const adapter = new MockRobustnessAdapter();
    adapter.executeAction = async (action: ActionSpec) => {
      if (action.type === 'click' && action.target === '#custom-submit') {
        adapter.networkErrors = ['500 Internal Server Error: unhandled database deadlock'];
      }
      return { success: true, durationMs: 1 };
    };

    const fuzzer = new BoundaryFuzzer(adapter);
    const result = await fuzzer.run({
      targetInput: '#order-notes',
      submitAction: {
        type: 'click',
        target: '#custom-submit',
        timeoutMs: 5000,
        metadata: {},
      },
      categories: ['sql_injection'],
      fuzzIterations: 1,
    });

    expect(result.passed).toBe(false);
    expect(result.failedCount).toBe(1);
    expect(result.findings[0].severity).toBe('CRITICAL');
  });

  it('covers path traversal, command injection, prototype pollution, control codes, and float boundaries', () => {
    const payloads = DEFAULT_FUZZ_PAYLOADS;

    // Path traversal
    const pathTraversal = payloads.find((p) => p.value.includes('../../../../etc/passwd'));
    expect(pathTraversal).toBeDefined();

    // Command injection
    const cmdInjection = payloads.find((p) => p.value === '| id');
    expect(cmdInjection).toBeDefined();

    // Prototype pollution
    const protoPollution = payloads.find((p) => p.value === '__proto__');
    expect(protoPollution).toBeDefined();

    // C0/C1 control codes
    const nullByte = payloads.find((p) => p.value === '\x00');
    expect(nullByte).toBeDefined();
    const ansiCode = payloads.find((p) => p.value === '\x1b[31m');
    expect(ansiCode).toBeDefined();
    const delCode = payloads.find((p) => p.value === '\x7f');
    expect(delCode).toBeDefined();

    // IEEE 754 float boundaries
    const posInf = payloads.find((p) => p.value === 'Infinity');
    expect(posInf).toBeDefined();
    const negInf = payloads.find((p) => p.value === '-Infinity');
    expect(negInf).toBeDefined();
    const subnormal = payloads.find((p) => p.value === '5e-324');
    expect(subnormal).toBeDefined();
  });

  it('uses pasteText instead of fill for payloads > 1000 characters', async () => {
    const adapter = new MockRobustnessAdapter();
    const actionsSeen: ActionSpec[] = [];
    adapter.executeAction = async (action: ActionSpec) => {
      actionsSeen.push(action);
      return { success: true, durationMs: 1 };
    };

    const fuzzer = new BoundaryFuzzer(adapter);
    await fuzzer.run({
      targetInput: '#bio',
      categories: ['long_string'],
      fuzzIterations: 1, // LONG-01 is 100KB > 1000 chars
    });

    const injectAction = actionsSeen.find(
      (a) => a.target === '#bio' && (a.type === 'pasteText' || a.type === 'fill')
    );
    expect(injectAction).toBeDefined();
    expect(injectAction?.type).toBe('pasteText');
  });

  it('execute5000CharStressTest uses pasteText and noSilentTruncation without brittle text matching', async () => {
    const adapter = new MockRobustnessAdapter();
    const assertionsRun: AssertionSpec[] = [];
    adapter.executeAssertion = async (assertion: AssertionSpec) => {
      assertionsRun.push(assertion);
      return { passed: true, durationMs: 1 };
    };

    const fuzzer = new BoundaryFuzzer(adapter);
    const res = await fuzzer.execute5000CharStressTest({
      targetInput: '#long-text',
      expectedMaxLength: 100,
      charCount: 5000,
    });

    expect(res.passed).toBe(true);
    // Verified noSilentTruncation assertion was checked
    const truncationAssertion = assertionsRun.find((a) => a.type === 'noSilentTruncation');
    expect(truncationAssertion).toBeDefined();
    expect(truncationAssertion?.target).toBe('#long-text');
    // Verified no brittle 'too long' substring check on body
    const brittleCheck = assertionsRun.find((a) => a.expected === 'too long');
    expect(brittleCheck).toBeUndefined();
  });
});

// ============================================================================
// EDGE CASES & INTEGRATION TESTS
// ============================================================================

describe('Robustness Engine Edge Cases & Integration', () => {
  it('RapidInteractionRunner flags failure when button fails to disable after trigger', async () => {
    const adapter = new MockRobustnessAdapter();
    // Button stays enabled after trigger, but rejects clicks later
    adapter.buttonDisabledAfterFirstClick = false;
    adapter.buttonEnabled = true;

    const runner = new RapidInteractionRunner(adapter);
    const result = await runner.run({
      targetButton: '#broken-button',
      rapidClickCount: 10,
    });

    expect(result.buttonDisabledAfterTrigger).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.finding).toBeDefined();
    expect(result.finding?.title).toContain('Debouncing failed');
  });

  it('RapidInteractionRunner respects custom triggerAction', async () => {
    const adapter = new MockRobustnessAdapter();
    adapter.buttonDisabledAfterFirstClick = true;

    const runner = new RapidInteractionRunner(adapter);
    const result = await runner.run({
      targetButton: '#pay-now',
      rapidClickCount: 10,
      triggerAction: {
        type: 'pressKey',
        target: '#pay-now',
        value: 'Enter',
        timeoutMs: 3000,
        metadata: {},
      },
    });

    expect(result.eventsIssued).toBe(10);
    expect(adapter.actionHistory[0].type).toBe('pressKey');
  });

  it('MonkeyExplorer calls onStep callback and exercises various action types', async () => {
    const adapter = new MockRobustnessAdapter();
    const explorer = new MonkeyExplorer(adapter);
    const stepLogs: number[] = [];

    const result = await explorer.run({
      maxActions: 25,
      seed: 42,
      interactableSelectors: ['input#name', 'button#save', 'a#link'],
      allowedActions: ['click', 'fill', 'scroll', 'hover', 'pressKey', 'wait'],
      onStep: (step) => {
        stepLogs.push(step.stepNumber);
      },
    });

    expect(result.totalActions).toBe(25);
    expect(stepLogs).toHaveLength(25);
    expect(stepLogs[0]).toBe(1);
    expect(stepLogs[24]).toBe(25);

    const actionTypes = new Set(result.trace.map((s) => s.action.type));
    expect(actionTypes.size).toBeGreaterThan(1);
  });

  it('MonkeyExplorer handles empty interactable list with fallback target', async () => {
    const adapter = new MockRobustnessAdapter();
    const explorer = new MonkeyExplorer(adapter);

    const result = await explorer.run({
      maxActions: 5,
      interactableSelectors: [],
    });

    expect(result.totalActions).toBe(5);
    expect(result.trace.every((t) => t.action.target === 'body' || t.action.type === 'wait')).toBe(true);
  });

  it('supports 5000-character input stress testing and detects crashes/overflows', async () => {
    const adapter = new MockRobustnessAdapter();
    const fuzzer = new BoundaryFuzzer(adapter);

    // Clean pass
    const cleanRes = await fuzzer.execute5000CharStressTest({
      targetInput: '#comment',
      charCount: 5000,
    });
    expect(cleanRes.passed).toBe(true);
    expect(cleanRes.charCount).toBe(5000);
    expect(cleanRes.finding).toBeUndefined();

    // Defect detection when console crash occurs
    const buggyAdapter = new MockRobustnessAdapter();
    buggyAdapter.consoleErrors = ['Uncaught RangeError: Maximum call stack size exceeded in layout tree'];
    const buggyFuzzer = new BoundaryFuzzer(buggyAdapter);
    const failRes = await buggyFuzzer.execute5000CharStressTest({
      targetInput: '#comment',
      charCount: 5000,
      submitTarget: '#submit',
    });
    expect(failRes.passed).toBe(false);
    expect(failRes.uiCrashed).toBe(true);
    expect(failRes.finding).toBeDefined();
    expect(failRes.finding?.severity).toBe('CRITICAL');
    expect(() => FindingSchema.parse(failRes.finding)).not.toThrow();
  });

  it('all findings generated across engines strictly satisfy FindingSchema', async () => {
    // 1. Rapid interaction finding
    const adapter1 = new MockRobustnessAdapter();
    adapter1.buttonDisabledAfterFirstClick = false;
    const runner = new RapidInteractionRunner(adapter1);
    const rapidRes = await runner.run({ targetButton: '#btn', rapidClickCount: 10 });
    expect(rapidRes.finding).toBeDefined();
    expect(() => FindingSchema.parse(rapidRes.finding)).not.toThrow();

    // 2. Monkey explorer finding
    const adapter2 = new MockRobustnessAdapter();
    adapter2.consoleErrors = ['Uncaught TypeError: test error'];
    const explorer = new MonkeyExplorer(adapter2);
    const monkeyRes = await explorer.run({ maxActions: 2 });
    expect(monkeyRes.findings.length).toBeGreaterThan(0);
    expect(() => FindingSchema.parse(monkeyRes.findings[0])).not.toThrow();

    // 3. Boundary fuzzer finding
    const adapter3 = new MockRobustnessAdapter();
    adapter3.networkErrors = ['500 Server Error'];
    const fuzzer = new BoundaryFuzzer(adapter3);
    const fuzzerRes = await fuzzer.run({ targetInput: '#input', fuzzIterations: 1 });
    expect(fuzzerRes.findings.length).toBeGreaterThan(0);
    expect(() => FindingSchema.parse(fuzzerRes.findings[0])).not.toThrow();
  });
});

