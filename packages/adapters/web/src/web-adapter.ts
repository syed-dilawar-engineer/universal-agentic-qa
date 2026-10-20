import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  Platform,
  PlatformSchema,
  CapabilityDescriptor,
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
  EvidenceType,
} from '@agentic-qa/schemas';
import {
  PlatformAdapter,
  ActionResult,
  AssertionResult,
  QAAdapterError,
} from '@agentic-qa/core';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  WebAdapterOptions,
  BrowserName,
  ConsoleEntry,
  NetworkFailureEntry,
  NetworkRequestEntry,
  LayoutCheckResult,
  resolveViewport,
  VIEWPORT_MATRIX,
} from './types.js';
import { checkPageLayout } from './layout-checker.js';

export class WebAdapter implements PlatformAdapter {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform = 'web';

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  private consoleErrors: ConsoleEntry[] = [];
  private consoleLogs: ConsoleEntry[] = [];
  private networkFailures: NetworkFailureEntry[] = [];
  private networkRequests: NetworkRequestEntry[] = [];

  private options: WebAdapterOptions;
  private outputDir: string;
  private isInitialized = false;

  constructor(options: WebAdapterOptions = {}) {
    this.id = options.id || 'web-adapter';
    this.name = options.name || 'Playwright Web Adapter';
    this.options = { ...options };
    this.outputDir = options.outputDir || path.resolve(process.cwd(), '.qa-output');
  }

