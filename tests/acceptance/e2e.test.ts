import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  TestPlan,
  TestCase,
  Finding,
  EvidenceArtifact,
} from '../../packages/schemas/src/index.js';
import {
  RunLifecycle,
  CapabilityRegistry,
  QABlockedError,
  QAUnsupportedError,
} from '../../packages/core/src/index.js';
import { startFixtureServer } from '../../fixtures/demo-app/server.js';
import { FixtureWebAdapter } from './fixture-adapter.js';
import { executeFixVerification } from './verify-fix.js';

describe('End-to-End Acceptance Test Suite', () => {
  let unfixedServer: { server: any; url: string; close: () => Promise<void> };
  let fixedServer: { server: any; url: string; close: () => Promise<void> };

  beforeAll(async () => {
    // Spin up real HTTP servers for both defective and fixed fixture apps
    unfixedServer = await startFixtureServer({ fixDefects: false });
    fixedServer = await startFixtureServer({ fixDefects: true });
  });

  afterAll(async () => {
    await unfixedServer.close();
    await fixedServer.close();
  });

  /**
   * Helper to construct the standard 4-defect test plan
   */
  function buildAcceptancePlan(targetUrl: string): TestPlan {
    const raceConditionScenario: TestCase = {
      id: 'TC-001-RACE-CONDITION',
      title: 'Rapid Submission Button Race Condition',
      description: 'Asserts that rapid clicks do not generate duplicate submissions (Bug 1)',
      platform: 'web',
      expectedOutcome: 'PASS',
      timeoutMs: 10000,
      retries: 0,
      tags: ['concurrency', 'race-condition'],
      steps: [
        {
          id: 'step-nav-1',
          description: 'Navigate to target application',
          action: { type: 'navigate', value: targetUrl, metadata: {} },
          continueOnFailure: false,
        },
        {
          id: 'step-click-rapid',
          description: 'Perform rapid clicks on checkout button',
          action: { type: 'rapidClicks', target: '#submit-btn', value: { count: 5 }, metadata: {} },
          continueOnFailure: false,
        },
        {
          id: 'step-assert-single-submission',
          description: 'Verify submissions count equals exactly 1',
          assertion: {
            type: 'elementTextEquals',
            target: '#submission-count',
            expected: 'Submissions: 1',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
      ],
    };

    const responsiveOverflowScenario: TestCase = {
      id: 'TC-002-RESPONSIVE-OVERFLOW',
      title: 'Mobile Viewport Responsive Overflow',
      description: 'Asserts that layout does not overflow horizontally on width < 380px (Bug 2)',
      platform: 'web',
      viewport: { width: 375, height: 667 },
      expectedOutcome: 'PASS',
      timeoutMs: 10000,
      retries: 0,
      tags: ['responsive', 'mobile', 'layout'],
      steps: [
        {
          id: 'step-nav-mobile',
          description: 'Navigate with mobile viewport (375x667)',
          action: {
            type: 'navigate',
            value: targetUrl,
            metadata: { viewport: { width: 375, height: 667 } },
          },
          continueOnFailure: false,
        },
        {
          id: 'step-assert-no-overflow',
          description: 'Verify #overflow-container fits within mobile viewport width',
          assertion: {
            type: 'custom',
            target: '#overflow-container',
            expected: '<= 375px',
            critical: true,
            metadata: { maxScrollWidth: 375 },
          },
          continueOnFailure: false,
        },
      ],
    };

    const unhandledConsoleErrorScenario: TestCase = {
      id: 'TC-003-CONSOLE-ERROR',
      title: 'Unhandled Console Error on Action Click',
      description: 'Asserts that clicking broken action button does not throw unhandled error (Bug 3)',
      platform: 'web',
      expectedOutcome: 'PASS',
      timeoutMs: 10000,
      retries: 0,
      tags: ['stability', 'console'],
      steps: [
        {
          id: 'step-nav-console',
          description: 'Navigate to target application',
          action: { type: 'navigate', value: targetUrl, metadata: {} },
          continueOnFailure: false,
        },
        {
          id: 'step-click-broken',
          description: 'Click broken action button',
          action: { type: 'click', target: '#broken-action-btn', metadata: {} },
          continueOnFailure: false,
        },
        {
          id: 'step-assert-console-clean',
          description: 'Verify console error log is clean with zero unhandled exceptions',
          assertion: {
            type: 'consoleClean',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
      ],
    };

    const accessibilityScenario: TestCase = {
      id: 'TC-004-ACCESSIBILITY-ICON',
      title: 'Icon Button Accessible Name',
      description: 'Asserts that visual icon button has accessible aria-label or title (Bug 4)',
      platform: 'web',
      expectedOutcome: 'PASS',
      timeoutMs: 10000,
      retries: 0,
      tags: ['a11y', 'wcag21aa'],
      steps: [
        {
          id: 'step-nav-a11y',
          description: 'Navigate to target application',
          action: { type: 'navigate', value: targetUrl, metadata: {} },
          continueOnFailure: false,
        },
        {
          id: 'step-assert-a11y-name',
          description: 'Verify button #icon-search-btn has accessible name per WCAG 2.1 AA 4.1.2',
          assertion: {
            type: 'noAccessibilityViolations',
            target: '#icon-search-btn',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
      ],
    };

    return {
      planId: `acceptance-plan-${Date.now()}`,
      name: 'Fixture App End-to-End Acceptance Plan',
      targetApp: targetUrl,
      platform: 'web',
      environment: 'acceptance',
      createdAt: new Date().toISOString(),
      metadata: {},
      scenarios: [
        raceConditionScenario,
        responsiveOverflowScenario,
        unhandledConsoleErrorScenario,
        accessibilityScenario,
      ],
    };
  }

  // ==========================================================================
  // TEST 1: Run testing against unfixed fixture app -> Assert failures are detected,
  //         findings generated, status FAILED.
  // ==========================================================================
  it('Test 1: truthfully detects deliberate failures on unfixed app, generating findings with evidence', async () => {
    const adapter = new FixtureWebAdapter({ id: 'unfixed-test-adapter' });
    const plan = buildAcceptancePlan(unfixedServer.url);
    const caps = [await adapter.getCapability()];

    const lifecycle = new RunLifecycle(adapter, plan, caps);
    const report = await lifecycle.execute();

    // 1. Overall status must be FAILED
    expect(report.overallStatus).toBe('FAILED');

    // 2. Summary must accurately reflect failed tests
    expect(report.summary.totalTests).toBe(4);
    expect(report.summary.failed).toBe(4);
    expect(report.summary.passed).toBe(0);

    // 3. Findings must be generated for all failures
    expect(report.findings).toHaveLength(4);

    // Verify finding structures conform strictly to schemas
    for (const finding of report.findings) {
      expect(finding.id).toMatch(/^FIND-/);
      expect(finding.severity).toBe('HIGH');
      expect(finding.status).toBe('CONFIRMED');
      expect(finding.fixVerification).toBe('UNVERIFIED');
      expect(finding.evidenceIds.length).toBeGreaterThan(0);
      expect(finding.reproductionSteps.length).toBeGreaterThan(0);
    }

    // Verify individual defect finding descriptions
    const raceFinding = report.findings.find((f) => f.title.includes('elementTextEquals'));
    expect(raceFinding).toBeDefined();
    expect(raceFinding?.actualBehavior).toContain('Submissions: 5');

    const overflowFinding = report.findings.find((f) => f.title.includes('custom'));
    expect(overflowFinding).toBeDefined();
    expect(overflowFinding?.actualBehavior).toContain('420px');

    const consoleFinding = report.findings.find((f) => f.title.includes('consoleClean'));
    expect(consoleFinding).toBeDefined();
    expect(consoleFinding?.actualBehavior).toContain('invokeCrashHandler');

    const a11yFinding = report.findings.find((f) => f.title.includes('noAccessibilityViolations'));
    expect(a11yFinding).toBeDefined();
    expect(a11yFinding?.description).toContain('Accessibility violation');

    // 4. Evidence artifacts must be captured and cryptographically valid
    expect(report.evidence.length).toBeGreaterThanOrEqual(4);
    for (const ev of report.evidence) {
      expect(ev.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(ev.sizeBytes).toBeGreaterThan(0);
      expect(ev.capturedAt).toBeDefined();
    }
  });

  // ==========================================================================
  // TEST 2: Run testing against fixed fixture app (FIX_DEFECTS=true) ->
  //         Assert all pass, status PASSED.
  // ==========================================================================
  it('Test 2: truthfully reports status PASSED with zero findings when FIX_DEFECTS=true', async () => {
    const adapter = new FixtureWebAdapter({ id: 'fixed-test-adapter' });
    const plan = buildAcceptancePlan(fixedServer.url);
    const caps = [await adapter.getCapability()];

    const lifecycle = new RunLifecycle(adapter, plan, caps);
    const report = await lifecycle.execute();

    // 1. Overall status must be PASSED
    expect(report.overallStatus).toBe('PASSED');

    // 2. Summary must show 100% pass rate
    expect(report.summary.totalTests).toBe(4);
    expect(report.summary.passed).toBe(4);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.blocked).toBe(0);
    expect(report.summary.error).toBe(0);

    // 3. Zero findings generated
    expect(report.findings).toHaveLength(0);

    // 4. Trust score must be high and unpenalized
    expect(report.trustScore.score).toBeGreaterThanOrEqual(70);
    expect(report.trustScore.honestyPenalty).toBe(0);
  });

  // ==========================================================================
  // TEST 3: Fix verification test (qa verify-fix logic) ->
  //         Assert defect transitions to FIX_VERIFIED.
  // ==========================================================================
  it('Test 3: executes fix verification logic and transitions finding to FIX_VERIFIED', async () => {
    // Step A: Produce an initial confirmed defect finding from unfixed app
    const unfixedAdapter = new FixtureWebAdapter({ id: 'verify-unfixed-adapter' });
    const unfixedPlan = buildAcceptancePlan(unfixedServer.url);
    const unfixedCaps = [await unfixedAdapter.getCapability()];

    const initialLifecycle = new RunLifecycle(unfixedAdapter, unfixedPlan, unfixedCaps);
    const initialReport = await initialLifecycle.execute();
    expect(initialReport.overallStatus).toBe('FAILED');

    const confirmedFinding: Finding = initialReport.findings[0];
    expect(confirmedFinding.status).toBe('CONFIRMED');
    expect(confirmedFinding.fixVerification).toBe('UNVERIFIED');
    expect(confirmedFinding.verifiedAt).toBeUndefined();

    // Step B: Run fix verification against the FIXED app server
    const fixedAdapter = new FixtureWebAdapter({ id: 'verify-fixed-adapter' });
    const verifyResult = await executeFixVerification({
      finding: confirmedFinding,
      targetAppUrl: fixedServer.url,
      adapter: fixedAdapter,
    });

    // Step C: Assert verification succeeded and status transitioned
    expect(verifyResult.verified).toBe(true);
    expect(verifyResult.previousStatus).toBe('CONFIRMED');
    expect(verifyResult.newStatus).toBe('FIX_VERIFIED');
    expect(verifyResult.fixVerification).toBe('VERIFIED');
    expect(verifyResult.message).toContain('successfully verified as fixed');

    // Assert the finding object itself was updated
    expect(confirmedFinding.status).toBe('FIX_VERIFIED');
    expect(confirmedFinding.fixVerification).toBe('VERIFIED');
    expect(confirmedFinding.verifiedAt).toBeDefined();

    // Step D: Negative test - assert fix verification honestly fails if tested against unfixed app
    const stillBrokenFinding: Finding = {
      ...confirmedFinding,
      status: 'CONFIRMED',
      fixVerification: 'UNVERIFIED',
      verifiedAt: undefined,
    };
    const failedVerifyResult = await executeFixVerification({
      finding: stillBrokenFinding,
      targetAppUrl: unfixedServer.url,
      adapter: unfixedAdapter,
    });

    expect(failedVerifyResult.verified).toBe(false);
    expect(failedVerifyResult.newStatus).toBe('FIX_FAILED');
    expect(failedVerifyResult.fixVerification).toBe('FAILED');
    expect(stillBrokenFinding.status).toBe('FIX_FAILED');
  });

  // ==========================================================================
  // TEST 4: Blocked platform test -> Assert that requesting an unsupported/blocked
  //         capability truthfully returns BLOCKED, not PASSED.
  // ==========================================================================
  it('Test 4: truthfully blocks execution and rejects spoofed PASS when capability is BLOCKED', async () => {
    const blockedAdapter = new FixtureWebAdapter({
      id: 'blocked-mobile-sim',
      name: 'Blocked Mobile Driver Adapter',
      capabilityState: 'BLOCKED',
      missingTools: ['adb', 'emulator', 'android-sdk'],
      blockReason: 'Mandatory Android SDK and ADB binaries missing on host system',
    });

    const cap = await blockedAdapter.getCapability();
    expect(cap.state).toBe('BLOCKED');
    expect(cap.missingTools).toEqual(['adb', 'emulator', 'android-sdk']);
    expect(cap.reason).toContain('Android SDK');

    // 1. Capability registry truthful probe test
    const registry = new CapabilityRegistry();
    registry.registerAdapter(blockedAdapter);

    const probedCaps = await registry.probeAllCapabilities();
    expect(probedCaps).toHaveLength(1);
    expect(probedCaps[0].state).toBe('BLOCKED');
    expect(probedCaps[0].missingTools).toContain('adb');

    // 2. Lifecycle execution blocked test
    const plan: TestPlan = {
      planId: 'plan-blocked-test',
      name: 'Blocked Platform Test',
      targetApp: 'com.example.mobileapp',
      platform: 'web',
      environment: 'local',
      createdAt: new Date().toISOString(),
      metadata: {},
      scenarios: [
        {
          id: 'test-blocked-step',
          title: 'Attempt action on blocked environment',
          description: 'Attempts execution on blocked adapter',
          platform: 'web',
          timeoutMs: 5000,
          retries: 0,
          tags: ['blocked'],
          expectedOutcome: 'PASS',
          steps: [
            {
              id: 'step-1',
              description: 'Launch application',
              action: { type: 'navigate', value: 'com.example.app', metadata: {} },
              continueOnFailure: false,
            },
          ],
        },
      ],
    };

    const lifecycle = new RunLifecycle(blockedAdapter, plan, [cap]);

    // Must throw QABlockedError immediately without attempting mock actions
    await expect(lifecycle.execute()).rejects.toThrow(QABlockedError);

    // Verify error properties
    try {
      await lifecycle.execute();
      expect.fail('Expected execution to throw QABlockedError, but it succeeded');
    } catch (err: any) {
      expect(err).toBeInstanceOf(QABlockedError);
      expect(err.name).toBe('QABlockedError');
      expect(err.code).toBe('QA_BLOCKED');
      expect(err.missingRequirement).toContain('adb');
      expect(err.message).toContain('Execution blocked: adapter Blocked Mobile Driver Adapter is BLOCKED');
    }

    // 3. Verify registry throws QAUnsupportedError when requesting platform with no adapter
    await expect(registry.resolveAdapterForTarget('game')).rejects.toThrow(
      QAUnsupportedError
    );
  });

  // ==========================================================================
  // EDGE CASE TESTS: Empty plans, Evidence hashing, and Platform bounds
  // ==========================================================================
  describe('Edge Cases and Boundary Conditions', () => {
    it('honestly handles empty scenarios test plan with zero trust score', async () => {
      const adapter = new FixtureWebAdapter({ id: 'empty-test-adapter' });
      const emptyPlan: TestPlan = {
        planId: 'plan-empty',
        name: 'Empty Acceptance Plan',
        targetApp: fixedServer.url,
        platform: 'web',
        environment: 'acceptance',
        createdAt: new Date().toISOString(),
        metadata: {},
        scenarios: [],
      };
      const caps = [await adapter.getCapability()];

      const lifecycle = new RunLifecycle(adapter, emptyPlan, caps);
      const report = await lifecycle.execute();

      expect(report.overallStatus).toBe('PASSED');
      expect(report.summary.totalTests).toBe(0);
      expect(report.summary.passed).toBe(0);
      expect(report.trustScore.score).toBe(0);
      expect(report.trustScore.summary).toContain('Evaluated 0 tests');
    });

    it('verifies evidence artifact cryptographic integrity on assertion failure', async () => {
      const adapter = new FixtureWebAdapter({ id: 'evidence-crypto-adapter' });
      await adapter.initialize({ url: unfixedServer.url });

      const artifact = await adapter.captureEvidence(
        'SCREENSHOT',
        'Cryptographic audit snapshot'
      );

      expect(artifact.sha256).toBeDefined();
      expect(artifact.sha256).toHaveLength(64);
      expect(artifact.sizeBytes).toBeGreaterThan(0);
      expect(artifact.mimeType).toBe('image/png');
      expect(Date.parse(artifact.capturedAt)).not.toBeNaN();
    });
  });
});

