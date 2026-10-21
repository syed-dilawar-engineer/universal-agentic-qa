import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
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
  redactSecrets,
} from '../../packages/core/src/index.js';
import { WebAdapter } from '../../packages/adapters/web/src/index.js';
import { startFixtureServer } from '../../fixtures/demo-app/server.js';
import { executeFixVerification } from './verify-fix.js';
import { FixtureWebAdapter } from './fixture-adapter.js';

describe('End-to-End Acceptance Test Suite (Real Playwright Browser Automation)', () => {
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
      timeoutMs: 15000,
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
      timeoutMs: 15000,
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
      timeoutMs: 15000,
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
      timeoutMs: 15000,
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
      name: 'Fixture App Real-Browser Acceptance Plan',
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
  // TEST 1: Real Browser run against defective fixture app ->
  //         Assert all 4 deliberate failures are TRUTHFULLY detected with evidence on disk.
  // ==========================================================================
  it('Test 1: truthfully detects deliberate failures on unfixed app using real Playwright browser', async () => {
    const adapter = new WebAdapter({ id: 'real-unfixed-adapter', headless: true });
    const cap = await adapter.getCapability();
    expect(cap.state).toBe('AVAILABLE');

    const plan = buildAcceptancePlan(unfixedServer.url);
    const lifecycle = new RunLifecycle(adapter, plan, [cap]);
    const report = await lifecycle.execute();

    // 1. Overall status must be FAILED
    expect(report.overallStatus).toBe('FAILED');

    // 2. Summary must accurately reflect 4 failed tests
    expect(report.summary.totalTests).toBe(4);
    expect(report.summary.failed).toBe(4);
    expect(report.summary.passed).toBe(0);

    // 3. Findings must be generated for all 4 failures
    expect(report.findings).toHaveLength(4);

    for (const finding of report.findings) {
      expect(finding.id).toMatch(/^FIND-/);
      expect(finding.severity).toBe('HIGH');
      expect(finding.status).toBe('CONFIRMED');
      expect(finding.fixVerification).toBe('UNVERIFIED');
      expect(finding.evidenceIds.length).toBeGreaterThan(0);
      expect(finding.reproductionSteps.length).toBeGreaterThan(0);
    }

    // Bug 1: Race condition detected
    const raceFinding = report.findings.find((f) => f.title.includes('elementTextEquals'));
    expect(raceFinding).toBeDefined();
    expect(raceFinding?.actualBehavior).toContain('Submissions: 5');

    // Bug 2: Horizontal overflow detected
    const overflowFinding = report.findings.find((f) => f.title.includes('custom'));
    expect(overflowFinding).toBeDefined();
    expect(overflowFinding?.actualBehavior).toContain('420px');

    // Bug 3: Console crash detected
    const consoleFinding = report.findings.find((f) => f.title.includes('consoleClean'));
    expect(consoleFinding).toBeDefined();
    expect(consoleFinding?.description).toContain('unhandled error');

    // Bug 4: Accessibility violation detected
    const a11yFinding = report.findings.find((f) => f.title.includes('noAccessibilityViolations'));
    expect(a11yFinding).toBeDefined();
    expect(a11yFinding?.description).toContain('accessible name');

    // 4. Evidence artifacts must genuinely exist on disk with valid SHA-256
    expect(report.evidence.length).toBeGreaterThanOrEqual(4);
    for (const ev of report.evidence) {
      expect(fs.existsSync(ev.path)).toBe(true);
      const fileBytes = fs.readFileSync(ev.path);
      const expectedSha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');
      expect(ev.sha256).toBe(expectedSha256);
      expect(ev.sizeBytes).toBe(fileBytes.length);
      expect(ev.sizeBytes).toBeGreaterThan(0);
    }
  });

  // ==========================================================================
  // TEST 2: Real Browser run against fixed fixture app (FIX_DEFECTS=true) ->
  //         Assert all 4 pass, status PASSED, high trust score.
  // ==========================================================================
  it('Test 2: truthfully reports status PASSED with zero findings when FIX_DEFECTS=true on real browser', async () => {
    const adapter = new WebAdapter({ id: 'real-fixed-adapter', headless: true });
    const cap = await adapter.getCapability();
    expect(cap.state).toBe('AVAILABLE');

    const plan = buildAcceptancePlan(fixedServer.url);
    const lifecycle = new RunLifecycle(adapter, plan, [cap]);
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
    expect(report.trustScore.score).toBeGreaterThanOrEqual(80);
    expect(report.trustScore.honestyPenalty).toBe(0);
  });

  // ==========================================================================
  // TEST 3: Fix verification using real browser ->
  //         Transitions finding to FIX_VERIFIED against fixed app;
  //         Honestly FAILED against unfixed app.
  // ==========================================================================
  it('Test 3: executes fix verification logic and transitions finding to FIX_VERIFIED using real browser', async () => {
    // Step A: Produce confirmed defect finding from unfixed app using real WebAdapter
    const unfixedAdapter = new WebAdapter({ id: 'verify-unfixed-adapter', headless: true });
    const unfixedPlan = buildAcceptancePlan(unfixedServer.url);
    const unfixedCap = await unfixedAdapter.getCapability();

    const initialLifecycle = new RunLifecycle(unfixedAdapter, unfixedPlan, [unfixedCap]);
    const initialReport = await initialLifecycle.execute();
    expect(initialReport.overallStatus).toBe('FAILED');

    const confirmedFinding: Finding = initialReport.findings[0];
    expect(confirmedFinding.status).toBe('CONFIRMED');
    expect(confirmedFinding.fixVerification).toBe('UNVERIFIED');

    // Step B: Run fix verification against the FIXED app server using real WebAdapter
    const fixedAdapter = new WebAdapter({ id: 'verify-fixed-adapter', headless: true });
    const verifyResult = await executeFixVerification({
      finding: confirmedFinding,
      targetAppUrl: fixedServer.url,
      adapter: fixedAdapter,
      originalPlan: unfixedPlan,
    });

    // Step C: Assert verification succeeded and status transitioned
    expect(verifyResult.verified).toBe(true);
    expect(verifyResult.previousStatus).toBe('CONFIRMED');
    expect(verifyResult.newStatus).toBe('FIX_VERIFIED');
    expect(verifyResult.fixVerification).toBe('VERIFIED');
    expect(confirmedFinding.status).toBe('FIX_VERIFIED');
    expect(confirmedFinding.fixVerification).toBe('VERIFIED');

    // Step D: Negative test - assert fix verification honestly fails if tested against unfixed app
    const stillBrokenFinding: Finding = {
      ...confirmedFinding,
      status: 'CONFIRMED',
      fixVerification: 'UNVERIFIED',
      verifiedAt: undefined,
    };
    const unfixedVerifyAdapter = new WebAdapter({ id: 'verify-broken-adapter', headless: true });
    const failedVerifyResult = await executeFixVerification({
      finding: stillBrokenFinding,
      targetAppUrl: unfixedServer.url,
      adapter: unfixedVerifyAdapter,
      originalPlan: unfixedPlan,
    });

    expect(failedVerifyResult.verified).toBe(false);
    expect(failedVerifyResult.newStatus).toBe('FIX_FAILED');
    expect(failedVerifyResult.fixVerification).toBe('FAILED');
    expect(stillBrokenFinding.status).toBe('FIX_FAILED');
  });

  // ==========================================================================
  // TEST 4: Blocked platform test ->
  //         Assert requesting an unsupported/blocked capability returns BLOCKED, not PASSED.
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

    const registry = new CapabilityRegistry();
    registry.registerAdapter(blockedAdapter);

    const probedCaps = await registry.probeAllCapabilities();
    expect(probedCaps).toHaveLength(1);
    expect(probedCaps[0].state).toBe('BLOCKED');

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
    await expect(lifecycle.execute()).rejects.toThrow(QABlockedError);
  });

  // ==========================================================================
  // TEST 5: Regression Test for FINDING-02:
  //         Proves that an unresolved defect cannot be certified as fixed simply
  //         because its homepage returns HTTP 200.
  // ==========================================================================
  it('Test 5: regression test - unresolved defect cannot be certified as fixed via HTTP 200 homepage check', async () => {
    // Construct finding representing unhandled crash on broken-action-btn
    const crashFinding: Finding = {
      id: 'FIND-BUG-003',
      title: 'Failed assertion: consoleClean',
      description: 'TypeError: Cannot read properties of undefined (reading invokeCrashHandler)',
      severity: 'HIGH',
      status: 'CONFIRMED',
      fixVerification: 'UNVERIFIED',
      platform: 'web',
      preconditions: [`Target app: ${unfixedServer.url}`],
      reproductionSteps: ['Navigate to target', 'Click #broken-action-btn', 'Assert console is clean'],
      expectedBehavior: '0 errors',
      actualBehavior: '1 error',
      evidenceIds: ['ev-test-1'],
      reproducibilityCount: 1,
      reproducibilitySuccessRate: 1.0,
      detectedAt: new Date().toISOString(),
      metadata: {
        scenario: {
          id: 'TC-003-CRASH',
          title: 'Crash check',
          description: 'Check crash on button click',
          platform: 'web',
          steps: [
            {
              id: 's1',
              description: 'Navigate',
              action: { type: 'navigate', value: unfixedServer.url, metadata: {} },
              continueOnFailure: false,
            },
            {
              id: 's2',
              description: 'Click broken button',
              action: { type: 'click', target: '#broken-action-btn', metadata: {} },
              continueOnFailure: false,
            },
            {
              id: 's3',
              description: 'Assert console clean',
              assertion: { type: 'consoleClean', critical: true, metadata: {} },
              continueOnFailure: false,
            },
          ],
        },
      },
    };

    // Even though unfixedServer returns HTTP 200 on '/', verifyFix must execute the actual click & consoleClean
    const adapter = new WebAdapter({ id: 'regression-test-adapter', headless: true });
    const verifyResult = await executeFixVerification({
      finding: crashFinding,
      targetAppUrl: unfixedServer.url,
      adapter,
    });

    // Must NOT claim VERIFIED simply because homepage returned 200!
    expect(verifyResult.verified).toBe(false);
    expect(verifyResult.newStatus).toBe('FIX_FAILED');
    expect(crashFinding.status).toBe('FIX_FAILED');
  });

  // ==========================================================================
  // TEST 6: Regression Test for FINDING-04 (Cloud Metadata & SSRF Protection):
  //         Asserts that requests targeting 169.254.169.254 or metadata.google.internal
  //         are blocked and cannot proceed.
  // ==========================================================================
  it('Test 6: blocks cloud metadata endpoints (169.254.169.254) and prevents SSRF', async () => {
    const adapter = new WebAdapter({ id: 'security-adapter', headless: true });
    await adapter.initialize();

    // 1. Direct navigation to metadata endpoint must be blocked
    const navResult = await adapter.executeAction({
      type: 'navigate',
      value: 'http://169.254.169.254/latest/meta-data/',
    });

    expect(navResult.success).toBe(false);
    expect(navResult.error).toContain('blocked by security policy');

    // 2. Navigation to GCP metadata DNS must be blocked
    const gcpResult = await adapter.executeAction({
      type: 'navigate',
      value: 'http://metadata.google.internal/computeMetadata/v1/',
    });
    expect(gcpResult.success).toBe(false);
    expect(gcpResult.error).toContain('blocked by security policy');

    // 3. Legitimate local target must succeed
    const validResult = await adapter.executeAction({
      type: 'navigate',
      value: fixedServer.url,
    });
    expect(validResult.success).toBe(true);

    await adapter.teardown();
  });

  // ==========================================================================
  // TEST 7: Regression Test for FINDING-04 (Secret and Credential Redaction):
  //         Asserts that Bearer tokens, AWS keys, and passwords are redacted.
  // ==========================================================================
  it('Test 7: redacts Bearer tokens, AWS keys, and passwords from logs and evidence', async () => {
    const rawSample =
      'User logged in with Authorization: Bearer secret_jwt_token_12345. ' +
      'AWS credentials: AKIAIOSFODNN7EXAMPLE. Form input: {"password":"super_secret_password"}.';

    const redacted = redactSecrets(rawSample);

    expect(redacted).not.toContain('secret_jwt_token_12345');
    expect(redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redacted).not.toContain('super_secret_password');

    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).toContain('[REDACTED_AWS_KEY]');
    expect(redacted).toContain('"password":"[REDACTED]"');

    // Verify diagnostic text around secrets is retained
    expect(redacted).toContain('User logged in with');
    expect(redacted).toContain('AWS credentials:');
  });
});
