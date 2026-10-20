import { PlatformAdapter } from '@agentic-qa/core';
import {
  ActionSpec,
  Finding,
  FindingSchema,
} from '@agentic-qa/schemas';
import { SeededRandom } from './random.js';
import {
  MonkeyError,
  MonkeyExplorerOptions,
  MonkeyExplorerResult,
  MonkeyStep,
  createActionSpec,
  createAssertionSpec,
} from './types.js';

interface StateVisitData {
  visitCount: number;
  elementInteractions: Map<string, number>;
}

/**
 * MonkeyExplorer performs randomized and state-guided exploration of interactable elements.
 * Fully bounded by maximum actions, timeout, and reproducible random seed.
 */
export class MonkeyExplorer {
  constructor(private readonly adapter: PlatformAdapter) {}

  async run(options: MonkeyExplorerOptions = {}): Promise<MonkeyExplorerResult> {
    const startTime = Date.now();
    const maxActions = options.maxActions ?? 50;
    const timeoutMs = options.timeoutMs ?? 30000;
    const seed = options.seed ?? 42;
    const rng = new SeededRandom(seed);

    const allowedActions = options.allowedActions ?? [
      'click',
      'fill',
      'scroll',
      'hover',
      'pressKey',
      'wait',
    ];

    const defaultSelectors = options.interactableSelectors ?? [
      'button',
      'a',
      'input',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[data-testid]',
    ];

    const stateMap = new Map<string, StateVisitData>();
    const trace: MonkeyStep[] = [];
    const errorsCaught: MonkeyError[] = [];
    const findings: Finding[] = [];
    let stateTransitions = 0;

    let currentState = await this.resolveState(options.stateExtractor);
    this.recordStateVisit(stateMap, currentState);

    let stepCount = 0;

    while (stepCount < maxActions && Date.now() - startTime < timeoutMs) {
      stepCount++;
      const stepStartTime = Date.now();

      // State-guided selection: find interactable candidates
      const candidates = options.elementProvider
        ? await options.elementProvider(currentState)
        : defaultSelectors;

      const stateData = stateMap.get(currentState)!;

      // Prioritize unvisited or least-interacted elements in the current state
      const chosenTarget = this.pickStateGuidedTarget(candidates, stateData, rng);
      stateData.elementInteractions.set(
        chosenTarget,
        (stateData.elementInteractions.get(chosenTarget) ?? 0) + 1
      );

      // Choose action type
      const actionType = this.chooseActionType(chosenTarget, allowedActions, rng);
      const actionSpec = this.buildActionSpec(actionType, chosenTarget, rng);

      let actionSuccess = true;
      let actionError: string | undefined;

      try {
        const actionResult = await this.adapter.executeAction(actionSpec);
        actionSuccess = actionResult.success;
        if (!actionResult.success && actionResult.error) {
          actionError = actionResult.error;
        }
      } catch (err: any) {
        actionSuccess = false;
        actionError = err.message;
      }

      // Check application health assertions after action
      const healthError = await this.checkHealthAssertions();
      if (healthError) {
        const errorRecord: MonkeyError = {
          stepNumber: stepCount,
          state: currentState,
          action: actionSpec,
          error: healthError,
          timestamp: new Date().toISOString(),
        };
        errorsCaught.push(errorRecord);

        // Generate CONFIRMED finding for caught error
        const finding: Finding = FindingSchema.parse({
          id: `FIND-MONKEY-${Date.now()}-${stepCount}`,
          title: `Application error during exploratory monkey test at step ${stepCount}`,
          description:
            `Monkey explorer caught unhandled error during exploration at step ${stepCount} ` +
            `in state '${currentState}'. Error: ${healthError}`,
          severity: 'HIGH',
          status: 'CONFIRMED',
          fixVerification: 'UNVERIFIED',
          platform: this.adapter.platform,
          preconditions: [
            `Random seed: ${seed}`,
            `Exploration step: ${stepCount} of ${maxActions}`,
            `Current state: ${currentState}`,
          ],
          reproductionSteps: [
            `1. Initialize MonkeyExplorer with seed ${seed}.`,
            `2. Replay actions 1 through ${stepCount} from the execution trace.`,
            `3. Execute action: ${JSON.stringify(actionSpec)}.`,
            `4. Observe unhandled error: ${healthError}.`,
          ],
          expectedBehavior: `Application must remain stable, responsive, and error-free during exploratory interactions.`,
          actualBehavior: `Caught unhandled error: ${healthError}`,
          evidenceIds: [],
          reproducibilityCount: 1,
          reproducibilitySuccessRate: 1.0,
          logsExcerpt: healthError,
          detectedAt: new Date().toISOString(),
          metadata: {
            seed,
            stepNumber: stepCount,
            state: currentState,
            action: actionSpec,
            totalActionsAtError: stepCount,
          },
        });
        findings.push(finding);
      }

      // Resolve state after action
      const stateAfter = await this.resolveState(options.stateExtractor);
      if (stateAfter !== currentState) {
        stateTransitions++;
        currentState = stateAfter;
        this.recordStateVisit(stateMap, currentState);
      }

      const stepRecord: MonkeyStep = {
        stepNumber: stepCount,
        stateBefore: stateData ? currentState : 'unknown',
        action: actionSpec,
        stateAfter,
        durationMs: Date.now() - stepStartTime,
        success: actionSuccess,
        error: actionError || healthError,
        timestamp: new Date().toISOString(),
      };

      trace.push(stepRecord);
      options.onStep?.(stepRecord);
    }

    const durationMs = Date.now() - startTime;
    const passed = errorsCaught.length === 0 && findings.length === 0;

    return {
      passed,
      seed,
      totalActions: stepCount,
      visitedStates: Array.from(stateMap.keys()),
      stateTransitionCount: stateTransitions,
      trace,
      errorsCaught,
      findings,
      durationMs,
    };
  }