  /**
   * Probe whether Chromium/Playwright browsers are installed.
   * If missing or launch fails, report BLOCKED with clear instructions to run `npx playwright install`.
   */
  async getCapability(): Promise<CapabilityDescriptor> {
    const browserType: BrowserName = this.options.browserType || 'chromium';
    const requiredTools = ['playwright', browserType];

    try {
      // Dynamic import to avoid hard crash if playwright is not resolvable
      const pw = await import('playwright');
      const launcher = pw[browserType];

      if (!launcher) {
        return {
          id: this.id,
          name: this.name,
          platform: this.platform,
          state: 'UNSUPPORTED',
          reason: `Browser type "${browserType}" is not supported by Playwright. Supported: chromium, firefox, webkit.`,
          requiredTools,
          missingTools: [browserType],
          metadata: { supportedBrowsers: ['chromium', 'firefox', 'webkit'] },
        };
      }

      // Check executable path
      let execPath: string | undefined;
      try {
        execPath = launcher.executablePath();
      } catch (err: any) {
        return {
          id: this.id,
          name: this.name,
          platform: this.platform,
          state: 'BLOCKED',
          reason: `Playwright ${browserType} browser is not installed: ${err.message}. Please run "npx playwright install ${browserType}" or "npx playwright install" to install required browsers.`,
          requiredTools,
          missingTools: [browserType],
          metadata: { error: err.message },
        };
      }

      if (!execPath || !fs.existsSync(execPath)) {
        return {
          id: this.id,
          name: this.name,
          platform: this.platform,
          state: 'BLOCKED',
          reason: `Browser executable does not exist at "${execPath}". Please run "npx playwright install ${browserType}" or "npx playwright install" to install required browsers.`,
          requiredTools,
          missingTools: [browserType],
          metadata: { executablePath: execPath },
        };
      }

      // Perform a lightweight probe launch to confirm executable operates correctly
      try {
        const probeBrowser = await launcher.launch({ headless: true });
        const version = probeBrowser.version();
        await probeBrowser.close();

        return {
          id: this.id,
          name: this.name,
          platform: this.platform,
          state: 'AVAILABLE',
          reason: `Playwright ${browserType} is installed and executable.`,
          requiredTools,
          missingTools: [],
          version,
          metadata: {
            browserType,
            executablePath: execPath,
            version,
          },
        };
      } catch (launchErr: any) {
        return {
          id: this.id,
          name: this.name,
          platform: this.platform,
          state: 'BLOCKED',
          reason: `Failed to launch ${browserType} (${launchErr.message}). Please run "npx playwright install ${browserType}" or "npx playwright install" to reinstall browsers and system dependencies.`,
          requiredTools,
          missingTools: [browserType],
          metadata: { executablePath: execPath, error: launchErr.message },
        };
      }
    } catch (importErr: any) {
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'BLOCKED',
        reason: `Playwright package is not available or failed to load: ${importErr.message}. Run "pnpm add playwright" and "npx playwright install".`,
        requiredTools,
        missingTools: ['playwright'],
        metadata: { error: importErr.message },
      };
    }
  }

  /**
   * Initializes browser session with configured browser engine and viewport matrix.
   */
  async initialize(options?: Record<string, any>): Promise<void> {
    const merged: WebAdapterOptions = { ...this.options, ...options };
    this.options = merged;

    if (merged.outputDir) {
      this.outputDir = path.resolve(process.cwd(), merged.outputDir);
    }

    // Reset runtime tracking stores
    this.consoleErrors = [];
    this.consoleLogs = [];
    this.networkFailures = [];
    this.networkRequests = [];

    // Allow mock browser/page injection for testing
    if (merged.customPage) {
      this.page = merged.customPage;
      this.context = merged.customContext;
      this.browser = merged.customBrowser;
      this.setupPageListeners(this.page!);
      this.isInitialized = true;
      return;
    }

    const browserType: BrowserName = merged.browserType || 'chromium';
    const resolvedViewport = resolveViewport(merged.viewport, merged.viewportWidth);

    const pw = await import('playwright');
    const launcher = pw[browserType];
    if (!launcher) {
      throw new QAAdapterError(
        `Invalid browser type "${browserType}". Supported: chromium, firefox, webkit.`,
        this.name
      );
    }

    this.browser = await launcher.launch({
      headless: merged.headless ?? true,
      ...merged.launchOptions,
    });

    this.context = await this.browser.newContext({
      viewport: resolvedViewport,
      ...merged.contextOptions,
    });

    this.page = await this.context.newPage();
    this.setupPageListeners(this.page);
    this.isInitialized = true;
  }

  /**
   * Configures listeners on the Playwright Page to track unhandled console errors and failed HTTP requests.
   */
  private setupPageListeners(page: Page): void {
    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      const loc = msg.location();
      const location = loc?.url ? `${loc.url}:${loc.lineNumber ?? 0}` : undefined;

      const entry: ConsoleEntry = {
        type,
        text,
        location,
        timestamp: new Date().toISOString(),
      };

      this.consoleLogs.push(entry);
      if (type === 'error') {
        this.consoleErrors.push(entry);
      }
    });

    page.on('pageerror', (err) => {
      const entry: ConsoleEntry = {
        type: 'pageerror',
        text: err.message || String(err),
        location: err.stack,
        timestamp: new Date().toISOString(),
      };

      this.consoleErrors.push(entry);
      this.consoleLogs.push(entry);
    });

    page.on('response', (res) => {
      const status = res.status();
      const entry: NetworkRequestEntry = {
        url: res.url(),
        method: res.request()?.method() || 'GET',
        status,
        statusText: res.statusText(),
        timestamp: new Date().toISOString(),
      };

      this.networkRequests.push(entry);

      if (status >= 400) {
        this.networkFailures.push({
          url: res.url(),
          method: entry.method,
          status,
          statusText: res.statusText(),
          timestamp: entry.timestamp,
        });
      }
    });

    page.on('requestfailed', (req) => {
      const failure = req.failure();
      this.networkFailures.push({
        url: req.url(),
        method: req.method(),
        errorText: failure?.errorText || 'Request failed',
        timestamp: new Date().toISOString(),
      });
    });
  }

  /**
   * Executes a typed action on the active page.
   * Supports: navigate, click, doubleClick, fill, type, clear, pressKey, hover, scroll, wait, snapshot, rapidClicks, evaluate
   */
  async executeAction(action: ActionSpec): Promise<ActionResult> {
    if (!this.page) {
      return {
        success: false,
        durationMs: 0,
        error: 'WebAdapter is not initialized. Call initialize() before executing actions.',
      };
    }

    const startTime = Date.now();
    const timeoutMs = action.timeoutMs ?? 10000;

    try {
      let output: any;

      switch (action.type) {
        case 'navigate': {
          const rawUrl = action.value ?? action.target;
          if (!rawUrl) {
            throw new Error('navigate action requires a target or value URL');
          }
          const url = String(rawUrl);
          const waitUntil = action.metadata?.waitUntil || 'load';
          const response = await this.page.goto(url, { timeout: timeoutMs, waitUntil });
          output = {
            url: this.page.url(),
            status: response ? response.status() : undefined,
            statusText: response ? response.statusText() : undefined,
          };
          break;
        }

        case 'click': {
          if (!action.target) {
            throw new Error('click action requires a target selector');
          }
          await this.page.click(action.target, {
            timeout: timeoutMs,
            button: action.metadata?.button ?? 'left',
            clickCount: action.metadata?.clickCount ?? 1,
            force: action.metadata?.force ?? false,
          });
          output = { target: action.target };
          break;
        }

        case 'doubleClick': {
          if (!action.target) {
            throw new Error('doubleClick action requires a target selector');
          }
          await this.page.dblclick(action.target, { timeout: timeoutMs });
          output = { target: action.target };
          break;
        }

        case 'fill': {
          if (!action.target) {
            throw new Error('fill action requires a target selector');
          }
          const text = String(action.value ?? '');
          await this.page.fill(action.target, text, { timeout: timeoutMs });
          output = { target: action.target, value: text };
          break;
        }

        case 'type': {
          const text = String(action.value ?? '');
          const delay = action.metadata?.delay;
          if (action.target) {
            const locator = this.page.locator(action.target);
            if (typeof (locator as any).pressSequentially === 'function') {
              await (locator as any).pressSequentially(text, { delay, timeout: timeoutMs });
            } else {
              await this.page.type(action.target, text, { delay, timeout: timeoutMs });
            }
          } else {
            await this.page.keyboard.type(text, { delay });
          }
          output = { target: action.target, value: text };
          break;
        }

        case 'clear': {
          if (!action.target) {
            throw new Error('clear action requires a target selector');
          }
          await this.page.fill(action.target, '', { timeout: timeoutMs });
          output = { target: action.target };
          break;
        }

        case 'pressKey': {
          const key = String(action.value ?? action.target ?? 'Enter');
          if (action.target && action.value) {
            await this.page.press(action.target, key, { timeout: timeoutMs });
          } else {
            await this.page.keyboard.press(key);
          }
          output = { key };
          break;
        }

        case 'hover': {
          if (!action.target) {
            throw new Error('hover action requires a target selector');
          }
          await this.page.hover(action.target, { timeout: timeoutMs });
          output = { target: action.target };
          break;
        }

        case 'scroll': {
          if (action.target) {
            await this.page.locator(action.target).scrollIntoViewIfNeeded({ timeout: timeoutMs });
            output = { scrolledTo: action.target };
          } else if (typeof action.value === 'number') {
            await this.page.evaluate((deltaY) => window.scrollBy(0, deltaY), action.value);
            output = { scrolledBy: { x: 0, y: action.value } };
          } else if (typeof action.value === 'string' && action.value.toLowerCase() === 'bottom') {
            await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            output = { scrolledTo: 'bottom' };
          } else if (typeof action.value === 'string' && action.value.toLowerCase() === 'top') {
            await this.page.evaluate(() => window.scrollTo(0, 0));
            output = { scrolledTo: 'top' };
          } else if (typeof action.value === 'object' && action.value !== null) {
            const x = Number(action.value.x ?? 0);
            const y = Number(action.value.y ?? 0);
            await this.page.evaluate(({ x, y }) => window.scrollBy(x, y), { x, y });
            output = { scrolledBy: { x, y } };
          } else {
            await this.page.evaluate(() => window.scrollBy(0, 300));
            output = { scrolledBy: { x: 0, y: 300 } };
          }
          break;
        }

        case 'wait': {
          if (action.target) {
            const state = action.metadata?.state ?? 'visible';
            await this.page.waitForSelector(action.target, { timeout: timeoutMs, state });
            output = { waitedForSelector: action.target, state };
          } else if (typeof action.value === 'number') {
            await this.page.waitForTimeout(action.value);
            output = { waitedMs: action.value };
          } else {
            const waitMs = typeof action.timeoutMs === 'number' && action.timeoutMs < 2000 ? action.timeoutMs : 500;
            await this.page.waitForTimeout(waitMs);
            output = { waitedMs: waitMs };
          }
          break;
        }

        case 'snapshot': {
          const content = await this.page.content();
          const title = await this.page.title();
          const url = this.page.url();
          output = {
            htmlLength: content.length,
            title,
            url,
          };
          break;
        }

        case 'rapidClicks': {
          if (!action.target) {
            throw new Error('rapidClicks action requires a target selector');
          }
          const count = Number(action.value ?? action.metadata?.count ?? 50);
          const intervalMs = Number(action.metadata?.intervalMs ?? 5);
          const locator = this.page.locator(action.target);
          await locator.waitFor({ state: 'visible', timeout: timeoutMs });

          let clicksDone = 0;
          for (let i = 0; i < count; i++) {
            await locator.click({ timeout: 2000, noWaitAfter: true, force: true });
            clicksDone++;
            if (intervalMs > 0) {
              await this.page.waitForTimeout(intervalMs);
            }
          }
          output = { clicksPerformed: clicksDone, target: action.target };
          break;
        }

        case 'evaluate': {
          if (!action.value) {
            throw new Error('evaluate action requires JavaScript code or function in value');
          }
          const result = await this.page.evaluate(action.value);
          output = { result };
          break;
        }

        default:
          throw new Error(`Unsupported action type: ${(action as any).type}`);
      }

      return {
        success: true,
        durationMs: Date.now() - startTime,
        output,
      };
    } catch (err: any) {
      return {
        success: false,
        durationMs: Date.now() - startTime,
        error: err.message || String(err),
      };
    }
  }

  /**
   * Evaluates deterministic assertions against current page state.
   * Supports: elementVisible, elementHidden, elementExists, elementTextEquals, elementTextContains,
   * elementDisabled, elementEnabled, elementCount, urlMatches, titleMatches, status200, consoleClean, noNetworkFailures, custom
   */
  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    if (!this.page) {
      return {
        passed: false,
        durationMs: 0,
        expected: assertion.expected,
        actual: 'WebAdapter is not initialized',
        message: 'WebAdapter is not initialized. Call initialize() before executing assertions.',
      };
    }

    const startTime = Date.now();

    try {
      let passed = false;
      let expected: any = assertion.expected;
      let actual: any;
      let message: string | undefined = assertion.message;

      switch (assertion.type) {
        case 'elementVisible': {
          if (!assertion.target) throw new Error('elementVisible assertion requires a target selector');
          const isVisible = await this.page.locator(assertion.target).isVisible();
          actual = isVisible;
          expected = assertion.expected ?? true;
          passed = isVisible === expected;
          if (!message) {
            message = passed
              ? `Element "${assertion.target}" visibility is ${isVisible}.`
              : `Expected element "${assertion.target}" to be visible (${expected}), but was ${actual}.`;
          }
          break;
        }

        case 'elementHidden': {
          if (!assertion.target) throw new Error('elementHidden assertion requires a target selector');
          const isVisible = await this.page.locator(assertion.target).isVisible();
          const isHidden = !isVisible;
          actual = isHidden;
          expected = assertion.expected ?? true;
          passed = isHidden === expected;
          if (!message) {
            message = passed
              ? `Element "${assertion.target}" hidden status is ${isHidden}.`
              : `Expected element "${assertion.target}" to be hidden (${expected}), but was ${actual}.`;
          }
          break;
        }

        case 'elementExists': {
          if (!assertion.target) throw new Error('elementExists assertion requires a target selector');
          const count = await this.page.locator(assertion.target).count();
          actual = count > 0;
          expected = assertion.expected ?? true;
          passed = actual === expected;
          if (!message) {
            message = passed
              ? `Element "${assertion.target}" exists in DOM.`
              : `Expected element "${assertion.target}" to exist in DOM, but element count was 0.`;
          }
          break;
        }

        case 'elementTextEquals': {
          if (!assertion.target) throw new Error('elementTextEquals assertion requires a target selector');
          const text = await this.page.locator(assertion.target).innerText();
          actual = text.trim();
          expected = String(assertion.expected ?? '').trim();
          passed = actual === expected;
          if (!message) {
            message = passed
              ? `Element "${assertion.target}" text equals expected text.`
              : `Expected element "${assertion.target}" text to equal "${expected}", but got "${actual}".`;
          }
          break;
        }

        case 'elementTextContains': {
          if (!assertion.target) throw new Error('elementTextContains assertion requires a target selector');
          const text = await this.page.locator(assertion.target).innerText();
          actual = text;
          expected = String(assertion.expected ?? '');
          passed = text.includes(expected);
          if (!message) {
            message = passed
              ? `Element "${assertion.target}" text contains "${expected}".`
              : `Expected element "${assertion.target}" text to contain "${expected}", but got "${actual}".`;
          }
          break;
        }

        case 'elementDisabled': {
          if (!assertion.target) throw new Error('elementDisabled assertion requires a target selector');
          const isDisabled = await this.page.locator(assertion.target).isDisabled();
          actual = isDisabled;
          expected = assertion.expected ?? true;
          passed = isDisabled === expected;
          if (!message) {
            message = passed
              ? `Element "${assertion.target}" disabled is ${isDisabled}.`
              : `Expected element "${assertion.target}" to be disabled (${expected}), but was ${actual}.`;
          }
          break;
        }

        case 'elementEnabled': {
          if (!assertion.target) throw new Error('elementEnabled assertion requires a target selector');
          const isEnabled = await this.page.locator(assertion.target).isEnabled();
          actual = isEnabled;
          expected = assertion.expected ?? true;
          passed = isEnabled === expected;
          if (!message) {
            message = passed
              ? `Element "${assertion.target}" enabled is ${isEnabled}.`
              : `Expected element "${assertion.target}" to be enabled (${expected}), but was ${actual}.`;
          }
          break;
        }

        case 'elementCount': {
          if (!assertion.target) throw new Error('elementCount assertion requires a target selector');
          const count = await this.page.locator(assertion.target).count();
          actual = count;
          expected = Number(assertion.expected ?? 1);
          passed = count === expected;
          if (!message) {
            message = passed
              ? `Element count for "${assertion.target}" is ${count}.`
              : `Expected ${expected} elements for "${assertion.target}", but counted ${actual}.`;
          }
          break;
        }

        case 'urlMatches': {
          const currentUrl = this.page.url();
          actual = currentUrl;
          expected = assertion.expected;

          if (expected instanceof RegExp) {
            passed = expected.test(currentUrl);
          } else {
            const pattern = String(expected ?? '');
            try {
              const regex = new RegExp(pattern);
              passed = regex.test(currentUrl) || currentUrl.includes(pattern);
            } catch {
              passed = currentUrl.includes(pattern);
            }
          }

          if (!message) {
            message = passed
              ? `URL matches "${expected}".`
              : `Expected URL to match "${expected}", but current URL is "${currentUrl}".`;
          }
          break;
        }

        case 'titleMatches': {
          const currentTitle = await this.page.title();
          actual = currentTitle;
          expected = assertion.expected;

          if (expected instanceof RegExp) {
            passed = expected.test(currentTitle);
          } else {
            const pattern = String(expected ?? '');
            try {
              const regex = new RegExp(pattern);
              passed = regex.test(currentTitle) || currentTitle.includes(pattern);
            } catch {
              passed = currentTitle.includes(pattern);
            }
          }

          if (!message) {
            message = passed
              ? `Page title matches "${expected}".`
              : `Expected page title to match "${expected}", but current title is "${currentTitle}".`;
          }
          break;
        }

        case 'status200': {
          const lastReq = this.networkRequests[this.networkRequests.length - 1];
          actual = lastReq?.status;
          expected = 200;
          passed = actual === 200;
          if (!message) {
            message = passed ? 'Last HTTP status was 200.' : `Expected status 200, got ${actual}.`;
          }
          break;
        }

        case 'consoleClean': {
          const errorCount = this.consoleErrors.length;
          actual = errorCount;
          expected = 0;
          passed = errorCount === 0;

          if (!message) {
            message = passed
              ? 'Console is clean with zero unhandled errors.'
              : `Console had ${errorCount} unhandled error(s):\n` +
                this.consoleErrors.map((e, idx) => `  [${idx + 1}] (${e.type}) ${e.text}`).join('\n');
          }
          break;
        }

        case 'noNetworkFailures': {
          const failureCount = this.networkFailures.length;
          actual = failureCount;
          expected = 0;
          passed = failureCount === 0;

          if (!message) {
            message = passed
              ? 'No network failures observed.'
              : `Observed ${failureCount} failed network request(s):\n` +
                this.networkFailures
                  .map((f, idx) => `  [${idx + 1}] [${f.method}] ${f.url} -> ${f.status || f.errorText}`)
                  .join('\n');
          }
          break;
        }

        case 'custom': {
          if (assertion.target === 'layout' || assertion.metadata?.kind === 'layout') {
            const layoutResult = await this.checkLayout();
            actual = layoutResult;
            expected = { hasIssues: false };
            passed = !layoutResult.hasIssues;

            if (!message) {
              message = passed
                ? 'Layout audit passed with 0 issues detected.'
                : `Layout audit detected ${layoutResult.issues.length} issue(s): ` +
                  layoutResult.issues.map((i) => `${i.type} on <${i.tagName}>: ${i.details}`).join('; ');
            }
          } else {
            passed = Boolean(assertion.expected);
            actual = assertion.expected;
          }
          break;
        }

        default:
          throw new Error(`Unsupported assertion type: ${(assertion as any).type}`);
      }

      return {
        passed,
        expected,
        actual,
        durationMs: Date.now() - startTime,
        message,
      };
    } catch (err: any) {
      return {
        passed: false,
        expected: assertion.expected,
        actual: err.message,
        durationMs: Date.now() - startTime,
        message: `Assertion threw error: ${err.message}`,
      };
    }
  }

  /**
   * Captures evidence artifact (Full-page / Viewport screenshot, DOM snapshot, console logs)
   * Computes SHA-256 hash, writes to disk in output directory, and returns EvidenceArtifact.
   */
  async captureEvidence(type: string, description?: string): Promise<EvidenceArtifact> {
    if (!this.page) {
      throw new QAAdapterError('WebAdapter is not initialized. Cannot capture evidence.', this.name);
    }

    fs.mkdirSync(this.outputDir, { recursive: true });

    const normalizedType = (type || 'SCREENSHOT').toUpperCase() as EvidenceType;
    const timestamp = Date.now();
    const randomSuffix = crypto.randomBytes(4).toString('hex');
    const id = `ev-${timestamp}-${randomSuffix}`;

    let buffer: Buffer;
    let mimeType: string;
    let ext: string;

    switch (normalizedType) {
      case 'DOM_SNAPSHOT': {
        const html = await this.page.content();
        buffer = Buffer.from(html, 'utf-8');
        mimeType = 'text/html';
        ext = 'html';
        break;
      }

      case 'CONSOLE_LOG': {
        const logData = {
          errors: this.consoleErrors,
          all: this.consoleLogs,
        };
        buffer = Buffer.from(JSON.stringify(logData, null, 2), 'utf-8');
        mimeType = 'application/json';
        ext = 'json';
        break;
      }

      case 'NETWORK_HAR': {
        const netData = {
          failures: this.networkFailures,
          requests: this.networkRequests,
        };
        buffer = Buffer.from(JSON.stringify(netData, null, 2), 'utf-8');
        mimeType = 'application/json';
        ext = 'json';
        break;
      }

      case 'SCREENSHOT':
      default: {
        const isViewportOnly = Boolean(
          description && description.toLowerCase().includes('viewport')
        );
        const screenshotBuf = await this.page.screenshot({
          fullPage: !isViewportOnly,
          type: 'png',
        });
        buffer = Buffer.from(screenshotBuf);
        mimeType = 'image/png';
        ext = 'png';
        break;
      }
    }

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const filename = `${id}.${ext}`;
    const filePath = path.resolve(this.outputDir, filename);

    fs.writeFileSync(filePath, buffer);

    const artifact: EvidenceArtifact = {
      id,
      type: normalizedType,
      path: filePath,
      sha256,
      sizeBytes: buffer.length,
      mimeType,
      capturedAt: new Date().toISOString(),
      description: description || `Captured ${normalizedType} evidence`,
      metadata: {
        url: this.page.url(),
        title: await this.page.title().catch(() => ''),
      },
    };

    return artifact;
  }

  /**
   * Layout checks: Detect horizontal overflow (scrollWidth > clientWidth), clipped elements, and offscreen controls.
   */
  async checkLayout(): Promise<LayoutCheckResult> {
    if (!this.page) {
      throw new QAAdapterError('WebAdapter is not initialized. Cannot perform layout audit.', this.name);
    }
    return await checkPageLayout(this.page);
  }

  /**
   * Teardown: Safely close page and browser contexts and reset state.
   */
  async teardown(): Promise<void> {
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.close().catch(() => {});
      }
    } finally {
      try {
        if (this.context) {
          await this.context.close().catch(() => {});
        }
      } finally {
        try {
          if (this.browser) {
            await this.browser.close().catch(() => {});
          }
        } finally {
          this.page = undefined;
          this.context = undefined;
          this.browser = undefined;
          this.isInitialized = false;
          this.consoleErrors = [];
          this.consoleLogs = [];
          this.networkFailures = [];
          this.networkRequests = [];
        }
      }
    }
  }

  // Diagnostics and inspection helpers
  getPage(): Page | undefined {
    return this.page;
  }

  getContext(): BrowserContext | undefined {
    return this.context;
  }

  getBrowser(): Browser | undefined {
    return this.browser;
  }

  getConsoleErrors(): ConsoleEntry[] {
    return [...this.consoleErrors];
  }

  getConsoleLogs(): ConsoleEntry[] {
    return [...this.consoleLogs];
  }

  getNetworkFailures(): NetworkFailureEntry[] {
    return [...this.networkFailures];
  }

  getNetworkRequests(): NetworkRequestEntry[] {
    return [...this.networkRequests];
  }

  clearErrors(): void {
    this.consoleErrors = [];
    this.networkFailures = [];
  }
}
