import {
  TestPlan,
  TestPlanSchema,
  QARunReport,
  Platform,
} from '@agentic-qa/schemas';
import {
  RunLifecycle,
  PlatformAdapter,
  QABlockedError,
  QAUnsupportedError,
} from '@agentic-qa/core';
import {
  ExecuteTestInput,
  ExecuteTestOutput,
  McpServerContext,
  DEFAULT_MAX_OUTPUT_CHARS,
} from '../types.js';
import { handleCreatePlan } from './create-plan.js';

export async function handleExecuteTest(
  input: ExecuteTestInput,
  context: McpServerContext
): Promise<ExecuteTestOutput> {
  const { adapterId, timeoutMs = 60000, maxOutputLength = DEFAULT_MAX_OUTPUT_CHARS } = input;

  // 1. Resolve test plan
  let plan: TestPlan;

  if (input.plan) {
    const parsed = TestPlanSchema.safeParse(input.plan);
    if (!parsed.success) {
      throw new Error(`Invalid test plan provided: ${parsed.error.message}`);
    }
    plan = parsed.data;
  } else if (input.planId) {
    const cachedPlan = context.storage.getPlan(input.planId);
    if (!cachedPlan) {
      throw new Error(`Plan with ID '${input.planId}' not found in storage.`);
    }
    plan = cachedPlan;
  } else if (input.targetApp) {
    const generated = await handleCreatePlan(
      {
        action: 'generate',
        targetApp: input.targetApp,
        platform: input.platform || 'web',
        planType: 'smoke',
      },
      context
    );
    if (!generated.plan) {
      throw new Error(`Failed to generate test plan for ${input.targetApp}`);
    }
    plan = generated.plan;
  } else {
    throw new Error('Either `plan`, `planId`, or `targetApp` must be provided to execute a test.');
  }

  // 2. Save plan into storage for subsequent lookups/verifications
  context.storage.savePlan(plan);

  // 3. Resolve adapter
  let adapter: PlatformAdapter;

  if (adapterId) {
    const found = context.registry.getAdapter(adapterId);
    if (!found) {
      throw new Error(`Adapter with ID '${adapterId}' not found in registry.`);
    }
    adapter = found;
  } else {
    try {
      adapter = await context.registry.resolveAdapterForTarget(plan.platform);
    } catch (err: any) {
      if (err instanceof QAUnsupportedError) {
        throw new Error(
          `Platform '${plan.platform}' is unsupported or has no registered adapter: ${err.message}`
        );
      }
      throw err;
    }
  }

  // 3. Probe capabilities
  const capabilities = await context.registry.probeAllCapabilities();

  // 4. Execute via RunLifecycle
  const lifecycle = new RunLifecycle(adapter, plan, capabilities);
  const report: QARunReport = await lifecycle.execute({
    maxDurationMs: timeoutMs,
  });

  // 5. Store report and artifacts in RunStorage
  context.storage.saveReport(report);

  // 6. Build bounded output
  const jsonString = JSON.stringify(report);
  const reportTruncated = jsonString.length > maxOutputLength;

  return {
    runId: report.runId,
    overallStatus: report.overallStatus,
    durationMs: report.durationMs,
    summary: report.summary,
    trustScore: {
      score: report.trustScore.score,
      deterministicAssertionsCount: report.trustScore.deterministicAssertionsCount,
      evidenceArtifactsCount: report.trustScore.evidenceArtifactsCount,
      summary: report.trustScore.summary,
    },
    findingsCount: report.findings.length,
    findings: report.findings,
    evidenceIds: report.evidence.map((e) => e.id),
    reportTruncated,
    fullReportId: report.runId,
  };
}
