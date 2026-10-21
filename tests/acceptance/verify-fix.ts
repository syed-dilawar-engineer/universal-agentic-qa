import {
  Finding,
  TestCase,
  TestPlan,
} from '../../packages/schemas/src/index.js';
import {
  RunLifecycle,
  PlatformAdapter,
} from '../../packages/core/src/index.js';

export interface VerifyFixOptions {
  finding: Finding;
  targetAppUrl: string;
  adapter: PlatformAdapter;
  originalPlan?: TestPlan;
  customTestCase?: TestCase;
}

export interface VerifyFixResult {
  findingId: string;
  verified: boolean;
  previousStatus: string;
  newStatus: 'FIX_VERIFIED' | 'FIX_FAILED';
  fixVerification: 'VERIFIED' | 'FAILED';
  durationMs: number;
  message: string;
  evidenceIds: string[];
}

/**
 * Reconstructs a runnable verification test case for a given finding
 */
function resolveVerificationScenario(
  finding: Finding,
  targetAppUrl: string,
  originalPlan?: TestPlan,
  customTestCase?: TestCase
): TestCase {
  if (customTestCase) {
    return customTestCase;
  }

  let matchedScenario: TestCase | undefined;
  if (finding.metadata?.scenario) {
    matchedScenario = finding.metadata.scenario as TestCase;
  } else if (originalPlan) {
    matchedScenario = originalPlan.scenarios.find((s) => s.id === finding.testCaseId);
  }

  if (matchedScenario) {
    const cloned: TestCase = JSON.parse(JSON.stringify(matchedScenario));
    if (targetAppUrl) {
      for (const step of cloned.steps) {
        if (step.action && step.action.type === 'navigate') {
          step.action.value = targetAppUrl;
        }
      }
    }
    return cloned;
  }

  // Defect 1: Race condition
  if (
    finding.testCaseId?.includes('RACE') ||
    finding.title.includes('elementTextEquals') ||
    finding.actualBehavior.includes('Submissions')
  ) {
    return {
      id: `verify-${finding.id}`,
      title: `Verify Race Condition Fix: ${finding.id}`,
      platform: 'web',
      expectedOutcome: 'PASS',
      timeoutMs: 10000,
      retries: 0,
      tags: ['verify-fix'],
      steps: [
        {
          id: 'v-step-nav',
          description: 'Navigate to target application',
          action: { type: 'navigate', value: targetAppUrl, metadata: {} },
          continueOnFailure: false,
        },
        {
          id: 'v-step-rapid',
          description: 'Execute rapid clicks on checkout button',
          action: { type: 'rapidClicks', target: '#submit-btn', value: { count: 5 }, metadata: {} },
          continueOnFailure: false,
        },
        {
          id: 'v-step-assert',
          description: 'Assert single submission recorded',
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
  }

  // Defect 2: Responsive layout overflow
  if (
    finding.testCaseId?.includes('OVERFLOW') ||
    finding.title.includes('custom') ||
    finding.actualBehavior.includes('420px')
  ) {
    return {
      id: `verify-${finding.id}`,
      title: `Verify Layout Overflow Fix: ${finding.id}`,
      platform: 'web',
      viewport: { width: 375, height: 667 },
      expectedOutcome: 'PASS',
      timeoutMs: 10000,
      retries: 0,
      tags: ['verify-fix'],
      steps: [
        {
          id: 'v-step-nav-mob',
          description: 'Navigate with mobile viewport (375x667)',
          action: {
            type: 'navigate',
            value: targetAppUrl,
            metadata: { viewport: { width: 375, height: 667 } },
          },
          continueOnFailure: false,
        },
        {
          id: 'v-step-assert-overflow',
          description: 'Assert layout does not overflow',
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
  }

  // Defect 3: Unhandled console error
  if (
    finding.testCaseId?.includes('CONSOLE') ||
    finding.title.includes('consoleClean') ||
    finding.actualBehavior.includes('crash')
  ) {
    return {
      id: `verify-${finding.id}`,
      title: `Verify Console Error Fix: ${finding.id}`,
      platform: 'web',
      expectedOutcome: 'PASS',
      timeoutMs: 10000,
      retries: 0,
      tags: ['verify-fix'],
      steps: [
        {
          id: 'v-step-nav',
          description: 'Navigate to target application',
          action: { type: 'navigate', value: targetAppUrl, metadata: {} },
          continueOnFailure: false,
        },
        {
          id: 'v-step-click',
          description: 'Click action button',
          action: { type: 'click', target: '#broken-action-btn', metadata: {} },
          continueOnFailure: false,
        },
        {
          id: 'v-step-assert-clean',
          description: 'Assert console is clean',
          assertion: { type: 'consoleClean', critical: true, metadata: {} },
          continueOnFailure: false,
        },
      ],
    };
  }

  // Defect 4: Accessibility
  return {
    id: `verify-${finding.id}`,
    title: `Verify Accessibility Fix: ${finding.id}`,
    platform: 'web',
    expectedOutcome: 'PASS',
    timeoutMs: 10000,
    retries: 0,
    tags: ['verify-fix'],
    steps: [
      {
        id: 'v-step-nav',
        description: 'Navigate to target application',
        action: { type: 'navigate', value: targetAppUrl, metadata: {} },
        continueOnFailure: false,
      },
      {
        id: 'v-step-assert-a11y',
        description: 'Assert accessible name on button',
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
}

/**
 * Executes fix verification logic (`qa verify-fix`).
 * Runs regression verification test against fixed target and transitions finding status.
 */
export async function executeFixVerification(
  options: VerifyFixOptions
): Promise<VerifyFixResult> {
  const { finding, targetAppUrl, adapter, originalPlan, customTestCase } = options;
  const start = Date.now();
  const previousStatus = finding.status;

  const testCase = resolveVerificationScenario(
    finding,
    targetAppUrl,
    originalPlan,
    customTestCase
  );

  const plan: TestPlan = {
    planId: `verify-plan-${Date.now()}`,
    name: `Verify Fix: ${finding.id}`,
    targetApp: targetAppUrl,
    platform: finding.platform,
    environment: 'regression',
    createdAt: new Date().toISOString(),
    metadata: { verifiedFindingId: finding.id },
    scenarios: [testCase],
  };

  const cap = await adapter.getCapability();
  const lifecycle = new RunLifecycle(adapter, plan, [cap]);

  let verified = false;
  let evidenceIds: string[] = [];

  try {
    const report = await lifecycle.execute();
    verified = report.overallStatus === 'PASSED';
    evidenceIds = report.evidence.map((e) => e.id);
  } catch (err) {
    verified = false;
  }

  const durationMs = Date.now() - start;

  if (verified) {
    finding.status = 'FIX_VERIFIED';
    finding.fixVerification = 'VERIFIED';
    finding.verifiedAt = new Date().toISOString();

    return {
      findingId: finding.id,
      verified: true,
      previousStatus,
      newStatus: 'FIX_VERIFIED',
      fixVerification: 'VERIFIED',
      durationMs,
      message: `Defect ${finding.id} successfully verified as fixed! Regression tests passed cleanly.`,
      evidenceIds,
    };
  } else {
    finding.status = 'FIX_FAILED';
    finding.fixVerification = 'FAILED';

    return {
      findingId: finding.id,
      verified: false,
      previousStatus,
      newStatus: 'FIX_FAILED',
      fixVerification: 'FAILED',
      durationMs,
      message: `Defect ${finding.id} verification FAILED: Defect remains reproducible on target.`,
      evidenceIds,
    };
  }
}
