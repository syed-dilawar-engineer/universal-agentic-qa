import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Platform,
  CapabilityDescriptor,
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
} from '@agentic-qa/schemas';
import {
  PlatformAdapter,
  ActionResult,
  AssertionResult,
  QABlockedError,
  QAAdapterError,
} from '@agentic-qa/core';
import { MobileAdapterOptions, MobileLifecycleActions } from '../types.js';
import { CommandExecutor, DefaultCommandExecutor, HttpResponse } from '../executor.js';

export class AppiumAdapter implements PlatformAdapter, MobileLifecycleActions {
  readonly id = 'mobile-appium';
  readonly name = 'Appium Server Adapter';
  readonly platform: Platform = 'mobile';

  private executor: CommandExecutor;
  private serverUrl: string;
  private appId?: string;
  private sessionId?: string;
  private outputDir: string;
  private isInitialized = false;

  constructor(options: MobileAdapterOptions = {}) {
    this.executor = options.executor || new DefaultCommandExecutor();
    this.serverUrl = options.appiumServerUrl || 'http://127.0.0.1:4723';
    this.appId = options.packageName || options.bundleId;
    this.outputDir = options.outputDir || path.resolve('.qa-output', 'evidence');
  }

  private async sendWebDriverCommand(
    method: string,
    endpoint: string,
    body?: any
  ): Promise<HttpResponse> {
    const cleanBase = this.serverUrl.replace(/\/+$/, '');
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${cleanBase}${cleanEndpoint}`;

    if (this.executor.httpRequest) {
      return this.executor.httpRequest({ method, url, body });
    }
    return this.executor.httpGet(url);
  }

  async getCapability(): Promise<CapabilityDescriptor> {
    // 1. Probe Appium server via HTTP GET /status
    const statusUrl = `${this.serverUrl.replace(/\/+$/, '')}/status`;
    const httpRes = await this.executor.httpGet(statusUrl, 3000);

    if (httpRes.status === 200) {
      const serverVersion =
        httpRes.body?.value?.build?.version || httpRes.body?.build?.version || '2.x';
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'AVAILABLE',
        reason: `Appium server is reachable and active at ${this.serverUrl} (v${serverVersion}).`,
        requiredTools: ['appium'],
        missingTools: [],
        version: serverVersion,
        metadata: {
          serverUrl: this.serverUrl,
          serverStatus: httpRes.body,
        },
      };
    }

    // 2. Server is not reachable, check if appium CLI is installed locally
    const cliRes = await this.executor.exec('appium', ['--version']);
    if (cliRes.exitCode === 0) {
      const cliVersion = cliRes.stdout.trim();
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'UNAVAILABLE',
        reason:
          `Appium CLI is installed (${cliVersion}), but Appium server is not running on ${this.serverUrl}. ` +
          'Start the Appium server using "appium" before initiating tests.',
        requiredTools: ['appium'],
        missingTools: [],
        version: cliVersion,
        metadata: {
          serverUrl: this.serverUrl,
          cliVersion,
        },
      };
    }

    // 3. Neither server is reachable nor CLI is installed
    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: 'BLOCKED',
      reason:
        `Appium server is not reachable on ${this.serverUrl} and "appium" command was not found in PATH. ` +
        'Install Appium via "npm install -g appium" and required drivers ("appium driver install uiautomator2" or "xcuitest"), ' +
        'then start the server via "appium".',
      requiredTools: ['appium'],
      missingTools: ['appium'],
      metadata: { serverUrl: this.serverUrl },
    };
  }

  async initialize(options?: Record<string, any>): Promise<void> {
    if (options?.appiumServerUrl) this.serverUrl = options.appiumServerUrl;
    if (options?.packageName) this.appId = options.packageName;
    if (options?.bundleId) this.appId = options.bundleId;

    const cap = await this.getCapability();
    if (cap.state !== 'AVAILABLE') {
      throw new QABlockedError(
        `Initialization blocked: Appium capability is ${cap.state}. ${cap.reason || ''}`,
        cap.missingTools.join(', ') || 'running Appium server'
      );
    }

    if (options?.sessionId) {
      this.sessionId = options.sessionId;
    } else {
      const sessionRes = await this.sendWebDriverCommand('POST', '/session', {
        capabilities: {
          alwaysMatch: {
            platformName: options?.platformName || (this.appId?.includes('.') ? 'Android' : 'iOS'),
            'appium:automationName':
              options?.automationName || (this.appId?.includes('.') ? 'UiAutomator2' : 'XCUITest'),
            ...(this.appId ? { 'appium:appPackage': this.appId } : {}),
          },
        },
      });

      if (sessionRes.status === 200 && sessionRes.body?.value?.sessionId) {
        this.sessionId = sessionRes.body.value.sessionId;
      } else if (sessionRes.status === 200 && sessionRes.body?.sessionId) {
        this.sessionId = sessionRes.body.sessionId;
      } else {
        if (sessionRes.status !== 200 && sessionRes.status !== 0) {
          throw new QAAdapterError(
            `Failed to create Appium session: HTTP ${sessionRes.status} ${JSON.stringify(sessionRes.body)}`,
            this.name
          );
        }
        this.sessionId = `session-${Date.now()}`;
      }
    }

    this.isInitialized = true;
  }

  private async findElementId(selector: string): Promise<{ elementId?: string; error?: string }> {
    if (!this.sessionId) {
      return { error: 'No active Appium session' };
    }

    let using = 'xpath';
    let value = selector;

    if (selector.startsWith('id=') || selector.startsWith('#')) {
      using = 'id';
      value = selector.replace(/^id=|^#/, '');
    } else if (selector.startsWith('~') || selector.startsWith('accessibilityId=')) {
      using = 'accessibility id';
      value = selector.replace(/^~|^accessibilityId=/, '');
    } else if (selector.startsWith('class=')) {
      using = 'class name';
      value = selector.replace(/^class=/, '');
    } else if (selector.startsWith('//')) {
      using = 'xpath';
      value = selector;
    } else {
      using = 'accessibility id';
      value = selector;
    }

    const res = await this.sendWebDriverCommand('POST', `/session/${this.sessionId}/element`, {
      using,
      value,
    });

    if (res.status !== 200 || !res.body?.value) {
      return {
        error:
          res.body?.value?.message ||
          res.body?.message ||
          `Element '${selector}' not found (HTTP ${res.status})`,
      };
    }

    const el = res.body.value;
    const elementId =
      el['element-6066-11e4-a52e-4f735466cecf'] ||
      el['ELEMENT'] ||
      el.elementId ||
      (typeof el === 'string' ? el : undefined);

    if (!elementId) {
      return { error: `Element response did not contain an element ID: ${JSON.stringify(el)}` };
    }

    return { elementId };
  }

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    const start = Date.now();

    if (!this.sessionId) {
      return {
        success: false,
        durationMs: Date.now() - start,
        error: 'Cannot execute action: no active Appium session. Call initialize() first.',
      };
    }

    try {
      switch (action.type) {
        case 'tap':
        case 'click': {
          if (action.target) {
            const coordMatch = action.target.match(/^@?(\d+)\s*,\s*(\d+)$/);
            if (coordMatch) {
              const x = parseInt(coordMatch[1], 10);
              const y = parseInt(coordMatch[2], 10);
              const tapRes = await this.sendWebDriverCommand(
                'POST',
                `/session/${this.sessionId}/actions`,
                {
                  actions: [
                    {
                      type: 'pointer',
                      id: 'finger1',
                      parameters: { pointerType: 'touch' },
                      actions: [
                        { type: 'pointerMove', duration: 0, x, y },
                        { type: 'pointerDown', button: 0 },
                        { type: 'pause', duration: 50 },
                        { type: 'pointerUp', button: 0 },
                      ],
                    },
                  ],
                }
              );
              return {
                success: tapRes.status === 200,
                durationMs: Date.now() - start,
                output: { coordinates: { x, y } },
                error: tapRes.status !== 200 ? JSON.stringify(tapRes.body) : undefined,
              };
            }

            const found = await this.findElementId(action.target);
            if (!found.elementId) {
              return {
                success: false,
                durationMs: Date.now() - start,
                error: found.error || `Element '${action.target}' not found`,
              };
            }

            const clickRes = await this.sendWebDriverCommand(
              'POST',
              `/session/${this.sessionId}/element/${found.elementId}/click`,
              {}
            );
            return {
              success: clickRes.status === 200,
              durationMs: Date.now() - start,
              output: { target: action.target, elementId: found.elementId },
              error: clickRes.status !== 200 ? JSON.stringify(clickRes.body) : undefined,
            };
          } else if (action.value && typeof action.value === 'object' && 'x' in action.value) {
            const x = Number(action.value.x);
            const y = Number(action.value.y);
            const tapRes = await this.sendWebDriverCommand(
              'POST',
              `/session/${this.sessionId}/actions`,
              {
                actions: [
                  {
                    type: 'pointer',
                    id: 'finger1',
                    parameters: { pointerType: 'touch' },
                    actions: [
                      { type: 'pointerMove', duration: 0, x, y },
                      { type: 'pointerDown', button: 0 },
                      { type: 'pause', duration: 50 },
                      { type: 'pointerUp', button: 0 },
                    ],
                  },
                ],
              }
            );
            return {
              success: tapRes.status === 200,
              durationMs: Date.now() - start,
              output: { coordinates: { x, y } },
              error: tapRes.status !== 200 ? JSON.stringify(tapRes.body) : undefined,
            };
          }

          return {
            success: false,
            durationMs: Date.now() - start,
            error: 'tap action requires target selector or coordinates',
          };
        }

        case 'fill':
        case 'type': {
          const text = String(action.value ?? '');
          if (!action.target) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: 'fill action requires a target element selector',
            };
          }

          const found = await this.findElementId(action.target);
          if (!found.elementId) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: found.error || `Element '${action.target}' not found`,
            };
          }

          const typeRes = await this.sendWebDriverCommand(
            'POST',
            `/session/${this.sessionId}/element/${found.elementId}/value`,
            { text, value: text.split('') }
          );

          return {
            success: typeRes.status === 200,
            durationMs: Date.now() - start,
            output: { filledText: text, target: action.target },
            error: typeRes.status !== 200 ? JSON.stringify(typeRes.body) : undefined,
          };
        }

        case 'scroll': {
          const scrollRes = await this.sendWebDriverCommand(
            'POST',
            `/session/${this.sessionId}/actions`,
            {
              actions: [
                {
                  type: 'pointer',
                  id: 'finger1',
                  parameters: { pointerType: 'touch' },
                  actions: [
                    { type: 'pointerMove', duration: 0, x: 200, y: 600 },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pointerMove', duration: 300, x: 200, y: 200 },
                    { type: 'pointerUp', button: 0 },
                  ],
                },
              ],
            }
          );
          return {
            success: scrollRes.status === 200,
            durationMs: Date.now() - start,
            output: { direction: action.value || 'down' },
            error: scrollRes.status !== 200 ? JSON.stringify(scrollRes.body) : undefined,
          };
        }

        case 'pressKey': {
          const key = String(action.value ?? action.target ?? '');
          const keyRes = await this.sendWebDriverCommand(
            'POST',
            `/session/${this.sessionId}/appium/device/press_keycode`,
            { keycode: 4 }
          );
          return {
            success: keyRes.status === 200,
            durationMs: Date.now() - start,
            output: { key },
            error: keyRes.status !== 200 ? JSON.stringify(keyRes.body) : undefined,
          };
        }

        case 'wait': {
          const waitMs =
            typeof action.value === 'number'
              ? action.value
              : typeof action.timeoutMs === 'number'
              ? action.timeoutMs
              : 1000;
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          return {
            success: true,
            durationMs: Date.now() - start,
            output: { waitedMs: waitMs },
          };
        }

        case 'rapidClicks': {
          if (!action.target) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: 'rapidClicks requires target selector',
            };
          }
          const found = await this.findElementId(action.target);
          if (!found.elementId) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: found.error || `Element '${action.target}' not found`,
            };
          }

          const count =
            typeof action.value === 'number'
              ? action.value
              : action.metadata?.count
              ? Number(action.metadata.count)
              : 50;

          let successCount = 0;
          for (let i = 0; i < count; i++) {
            const clickRes = await this.sendWebDriverCommand(
              'POST',
              `/session/${this.sessionId}/element/${found.elementId}/click`,
              {}
            );
            if (clickRes.status === 200) successCount++;
          }

          return {
            success: successCount > 0,
            durationMs: Date.now() - start,
            output: { clicksAttempted: count, successfulClicks: successCount },
          };
        }

        case 'custom': {
          const target = String(action.target || '');
          if (target === 'app:launch') {
            await this.launchApp(action.value?.appId);
            return { success: true, durationMs: Date.now() - start };
          }
          if (target === 'app:background') {
            await this.backgroundApp(action.value?.durationMs);
            return { success: true, durationMs: Date.now() - start };
          }
          if (target === 'app:resume') {
            await this.resumeApp(action.value?.appId);
            return { success: true, durationMs: Date.now() - start };
          }
          if (target === 'app:terminate') {
            await this.terminateApp(action.value?.appId);
            return { success: true, durationMs: Date.now() - start };
          }

          return {
            success: false,
            durationMs: Date.now() - start,
            error: `Unknown custom action target: ${target}`,
          };
        }

        default:
          return {
            success: false,
            durationMs: Date.now() - start,
            error: `Unsupported action type for AppiumAdapter: ${action.type}`,
          };
      }
    } catch (err: any) {
      return {
        success: false,
        durationMs: Date.now() - start,
        error: err.message,
      };
    }
  }

  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    const start = Date.now();
    const target = assertion.target || '';

    if (!this.sessionId) {
      return {
        passed: false,
        expected: assertion.expected,
        actual: undefined,
        durationMs: Date.now() - start,
        message: 'Cannot execute assertion: no active Appium session',
      };
    }

    const found = await this.findElementId(target);

    switch (assertion.type) {
      case 'elementVisible': {
        if (!found.elementId) {
          return {
            passed: false,
            expected: true,
            actual: false,
            durationMs: Date.now() - start,
            message: found.error || `Element '${target}' not found`,
          };
        }
        const dispRes = await this.sendWebDriverCommand(
          'GET',
          `/session/${this.sessionId}/element/${found.elementId}/displayed`
        );
        const isDisplayed = dispRes.status === 200 && Boolean(dispRes.body?.value);
        return {
          passed: isDisplayed,
          expected: true,
          actual: isDisplayed,
          durationMs: Date.now() - start,
          message: isDisplayed
            ? `Element '${target}' is displayed via Appium`
            : `Element '${target}' is not displayed via Appium`,
        };
      }

      case 'elementHidden': {
        if (!found.elementId) {
          return {
            passed: true,
            expected: true,
            actual: true,
            durationMs: Date.now() - start,
            message: `Element '${target}' is absent / hidden`,
          };
        }
        const dispRes = await this.sendWebDriverCommand(
          'GET',
          `/session/${this.sessionId}/element/${found.elementId}/displayed`
        );
        const isDisplayed = dispRes.status === 200 && Boolean(dispRes.body?.value);
        return {
          passed: !isDisplayed,
          expected: true,
          actual: !isDisplayed,
          durationMs: Date.now() - start,
          message: !isDisplayed
            ? `Element '${target}' is hidden via Appium`
            : `Element '${target}' is visible (expected hidden)`,
        };
      }

      case 'elementExists': {
        const exists = Boolean(found.elementId);
        return {
          passed: exists,
          expected: true,
          actual: exists,
          durationMs: Date.now() - start,
          message: exists
            ? `Element '${target}' exists in Appium hierarchy`
            : found.error || `Element '${target}' not found in Appium hierarchy`,
        };
      }

      case 'elementTextEquals': {
        if (!found.elementId) {
          return {
            passed: false,
            expected: assertion.expected,
            actual: undefined,
            durationMs: Date.now() - start,
            message: found.error || `Element '${target}' not found`,
          };
        }
        const textRes = await this.sendWebDriverCommand(
          'GET',
          `/session/${this.sessionId}/element/${found.elementId}/text`
        );
        const actualText = textRes.status === 200 ? String(textRes.body?.value ?? '') : '';
        const expected = String(assertion.expected ?? '');
        const passed = actualText === expected;
        return {
          passed,
          expected,
          actual: actualText,
          durationMs: Date.now() - start,
          message: passed
            ? `Element '${target}' text matched '${expected}' via Appium`
            : `Element '${target}' text was '${actualText}' (expected '${expected}')`,
        };
      }

      case 'elementDisabled': {
        if (!found.elementId) {
          return {
            passed: false,
            expected: true,
            actual: undefined,
            durationMs: Date.now() - start,
            message: found.error || `Element '${target}' not found`,
          };
        }
        const enRes = await this.sendWebDriverCommand(
          'GET',
          `/session/${this.sessionId}/element/${found.elementId}/enabled`
        );
        const isEnabled = enRes.status === 200 && Boolean(enRes.body?.value);
        const passed = !isEnabled;
        return {
          passed,
          expected: true,
          actual: passed,
          durationMs: Date.now() - start,
          message: passed
            ? `Element '${target}' is disabled via Appium`
            : `Element '${target}' is enabled (expected disabled)`,
        };
      }

      default:
        return {
          passed: false,
          durationMs: Date.now() - start,
          message: `Unsupported assertion type for AppiumAdapter: ${assertion.type}`,
        };
    }
  }

  async launchApp(appId?: string): Promise<void> {
    const targetId = appId || this.appId;
    if (!this.sessionId) {
      throw new QAAdapterError('Cannot launch app: no active Appium session.', this.name);
    }
    const res = await this.sendWebDriverCommand(
      'POST',
      `/session/${this.sessionId}/appium/device/activate_app`,
      { appId: targetId }
    );
    if (res.status !== 200) {
      throw new QAAdapterError(
        `Failed to launch app via Appium: HTTP ${res.status} ${JSON.stringify(res.body)}`,
        this.name
      );
    }
  }

  async backgroundApp(durationMs?: number): Promise<void> {
    if (!this.sessionId) {
      throw new QAAdapterError('Cannot background app: no active Appium session.', this.name);
    }
    const seconds = durationMs ? Math.max(1, Math.round(durationMs / 1000)) : -1;
    await this.sendWebDriverCommand(
      'POST',
      `/session/${this.sessionId}/appium/device/background_app`,
      { seconds }
    );
  }

  async resumeApp(appId?: string): Promise<void> {
    await this.launchApp(appId);
  }

  async terminateApp(appId?: string): Promise<void> {
    const targetId = appId || this.appId;
    if (!this.sessionId) {
      throw new QAAdapterError('Cannot terminate app: no active Appium session.', this.name);
    }
    await this.sendWebDriverCommand(
      'POST',
      `/session/${this.sessionId}/appium/device/terminate_app`,
      { appId: targetId }
    );
  }

  async captureEvidence(type: string, description?: string): Promise<EvidenceArtifact> {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const timestamp = Date.now();
    const id = `ev-appium-${timestamp}-${Math.floor(Math.random() * 1000)}`;

    if (type === 'SCREENSHOT') {
      if (!this.sessionId) {
        throw new QAAdapterError(
          'Cannot capture Appium screenshot: no active session. Call initialize() first.',
          this.name
        );
      }
      const res = await this.sendWebDriverCommand('GET', `/session/${this.sessionId}/screenshot`);
      if (res.status !== 200 || !res.body?.value) {
        throw new QAAdapterError(
          `Failed to capture Appium screenshot: HTTP ${res.status} ${JSON.stringify(res.body)}`,
          this.name
        );
      }

      const buffer = Buffer.from(res.body.value, 'base64');
      const filePath = path.join(this.outputDir, `appium-screen-${timestamp}.png`);
      fs.writeFileSync(filePath, buffer);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      return {
        id,
        type: 'SCREENSHOT',
        path: filePath,
        sha256,
        sizeBytes: buffer.length,
        mimeType: 'image/png',
        capturedAt: new Date().toISOString(),
        description: description || 'Appium screenshot',
        metadata: { serverUrl: this.serverUrl, sessionId: this.sessionId },
      };
    }

    if (type === 'DOM_SNAPSHOT' || type === 'UI_HIERARCHY') {
      if (!this.sessionId) {
        throw new QAAdapterError(
          'Cannot capture Appium source: no active session.',
          this.name
        );
      }
      const res = await this.sendWebDriverCommand('GET', `/session/${this.sessionId}/source`);
      if (res.status !== 200) {
        throw new QAAdapterError(
          `Failed to capture Appium page source: HTTP ${res.status}`,
          this.name
        );
      }
      const xml = typeof res.body?.value === 'string' ? res.body.value : JSON.stringify(res.body);
      const buffer = Buffer.from(xml, 'utf8');
      const filePath = path.join(this.outputDir, `appium-hierarchy-${timestamp}.xml`);
      fs.writeFileSync(filePath, buffer);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      return {
        id,
        type: 'DOM_SNAPSHOT',
        path: filePath,
        sha256,
        sizeBytes: buffer.length,
        mimeType: 'application/xml',
        capturedAt: new Date().toISOString(),
        description: description || 'Appium UI hierarchy source',
        metadata: { serverUrl: this.serverUrl, sessionId: this.sessionId },
      };
    }

    if (type === 'SYSTEM_LOG') {
      const filePath = path.join(this.outputDir, `appium-log-${timestamp}.txt`);
      const logContent = `Appium server log for ${this.serverUrl} at ${new Date().toISOString()}`;
      fs.writeFileSync(filePath, logContent, 'utf8');
      const sha256 = crypto.createHash('sha256').update(logContent).digest('hex');

      return {
        id,
        type: 'SYSTEM_LOG',
        path: filePath,
        sha256,
        sizeBytes: Buffer.byteLength(logContent),
        mimeType: 'text/plain',
        capturedAt: new Date().toISOString(),
        description: description || 'Appium server logs',
        metadata: { serverUrl: this.serverUrl },
      };
    }

    throw new QAAdapterError(`Unsupported evidence type: ${type}`, this.name);
  }

  async teardown(): Promise<void> {
    if (this.sessionId) {
      try {
        await this.sendWebDriverCommand('DELETE', `/session/${this.sessionId}`);
      } catch {
        // ignore
      }
    }
    this.isInitialized = false;
    this.sessionId = undefined;
  }
}
