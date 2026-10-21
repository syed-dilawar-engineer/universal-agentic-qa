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
  TestStep,
  AssertionSpec,
  AssertionType,
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
  findingId?: string;
  report?: string;
  plan?: string;
  target?: string;
  platform?: Platform;
  out?: string;
  json?: boolean;
}

/**
 * Truthfully reconstructs a test scenario from finding reproduction steps and metadata.
 * Never creates dummy custom assertions.
 */
export function reconstructVerificationScenario(
  finding: Finding,
  platform: Platform,
  targetApp: string
): TestCase | undefined {
  if (finding.metadata?.scenario) {
    return finding.metadata.scenario as TestCase;
  }

  // Determine truthful, deterministic assertion
  let assertion: AssertionSpec | undefined;

  if (finding.metadata?.failedAssertion) {
    const prev = finding.metadata.failedAssertion;
    assertion = {
      type: prev.type,
      target: prev.target,
      expected: prev.expected,
      tolerance: prev.tolerance,
      critical: prev.critical ?? true,
      metadata: { ...prev.metadata, findingId: finding.id },
    };
  } else if (finding.title.startsWith('Failed assertion: ')) {
    const rawType = finding.title.replace('Failed assertion: ', '').trim() as AssertionType;
    let expected: any = finding.expectedBehavior;
    try {
      expected = JSON.parse(finding.expectedBehavior);
    } catch {
      // keep raw string
    }
    assertion = {
      type: rawType,
      target: finding.metadata?.target || finding.metadata?.selector,
      expected,
      critical: true,
      metadata: { findingId: finding.id },
    };
  } else if (finding.expectedBehavior) {
    const exp = finding.expectedBehavior.toLowerCase();
    if (exp.includes('200') || exp.includes('http 200') || exp.includes('status 200')) {
      assertion = {
        type: 'status200',
        critical: true,
        expected: 200,
        metadata: { findingId: finding.id },
      };
    } else if (exp.includes('console') || exp.includes('clean')) {
      assertion = {
        type: 'consoleClean',
        critical: true,
        metadata: { findingId: finding.id },
      };
    } else if (exp.includes('accessibility') || exp.includes('a11y') || exp.includes('wcag')) {
      assertion = {
        type: 'noAccessibilityViolations',
        critical: true,
        metadata: { findingId: finding.id },
      };
    } else if (exp.includes('overflow') || exp.includes('layout')) {
      assertion = {
        type: 'noLayoutOverflow',
        critical: true,
        metadata: { findingId: finding.id },
      };
    } else if (exp.includes('visible') || exp.includes('displayed')) {
      assertion = {
        type: 'elementVisible',
        target: finding.metadata?.target || finding.metadata?.selector || '#root',
        expected: true,
        critical: true,
        metadata: { findingId: finding.id },
      };
    } else if (finding.metadata?.target) {
      assertion = {
        type: 'elementTextContains',
        target: finding.metadata.target,
        expected: finding.expectedBehavior,
        critical: true,
        metadata: { findingId: finding.id },
      };
    }
  }

  // Refuse empty dummy custom assertions: never certify FIX_VERIFIED without an executable assertion!
  if (!assertion || assertion.type === 'custom') {
    return undefined;
  }

  const steps: TestStep[] = [];
  steps.push({
    id: 'step-verify-nav',
    description: `Navigate to target app: ${targetApp}`,
    action: {
      type: 'navigate',
      target: targetApp,
      value: targetApp,
      timeoutMs: 15000,
      metadata: {},
    },
    continueOnFailure: false,
  });

  if (finding.reproductionSteps && finding.reproductionSteps.length > 0) {
    finding.reproductionSteps.forEach((stepDesc, idx) => {
      const isLast = idx === finding.reproductionSteps.length - 1;
      const lower = stepDesc.toLowerCase();
      let actionType: any = 'click';
      let actionTarget: string | undefined = finding.metadata?.target;

      if (lower.startsWith('click')) {
        actionType = 'click';
        actionTarget = actionTarget || 'button';
      } else if (lower.startsWith('navigate') || lower.startsWith('go to') || lower.startsWith('open')) {
        actionType = 'navigate';
      } else if (lower.startsWith('type') || lower.startsWith('enter') || lower.startsWith('input')) {
        actionType = 'type';
        actionTarget = actionTarget || 'input';
      }

      steps.push({
        id: `repro-step-${idx + 1}`,
        description: stepDesc,
        action: {
          type: actionType,
          target: actionTarget,
          value: stepDesc,
          timeoutMs: 10000,
          metadata: { stepDescription: stepDesc },
        },
        assertion: isLast ? assertion : undefined,
        continueOnFailure: false,
      });
    });
  } else {
    steps.push({
      id: 'step-verify-assert',
      description: `Assert expected behavior: ${finding.expectedBehavior}`,
      assertion,
      continueOnFailure: false,
    });
  }

  return {
    id: `verify-${finding.id}`,
    title: `Verify Fix for: ${finding.title}`,
    description: finding.description,
    platform,
    timeoutMs: 30000,
    retries: 0,
    tags: ['fix-verification', finding.id],
    expectedOutcome: 'PASS',
    steps,
  };
}

