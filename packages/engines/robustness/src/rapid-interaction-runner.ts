import { PlatformAdapter } from '@agentic-qa/core';
import {
  Finding,
  EvidenceArtifact,
  ActionSpec,
  FindingSchema,
} from '@agentic-qa/schemas';
import {
  RapidInteractionOptions,
  RapidInteractionResult,
  createActionSpec,
  createAssertionSpec,
} from './types.js';

/**
 * RapidInteractionRunner executes the Mandatory 500 Rapid Button Interactions Test.
 * It stress-tests button debouncing, concurrency, race conditions, UI responsiveness,
 * and duplicate submission prevention.
 */
export class RapidInteractionRunner {
  constructor(private readonly adapter: PlatformAdapter) {}

  /**
   * Executes the rapid button interaction test suite.
   */
  async run(options: RapidInteractionOptions): Promise<RapidInteractionResult> {
    const startTime = Date.now();
    const count = options.rapidClickCount ?? 500;
    const hangThresholdMs = options.hangThresholdMs ?? 5000;
    const batchSize = options.batchSize ?? 50;
    const dispatchMode = options.dispatchMode ?? 'burst';
    const evidenceList: EvidenceArtifact[] = [];
    const unhandledExceptions: string[] = [];

    // 1. Locate button and record initial state
    const existsAssertion = await this.adapter.executeAssertion(
      createAssertionSpec({
        type: 'elementExists',
        target: options.targetButton,
        message: `Checking if target button '${options.targetButton}' exists`,
      })
    );

    const enabledAssertion = await this.adapter.executeAssertion(
      createAssertionSpec({
        type: 'elementEnabled',
        target: options.targetButton,
        message: `Checking if target button '${options.targetButton}' is initially enabled`,
      })
    );

    const initialState = {
      exists: existsAssertion.passed,
      enabled: enabledAssertion.passed,
    };

    if (!initialState.exists) {
      const now = new Date().toISOString();
      const finding: Finding = FindingSchema.parse({
        id: `FIND-RAPID-NOTFOUND-${Date.now()}`,
        title: `Target button not found: ${options.targetButton}`,
        description: `Rapid interaction runner could not locate target button '${options.targetButton}' on initial inspection.`,
        severity: 'CRITICAL',
        status: 'CONFIRMED',
        fixVerification: 'UNVERIFIED',
        platform: this.adapter.platform,
        preconditions: [`Target button selector: ${options.targetButton}`],
        reproductionSteps: [
          `1. Navigate to target view.`,
          `2. Search for element with selector '${options.targetButton}'.`,
          `3. Element was not found in the DOM or accessibility tree.`,
        ],
        expectedBehavior: `Element '${options.targetButton}' must exist and be visible before running rapid interactions.`,
        actualBehavior: `Element '${options.targetButton}' does not exist.`,
        evidenceIds: [],
        reproducibilityCount: 1,
        reproducibilitySuccessRate: 1.0,
        detectedAt: now,
        metadata: { targetButton: options.targetButton },
      });

      return {
        passed: false,
        targetButton: options.targetButton,
        initialState,
        eventsIssued: 0,
        eventsAccepted: 0,
        eventsRejected: 0,
        buttonDisabledAfterTrigger: false,
        duplicateSubmissionsDetected: false,
        duplicateCount: 0,
        uiHung: false,
        hangDurationMs: 0,
        unhandledExceptions: [`Button '${options.targetButton}' does not exist`],
        durationMs: Date.now() - startTime,
        finding,
        evidence: [],
      };
    }

    // 2. Trigger initial action that should cause button to become disabled or debounced
    const triggerAction: ActionSpec = options.triggerAction ?? createActionSpec({
      type: 'click',
      target: options.targetButton,
      description: `Initial activation trigger for button '${options.targetButton}'`,
    });

    const triggerResult = await this.adapter.executeAction(triggerAction);
    if (!triggerResult.success && triggerResult.error) {
      unhandledExceptions.push(`Trigger action error: ${triggerResult.error}`);
    }

    // Check if button disabled itself immediately following the trigger
    const postTriggerDisabledCheck = await this.adapter.executeAssertion(
      createAssertionSpec({
        type: 'elementDisabled',
        target: options.targetButton,
        message: `Verifying button '${options.targetButton}' is disabled after initial trigger`,
      })
    );
    const buttonDisabledAfterTrigger = postTriggerDisabledCheck.passed;

    // 3. Attempt rapid activation events (default: 500)
    let eventsIssued = 0;
    let eventsAccepted = 0;
    let eventsRejected = 0;

    if (dispatchMode === 'native') {
      // Platform adapter native implementation for rapid clicks (if supported)
      eventsIssued = count;
      const nativeResult = await this.adapter.executeAction(
        createActionSpec({
          type: 'rapidClicks',
          target: options.targetButton,
          value: count,
          description: `Rapid burst of ${count} clicks`,
        })
      );

      if (nativeResult.output && typeof nativeResult.output === 'object') {
        eventsAccepted =
          nativeResult.output.eventsAccepted ??
          nativeResult.output.accepted ??
          (buttonDisabledAfterTrigger ? 0 : nativeResult.success ? 1 : 0);
        eventsRejected =
          nativeResult.output.eventsRejected ??
          nativeResult.output.rejected ??
          (count - eventsAccepted);
      } else if (nativeResult.success) {
        // If native succeeded, 0 accepted if disabled after trigger, else 1
        eventsAccepted = buttonDisabledAfterTrigger ? 0 : 1;
        eventsRejected = count - eventsAccepted;
      } else {
        eventsAccepted = 0;
        eventsRejected = count;
      }

      if (nativeResult.error) {
        unhandledExceptions.push(`Native rapid click error: ${nativeResult.error}`);
      }
    } else if (dispatchMode === 'burst') {
      // Concurrent batches simulating real-world race condition hammering
      const batches = Math.ceil(count / batchSize);
      for (let b = 0; b < batches; b++) {
        const currentBatchSize = Math.min(batchSize, count - eventsIssued);
        const promises = Array.from({ length: currentBatchSize }, (_, idx) => {
          const actionIndex = eventsIssued + idx + 1;
          return this.adapter.executeAction(
            createActionSpec({
              type: 'click',
              target: options.targetButton,
              metadata: { rapidInteractionIndex: actionIndex },
            })
          ).catch((err) => ({
            success: false,
            durationMs: 0,
            error: err.message,
          }));
        });

        const results = await Promise.all(promises);
        eventsIssued += results.length;

        for (const res of results) {
          if (res.success) {
            // If the button is disabled or debounced, the click should not have been accepted
            if (buttonDisabledAfterTrigger) {
              // Action accepted despite button being disabled -> debouncing / race bug
              eventsAccepted++;
            } else {
              eventsAccepted++;
            }
          } else {
            eventsRejected++;
            if (res.error && !res.error.toLowerCase().includes('disabled') && !res.error.toLowerCase().includes('debounce')) {
              unhandledExceptions.push(`Event rejected with error: ${res.error}`);
            }
          }
        }
      }
    } else {
      // Sequential dispatch
      for (let i = 0; i < count; i++) {
        eventsIssued++;
        try {
          const res = await this.adapter.executeAction(
            createActionSpec({
              type: 'click',
              target: options.targetButton,
              metadata: { rapidInteractionIndex: i + 1 },
            })
          );
          if (res.success) {
            eventsAccepted++;
          } else {
            eventsRejected++;
            if (res.error && !res.error.toLowerCase().includes('disabled') && !res.error.toLowerCase().includes('debounce')) {
              unhandledExceptions.push(`Sequential event error: ${res.error}`);
            }
          }
        } catch (err: any) {
          eventsRejected++;
          unhandledExceptions.push(err.message);
        }
      }
    }

    // 4. Check for duplicate submissions or server race conditions
    let duplicateSubmissionsDetected = false;
    let duplicateCount = 0;

    if (options.checkDuplicateSubmissions) {
      try {
        const dupCheck = await options.checkDuplicateSubmissions();
        duplicateSubmissionsDetected = dupCheck.duplicateDetected;
        duplicateCount = dupCheck.count;
      } catch (err: any) {
        unhandledExceptions.push(`Duplicate submission check failed: ${err.message}`);
      }
    } else {
      // If no custom checker, debouncing failure is indicated by accepting multiple events
      // after the initial trigger was already fired
      if (eventsAccepted > 0 && buttonDisabledAfterTrigger) {
        duplicateSubmissionsDetected = true;
        duplicateCount = eventsAccepted;
      } else if (eventsAccepted > 1) {
        duplicateSubmissionsDetected = true;
        duplicateCount = eventsAccepted;
      }
    }

    // 5. Check if the UI hung or threw unhandled exceptions
    const hangCheckStart = Date.now();
    let uiHung = false;

    try {
      const pingPromise = this.adapter.executeAssertion(
        createAssertionSpec({
          type: 'elementExists',
          target: options.targetButton,
        })
      );

      const timeoutPromise = new Promise<{ passed: boolean }>((_, reject) =>
        setTimeout(() => reject(new Error('UI responsiveness probe timed out')), hangThresholdMs)
      );

      await Promise.race([pingPromise, timeoutPromise]);
    } catch (err: any) {
      uiHung = true;
      unhandledExceptions.push(`UI hung / unresponsive after rapid interactions: ${err.message}`);
    }

    const hangDurationMs = Date.now() - hangCheckStart;
    if (hangDurationMs >= hangThresholdMs) {
      uiHung = true;
    }

    // Check console errors
    try {
      const consoleCheck = await this.adapter.executeAssertion(
        createAssertionSpec({
          type: 'consoleClean',
        })
      );
      if (!consoleCheck.passed && consoleCheck.message) {
        unhandledExceptions.push(consoleCheck.message);
      }
    } catch {
      // Console assertion might not be supported on all adapters
    }

    // Check network failures
    try {
      const networkCheck = await this.adapter.executeAssertion(
        createAssertionSpec({
          type: 'noNetworkFailures',
        })
      );
      if (!networkCheck.passed && networkCheck.message) {
        unhandledExceptions.push(networkCheck.message);
      }
    } catch {
      // Network assertion might not be supported on all adapters
    }

    // 6. Evaluate overall pass/fail & generate CONFIRMED finding if needed
    const debouncingFailed = (!buttonDisabledAfterTrigger && eventsAccepted > 0) || duplicateSubmissionsDetected;
    const hasUnhandledExceptions = unhandledExceptions.length > 0;
    const passed = !debouncingFailed && !uiHung && !hasUnhandledExceptions;

    let finding: Finding | undefined;

    if (!passed) {
      // Try capturing evidence snapshot
      try {
        const ev = await this.adapter.captureEvidence(
          'SCREENSHOT',
          `Evidence of rapid button interaction failure on ${options.targetButton}`
        );
        evidenceList.push(ev);
      } catch {
        // Evidence capture optional
      }

      const now = new Date().toISOString();
      const findingSeverity = uiHung || duplicateSubmissionsDetected ? 'CRITICAL' : 'HIGH';

      let failureTitle = `Rapid interaction test failed on '${options.targetButton}'`;
      if (uiHung) {
        failureTitle = `UI hung after ${eventsIssued} rapid interactions on '${options.targetButton}'`;
      } else if (duplicateSubmissionsDetected) {
        failureTitle = `Debouncing failed: ${duplicateCount} duplicate actions accepted on '${options.targetButton}'`;
      } else if (hasUnhandledExceptions) {
        failureTitle = `Unhandled exceptions during rapid interactions on '${options.targetButton}'`;
      }

      finding = FindingSchema.parse({
        id: `FIND-RAPID-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        title: failureTitle,
        description:
          `Rapid interaction runner executed ${eventsIssued} rapid activation events on '${options.targetButton}'. ` +
          `Stats: ${eventsAccepted} accepted, ${eventsRejected} rejected. ` +
          `Button disabled after trigger: ${buttonDisabledAfterTrigger ? 'YES' : 'NO'}. ` +
          `Duplicate submissions: ${duplicateSubmissionsDetected ? `YES (${duplicateCount})` : 'NO'}. ` +
          `UI hung: ${uiHung ? 'YES' : 'NO'}. ` +
          `Errors: ${unhandledExceptions.length > 0 ? unhandledExceptions.join('; ') : 'None'}.`,
        severity: findingSeverity,
        status: 'CONFIRMED',
        fixVerification: 'UNVERIFIED',
        platform: this.adapter.platform,
        preconditions: [
          `Target button '${options.targetButton}' exists: ${initialState.exists}`,
          `Initial button enabled: ${initialState.enabled}`,
        ],
        reproductionSteps: [
          `1. Navigate to view with button '${options.targetButton}'.`,
          `2. Record initial button state (enabled: ${initialState.enabled}).`,
          `3. Trigger activation event to start submission/debounce.`,
          `4. Dispatch ${eventsIssued} rapid activation events without delay.`,
          `5. Observe: ${eventsAccepted} accepted, ${eventsRejected} rejected, duplicate submissions: ${duplicateSubmissionsDetected}, UI hung: ${uiHung}.`,
        ],
        expectedBehavior:
          `Button '${options.targetButton}' must be disabled or debounced immediately upon activation. ` +
          `All subsequent rapid activation events (${count}) must be rejected, preventing duplicate submissions, server race conditions, and UI hangs.`,
        actualBehavior:
          `Button accepted ${eventsAccepted} events and rejected ${eventsRejected} events. ` +
          `Duplicate submissions detected: ${duplicateSubmissionsDetected} (count: ${duplicateCount}). ` +
          `UI hung: ${uiHung} (responsiveness probe duration: ${hangDurationMs}ms). ` +
          `Unhandled exceptions: ${unhandledExceptions.length > 0 ? unhandledExceptions.join('; ') : 'none'}.`,
        evidenceIds: evidenceList.map((e) => e.id),
        reproducibilityCount: 1,
        reproducibilitySuccessRate: 1.0,
        logsExcerpt: unhandledExceptions.length > 0 ? unhandledExceptions.join('\n') : undefined,
        detectedAt: now,
        metadata: {
          targetButton: options.targetButton,
          eventsIssued,
          eventsAccepted,
          eventsRejected,
          buttonDisabledAfterTrigger,
          duplicateSubmissionsDetected,
          duplicateCount,
          uiHung,
          hangDurationMs,
          unhandledExceptions,
        },
      });
    }

    return {
      passed,
      targetButton: options.targetButton,
      initialState,
      eventsIssued,
      eventsAccepted,
      eventsRejected,
      buttonDisabledAfterTrigger,
      duplicateSubmissionsDetected,
      duplicateCount,
      uiHung,
      hangDurationMs,
      unhandledExceptions,
      durationMs: Date.now() - startTime,
      finding,
      evidence: evidenceList,
    };
  }
}