  private async resolveState(customExtractor?: () => Promise<string>): Promise<string> {
    if (customExtractor) {
      try {
        return await customExtractor();
      } catch {
        // Fallback if custom extractor fails
      }
    }

    try {
      const evalRes = await this.adapter.executeAction(
        createActionSpec({
          type: 'evaluate',
          value: 'window.location.pathname + window.location.hash || document.title',
        })
      );
      if (evalRes.success && typeof evalRes.output === 'string' && evalRes.output.trim().length > 0) {
        return evalRes.output;
      }
    } catch {
      // Evaluate not supported on this adapter
    }

    return 'default-root-state';
  }

  private recordStateVisit(stateMap: Map<string, StateVisitData>, state: string): void {
    const existing = stateMap.get(state);
    if (existing) {
      existing.visitCount++;
    } else {
      stateMap.set(state, {
        visitCount: 1,
        elementInteractions: new Map<string, number>(),
      });
    }
  }

  private pickStateGuidedTarget(
    candidates: string[],
    stateData: StateVisitData,
    rng: SeededRandom
  ): string {
    if (candidates.length === 0) return 'body';

    // Find candidates not yet interacted with in this state
    const unvisited = candidates.filter(
      (c) => !stateData.elementInteractions.has(c) || stateData.elementInteractions.get(c) === 0
    );

    if (unvisited.length > 0) {
      return rng.pick(unvisited);
    }

    // Otherwise pick candidate with minimum interaction count (least explored)
    let minCount = Infinity;
    let leastVisited: string[] = [];

    for (const c of candidates) {
      const count = stateData.elementInteractions.get(c) ?? 0;
      if (count < minCount) {
        minCount = count;
        leastVisited = [c];
      } else if (count === minCount) {
        leastVisited.push(c);
      }
    }

    return rng.pick(leastVisited.length > 0 ? leastVisited : candidates);
  }

  private chooseActionType(
    target: string,
    allowed: Array<'click' | 'fill' | 'scroll' | 'hover' | 'pressKey' | 'wait'>,
    rng: SeededRandom
  ): 'click' | 'fill' | 'scroll' | 'hover' | 'pressKey' | 'wait' {
    const isTextInput =
      target.includes('input') ||
      target.includes('textarea') ||
      target.includes('search') ||
      target.includes('field');

    if (isTextInput && allowed.includes('fill')) {
      // 70% chance to fill text input
      if (rng.next() < 0.7) {
        return 'fill';
      }
    }

    const isClickable =
      target.includes('button') ||
      target.includes('a') ||
      target.includes('link') ||
      target.includes('checkbox');

    if (isClickable && allowed.includes('click')) {
      // 80% chance to click button/link
      if (rng.next() < 0.8) {
        return 'click';
      }
    }

    return rng.pick(allowed);
  }

  private buildActionSpec(
    type: 'click' | 'fill' | 'scroll' | 'hover' | 'pressKey' | 'wait',
    target: string,
    rng: SeededRandom
  ): ActionSpec {
    switch (type) {
      case 'click':
        return createActionSpec({
          type: 'click',
          target,
          timeoutMs: 3000,
          description: `Monkey click on ${target}`,
        });
      case 'fill': {
        const sampleStrings = [
          'test_input',
          'random_monkey_data',
          '12345',
          'admin@example.com',
          'Special!@#$',
        ];
        return createActionSpec({
          type: 'fill',
          target,
          value: rng.pick(sampleStrings),
          timeoutMs: 3000,
          description: `Monkey fill on ${target}`,
        });
      }
      case 'scroll': {
        const deltaY = rng.nextInt(-300, 300);
        return createActionSpec({
          type: 'scroll',
          target,
          value: { x: 0, y: deltaY },
          timeoutMs: 2000,
          description: `Monkey scroll on ${target} by dy=${deltaY}`,
        });
      }
      case 'hover':
        return createActionSpec({
          type: 'hover',
          target,
          timeoutMs: 2000,
          description: `Monkey hover on ${target}`,
        });
      case 'pressKey': {
        const keys = ['Tab', 'Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'Space'];
        const chosenKey = rng.pick(keys);
        return createActionSpec({
          type: 'pressKey',
          target,
          value: chosenKey,
          timeoutMs: 2000,
          description: `Monkey pressKey ${chosenKey} on ${target}`,
        });
      }
      case 'wait': {
        const waitMs = rng.nextInt(50, 200);
        return createActionSpec({
          type: 'wait',
          value: waitMs,
          timeoutMs: 1000,
          description: `Monkey wait ${waitMs}ms`,
        });
      }
    }
  }

  private async checkHealthAssertions(): Promise<string | undefined> {
    try {
      const consoleCheck = await this.adapter.executeAssertion(
        createAssertionSpec({
          type: 'consoleClean',
        })
      );
      if (!consoleCheck.passed && consoleCheck.message) {
        return `Console error: ${consoleCheck.message}`;
      }
    } catch {
      // Ignored if assertion not supported
    }

    try {
      const networkCheck = await this.adapter.executeAssertion(
        createAssertionSpec({
          type: 'noNetworkFailures',
        })
      );
      if (!networkCheck.passed && networkCheck.message) {
        return `Network failure: ${networkCheck.message}`;
      }
    } catch {
      // Ignored if assertion not supported
    }

    return undefined;
  }
}
