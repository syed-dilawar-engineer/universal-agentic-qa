import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  Platform,
  CapabilityDescriptor,
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
} from '../../packages/schemas/src/index.js';
import {
  PlatformAdapter,
  ActionResult,
  AssertionResult,
} from '../../packages/core/src/index.js';

export interface FixtureAdapterOptions {
  id?: string;
  name?: string;
  capabilityState?: 'AVAILABLE' | 'BLOCKED' | 'UNSUPPORTED' | 'UNAVAILABLE';
  missingTools?: string[];
  blockReason?: string;
}

export class FixtureWebAdapter implements PlatformAdapter {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform = 'web';

  private capabilityState: 'AVAILABLE' | 'BLOCKED' | 'UNSUPPORTED' | 'UNAVAILABLE';
  private missingTools: string[];
  private blockReason?: string;

  // Virtual browser state for the fixture app
  public isInitialized = false;
  public targetUrl: string = '';
  public isFixedMode = false;
  public submissionsCount = 0;
  public submitButtonDisabled = false;
  public consoleErrors: string[] = [];
  public brokenActionInvoked = false;
  public currentViewport = { width: 1440, height: 900 };
  public actionsLog: ActionSpec[] = [];
  public capturedEvidence: EvidenceArtifact[] = [];

  constructor(options: FixtureAdapterOptions = {}) {
    this.id = options.id ?? 'fixture-web-adapter';
    this.name = options.name ?? 'Fixture Web Adapter';
    this.capabilityState = options.capabilityState ?? 'AVAILABLE';
    this.missingTools = options.missingTools ?? [];
    this.blockReason = options.blockReason;
  }

