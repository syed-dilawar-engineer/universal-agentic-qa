import {
  TestPlan,
  TestCase,
  TestCaseSchema,
  QARunReport,
  Platform,
} from '@agentic-qa/schemas';
import { RunLifecycle, PlatformAdapter } from '@agentic-qa/core';
import {
  VerifyFixInput,
  VerifyFixOutput,
  McpServerContext,
} from '../types.js';

export async function handleVerifyFix(
  input: VerifyFixInput,
  context: McpServerContext
): Promise<VerifyFixOutput> {
  const { findingId, adapterId, timeoutMs = 60000 } = input;

  // 1. Locate finding
  const finding = context.storage.getFinding(findingId);
  if (!finding) {
    throw new Error(
      `Finding with ID '${findingId}' was not found in storage. Ensure the defect was recorded from a prior test run.`
    );
  }

  // 2. Resolve target app
  const targetApp = input.targetApp || (finding.preconditions[0]?.replace('Target app: ', '')) || 'http://localhost:3000';
  const platform: Platform = finding.platform;

  // 3. Resolve test case for regression
  let testCase: TestCase;

  if (input.testCase) {
    const parsed = TestCaseSchema.safeParse(input.testCase);
    if (!parsed.success) {
      throw new Error(`Invalid testCase provided for regression verification: ${parsed.error.message}`);
    }
    testCase = parsed.data;
  } else {
    // Attempt to locate original test case from saved plans
    let originalTestCase: TestCase | undefined;
    for (const plan of context.storage.getAllPlans()) {
      const sc = plan.scenarios.find((s) => s.id === finding.testCaseId);
      if (sc) {
        originalTestCase = sc;
        break;
      }
    }

    if (originalTestCase) {
      testCase = originalTestCase;
    } else {
      // Determine assertion type from finding title or default
      let assertionType: any = 'elementTextContains';
      if (finding.title.startsWith('Failed assertion: ')) {
        assertionType = finding.title.replace('Failed assertion: ', '').trim();
      }

      let expectedValue: any = finding.expectedBehavior;
      try {
        expectedValue = JSON.parse(finding.expectedBehavior);
      } catch {
        // keep raw string
      }

      // Construct targeted regression test case from finding reproduction steps
      testCase = {
        id: `regression-${finding.id}`,
        title: `Regression Verification: ${finding.title}`,
        description: `Truthfully verifies whether defect '${finding.id}' (${finding.title}) has been resolved.`,
        platform,
        timeoutMs: 30000,
        retries: 0,
        tags: ['regression', 'fix-verification', finding.id],
        expectedOutcome: 'PASS',
        steps: [
          {
            id: 'step-reg-nav',
            description: `Navigate to target app: ${targetApp}`,
            action: {
              type: 'navigate',
              target: targetApp,
              timeoutMs: 15000,
              metadata: {},
            },
            continueOnFailure: false,
          },
          {
            id: 'step-reg-assert',
            description: `Verify expected behavior: ${finding.expectedBehavior}`,
            assertion: {
              type: assertionType,
              expected: expectedValue,
              critical: true,
              metadata: { findingId: finding.id },
            },
            continueOnFailure: false,
          },
        ],
      };
    }
  }

  // 4. Build single-scenario regression plan
  const regressionPlan: TestPlan = {
    planId: `plan-reg-${finding.id}-${Date.now()}`,
    name: `Regression Verification for ${finding.id}`,
    targetApp,
    platform,
    environment: 'local',
    createdAt: new Date().toISOString(),
    scenarios: [testCase],
    metadata: {
      findingId: finding.id,
      verifiedFix: true,
    },
  };

  // 5. Resolve adapter
  let adapter: PlatformAdapter;
  if (adapterId) {
    const found = context.registry.getAdapter(adapterId);
    if (!found) {
      throw new Error(`Adapter with ID '${adapterId}' not found.`);
    }
    adapter = found;
  } else {
    adapter = await context.registry.resolveAdapterForTarget(platform);
  }

  // 6. Execute via RunLifecycle
  const capabilities = await context.registry.probeAllCapabilities();
  const lifecycle = new RunLifecycle(adapter, regressionPlan, capabilities);
  const report: QARunReport = await lifecycle.execute({ maxDurationMs: timeoutMs });

  // Save regression run
  context.storage.saveReport(report);

  // 7. Truthful determination of fix status
  const passed = report.overallStatus === 'PASSED' && report.summary.failed === 0;
  const previousStatus = finding.status;
  const newStatus = passed ? 'FIX_VERIFIED' : 'FIX_FAILED';
  const fixVerification = passed ? 'VERIFIED' : 'FAILED';

  // Update finding in storage
  context.storage.updateFinding(finding.id, {
    status: newStatus,
    fixVerification,
    verifiedAt: new Date().toISOString(),
    metadata: {
      regressionRunId: report.runId,
      regressionPassed: passed,
    },
  });

  const message = passed
    ? `Defect '${findingId}' was TRUTHFULLY VERIFIED AS FIXED. All regression assertions passed (0 failures).`
    : `Defect '${findingId}' FIX FAILED. Regression rerun encountered ${report.summary.failed} assertion failure(s).`;

  return {
    findingId: finding.id,
    verified: passed,
    previousStatus,
    newStatus,
    fixVerification,
    runId: report.runId,
    durationMs: report.durationMs,
    message,
    evidenceIds: report.evidence.map((e) => e.id),
  };
}
