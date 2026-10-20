import {
  TestPlan,
  TestPlanSchema,
  TestCase,
  TestCaseSchema,
  Platform,
} from '@agentic-qa/schemas';
import {
  CreatePlanInput,
  CreatePlanOutput,
  McpServerContext,
} from '../types.js';

export async function handleCreatePlan(
  input: CreatePlanInput,
  context: McpServerContext
): Promise<CreatePlanOutput> {
  const { action } = input;

  if (action === 'validate') {
    if (!input.plan) {
      return {
        valid: false,
        action: 'validate',
        summary: 'Validation failed: No plan object provided in arguments.',
        errors: [{ path: 'plan', message: 'The `plan` parameter is required when action is `validate`.' }],
      };
    }

    const parseResult = TestPlanSchema.safeParse(input.plan);
    if (!parseResult.success) {
      const formattedErrors = parseResult.error.errors.map((err) => ({
        path: err.path.join('.'),
        message: err.message,
        code: err.code,
      }));

      return {
        valid: false,
        action: 'validate',
        summary: `Validation failed with ${formattedErrors.length} schema error(s).`,
        errors: formattedErrors,
      };
    }

    return {
      valid: true,
      action: 'validate',
      scenarioCount: parseResult.data.scenarios.length,
      plan: parseResult.data,
      summary: `Test plan '${parseResult.data.name}' is valid and contains ${parseResult.data.scenarios.length} test scenarios.`,
    };
  }

  // action === 'generate'
  const targetApp = input.targetApp || 'http://localhost:3000';
  const platform: Platform = input.platform || 'web';
  const planType = input.planType || 'smoke';
  const planId = `plan-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const planName = input.name || `${planType.toUpperCase()} Test Plan for ${targetApp}`;

  let scenarios: TestCase[] = [];

  if (input.scenarios && input.scenarios.length > 0) {
    // Validate custom scenarios
    const parsedScenarios: TestCase[] = [];
    for (const [idx, s] of input.scenarios.entries()) {
      const res = TestCaseSchema.safeParse(s);
      if (!res.success) {
        return {
          valid: false,
          action: 'generate',
          summary: `Invalid custom scenario at index ${idx}: ${res.error.message}`,
          errors: res.error.errors.map((e) => ({
            path: `scenarios[${idx}].${e.path.join('.')}`,
            message: e.message,
          })),
        };
      }
      parsedScenarios.push(res.data);
    }
    scenarios = parsedScenarios;
  } else {
    // Generate built-in scenario templates
    scenarios = generateTemplateScenarios(targetApp, platform, planType);
  }

  const generatedPlan: TestPlan = {
    planId,
    name: planName,
    targetApp,
    platform,
    environment: 'local',
    scenarios,
    createdAt: new Date().toISOString(),
    metadata: {
      generatedBy: '@agentic-qa/mcp-server',
      planType,
    },
  };

  // Validate the final plan
  const validated = TestPlanSchema.parse(generatedPlan);

  // Cache in storage
  context.storage.savePlan(validated);

  return {
    valid: true,
    action: 'generate',
    plan: validated,
    scenarioCount: validated.scenarios.length,
    summary: `Generated valid ${planType} test plan '${planName}' with ${validated.scenarios.length} test scenario(s).`,
  };
}

function generateTemplateScenarios(
  targetApp: string,
  platform: Platform,
  planType: 'smoke' | 'regression' | 'accessibility' | 'robustness' | 'custom'
): TestCase[] {
  const timestamp = Date.now();

  if (planType === 'accessibility') {
    return [
      {
        id: `tc-a11y-${timestamp}`,
        title: 'Landing Page Accessibility Audit (WCAG AA)',
        description: 'Navigates to landing page and asserts 0 WCAG accessibility violations.',
        platform,
        timeoutMs: 30000,
        retries: 0,
        tags: ['accessibility', 'wcag2aa'],
        expectedOutcome: 'PASS',
        steps: [
          {
            id: 'step-navigate',
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
            id: 'step-check-a11y',
            description: 'Evaluate WCAG 2.1 AA accessibility rules',
            assertion: {
              type: 'noAccessibilityViolations',
              critical: true,
              metadata: { standards: ['wcag2a', 'wcag2aa'] },
            },
            continueOnFailure: false,
          },
        ],
      },
    ];
  }

  if (planType === 'robustness') {
    return [
      {
        id: `tc-robust-${timestamp}`,
        title: 'UI Resilience & Rapid Interaction Stress Test',
        description: 'Performs rapid interactive clicks and verifies zero unhandled exceptions.',
        platform,
        timeoutMs: 45000,
        retries: 0,
        tags: ['robustness', 'stress'],
        expectedOutcome: 'PASS',
        steps: [
          {
            id: 'step-navigate',
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
            id: 'step-rapid-clicks',
            description: 'Simulate high-frequency rapid click burst (100 clicks)',
            action: {
              type: 'rapidClicks',
              target: 'body',
              value: 100,
              timeoutMs: 10000,
              metadata: {},
            },
            continueOnFailure: false,
          },
          {
            id: 'step-console-clean',
            description: 'Verify console remains clean with zero uncaught runtime exceptions',
            assertion: {
              type: 'consoleClean',
              critical: true,
              metadata: {},
            },
            continueOnFailure: false,
          },
        ],
      },
    ];
  }

  if (planType === 'regression') {
    return [
      {
        id: `tc-regr-${timestamp}`,
        title: 'Core Flow Regression Verification',
        description: 'Verifies critical navigation, element presence, and status 200.',
        platform,
        timeoutMs: 30000,
        retries: 1,
        tags: ['regression'],
        expectedOutcome: 'PASS',
        steps: [
          {
            id: 'step-nav',
            description: `Navigate to ${targetApp}`,
            action: {
              type: 'navigate',
              target: targetApp,
              timeoutMs: 10000,
              metadata: {},
            },
            continueOnFailure: false,
          },
          {
            id: 'step-status',
            description: 'Assert HTTP status is 200',
            assertion: {
              type: 'status200',
              critical: true,
              metadata: {},
            },
            continueOnFailure: false,
          },
        ],
      },
    ];
  }

  // Default: smoke test
  return [
    {
      id: `tc-smoke-${timestamp}`,
      title: 'Target Application Baseline Smoke Test',
      description: 'Navigates to landing page, confirms status 200, and verifies clean console.',
      platform,
      timeoutMs: 30000,
      retries: 0,
      tags: ['smoke', 'baseline'],
      expectedOutcome: 'PASS',
      steps: [
        {
          id: 'step-load',
          description: `Navigate to application at ${targetApp}`,
          action: {
            type: 'navigate',
            target: targetApp,
            timeoutMs: 15000,
            metadata: {},
          },
          continueOnFailure: false,
        },
        {
          id: 'step-assert-status',
          description: 'Assert response status is successful (200)',
          assertion: {
            type: 'status200',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
        {
          id: 'step-assert-console',
          description: 'Assert clean console log with zero fatal exceptions',
          assertion: {
            type: 'consoleClean',
            critical: false,
            metadata: {},
          },
          continueOnFailure: true,
        },
      ],
    },
  ];
}
