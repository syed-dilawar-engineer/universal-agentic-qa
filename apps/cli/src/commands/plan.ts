import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import {
  TestPlan,
  TestPlanSchema,
  Platform,
  TestCase,
} from '@agentic-qa/schemas';
import { loadConfig } from '@agentic-qa/core';
import { CliLogger, createTable, pc } from '../output.js';

export interface PlanOptions {
  validate?: string;
  generate?: boolean;
  target?: string;
  platform?: Platform;
  name?: string;
  out?: string;
  config?: string;
  json?: boolean;
}

export function generateTestPlan(options: {
  target?: string;
  platform?: Platform;
  name?: string;
  configPath?: string;
} = {}): TestPlan {
  let target = options.target;
  let platform = options.platform;

  if (!target || !platform) {
    try {
      const cfg = loadConfig(options.configPath);
      target = target || cfg.target.url || cfg.target.appPath || 'http://localhost:3000';
      platform = platform || cfg.target.platform || 'web';
    } catch {
      target = target || 'http://localhost:3000';
      platform = platform || 'web';
    }
  }

  const name = options.name || `Smoke & Regression Plan for ${target}`;

  const smokeTest: TestCase = {
    id: 'test-smoke-01',
    title: 'Initial Target Load & Health Verification',
    description: 'Verifies the target is reachable, loads successfully, and exhibits no uncaught errors',
    platform,
    timeoutMs: 30000,
    retries: 1,
    tags: ['smoke', 'health', 'p0'],
    expectedOutcome: 'PASS',
    steps: [
      {
        id: 'step-nav',
        description: `Navigate to target: ${target}`,
        action: {
          type: 'navigate',
          value: target,
          timeoutMs: 10000,
          metadata: {},
        },
        assertion: {
          type: 'status200',
          critical: true,
          message: 'HTTP response must be 200 OK',
          metadata: {},
        },
        continueOnFailure: false,
      },
      {
        id: 'step-console',
        description: 'Verify clean console logs with zero unhandled exceptions',
        assertion: {
          type: 'consoleClean',
          critical: true,
          message: 'Zero unhandled console errors required',
          metadata: {},
        },
        continueOnFailure: true,
      },
      {
        id: 'step-snapshot',
        description: 'Capture visual baseline snapshot',
        action: {
          type: 'snapshot',
          timeoutMs: 10000,
          metadata: {},
        },
        assertion: {
          type: 'noVisualRegression',
          tolerance: 0.01,
          critical: false,
          metadata: {},
        },
        continueOnFailure: true,
      },
    ],
  };

  const interactiveTest: TestCase = {
    id: 'test-interact-02',
    title: 'Primary Interaction & Accessibility Check',
    description: 'Executes standard UI interaction flow and validates accessibility conformance',
    platform,
    timeoutMs: 30000,
    retries: 0,
    tags: ['interactive', 'a11y', 'p1'],
    expectedOutcome: 'PASS',
    steps: [
      {
        id: 'step-wait',
        description: 'Wait for dynamic page hydration and network quiescence',
        action: {
          type: 'wait',
          value: 100,
          timeoutMs: 5000,
          metadata: {},
        },
        continueOnFailure: false,
      },
      {
        id: 'step-a11y',
        description: 'Verify WCAG AA accessibility compliance',
        assertion: {
          type: 'noAccessibilityViolations',
          critical: false,
          message: 'Zero WCAG 2.1 AA violations',
          metadata: {},
        },
        continueOnFailure: true,
      },
    ],
  };

  return TestPlanSchema.parse({
    planId: `plan-${Date.now()}`,
    name,
    targetApp: target,
    platform,
    environment: 'local',
    scenarios: [smokeTest, interactiveTest],
    createdAt: new Date().toISOString(),
    metadata: {
      generatedBy: '@agentic-qa/cli',
      version: '1.0.0',
    },
  });
}

export function validateTestPlanFile(filePath: string): { valid: boolean; plan?: TestPlan; errors?: any } {
  const resolved = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolved)) {
    return { valid: false, errors: `Plan file does not exist: ${resolved}` };
  }

  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw);
    const result = TestPlanSchema.safeParse(parsed);
    if (result.success) {
      return { valid: true, plan: result.data };
    }
    return { valid: false, errors: result.error.format() };
  } catch (err: any) {
    return { valid: false, errors: `JSON parse error: ${err.message}` };
  }
}