export function registerVerifyFixCommand(
  program: Command,
  registryFactory: () => CapabilityRegistry = createDefaultRegistry,
  getLogger: (isJson: boolean) => CliLogger
): void {
  program
    .command('verify-fix')
    .description('Rerun failed test cases using original reproduction actions and assertions')
    .option('-f, --finding <id>', 'Finding ID to verify fix for')
    .option('--finding-id <id>', 'Alias for --finding')
    .option('-r, --report <path>', 'Path to previous QA run report containing failures')
    .option('-p, --plan <path>', 'Original test plan file path containing reproduction scenarios')
    .option('-t, --target <target>', 'Target application or URL override')
    .option('--platform <platform>', 'Platform override')
    .option('-o, --out <path>', 'Destination path for rerun report JSON')
    .option('--json', 'Output machine-readable JSON')
    .action(async (options: VerifyFixOptions) => {
      const logger = getLogger(!!options.json);
      const targetFindingId = options.findingId || options.finding;

      try {
        const prevReport = loadReport(options.report);
        const target = options.target || prevReport.targetApp;
        const platform = options.platform || prevReport.platform;

        let scenariosToRerun: TestCase[] = [];
        let targetFinding: Finding | undefined;

        // Try to load original plan if provided
        let originalPlan: TestPlan | undefined;
        if (options.plan) {
          const v = validateTestPlanFile(options.plan);
          if (v.valid && v.plan) originalPlan = v.plan;
        }

        if (targetFindingId) {
          targetFinding = prevReport.findings.find((f) => f.id === targetFindingId);
          if (!targetFinding) {
            throw new Error(
              `Finding ID '${targetFindingId}' not found in report ${prevReport.runId}`
            );
          }

          // 1. Check if finding contains stored reproduction scenario or reconstruct it truthfully
          let scenario: TestCase | undefined;
          if (targetFinding.metadata?.scenario) {
            scenario = targetFinding.metadata.scenario as TestCase;
          } else if (originalPlan && targetFinding.testCaseId) {
            scenario = originalPlan.scenarios.find((s) => s.id === targetFinding!.testCaseId);
          } else {
            // Reconstruct scenario from finding metadata and reproduction details (no dummy assertions)
            scenario = reconstructVerificationScenario(targetFinding, platform, target);
          }

          // If reproduction steps and assertions cannot be reconstructed, report NOT_VERIFIED.
          if (!scenario || !scenario.steps || scenario.steps.length === 0) {
            const errMessage =
              `Cannot verify fix for finding '${targetFindingId}': original reproduction scenario ` +
              `with actions and assertions is missing. Provide --plan <path> with original test case.`;
            if (options.json) {
              logger.json({
                status: 'NOT_VERIFIED',
                findingId: targetFindingId,
                verified: false,
                error: errMessage,
              });
            } else {
              logger.error(`\n✖ ${errMessage}`);
            }
            process.exitCode = 1;
            return;
          }

          // Clone scenario and update target URL if overridden
          const clonedScenario: TestCase = JSON.parse(JSON.stringify(scenario));
          if (options.target) {
            for (const step of clonedScenario.steps) {
              if (step.action?.type === 'navigate') {
                step.action.value = options.target;
              }
            }
          }

          scenariosToRerun.push(clonedScenario);
        } else {
          // Re-verify all failed test cases from previous run
          const failedResults = prevReport.testResults.filter(
            (r) => r.status === 'FAILED' || r.status === 'ERROR'
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

          if (originalPlan) {
            const failedIds = new Set(failedResults.map((r) => r.testCaseId));
            scenariosToRerun = originalPlan.scenarios.filter((s) => failedIds.has(s.id));
          } else {
            // Check if findings in report contain scenario metadata or reconstructible assertions
            for (const fr of failedResults) {
              const matchingFinding = prevReport.findings.find((f) => f.testCaseId === fr.testCaseId);
              if (matchingFinding?.metadata?.scenario) {
                scenariosToRerun.push(matchingFinding.metadata.scenario as TestCase);
              } else if (matchingFinding) {
                const reconstructed = reconstructVerificationScenario(matchingFinding, platform, target);
                if (reconstructed) {
                  scenariosToRerun.push(reconstructed);
                }
              }
            }
          }

          if (scenariosToRerun.length === 0) {
            const errMessage =
              'Cannot rerun failed test cases: original scenario definitions not found. ' +
              'Please provide --plan <path> containing the original test cases to replay.';
            if (options.json) {
              logger.json({
                status: 'NOT_VERIFIED',
                verified: false,
                error: errMessage,
              });
            } else {
              logger.error(`\n✖ ${errMessage}`);
            }
            process.exitCode = 1;
            return;
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

        // Ensure no scenario certifies FIX_VERIFIED using an empty dummy custom assertion
        for (const sc of scenariosToRerun) {
          for (const step of sc.steps) {
            if (step.assertion?.type === 'custom') {
              const isConfiguredCustom =
                step.assertion.metadata?.maxScrollWidth !== undefined ||
                step.assertion.metadata?.kind === 'layout' ||
                step.assertion.target === 'layout';
              if (!isConfiguredCustom) {
                throw new Error(
                  `Cannot certify FIX_VERIFIED on an empty dummy custom assertion in step '${step.id}'. ` +
                  `Verifiable deterministic assertions are strictly required.`
                );
              }
            }
          }
        }

        const registry = registryFactory();
        const capabilities = await registry.probeAllCapabilities();
        const adapter = await registry.resolveAdapterForTarget(platform);

        const lifecycle = new RunLifecycle(adapter, verifyPlan, capabilities);
        const report = await lifecycle.execute();

        saveReport(report, options.out);

        const isVerified = report.overallStatus === 'PASSED';
        const resultStatus = isVerified ? 'VERIFIED' : 'FAILED';
        const findingStatus = isVerified ? 'FIX_VERIFIED' : 'FIX_FAILED';

        if (options.json) {
          logger.json({
            status: resultStatus,
            findingId: targetFinding?.id,
            findingStatus,
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
            logger.log(
              pc.green(`✔ All ${scenariosToRerun.length} regression test case(s) passed successfully. Finding resolved.`)
            );
          } else {
            logger.log(pc.bold(pc.red('FAILED')));
            logger.log(
              pc.red(
                `✖ Defect remains unresolved: ${report.summary.failed} test case(s) failed during regression verification.`
              )
            );
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
