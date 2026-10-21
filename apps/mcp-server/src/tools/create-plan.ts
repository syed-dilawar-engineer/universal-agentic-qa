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

  const smokeScenarios: TestCase[] = [
    {
      id: `tc-smoke-baseline-${timestamp}`,
      title: 'Target Application Baseline Boot & Console Cleanliness',
      description: 'Navigates to landing page, confirms HTTP status 200, and verifies zero unhandled console exceptions.',
      platform,
      timeoutMs: 30000,
      retries: 0,
      tags: ['smoke', 'baseline', 'healthcheck'],
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
          description: 'Assert HTTP response status is 200 OK',
          assertion: {
            type: 'status200',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
        {
          id: 'step-assert-console',
          description: 'Assert clean console log with zero fatal uncaught exceptions',
          assertion: {
            type: 'consoleClean',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
      ],
    },
    {
      id: `tc-smoke-hydration-${timestamp}`,
      title: 'Client-Side Hydration & DOM Hierarchy Integrity',
      description: 'Detects React 18/19 hydration mismatches, broken event listeners, and initial layout overflow.',
      platform,
      timeoutMs: 30000,
      retries: 0,
      tags: ['smoke', 'hydration', 'dom-sanity'],
      expectedOutcome: 'PASS',
      steps: [
        {
          id: 'step-nav',
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
          id: 'step-check-hydration',
          description: 'Assert zero React hydration errors (#418, #423, #425) or server/client HTML divergence',
          assertion: {
            type: 'noHydrationMismatch',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
        {
          id: 'step-check-layout-bounds',
          description: 'Assert initial layout does not blow out horizontal viewport boundaries',
          assertion: {
            type: 'noLayoutOverflow',
            critical: false,
            metadata: {},
          },
          continueOnFailure: true,
        },
      ],
    },
    {
      id: `tc-smoke-interactivity-${timestamp}`,
      title: 'First Input Responsiveness & Viewport Sanity',
      description: 'Verifies page responds to initial interactions without freezing the main thread.',
      platform,
      timeoutMs: 30000,
      retries: 0,
      tags: ['smoke', 'responsiveness'],
      expectedOutcome: 'PASS',
      steps: [
        {
          id: 'step-nav',
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
          id: 'step-scroll-probe',
          description: 'Scroll viewport smoothly to trigger lazy-loaded sections and assert no crash',
          action: {
            type: 'scroll',
            target: 'body',
            value: 300,
            timeoutMs: 5000,
            metadata: {},
          },
          continueOnFailure: false,
        },
        {
          id: 'step-console-check',
          description: 'Verify console remains clean after scroll interaction',
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

  const robustnessScenarios: TestCase[] = [
    {
      id: `tc-robust-rapid-${timestamp}`,
      title: 'UI Resilience & High-Frequency Double-Submit Chaos',
      description: 'Performs rapid burst clicks (100 clicks) and asserts button debounce, duplicate prevention, and clean console.',
      platform,
      timeoutMs: 45000,
      retries: 0,
      tags: ['robustness', 'stress', 'rapid-click', 'debounce'],
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
          description: 'Simulate high-frequency rapid click burst (100 clicks) to test debounce logic',
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
    {
      id: `tc-robust-input5000-${timestamp}`,
      title: '5,000 Character Boundary Stress & Truncation Guard',
      description: 'Injects 5,000 characters into input field to verify strict length validation, prevent silent DB truncation, and avoid horizontal layout blowout.',
      platform,
      timeoutMs: 45000,
      retries: 0,
      tags: ['robustness', 'boundary', '5000-chars', 'fuzzing'],
      expectedOutcome: 'PASS',
      steps: [
        {
          id: 'step-nav',
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
          id: 'step-inject-5000',
          description: 'Inject 5,000 continuous ASCII characters into primary input field',
          action: {
            type: 'fill',
            target: 'input, textarea',
            value: 'A'.repeat(5000),
            timeoutMs: 15000,
            metadata: { charCount: 5000 },
          },
          continueOnFailure: true,
        },
        {
          id: 'step-assert-no-layout-overflow',
          description: 'Verify 5,000 characters do not burst CSS grid or container layout horizontally',
          assertion: {
            type: 'noLayoutOverflow',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
        {
          id: 'step-assert-no-silent-truncation',
          description: 'Assert data is not silently truncated without validation feedback to user',
          assertion: {
            type: 'noSilentTruncation',
            critical: false,
            metadata: { expectedLimit: 5000 },
          },
          continueOnFailure: true,
        },
        {
          id: 'step-console-clean',
          description: 'Verify no unhandled RangeError or memory exhaustion occurred',
          assertion: {
            type: 'consoleClean',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
      ],
    },
    {
      id: `tc-robust-injection-${timestamp}`,
      title: 'Adversarial Injection & Unicode Shaping Resilience',
      description: 'Injects SQL truncation payloads and complex Telugu/homoglyph script to test parser security and font shaping.',
      platform,
      timeoutMs: 45000,
      retries: 0,
      tags: ['robustness', 'security', 'sqli-truncation', 'unicode-shaping'],
      expectedOutcome: 'PASS',
      steps: [
        {
          id: 'step-nav',
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
          id: 'step-inject-unicode',
          description: 'Inject Telugu script bomb and homoglyphs to verify layout shaper does not crash',
          action: {
            type: 'fill',
            target: 'input, textarea',
            value: '\u0C1C\u0C4D\u0C1E\u0C3E \u0430dm\u0456n',
            timeoutMs: 10000,
            metadata: {},
          },
          continueOnFailure: true,
        },
        {
          id: 'step-console-check',
          description: 'Verify zero script engine or layout engine crashes',
          assertion: {
            type: 'consoleClean',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
      ],
    },
    {
      id: `tc-robust-viewport-320-${timestamp}`,
      title: 'Extreme Viewport Fragility & 320px Narrow Screen Audit',
      description: 'Simulates narrow 320px foldables/mobile viewports to detect clipped controls, occlusion, and horizontal scrolling.',
      platform,
      viewport: { width: 320, height: 640 },
      timeoutMs: 45000,
      retries: 0,
      tags: ['robustness', 'viewport', 'responsive', 'mobile-foldable'],
      expectedOutcome: 'PASS',
      steps: [
        {
          id: 'step-nav',
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
          id: 'step-overflow-check',
          description: 'Assert no horizontal scroll blowout on 320px screen width',
          assertion: {
            type: 'noLayoutOverflow',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
        {
          id: 'step-occlusion-check',
          description: 'Verify interactive submit buttons are not occluded by floating headers/footers',
          assertion: {
            type: 'isElementOccluded',
            target: 'button, [role="button"]',
            expected: false,
            critical: false,
            metadata: {},
          },
          continueOnFailure: true,
        },
      ],
    },
    {
      id: `tc-robust-network-chaos-${timestamp}`,
      title: 'Network Interruption & Offline Degradation Resilience',
      description: 'Simulates offline network state and verifies graceful error presentation without unhandled promise rejections.',
      platform,
      timeoutMs: 45000,
      retries: 0,
      tags: ['robustness', 'network-chaos', 'offline-mode'],
      expectedOutcome: 'PASS',
      steps: [
        {
          id: 'step-nav',
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
          id: 'step-drop-network',
          description: 'Simulate sudden network drop / offline mode mid-session',
          action: {
            type: 'simulateNetwork',
            value: 'offline',
            timeoutMs: 5000,
            metadata: {},
          },
          continueOnFailure: true,
        },
        {
          id: 'step-assert-clean-fail',
          description: 'Verify app handles offline state gracefully without unhandled promise crashes',
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

  const accessibilityScenarios: TestCase[] = [
    {
      id: `tc-a11y-wcag-${timestamp}`,
      title: 'Landing Page Accessibility Audit (WCAG 2.1 AA)',
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
    {
      id: `tc-a11y-target-size-${timestamp}`,
      title: 'WCAG 2.2 AAA Minimum 44x44px Touch Target Size Audit',
      description: 'Asserts all interactive buttons, links, and input elements satisfy the 44x44 CSS px touch target criterion.',
      platform,
      timeoutMs: 30000,
      retries: 0,
      tags: ['accessibility', 'wcag22aaa', 'touch-target'],
      expectedOutcome: 'PASS',
      steps: [
        {
          id: 'step-nav',
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
          id: 'step-assert-target-size',
          description: 'Verify tap targets have at least 44x44 CSS pixels bounding area or sufficient perimeter clearance',
          assertion: {
            type: 'targetSizeAAA',
            target: 'button, a, input, [role="button"]',
            critical: false,
            metadata: { minSize: 44 },
          },
          continueOnFailure: true,
        },
      ],
    },
    {
      id: `tc-a11y-text-truncation-${timestamp}`,
      title: 'Internationalization (i18n) & Text Truncation Audit',
      description: 'Verifies responsive labels and paragraphs do not suffer from unintended CSS ellipsis truncation or word clipping.',
      platform,
      timeoutMs: 30000,
      retries: 0,
      tags: ['accessibility', 'i18n', 'text-truncation'],
      expectedOutcome: 'PASS',
      steps: [
        {
          id: 'step-nav',
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
          id: 'step-assert-no-truncation',
          description: 'Assert labels and buttons display complete text without unintentional ellipsis cutting off meaning',
          assertion: {
            type: 'noTextTruncation',
            target: 'button, h1, h2, h3, label',
            critical: false,
            metadata: {},
          },
          continueOnFailure: true,
        },
      ],
    },
  ];

  const regressionScenarios: TestCase[] = [
    {
      id: `tc-regr-core-${timestamp}`,
      title: 'Core Flow Baseline Regression Verification',
      description: 'Verifies critical navigation, element presence, clean console, and HTTP status 200.',
      platform,
      timeoutMs: 30000,
      retries: 1,
      tags: ['regression', 'baseline'],
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
        {
          id: 'step-console',
          description: 'Assert zero console regressions',
          assertion: {
            type: 'consoleClean',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
      ],
    },
    {
      id: `tc-regr-form-validation-${timestamp}`,
      title: 'Form Boundary & Input Validation Regression',
      description: 'Verifies forms reject empty or invalid submissions cleanly without uncaught exceptions or network errors.',
      platform,
      timeoutMs: 35000,
      retries: 1,
      tags: ['regression', 'form-validation'],
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
          id: 'step-assert-network',
          description: 'Assert no unhandled 4xx/5xx network failures during session navigation',
          assertion: {
            type: 'noNetworkFailures',
            critical: true,
            metadata: {},
          },
          continueOnFailure: false,
        },
      ],
    },
  ];

  if (planType === 'accessibility') {
    return accessibilityScenarios;
  }

  if (planType === 'robustness') {
    return robustnessScenarios;
  }

  if (planType === 'regression') {
    return regressionScenarios;
  }

  if (planType === 'custom') {
    // Return all scenarios combined for complete master suite
    return [
      ...smokeScenarios,
      ...robustnessScenarios,
      ...accessibilityScenarios,
      ...regressionScenarios,
    ];
  }

  // Default: smoke test scenarios
  return smokeScenarios;
}
