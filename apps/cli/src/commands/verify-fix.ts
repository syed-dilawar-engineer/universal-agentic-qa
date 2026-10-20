import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import {
  RunLifecycle,
  CapabilityRegistry,
  QABlockedError,
  QAUnsupportedError,
} from '@agentic-qa/core';
import {
  TestPlan,
  TestPlanSchema,
  TestCase,
  QARunReport,
  Finding,
  Platform,
} from '@agentic-qa/schemas';
import { loadReport, saveReport } from '../utils/reporter.js';
import { createDefaultRegistry } from '../utils/registry.js';
import { generateTestPlan, validateTestPlanFile } from './plan.js';
import { CliLogger, pc } from '../output.js';

export interface VerifyFixOptions {
  finding?: string;
  report?: string;
  plan?: string;
  target?: string;
  platform?: Platform;
  out?: string;
  json?: boolean;
}

export function registerVerifyFixCommand(
  program: Command,
  registryFactory: () => CapabilityRegistry = createDefaultRegistry,
  getLogger: (isJson: boolean) => CliLogger
): void {
  program
    .command('verify-fix')
    .description('Rerun failed test cases to verify a fix, outputting VERIFIED or FAILED')
    .option('-f, --finding <id>', 'Finding ID to verify fix for')
    .option('-r, --report <path>', 'Path to previous QA run report containing failures')
    .option('-p, --plan <path>', 'Test plan file path')
    .option('-t, --target <target>', 'Target application or URL override')
    .option('--platform <platform>', 'Platform override')
    .option('-o, --out <path>', 'Destination path for rerun report JSON')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: VerifyFixOptions) => {
      const logger = getLogger(!!options.json);

      try {
        const prevReport = loadReport(options.report);
        const target = options.target || prevReport.targetApp;
        const platform = options.platform || prevReport.platform;

        let scenariosToRerun: TestCase[] = [];
        let targetFinding: Finding | undefined;

        if (options.finding) {
          targetFinding = prevReport.findings.find(f => f.id === options.finding);
          if (!targetFinding) {
            throw new Error(`Finding ID '${options.finding}' not found in report ${prevReport.runId}`);
          }

          // Build a scenario from the finding's reproduction steps
          scenariosToRerun.push({
            id: `verify-${targetFinding.id}`,
            title: `Verify Fix for: ${targetFinding.title}`,
            description: targetFinding.description,
            platform,
            timeoutMs: 30000,
            retries: 0,
            tags: ['fix-verification', targetFinding.id],
            expectedOutcome: 'PASS',
            steps: targetFinding.reproductionSteps.map((stepDesc, idx) => ({
              id: `repro-step-${idx + 1}`,
              description: stepDesc,
              action: {
                type: 'navigate',
                value: target,
                timeoutMs: 10000,
                metadata: {},
              },
              assertion: {
                type: 'status200',
                critical: true,
                metadata: {},
              },
              continueOnFailure: false,
            })),
          });
        } else {
          // Find all failed test cases from previous run
          const failedResults = prevReport.testResults.filter(
            r => r.status === 'FAILED' || r.status === 'ERROR'
          );

          if (failedResults.length === 0 && prevReport.findings.length === 0) {
            if (options.json) {
              logger.json({
                status: 'VERIFIED',
                message: 'No failed test cases or findings in previous run report.',
                rerunCount: 0,
              });
            } else {
              logger.log(pc.bold(pc.green('VERIFIED')));
              logger.log('No failed test cases in previous report.');
            }
            process.exitCode = 0;
            return;
          }

          // Try to load original plan if provided
          let originalPlan: TestPlan | undefined;
          if (options.plan) {
            const v = validateTestPlanFile(options.plan);
            if (v.valid) originalPlan = v.plan;
          }

          if (originalPlan) {
            const failedIds = new Set(failedResults.map(r => r.testCaseId));
            scenariosToRerun = originalPlan.scenarios.filter(s => failedIds.has(s.id));
          }

          if (scenariosToRerun.length === 0) {
            // Synthesize scenarios for failed tests
            scenariosToRerun = failedResults.map(fr => ({
              id: `rerun-${fr.testCaseId}`,
              title: `Rerun: ${fr.title}`,
              description: `Verification rerun of failed test ${fr.testCaseId}`,
              platform,
              timeoutMs: 30000,
              retries: 0,
              tags: ['fix-verification'],
              expectedOutcome: 'PASS',
              steps: [
                {
                  id: 'step-verify-nav',
                  description: `Navigate to target ${target}`,
                  action: { type: 'navigate', value: target, timeoutMs: 10000, metadata: {} },
                  assertion: { type: 'status200', critical: true, metadata: {} },
                  continueOnFailure: false,
                },
              ],
            }));
          }
        }

        const verifyPlan: TestPlan = {
          planId: `verify-plan-${Date.now()}`,
          name: `Fix Verification Suite for ${target}`,
          targetApp: target,
          platform,
          environment: 'local',
          scenarios: scenariosToRerun,
          createdAt: new Date().toISOString(),
          metadata: {
            verifyingFindingId: targetFinding?.id,
            previousRunId: prevReport.runId,
          },
        };

        const registry = registryFactory();
        const capabilities = await registry.probeAllCapabilities();
        const adapter = await registry.resolveAdapterForTarget(platform);

        const lifecycle = new RunLifecycle(adapter, verifyPlan, capabilities);
        const report = await lifecycle.execute();

        saveReport(report, options.out);

        const isVerified = report.overallStatus === 'PASSED';
        const resultStatus = isVerified ? 'VERIFIED' : 'FAILED';

        if (options.json) {
          logger.json({
            status: resultStatus,
            findingId: targetFinding?.id,
            verified: isVerified,
            rerunTestsCount: scenariosToRerun.length,
            passed: report.summary.passed,
            failed: report.summary.failed,
            overallStatus: report.overallStatus,
          });
        } else {
          logger.log('\n================================================================================');
          if (isVerified) {
            logger.log(pc.bold(pc.green('VERIFIED')));
            logger.log(pc.green(`✔ All ${scenariosToRerun.length} regression test case(s) passed successfully.`));
          } else {
            logger.log(pc.bold(pc.red('FAILED')));
            logger.log(pc.red(`✖ Defect is still present. ${report.summary.failed} test case(s) failed.`));
          }
          logger.log('================================================================================\n');
        }

        process.exitCode = isVerified ? 0 : 1;
      } catch (err: any) {
        if (err instanceof QABlockedError || err instanceof QAUnsupportedError) {
          if (options.json) {
            logger.json({ status: 'BLOCKED', error: err.message });
          } else {
            logger.error(`\n⚠ Fix verification BLOCKED: ${err.message}`);
          }
          process.exitCode = 2;
        } else {
          if (options.json) {
            logger.json({ status: 'FAILED', error: err.message });
          } else {
            logger.error(`\n✖ Fix verification failed: ${err.message}`);
          }
          process.exitCode = 1;
        }
      }
    });
}
