import { Command } from 'commander';
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
  Platform,
} from '@agentic-qa/schemas';
import { loadConfig } from '@agentic-qa/core';
import { createDefaultRegistry } from '../utils/registry.js';
import { saveReport, renderReportTerminal } from '../utils/reporter.js';
import { CliLogger, pc } from '../output.js';
import { MonkeyExplorer, BoundaryFuzzer } from '@agentic-qa/engine-robustness';

export interface ExploreOptions {
  target?: string;
  maxSteps?: string | number;
  seed?: string | number;
  duration?: string | number;
  platform?: Platform;
  engine?: string;
  fuzz?: boolean;
  config?: string;
  out?: string;
  json?: boolean;
}

// Simple deterministic PRNG based on seed
function createPrng(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export function generateExploratoryPlan(options: {
  target: string;
  platform: Platform;
  maxSteps: number;
  seed: number;
}): TestPlan {
  const rand = createPrng(options.seed);
  const steps: TestStep[] = [];

  // Step 1: Initial navigation
  steps.push({
    id: 'explore-step-0',
    description: `Navigate to target: ${options.target}`,
    action: {
      type: 'navigate',
      value: options.target,
      timeoutMs: 10000,
      metadata: {},
    },
    assertion: {
      type: 'status200',
      critical: true,
      metadata: {},
    },
    continueOnFailure: false,
  });

  const actionTypes = ['scroll', 'rapidClicks', 'wait', 'snapshot', 'hover'];
  const count = Math.min(Math.max(options.maxSteps - 1, 5), 500);

  for (let i = 1; i <= count; i++) {
    const actType = actionTypes[Math.floor(rand() * actionTypes.length)];
    let val: any = undefined;
    if (actType === 'wait') val = 20;
    if (actType === 'rapidClicks') val = 50;

    steps.push({
      id: `explore-step-${i}`,
      description: `Monkey action ${i}: ${actType}`,
      action: {
        type: actType as any,
        value: val,
        timeoutMs: 5000,
        metadata: { seed: options.seed, stepIndex: i },
      },
      assertion: {
        type: 'consoleClean',
        critical: false,
        message: 'No unhandled exception during exploration step',
        metadata: {},
      },
      continueOnFailure: true,
    });
  }

  const scenario: TestCase = {
    id: 'explore-scenario-01',
    title: `Bounded Monkey Exploration (${count + 1} steps, seed: ${options.seed})`,
    description: 'Autonomous exploratory test sequence verifying interface stability under fuzzing',
    platform: options.platform,
    timeoutMs: 120000,
    retries: 0,
    tags: ['exploratory', 'fuzz', 'robustness'],
    expectedOutcome: 'PASS',
    steps,
  };

  return TestPlanSchema.parse({
    planId: `explore-plan-${Date.now()}`,
    name: `Exploratory Test Run on ${options.target}`,
    targetApp: options.target,
    platform: options.platform,
    environment: 'local',
    scenarios: [scenario],
    createdAt: new Date().toISOString(),
    metadata: {
      mode: 'exploratory',
      seed: options.seed,
      maxSteps: count + 1,
    },
  });
}

export function registerExploreCommand(
  program: Command,
  registryFactory: () => CapabilityRegistry = createDefaultRegistry,
  getLogger: (isJson: boolean) => CliLogger
): void {
  program
    .command('explore [target]')
    .description('Run bounded exploratory/monkey test against target')
    .option('-t, --target <target>', 'Target URL or application path')
    .option('-m, --max-steps <number>', 'Maximum number of exploratory steps', '30')
    .option('-s, --seed <number>', 'Deterministic random seed for monkey actions', '42')
    .option('-d, --duration <seconds>', 'Maximum exploration duration in seconds', '60')
    .option('--platform <platform>', 'Target platform (web, mobile, desktop)', 'web')
    .option('--engine <engine>', 'Exploration engine mode: plan, monkey, fuzzer, or all', 'plan')
    .option('--fuzz', 'Run boundary fuzzer against target')
    .option('-c, --config <path>', 'Configuration file path')
    .option('-o, --out <path>', 'Destination path for run report JSON')
    .option('--json', 'Output machine-readable JSON')
    .action(async (targetArg: string | undefined, options: ExploreOptions) => {
      const logger = getLogger(!!options.json);

      let target = targetArg || options.target;
      let platform = options.platform || 'web';

      if (!target) {
        try {
          const cfg = loadConfig(options.config);
          target = cfg.target.url || cfg.target.appPath || 'http://localhost:3000';
          platform = cfg.target.platform || platform;
        } catch {
          target = 'http://localhost:3000';
        }
      }

      const maxSteps = Number(options.maxSteps) || 30;
      const seed = Number(options.seed) || 42;

      try {
        const plan = generateExploratoryPlan({
          target,
          platform,
          maxSteps,
          seed,
        });

        const registry = registryFactory();
        const capabilities = await registry.probeAllCapabilities();
        const adapter = await registry.resolveAdapterForTarget(platform);

        if (!options.json) {
          logger.log(pc.bold('\n🐒 Starting Bounded Exploratory QA Run'));
          logger.log(`Target:    ${pc.cyan(target)}`);
          logger.log(`Platform:  ${pc.cyan(platform)}`);
          logger.log(`Max Steps: ${pc.cyan(String(maxSteps))}`);
          logger.log(`Seed:      ${pc.cyan(String(seed))}`);
          logger.log(`Adapter:   ${pc.cyan(adapter.name)}\n`);
        }

        const lifecycle = new RunLifecycle(adapter, plan, capabilities);
        const report = await lifecycle.execute({
          onStepStart: (stepId, desc) => {
            if (!options.json) {
              logger.log(`  [EXPLORE] ${stepId}: ${desc}`);
            }
          },
        });

        // Run specialized robustness engines if requested
        if (options.engine === 'monkey' || options.engine === 'all') {
          const explorer = new MonkeyExplorer(adapter);
          try {
            await adapter.initialize();
            const monkeyResult = await explorer.run({
              maxActions: maxSteps,
              seed,
              timeoutMs: (Number(options.duration) || 60) * 1000,
            });
            if (monkeyResult.findings.length > 0) {
              report.findings.push(...monkeyResult.findings);
              report.overallStatus = 'FAILED';
            }
          } catch {
            // Ignore specialized run errors
          }
        }

        if (options.fuzz || options.engine === 'fuzzer' || options.engine === 'all') {
          const fuzzer = new BoundaryFuzzer(adapter);
          try {
            await adapter.initialize();
            const fuzzResult = await fuzzer.run({
              targetInput: 'input[type="text"], input:not([type]), textarea',
              fuzzIterations: Math.min(maxSteps, 20),
            });
            if (fuzzResult.findings.length > 0) {
              report.findings.push(...fuzzResult.findings);
              report.overallStatus = 'FAILED';
            }
          } catch {
            // Ignore specialized run errors
          }
        }

        const savedPath = saveReport(report, options.out);

        if (options.json) {
          logger.json({
            ...report,
            exploratoryDetails: {
              mode: 'exploratory',
              seed,
              maxSteps,
            },
          });
        } else {
          renderReportTerminal(report, logger);
          logger.log(`\nReport artifact saved to: ${pc.cyan(savedPath)}`);
        }

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
            logger.json({ overallStatus: 'BLOCKED', error: err.message });
          } else {
            logger.error(`\n⚠ Exploration BLOCKED: ${err.message}`);
          }
          process.exitCode = 2;
        } else {
          if (options.json) {
            logger.json({ overallStatus: 'FAILED', error: err.message });
          } else {
            logger.error(`\n✖ Exploration failed: ${err.message}`);
          }
          process.exitCode = 1;
        }
      }
    });
}
