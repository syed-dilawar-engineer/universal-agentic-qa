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
  Platform,
  QARunReport,
} from '@agentic-qa/schemas';
import { generateTestPlan, validateTestPlanFile } from './plan.js';
import { createDefaultRegistry } from '../utils/registry.js';
import { saveReport, renderReportTerminal } from '../utils/reporter.js';
import { CliLogger, pc } from '../output.js';

export interface TestOptions {
  plan?: string;
  target?: string;
  platform?: Platform;
  adapter?: string;
  config?: string;
  out?: string;
  json?: boolean;
}

export function resolvePlan(options: TestOptions): TestPlan {
  if (options.plan) {
    const validation = validateTestPlanFile(options.plan);
    if (!validation.valid || !validation.plan) {
      throw new Error(`Invalid test plan file at ${options.plan}: ${JSON.stringify(validation.errors)}`);
    }
    const plan = validation.plan;
    if (options.target) plan.targetApp = options.target;
    if (options.platform) plan.platform = options.platform;
    return plan;
  }

  // Generate a dynamic plan from target/config
  return generateTestPlan({
    target: options.target,
    platform: options.platform,
    configPath: options.config,
  });
}

export function registerTestCommand(
  program: Command,
  registryFactory: () => CapabilityRegistry = createDefaultRegistry,
  getLogger: (isJson: boolean) => CliLogger
): void {
  program
    .command('test')
    .description('Execute test plan against target using RunLifecycle')
    .option('-p, --plan <path>', 'Path to test plan JSON file')
    .option('-t, --target <target>', 'Target URL or application override')
    .option('--platform <platform>', 'Target platform (web, mobile, desktop, api, game)')
    .option('-a, --adapter <id>', 'Platform adapter ID override')
    .option('-c, --config <path>', 'Configuration file path')
    .option('-o, --out <path>', 'Destination path for run report JSON')
    .option('--json', 'Output machine-readable JSON report to stdout')
    .action(async (options: TestOptions) => {
      const logger = getLogger(!!options.json);

      try {
        const plan = resolvePlan(options);
        const registry = registryFactory();
        const capabilities = await registry.probeAllCapabilities();

        // Resolve adapter
        let adapter = options.adapter ? registry.getAdapter(options.adapter) : undefined;
        if (!adapter) {
          adapter = await registry.resolveAdapterForTarget(plan.platform);
        }

        if (!options.json) {
          logger.log(pc.bold('\n🚀 Executing Agentic QA Run'));
          logger.log(`Plan:     ${pc.cyan(plan.name)} (${plan.planId})`);
          logger.log(`Target:   ${pc.cyan(plan.targetApp)}`);
          logger.log(`Platform: ${pc.cyan(plan.platform)}`);
          logger.log(`Adapter:  ${pc.cyan(adapter.name)} (${adapter.id})\n`);
        }

        const lifecycle = new RunLifecycle(adapter, plan, capabilities);

        const report = await lifecycle.execute({
          onTestCaseStart: (tc) => {
            if (!options.json) {
              logger.log(`\n• Running scenario: ${pc.bold(tc.title)} (${tc.id})`);
            }
          },
          onStepStart: (stepId, desc) => {
            if (!options.json) {
              logger.log(`  [START] ${stepId}: ${desc}`);
            }
          },
          onStepEnd: (stepRes) => {
            if (!options.json) {
              const badge =
                stepRes.status === 'PASSED'
                  ? pc.green('✔ PASS')
                  : stepRes.status === 'BLOCKED'
                  ? pc.yellow('⚠ BLOCK')
                  : pc.red('✖ FAIL');
              logger.log(`  [END]   ${badge} (${stepRes.durationMs}ms)` + (stepRes.error ? ` - ${stepRes.error}` : ''));
            }
          },
        });

        // Save report to disk
        const savedPath = saveReport(report, options.out);

        if (options.json) {
          logger.json(report);
        } else {
          renderReportTerminal(report, logger);
          logger.log(`\nReport artifact saved to: ${pc.cyan(savedPath)}`);
        }

        // Set exit code according to requirements:
        // exit code 0 for pass, exit code 1 for test failure, exit code 2 for blocked.
        if (report.overallStatus === 'PASSED') {
          process.exitCode = 0;
        } else if (report.overallStatus === 'BLOCKED') {
          process.exitCode = 2;
        } else {
          process.exitCode = 1;
        }
      } catch (err: any) {
        if (err instanceof QABlockedError || err instanceof QAUnsupportedError) {
          if (options.json) {
            logger.json({
              overallStatus: 'BLOCKED',
              error: err.message,
              code: err.code,
              missingRequirement: (err as any).missingRequirement,
            });
          } else {
            logger.error(`\n⚠ QA Run BLOCKED: ${err.message}`);
          }
          process.exitCode = 2;
        } else {
          if (options.json) {
            logger.json({
              overallStatus: 'FAILED',
              error: err.message,
            });
          } else {
            logger.error(`\n✖ QA Run Failed with error: ${err.message}`);
          }
          process.exitCode = 1;
        }
      }
    });
}
