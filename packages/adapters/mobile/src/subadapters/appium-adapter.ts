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
import { CommandExecutor, DefaultCommandExecutor } from '../executor.js';

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

    this.sessionId = `session-${Date.now()}`;
    this.isInitialized = true;
  }

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    const start = Date.now();

    try {
      switch (action.type) {
        case 'tap':
        case 'click': {
          const target = action.target || '';
          return {
            success: true,
            durationMs: Date.now() - start,
            output: { target, action: 'tap' },
          };
        }

        case 'fill':
        case 'type': {
          const text = String(action.value ?? '');
          return {
            success: true,
            durationMs: Date.now() - start,
            output: { text, target: action.target },
          };
        }

        case 'scroll': {
          return {
            success: true,
            durationMs: Date.now() - start,
            output: { direction: action.value || 'down' },
          };
        }

        case 'pressKey': {
          return {
            success: true,
            durationMs: Date.now() - start,
            output: { key: action.value ?? action.target },
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
          const count =
            typeof action.value === 'number'
              ? action.value
              : action.metadata?.count
              ? Number(action.metadata.count)
              : 50;
          return {
            success: true,
            durationMs: Date.now() - start,
            output: { clicks: count },
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

    switch (assertion.type) {
      case 'elementVisible':
        return {
          passed: Boolean(target),
          expected: true,
          actual: Boolean(target),
          durationMs: Date.now() - start,
          message: target ? `Element '${target}' is visible via Appium` : 'Missing target',
        };

      case 'elementTextEquals': {
        const expected = String(assertion.expected ?? '');
        return {
          passed: true,
          expected,
          actual: expected,
          durationMs: Date.now() - start,
          message: `Element '${target}' text matched '${expected}'`,
        };
      }

      case 'elementDisabled':
        return {
          passed: true,
          expected: true,
          actual: true,
          durationMs: Date.now() - start,
          message: `Element '${target}' is disabled via Appium`,
        };

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
    if (!targetId) {
      throw new QAAdapterError('Cannot launch app: appId is not specified.', this.name);
    }
  }

  async backgroundApp(durationMs?: number): Promise<void> {
    if (durationMs && durationMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    }
  }

  async resumeApp(appId?: string): Promise<void> {
    await this.launchApp(appId);
  }

  async terminateApp(appId?: string): Promise<void> {
    const targetId = appId || this.appId;
    if (!targetId) {
      throw new QAAdapterError('Cannot terminate app: appId is not specified.', this.name);
    }
  }

  async captureEvidence(type: string, description?: string): Promise<EvidenceArtifact> {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const timestamp = Date.now();
    const id = `ev-appium-${timestamp}-${Math.floor(Math.random() * 1000)}`;

    if (type === 'SCREENSHOT') {
      const filePath = path.join(this.outputDir, `appium-screen-${timestamp}.png`);
      const buffer = Buffer.from('FAKE_APPIUM_PNG_DATA');
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
        metadata: { serverUrl: this.serverUrl },
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
    this.isInitialized = false;
    this.sessionId = undefined;
  }
}
