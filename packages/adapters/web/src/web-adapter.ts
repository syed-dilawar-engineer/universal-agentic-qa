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
  isBlockedMetadataUrl,
  redactSecrets,
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

    await this.setupRouteSecurity(this.context);

    this.page = await this.context.newPage();
    this.setupPageListeners(this.page);
    this.isInitialized = true;
  }

  /**
   * Sets up route interception to block outbound requests to cloud metadata endpoints (SSRF protection).
   */
  private async setupRouteSecurity(context: BrowserContext): Promise<void> {
    try {
      if (typeof (context as any).route === 'function') {
        await context.route('**/*', (route) => {
          const reqUrl = route.request().url();
          const check = isBlockedMetadataUrl(reqUrl);
          if (check.blocked) {
            this.networkFailures.push({
              url: reqUrl,
              method: route.request().method(),
              errorText: `Request blocked by cloud metadata security policy: ${check.reason}`,
              timestamp: new Date().toISOString(),
            });
            route.abort('blockedbyclient').catch(() => {});
            return;
          }
          route.continue().catch(() => {});
        });
      }
    } catch {
      // Mock contexts without route support ignore gracefully
    }
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
      const isReactHydrationWarn =
        (type === 'warning' || (type as string) === 'warn') &&
        (/hydration/i.test(text) || /did not match/i.test(text));
      if (type === 'error' || isReactHydrationWarn) {
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
          const secCheck = isBlockedMetadataUrl(url);
          if (secCheck.blocked) {
            throw new Error(`Navigation blocked by security policy: ${secCheck.reason}`);
          }

          if (action.metadata?.viewport) {
            const vp = typeof action.metadata.viewport === 'object'
              ? action.metadata.viewport
              : resolveViewport(action.metadata.viewport);
            if (vp && typeof vp.width === 'number' && typeof vp.height === 'number') {
              await this.page.setViewportSize({ width: vp.width, height: vp.height });
            }
          }

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

        case 'pasteText':
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
          const countRaw =
            typeof action.value === 'object' && action.value !== null
              ? (action.value.count ?? 50)
              : (action.value ?? action.metadata?.count ?? 50);
          const count = Number(countRaw) || 50;
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

        case 'goBack': {
          const waitUntil = action.metadata?.waitUntil || 'load';
          const response = await this.page.goBack({ timeout: timeoutMs, waitUntil });
          output = {
            url: this.page.url(),
            status: response ? response.status() : undefined,
          };
          break;
        }

        case 'goForward': {
          const waitUntil = action.metadata?.waitUntil || 'load';
          const response = await this.page.goForward({ timeout: timeoutMs, waitUntil });
          output = {
            url: this.page.url(),
            status: response ? response.status() : undefined,
          };
          break;
        }

        case 'reload': {
          const waitUntil = action.metadata?.waitUntil || 'load';
          const response = await this.page.reload({ timeout: timeoutMs, waitUntil });
          output = {
            url: this.page.url(),
            status: response ? response.status() : undefined,
          };
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
          let matchedReq: NetworkRequestEntry | undefined;

          const targetPattern =
            assertion.target ||
            assertion.metadata?.url ||
            (typeof (assertion as any).value === 'string' ? (assertion as any).value : undefined);

          if (targetPattern) {
            const patternStr = String(targetPattern);
            matchedReq = [...this.networkRequests].reverse().find((req) => {
              try {
                const regex = new RegExp(patternStr);
                return regex.test(req.url) || req.url.includes(patternStr);
              } catch {
                return req.url.includes(patternStr);
              }
            });
          } else {
            // Check main document navigation request matching current page URL
            const pageUrl = this.page.url();
            const cleanPageUrl = pageUrl.split('#')[0].replace(/\/$/, '');

            matchedReq = [...this.networkRequests].reverse().find((req) => {
              const cleanReqUrl = req.url.split('#')[0].replace(/\/$/, '');
              return cleanReqUrl === cleanPageUrl;
            });

            // If no direct match to pageUrl, filter out 204 beacons and favicons/static assets
            if (!matchedReq) {
              const candidates = this.networkRequests.filter((req) => {
                if (req.status === 204) return false;
                if (/favicon\.ico|\/favicon/i.test(req.url)) return false;
                if (/\.(png|jpe?g|gif|svg|webp|woff2?|ttf|eot)(\?.*)?$/i.test(req.url)) return false;
                return true;
              });
              matchedReq = candidates[candidates.length - 1];
            }

            // Fallback if all were filtered
            if (!matchedReq) {
              matchedReq = this.networkRequests[this.networkRequests.length - 1];
            }
          }

          actual = matchedReq?.status;
          expected = Number(assertion.expected ?? 200);
          passed = actual === expected;
          if (!message) {
            const targetDesc = matchedReq?.url
              ? `"${matchedReq.url}"`
              : targetPattern
                ? `pattern "${targetPattern}"`
                : 'main document';
            message = passed
              ? `HTTP status for ${targetDesc} was ${actual}.`
              : `Expected HTTP status ${expected} for ${targetDesc}, but got ${actual ?? 'no response'}.`;
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

        case 'noAccessibilityViolations': {
          if (assertion.target) {
            const target = assertion.target;
            const a11yData = await this.page.evaluate((sel: string) => {
              const el = document.querySelector(sel);
              if (!el) return null;
              const ariaLabel = el.getAttribute('aria-label');
              const title = el.getAttribute('title');
              const ariaLabelledBy = el.getAttribute('aria-labelledby');
              const text = el.textContent?.trim() || '';
              const imgAlt = el.querySelector('img')?.getAttribute('alt');
              const hasName = Boolean(ariaLabel || title || ariaLabelledBy || text || imgAlt);
              return { hasName, ariaLabel, title };
            }, target);

            if (!a11yData) {
              throw new Error(`Element "${target}" not found for accessibility assertion`);
            }
            passed = a11yData.hasName;
            expected = true;
            actual = a11yData.hasName;
            if (!message) {
              message = passed
                ? `Element "${target}" has valid accessible name per WCAG 2.1 AA 4.1.2.`
                : `Element "${target}" violates WCAG 2.1 AA 4.1.2: missing accessible name.`;
            }
          } else {
            // Full-page DOM accessibility audit
            const violations = await this.page.evaluate(() => {
              const issues: Array<{ type: string; selector: string; details: string }> = [];

              function getSelector(el: Element): string {
                if (el.id) return `#${el.id}`;
                let sel = el.tagName.toLowerCase();
                if (el.className && typeof el.className === 'string') {
                  const cls = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
                  if (cls) sel += `.${cls}`;
                }
                return sel;
              }

              // 1. Missing image alt attribute (WCAG 1.1.1)
              const images = Array.from(document.querySelectorAll('img:not([alt])'));
              for (const img of images) {
                issues.push({
                  type: 'MISSING_ALT',
                  selector: getSelector(img),
                  details: '<img> element missing alt attribute (WCAG 1.1.1)',
                });
              }

              // 2. Buttons without accessible name (WCAG 4.1.2)
              const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
              for (const btn of buttons) {
                const ariaLabel = btn.getAttribute('aria-label');
                const ariaLabelledBy = btn.getAttribute('aria-labelledby');
                const title = btn.getAttribute('title');
                const text = btn.textContent?.trim() || '';
                const imgAlt = btn.querySelector('img')?.getAttribute('alt');
                if (!ariaLabel && !ariaLabelledBy && !title && !text && !imgAlt) {
                  issues.push({
                    type: 'MISSING_BUTTON_NAME',
                    selector: getSelector(btn),
                    details: 'Button has no accessible name (WCAG 4.1.2)',
                  });
                }
              }

              // 3. Links without accessible name (WCAG 2.4.4 / 4.1.2)
              const links = Array.from(document.querySelectorAll('a[href]'));
              for (const a of links) {
                const ariaLabel = a.getAttribute('aria-label');
                const ariaLabelledBy = a.getAttribute('aria-labelledby');
                const title = a.getAttribute('title');
                const text = a.textContent?.trim() || '';
                const imgAlt = a.querySelector('img')?.getAttribute('alt');
                if (!ariaLabel && !ariaLabelledBy && !title && !text && !imgAlt) {
                  issues.push({
                    type: 'MISSING_LINK_NAME',
                    selector: getSelector(a),
                    details: 'Link has no accessible name (WCAG 2.4.4 / 4.1.2)',
                  });
                }
              }

              // 4. Form inputs without associated labels (WCAG 1.3.1 / 4.1.2)
              const inputs = Array.from(
                document.querySelectorAll(
                  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea'
                )
              );
              for (const input of inputs) {
                const ariaLabel = input.getAttribute('aria-label');
                const ariaLabelledBy = input.getAttribute('aria-labelledby');
                const title = input.getAttribute('title');
                const placeholder = input.getAttribute('placeholder');
                const id = input.id;
                const hasLabelFor = id ? Boolean(document.querySelector(`label[for="${id}"]`)) : false;
                const hasParentLabel = Boolean(input.closest && input.closest('label'));

                if (!ariaLabel && !ariaLabelledBy && !title && !placeholder && !hasLabelFor && !hasParentLabel) {
                  issues.push({
                    type: 'MISSING_INPUT_LABEL',
                    selector: getSelector(input),
                    details: 'Form input missing associated label or accessible name (WCAG 1.3.1 / 4.1.2)',
                  });
                }
              }

              return issues;
            });

            actual = violations.length;
            expected = 0;
            passed = violations.length === 0;

            if (!message) {
              message = passed
                ? 'Page accessibility inspection passed with 0 violations.'
                : `Page accessibility inspection detected ${violations.length} violation(s):\n` +
                  violations.map((v, idx) => `  [${idx + 1}] ${v.type} on ${v.selector}: ${v.details}`).join('\n');
            }
          }
          break;
        }

        case 'noHydrationMismatch': {
          const hydrationErrors: ConsoleEntry[] = [];
          const seen = new Set<string>();
          for (const entry of [...this.consoleErrors, ...this.consoleLogs]) {
            const key = `${entry.type}:${entry.text}:${entry.location ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (this.isReactHydrationError(entry)) {
              hydrationErrors.push(entry);
            }
          }

          actual = hydrationErrors.length;
          expected = 0;
          passed = hydrationErrors.length === 0;

          if (!message) {
            message = passed
              ? 'No React hydration mismatches detected in console or page errors.'
              : `Detected ${hydrationErrors.length} React hydration mismatch error(s):\n` +
                hydrationErrors.map((e, idx) => `  [${idx + 1}] (${e.type}) ${e.text}`).join('\n');
          }
          break;
        }

        case 'isElementOccluded': {
          if (!assertion.target) throw new Error('isElementOccluded assertion requires a target selector');
          const occlusionData = await this.page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (!el) {
              return { found: false, isOccluded: false, reason: 'Element not found in DOM' };
            }
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
              return { found: true, isOccluded: true, reason: 'Element has 0x0 dimensions' };
            }
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;

            if (typeof document.elementFromPoint !== 'function') {
              return { found: true, isOccluded: false, reason: 'document.elementFromPoint not supported' };
            }

            const topEl = document.elementFromPoint(cx, cy);
            if (!topEl) {
              return { found: true, isOccluded: true, reason: 'No element found at target center point' };
            }

            const isTopOrDescendant = topEl === el || el.contains(topEl);
            const topTag = topEl.tagName ? topEl.tagName.toLowerCase() : 'unknown';
            const topId = topEl.id ? `#${topEl.id}` : '';
            const topClass =
              topEl.className && typeof topEl.className === 'string'
                ? `.${topEl.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`
                : '';
            const topDesc = `<${topTag}${topId}${topClass}>`;

            return {
              found: true,
              isOccluded: !isTopOrDescendant,
              topElement: topDesc,
              point: { x: Math.round(cx), y: Math.round(cy) },
            };
          }, assertion.target);

          if (!occlusionData.found) {
            throw new Error(`Element "${assertion.target}" not found for isElementOccluded assertion`);
          }

          actual = occlusionData.isOccluded;
          expected = assertion.expected !== undefined ? assertion.expected : false;
          passed = actual === expected;

          if (!message) {
            if (actual) {
              message = `Element "${assertion.target}" is occluded by ${occlusionData.topElement || 'an overlay element'} at (${occlusionData.point?.x}, ${occlusionData.point?.y}).`;
            } else {
              message = `Element "${assertion.target}" is not occluded (visible and clickable at top z-index).`;
            }
          }
          break;
        }

        case 'targetSizeAAA': {
          if (!assertion.target) throw new Error('targetSizeAAA assertion requires a target selector');
          const sizeData = await this.page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return {
              width: Math.round(rect.width * 100) / 100,
              height: Math.round(rect.height * 100) / 100,
            };
          }, assertion.target);

          if (!sizeData) {
            throw new Error(`Element "${assertion.target}" not found for targetSizeAAA assertion`);
          }

          const meetsAAA = sizeData.width >= 44 && sizeData.height >= 44;
          actual = `${sizeData.width}x${sizeData.height}px`;
          expected = '>= 44x44px';
          passed = meetsAAA;

          if (!message) {
            message = passed
              ? `Touch target size for "${assertion.target}" (${actual}) satisfies WCAG 2.2 AAA standard (>= 44x44px).`
              : `Touch target size for "${assertion.target}" (${actual}) fails WCAG 2.2 AAA standard (requires >= 44x44px).`;
          }
          break;
        }

        case 'noLayoutOverflow': {
          if (assertion.target) {
            const overflowData = await this.page.evaluate((sel: string) => {
              const el = document.querySelector(sel);
              if (!el) return null;
              const scrollWidth = el.scrollWidth;
              const clientWidth = el.clientWidth;
              return {
                scrollWidth,
                clientWidth,
                hasOverflow: scrollWidth > clientWidth,
              };
            }, assertion.target);

            if (!overflowData) {
              throw new Error(`Element "${assertion.target}" not found for noLayoutOverflow assertion`);
            }

            passed = !overflowData.hasOverflow;
            actual = overflowData.hasOverflow
              ? `scrollWidth (${overflowData.scrollWidth}px) > clientWidth (${overflowData.clientWidth}px)`
              : 'no overflow';
            expected = 'no overflow';

            if (!message) {
              message = passed
                ? `Element "${assertion.target}" has no layout overflow (scrollWidth <= clientWidth).`
                : `Element "${assertion.target}" has layout overflow: scrollWidth (${overflowData.scrollWidth}px) exceeds clientWidth (${overflowData.clientWidth}px).`;
            }
          } else {
            const layoutResult = await this.checkLayout();
            passed = !layoutResult.horizontalOverflow;
            actual = layoutResult.horizontalOverflow
              ? `Page scrollWidth (${layoutResult.metrics.scrollWidth}px) > clientWidth (${layoutResult.metrics.clientWidth}px)`
              : 'no overflow';
            expected = 'no overflow';

            if (!message) {
              message = passed
                ? 'Page has no layout overflow (scrollWidth <= clientWidth).'
                : `Page has layout overflow: scrollWidth (${layoutResult.metrics.scrollWidth}px) exceeds clientWidth (${layoutResult.metrics.clientWidth}px).`;
            }
          }
          break;
        }

        case 'noTextTruncation': {
          if (!assertion.target) {
            throw new Error('noTextTruncation assertion requires a target selector');
          }
          const truncationData = await this.page.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const scrollWidth = el.scrollWidth;
            const clientWidth = el.clientWidth;
            return {
              scrollWidth,
              clientWidth,
              isTruncated: scrollWidth > clientWidth,
            };
          }, assertion.target);

          if (!truncationData) {
            throw new Error(`Element "${assertion.target}" not found for noTextTruncation assertion`);
          }

          passed = !truncationData.isTruncated;
          actual = truncationData.isTruncated
            ? `scrollWidth (${truncationData.scrollWidth}px) > clientWidth (${truncationData.clientWidth}px)`
            : 'not truncated';
          expected = 'not truncated';

          if (!message) {
            message = passed
              ? `Element "${assertion.target}" text is not truncated (scrollWidth <= clientWidth).`
              : `Element "${assertion.target}" text is truncated: scrollWidth (${truncationData.scrollWidth}px) exceeds clientWidth (${truncationData.clientWidth}px).`;
          }
          break;
        }

        case 'custom': {
          if (assertion.metadata?.maxScrollWidth !== undefined && assertion.target) {
            const maxAllowed = Number(assertion.metadata.maxScrollWidth);
            const measured = await this.page.locator(assertion.target).first().evaluate((el) => {
              const rect = el.getBoundingClientRect();
              return Math.max(el.scrollWidth, (el as HTMLElement).offsetWidth || 0, rect.width);
            });
            passed = measured <= maxAllowed;
            expected = `<= ${maxAllowed}px`;
            actual = `${measured}px`;
            if (!message) {
              message = passed
                ? `Element "${assertion.target}" width (${measured}px) fits within ${maxAllowed}px.`
                : `Element "${assertion.target}" horizontal overflow: width (${measured}px) exceeds max allowed (${maxAllowed}px).`;
            }
          } else if (assertion.target === 'layout' || assertion.metadata?.kind === 'layout') {
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
        buffer = Buffer.from(redactSecrets(html), 'utf-8');
        mimeType = 'text/html';
        ext = 'html';
        break;
      }

      case 'CONSOLE_LOG': {
        const logData = {
          errors: this.consoleErrors,
          all: this.consoleLogs,
        };
        buffer = Buffer.from(redactSecrets(JSON.stringify(logData, null, 2)), 'utf-8');
        mimeType = 'application/json';
        ext = 'json';
        break;
      }

      case 'NETWORK_HAR': {
        const netData = {
          failures: this.networkFailures,
          requests: this.networkRequests,
        };
        buffer = Buffer.from(redactSecrets(JSON.stringify(netData, null, 2)), 'utf-8');
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

  private isReactHydrationError(entry: ConsoleEntry): boolean {
    const text = entry.text;
    if (
      /Hydration failed/i.test(text) ||
      /Minified React error #(?:418|423|425|426)\b/i.test(text) ||
      /#(?:418|423|425|426)\b/.test(text) ||
      /Text content did not match/i.test(text) ||
      /hydration mismatch/i.test(text) ||
      /error while hydrating/i.test(text)
    ) {
      return true;
    }
    if (
      (entry.type === 'error' || entry.type === 'pageerror' || entry.type === 'warning' || entry.type === 'warn') &&
      (/hydration/i.test(text) || /did not match/i.test(text))
    ) {
      return true;
    }
    return false;
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