export function registerPlanCommand(
  program: Command,
  getLogger: (isJson: boolean) => CliLogger
): void {
  program
    .command('plan [fileOrTarget]')
    .description('Generate or validate an Agentic QA test plan')
    .option('-v, --validate <path>', 'Validate an existing test plan JSON file')
    .option('-g, --generate', 'Generate a new test plan for the specified target')
    .option('-t, --target <target>', 'Target URL or application path for generated plan')
    .option('-p, --platform <platform>', 'Platform type (web, mobile, desktop, api, game)')
    .option('-n, --name <name>', 'Name for the test plan')
    .option('-o, --out <path>', 'Output file path to save the generated test plan')
    .option('-c, --config <path>', 'Configuration file path')
    .option('--json', 'Output machine-readable JSON')
    .action(async (fileOrTarget: string | undefined, options: PlanOptions) => {
      const logger = getLogger(!!options.json);

      // Check if validation is requested
      const validateTarget = options.validate || (fileOrTarget && fs.existsSync(path.resolve(process.cwd(), fileOrTarget)) ? fileOrTarget : undefined);

      if (validateTarget && !options.generate) {
        const validation = validateTestPlanFile(validateTarget);
        if (validation.valid && validation.plan) {
          if (options.json) {
            logger.json({
              valid: true,
              planId: validation.plan.planId,
              name: validation.plan.name,
              scenariosCount: validation.plan.scenarios.length,
              plan: validation.plan,
            });
          } else {
            logger.log(pc.green(`\n✔ Test plan is VALID: ${validateTarget}`));
            logger.log(`  Plan ID:   ${validation.plan.planId}`);
            logger.log(`  Name:      ${validation.plan.name}`);
            logger.log(`  Platform:  ${validation.plan.platform}`);
            logger.log(`  Scenarios: ${validation.plan.scenarios.length}`);
          }
          process.exitCode = 0;
          return;
        } else {
          if (options.json) {
            logger.json({
              valid: false,
              errors: validation.errors,
            });
          } else {
            logger.error(`\n✖ Test plan validation FAILED: ${validateTarget}`);
            logger.error(typeof validation.errors === 'string' ? validation.errors : JSON.stringify(validation.errors, null, 2));
          }
          process.exitCode = 1;
          return;
        }
      }

      // Generation mode
      try {
        const target = options.target || (!validateTarget ? fileOrTarget : undefined);
        const plan = generateTestPlan({
          target,
          platform: options.platform,
          name: options.name,
          configPath: options.config,
        });

        if (options.out) {
          const outPath = path.resolve(process.cwd(), options.out);
          const outDir = path.dirname(outPath);
          if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
          }
          fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), 'utf8');
        }

        if (options.json) {
          logger.json(plan);
        } else {
          logger.log(pc.bold('\n✔ Generated Test Plan Successfully\n'));
          logger.log(`Plan ID:    ${pc.cyan(plan.planId)}`);
          logger.log(`Name:       ${plan.name}`);
          logger.log(`Target:     ${pc.cyan(plan.targetApp)} (${plan.platform})`);
          logger.log(`Scenarios:  ${plan.scenarios.length}`);

          const table = createTable({
            head: ['Scenario ID', 'Title', 'Platform', 'Steps', 'Tags'].map(h => pc.bold(h)),
          });
          for (const s of plan.scenarios) {
            table.push([
              s.id,
              s.title,
              s.platform,
              s.steps.length,
              s.tags.join(', '),
            ]);
          }
          logger.log(table.toString());

          if (options.out) {
            logger.log(`\nSaved to: ${pc.cyan(options.out)}`);
          }
        }
        process.exitCode = 0;
      } catch (err: any) {
        if (options.json) {
          logger.json({ success: false, error: err.message });
        } else {
          logger.error(`\n✖ Failed to generate test plan: ${err.message}`);
        }
        process.exitCode = 1;
      }
    });
}