  async getCapability(): Promise<CapabilityDescriptor> {
    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: this.capabilityState,
      reason:
        this.capabilityState === 'BLOCKED'
          ? this.blockReason ?? `Missing required tools: ${this.missingTools.join(', ')}`
          : undefined,
      requiredTools: ['node', 'http'],
      missingTools: this.missingTools,
      metadata: { fixture: true },
    };
  }

  setCapabilityState(
    state: 'AVAILABLE' | 'BLOCKED' | 'UNSUPPORTED' | 'UNAVAILABLE',
    missing: string[] = [],
    reason?: string
  ): void {
    this.capabilityState = state;
    this.missingTools = missing;
    this.blockReason = reason;
  }

  async initialize(options?: Record<string, any>): Promise<void> {
    this.isInitialized = true;
    this.targetUrl = options?.url ?? this.targetUrl;
    this.submissionsCount = 0;
    this.submitButtonDisabled = false;
    this.consoleErrors = [];
    this.brokenActionInvoked = false;
    this.actionsLog = [];

    if (options?.viewport) {
      this.currentViewport = options.viewport;
    }

    // Probe the real fixture server via HTTP fetch if URL is provided
    if (this.targetUrl) {
      try {
        const response = await fetch(this.targetUrl);
        const html = await response.text();

        // Detect if fixed mode is enabled in the served HTML or URL
        this.isFixedMode =
          html.includes('window.__FIX_DEFECTS__ = true') ||
          this.targetUrl.includes('fix=true') ||
          this.targetUrl.includes('FIX_DEFECTS=true');
      } catch (err: any) {
        // If server is not responding over HTTP, fall back to URL query inspection
        this.isFixedMode =
          this.targetUrl.includes('fix=true') ||
          this.targetUrl.includes('FIX_DEFECTS=true');
      }
    }
  }

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    this.actionsLog.push(action);
    const start = Date.now();

    switch (action.type) {
      case 'navigate': {
        this.targetUrl = String(action.value ?? action.target ?? '');
        if (action.metadata?.viewport) {
          this.currentViewport = action.metadata.viewport;
        }
        await this.initialize({ url: this.targetUrl, viewport: this.currentViewport });
        return { success: true, durationMs: Date.now() - start };
      }

      case 'rapidClicks': {
        const count = typeof action.value === 'object' && action.value?.count ? action.value.count : 5;
        const target = action.target ?? '#submit-btn';

        if (target === '#submit-btn') {
          if (this.isFixedMode) {
            // FIXED (Bug 1 resolved):
            // Synchronously locks button on click #1. Subsequent clicks rejected!
            if (!this.submitButtonDisabled) {
              this.submitButtonDisabled = true;
              this.submissionsCount = 1;
            }
          } else {
            // DEFECTIVE (Bug 1 present):
            // Asynchronous disable delay allows all rapid successive clicks to register!
            this.submissionsCount = count;
            this.submitButtonDisabled = true; // Disabled only AFTER all clicks registered
          }
        }
        return { success: true, durationMs: Date.now() - start, output: { submissionsCount: this.submissionsCount } };
      }

      case 'click': {
        const target = action.target;

        if (target === '#broken-action-btn') {
          this.brokenActionInvoked = true;
          if (this.isFixedMode) {
            // FIXED (Bug 3 resolved): Safe handler, no console errors
          } else {
            // DEFECTIVE (Bug 3 present): Unhandled TypeError emitted
            this.consoleErrors.push(
              "TypeError: Cannot read properties of undefined (reading 'invokeCrashHandler')"
            );
          }
        } else if (target === '#submit-btn') {
          if (this.isFixedMode) {
            if (!this.submitButtonDisabled) {
              this.submitButtonDisabled = true;
              this.submissionsCount += 1;
            }
          } else {
            this.submissionsCount += 1;
            this.submitButtonDisabled = true;
          }
        }
        return { success: true, durationMs: Date.now() - start };
      }

      case 'wait': {
        const ms = typeof action.value === 'number' ? action.value : 10;
        await new Promise((res) => setTimeout(res, ms));
        return { success: true, durationMs: Date.now() - start };
      }

      default:
        return { success: true, durationMs: Date.now() - start };
    }
  }

  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    const start = Date.now();

    switch (assertion.type) {
      case 'consoleClean': {
        // Bug 3 check: Unhandled console errors
        const passed = this.consoleErrors.length === 0;
        return {
          passed,
          durationMs: Date.now() - start,
          actual: this.consoleErrors.length > 0 ? this.consoleErrors.join('; ') : 'No console errors',
          expected: 'No console errors',
          message: passed
            ? undefined
            : `Unhandled console error detected: ${this.consoleErrors.join('; ')}`,
        };
      }

      case 'noAccessibilityViolations': {
        // Bug 4 check: Accessible name on icon button #icon-search-btn
        const target = assertion.target ?? '#icon-search-btn';
        if (target === '#icon-search-btn') {
          const hasAccessibleName = this.isFixedMode;
          return {
            passed: hasAccessibleName,
            durationMs: Date.now() - start,
            actual: hasAccessibleName
              ? { ariaLabel: 'Search catalog', title: 'Search catalog' }
              : { ariaLabel: null, title: null, text: '' },
            expected: 'Accessible name present (aria-label or title)',
            message: hasAccessibleName
              ? undefined
              : 'Accessibility violation: Button #icon-search-btn has no accessible name (missing aria-label/title) violating WCAG 2.1 AA 4.1.2.',
          };
        }
        return { passed: true, durationMs: Date.now() - start };
      }

      case 'elementTextEquals': {
        // Bug 1 check: Submissions count should be 1
        const target = assertion.target;
        if (target === '#submission-count') {
          const actualText = `Submissions: ${this.submissionsCount}`;
          const passed = actualText === assertion.expected;
          return {
            passed,
            durationMs: Date.now() - start,
            actual: actualText,
            expected: assertion.expected,
            message: passed
              ? undefined
              : `Race condition failure: Expected '${assertion.expected}', but got '${actualText}' (${this.submissionsCount} duplicate submissions recorded).`,
          };
        }
        return { passed: true, durationMs: Date.now() - start };
      }

      case 'custom': {
        // Bug 2 check: Layout overflow on viewport width < 380px
        const target = assertion.target;
        if (target === '#overflow-container') {
          const viewportWidth = this.currentViewport.width;
          // Unfixed layout element has fixed 420px width; fixed layout fits viewportWidth
          const elementScrollWidth = this.isFixedMode ? Math.min(viewportWidth, 800) : 420;
          const overflows = viewportWidth < 380 && elementScrollWidth > viewportWidth;

          return {
            passed: !overflows,
            durationMs: Date.now() - start,
            actual: `${elementScrollWidth}px`,
            expected: `<= ${viewportWidth}px`,
            message: !overflows
              ? undefined
              : `Responsive layout overflow detected: Element width (${elementScrollWidth}px) exceeds viewport width (${viewportWidth}px) causing horizontal scroll.`,
          };
        }
        return { passed: true, durationMs: Date.now() - start };
      }

      case 'elementDisabled': {
        const passed = this.submitButtonDisabled;
        return {
          passed,
          durationMs: Date.now() - start,
          actual: this.submitButtonDisabled,
          expected: true,
          message: passed ? undefined : 'Expected button to be disabled.',
        };
      }

      default:
        return { passed: true, durationMs: Date.now() - start };
    }
  }

  async captureEvidence(type: string, description: string = ''): Promise<EvidenceArtifact> {
    const rawContent = `EVIDENCE_${type}_${Date.now()}_fixed=${this.isFixedMode}_errors=${this.consoleErrors.length}`;
    const hash = crypto.createHash('sha256').update(rawContent).digest('hex');
    const artifactPath = `/tmp/agentic-qa-evidence-${Date.now()}.png`;

    const artifact: EvidenceArtifact = {
      id: `ev-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      type: (type as any) || 'SCREENSHOT',
      path: artifactPath,
      sha256: hash,
      sizeBytes: Buffer.byteLength(rawContent),
      mimeType: type === 'DOM_SNAPSHOT' ? 'text/html' : 'image/png',
      capturedAt: new Date().toISOString(),
      description,
      metadata: {
        viewport: this.currentViewport,
        targetUrl: this.targetUrl,
        isFixedMode: this.isFixedMode,
      },
    };

    this.capturedEvidence.push(artifact);
    return artifact;
  }

  async teardown(): Promise<void> {
    this.isInitialized = false;
  }
}
