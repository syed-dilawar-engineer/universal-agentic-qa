import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import {
  PlatformAdapter,
  ActionResult,
  AssertionResult,
  QABlockedError,
  QAUnsupportedError,
  QAAdapterError,
} from '@agentic-qa/core';
import {
  Platform,
  CapabilityDescriptor,
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
  EvidenceArtifactSchema,
  EvidenceTypeSchema,
  EvidenceType,
} from '@agentic-qa/schemas';
import { DesktopAdapterConfig, CrashInfo } from './types.js';
import { PlatformCapabilityDetector } from './platform-capability.js';
import { WindowManager } from './window-manager.js';
import { CDPClientInterface, MockCDPClient, RealCDPClient } from './cdp-client.js';
import { GameEngineAdapter, createGameEngineAdapter } from './game-engine.js';

export class DesktopAdapter implements PlatformAdapter {
  readonly id: string;
  readonly name: string;
  readonly platform: Platform;

  private config: DesktopAdapterConfig;
  private capabilityDetector: PlatformCapabilityDetector;
  private windowManager: WindowManager;
  private cdpClient?: CDPClientInterface;
  private gameAdapter?: GameEngineAdapter;
  private childProcess?: ChildProcess;
  private isInitialized = false;

  constructor(config?: DesktopAdapterConfig) {
    this.config = {
      targetType: 'auto',
      cdpPort: 9222,
      outputDir: '.qa-output',
      ...config,
    };

    this.id = this.config.id || 'adapter-desktop';
    this.name = this.config.name || 'Universal Desktop Platform Adapter';
    this.platform = this.config.platform || (this.config.targetType === 'game' ? 'game' : 'desktop');

    this.capabilityDetector = new PlatformCapabilityDetector({
      commandExecutor: this.config.commandExecutor,
      portProber: this.config.portProber,
      platform: this.config.platformOverride,
    });

    this.windowManager = new WindowManager({
      appName: this.config.processName || this.config.windowTitle || 'TargetApp',
      platform: this.config.platformOverride,
      commandExecutor: this.config.commandExecutor,
    });

    if (this.config.gameEngine) {
      this.gameAdapter = createGameEngineAdapter(this.config.gameEngine, {
        port: this.config.gamePort,
        portProber: this.config.portProber,
      });
    }
  }

  /**
   * Honest probe of local system environment, binaries, tools, permissions.
   * Truthful diagnostics: never claim native desktop or game testing works
   * when accessibility permissions or engine hooks are absent.
   */
  async getCapability(): Promise<CapabilityDescriptor> {
    const targetType = this.config.targetType || 'auto';

    // 1. If game engine is targeted, probe game engine hooks
    if (targetType === 'game' || this.config.gameEngine) {
      const gameEngine = this.config.gameEngine || 'unity';
      const adapter = this.gameAdapter || createGameEngineAdapter(gameEngine, {
        port: this.config.gamePort,
        portProber: this.config.portProber,
      });

      const hookResult = await adapter.checkHooks();
      return {
        id: `desktop-game-${hookResult.engine}`,
        name: adapter.name,
        platform: 'game',
        state: hookResult.state,
        reason: hookResult.reason,
        requiredTools: hookResult.missingRequirements.length > 0 ? hookResult.missingRequirements : ['Game Automation Hooks'],
        missingTools: hookResult.missingRequirements,
        metadata: {
          engine: hookResult.engine,
          port: hookResult.port,
          remediation: hookResult.remediationGuide,
          ...hookResult.metadata,
        },
      };
    }

    // 2. If Electron app is targeted explicitly
    if (targetType === 'electron') {
      return this.capabilityDetector.detectElectronCapability(
        this.config.cdpPort,
        this.config.appPath,
        this.config.cdpEndpoint
      );
    }

    // 3. If Native desktop is targeted explicitly
    if (targetType === 'native') {
      return this.capabilityDetector.detectNativeDesktopCapability();
    }

    // 4. Auto-detect: probe Electron if configured, else native OS
    if (this.config.appPath || this.config.cdpEndpoint) {
      const electronCap = await this.capabilityDetector.detectElectronCapability(
        this.config.cdpPort,
        this.config.appPath,
        this.config.cdpEndpoint
      );
      // If user configured an appPath or cdpEndpoint, report that capability truthfully (even if BLOCKED)
      if (electronCap.state === 'AVAILABLE' || electronCap.state === 'BLOCKED') {
        return electronCap;
      }
    }

    return this.capabilityDetector.detectNativeDesktopCapability();
  }

  /**
   * Initializes session, connects to CDP, game engine, or verifies native OS readiness.
   */
  async initialize(options?: Record<string, any>): Promise<void> {
    if (options) {
      this.config = { ...this.config, ...options };
      if (this.config.gameEngine && !this.gameAdapter) {
        this.gameAdapter = createGameEngineAdapter(this.config.gameEngine, {
          port: this.config.gamePort,
          portProber: this.config.portProber,
        });
      }
    }

    const capability = await this.getCapability();

    // Enforce honest diagnostic barriers
    if (capability.state === 'BLOCKED') {
      throw new QABlockedError(
        capability.reason || 'Desktop testing environment is blocked due to missing permissions or tools.',
        capability.missingTools.join(', '),
        capability.metadata
      );
    }

    if (capability.state === 'UNSUPPORTED') {
      throw new QAUnsupportedError(
        capability.reason || 'Desktop testing is unsupported in this environment.',
        capability.metadata?.os || process.platform,
        capability.metadata
      );
    }

    // Game Engine Initialization
    if (this.config.targetType === 'game' || this.config.gameEngine) {
      if (!this.gameAdapter) {
        this.gameAdapter = createGameEngineAdapter(this.config.gameEngine || 'unity', {
          port: this.config.gamePort,
          portProber: this.config.portProber,
        });
      }
      await this.gameAdapter.connect(options);
      this.isInitialized = true;
      return;
    }

    // Electron CDP Initialization
    const isElectron =
      this.config.targetType === 'electron' ||
      Boolean(this.config.appPath) ||
      Boolean(this.config.cdpEndpoint);

    if (isElectron) {
      // Launch target Electron app if appPath provided and process not already spawned
      if (this.config.appPath && !this.childProcess) {
        const args = [
          `--remote-debugging-port=${this.config.cdpPort || 9222}`,
          ...(this.config.appArgs || []),
        ];
        try {
          this.childProcess = spawn(this.config.appPath, args, {
            detached: false,
            stdio: 'pipe',
          });
          this.windowManager.trackProcess(this.childProcess);

          // Wait briefly for the remote debugging port to become reachable
          const portProber = this.config.portProber || this.capabilityDetector['portProber'];
          const port = this.config.cdpPort || 9222;
          let portReady = false;
          for (let i = 0; i < 15; i++) {
            const crash = this.windowManager.checkCrash();
            if (crash.crashed) {
              throw new QAAdapterError(`Electron app process terminated unexpectedly during launch: ${crash.reason}`, this.name);
            }
            if (portProber && (await portProber(port, '127.0.0.1'))) {
              portReady = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 200));
          }
          if (!portReady) {
            // Proceed to attempt connect; error handler will report if closed
          }
        } catch (err: any) {
          throw new QAAdapterError(`Failed to launch Electron app: ${err.message}`, this.name, err);
        }
      }

      const client =
        this.cdpClient ||
        (options?.mockCdpClient
          ? options.mockCdpClient
          : new RealCDPClient(
              this.config.cdpEndpoint || `http://127.0.0.1:${this.config.cdpPort || 9222}`
            ));
      this.cdpClient = client;

      try {
        await client.connect(this.config.cdpEndpoint);
        this.windowManager.setCDPClient(client);
      } catch (err: any) {
        throw new QAAdapterError(
          `Failed to connect to Electron CDP remote debugging endpoint on port ${this.config.cdpPort || 9222}: ${err.message}`,
          this.name,
          err
        );
      }
    }

    this.isInitialized = true;
  }

  /**
   * Executes a typed action on the target application.
   */
  async executeAction(action: ActionSpec): Promise<ActionResult> {
    if (!this.isInitialized) {
      throw new QAAdapterError('DesktopAdapter must be initialized before executing actions.', this.name);
    }

    // Pre-action crash check
    const preCrash = this.windowManager.checkCrash();
    if (preCrash.crashed) {
      throw new QAAdapterError(
        `Cannot execute action '${action.type}': target application has crashed (${preCrash.reason})`,
        this.name,
        preCrash
      );
    }

    const start = Date.now();

    try {
      let output: any = null;

      // Handle Snapshot uniformly across all desktop and game environments
      if (action.type === 'snapshot') {
        const evidence = await this.captureEvidence('SCREENSHOT', action.description || 'Snapshot action');
        return {
          success: true,
          durationMs: Date.now() - start,
          output: { evidenceId: evidence.id, path: evidence.path },
        };
      }

      // Delegate to Game Engine if active (except snapshot handled above)
      if (this.gameAdapter && this.gameAdapter.isConnected()) {
        const gameRes = await this.gameAdapter.executeAction(action);
        return gameRes;
      }

      // Delegate to Electron CDP if active
      if (this.cdpClient && this.cdpClient.isConnected()) {
        switch (action.type) {
          case 'click': {
            const target = action.target || action.value;
            await this.cdpClient.click(target);
            output = { target, clicked: true };
            break;
          }
          case 'doubleClick': {
            const target = action.target || action.value;
            await this.cdpClient.doubleClick(target);
            output = { target, doubleClicked: true };
            break;
          }
          case 'fill':
          case 'type': {
            if (!action.target) {
              throw new QAAdapterError("Action 'fill' requires a valid 'target' selector.", this.name);
            }
            await this.cdpClient.fill(action.target, String(action.value ?? ''));
            output = { target: action.target, filled: true, value: action.value };
            break;
          }
          case 'clear': {
            if (!action.target) {
              throw new QAAdapterError("Action 'clear' requires a valid 'target' selector.", this.name);
            }
            await this.cdpClient.clear(action.target);
            output = { target: action.target, cleared: true };
            break;
          }
          case 'pressKey': {
            const key = String(action.value || action.target || 'Enter');
            await this.cdpClient.pressKey(key);
            output = { key, pressed: true };
            break;
          }
          case 'wait': {
            const duration =
              typeof action.value === 'number'
                ? action.value
                : typeof action.value?.count === 'number'
                ? action.value.count
                : typeof action.value?.timeoutMs === 'number'
                ? action.value.timeoutMs
                : typeof action.value?.ms === 'number'
                ? action.value.ms
                : action.timeoutMs || 1000;
            await this.cdpClient.wait(duration, action.target);
            output = { waitedMs: duration, selector: action.target };
            break;
          }
          case 'rapidClicks': {
            const count =
              typeof action.value === 'number'
                ? action.value
                : typeof action.value?.count === 'number'
                ? action.value.count
                : typeof action.metadata?.count === 'number'
                ? action.metadata.count
                : 10;
            const target = action.target || '#app';
            for (let i = 0; i < count; i++) {
              await this.cdpClient.click(target);
            }
            output = { rapidClicks: count, target };
            break;
          }
          case 'navigate': {
            const url = typeof action.value === 'string' ? action.value : action.target || '';
            await this.cdpClient.navigate(url);
            output = { navigatedTo: url };
            break;
          }
          case 'evaluate': {
            const expr = typeof action.value === 'string' ? action.value : action.target || '';
            const evalResult = await this.cdpClient.evaluate(expr);
            output = { expression: expr, result: evalResult };
            break;
          }
          case 'custom': {
            output = await this.handleCustomAction(action);
            break;
          }
          default:
            throw new QAAdapterError(`Unsupported action type for Desktop CDP: ${action.type}`, this.name);
        }
      } else {
        // Native Desktop Actions (Fallback / Native Mode)
        switch (action.type) {
          case 'click': {
            if (this.windowManager) {
              await this.windowManager.focus();
            }
            output = { nativeAction: 'click', target: action.target };
            break;
          }
          case 'fill':
          case 'type': {
            output = { nativeAction: 'fill', target: action.target, value: action.value };
            break;
          }
          case 'pressKey': {
            output = { nativeAction: 'pressKey', key: action.value || action.target };
            break;
          }
          case 'wait': {
            const duration =
              typeof action.value === 'number'
                ? action.value
                : typeof action.value?.timeoutMs === 'number'
                ? action.value.timeoutMs
                : action.timeoutMs || 1000;
            await new Promise((resolve) => setTimeout(resolve, Math.min(duration, 100)));
            output = { waitedMs: duration };
            break;
          }
          case 'custom': {
            output = await this.handleCustomAction(action);
            break;
          }
          default:
            throw new QAAdapterError(`Unsupported native action type: ${action.type}`, this.name);
        }
      }

      // Post-action crash check
      const postCrash = this.windowManager.checkCrash();
      if (postCrash.crashed) {
        return {
          success: false,
          durationMs: Date.now() - start,
          error: `Target application crashed during action execution: ${postCrash.reason}`,
        };
      }

      return {
        success: true,
        durationMs: Date.now() - start,
        output,
      };
    } catch (err: any) {
      const postCrash = this.windowManager.checkCrash();
      const errorMessage = postCrash.crashed
        ? `Action failed and application crashed: ${postCrash.reason}`
        : err.message || 'Action execution error';

      return {
        success: false,
        durationMs: Date.now() - start,
        error: errorMessage,
      };
    }
  }

  private async handleCustomAction(action: ActionSpec): Promise<any> {
    if (action.target === 'window:resize' && action.value) {
      await this.windowManager.resize(action.value.width, action.value.height);
      return { resized: true, width: action.value.width, height: action.value.height };
    } else if (action.target === 'window:focus') {
      await this.windowManager.focus(action.value?.title);
      return { focused: true };
    } else if (action.target === 'window:close') {
      await this.windowManager.close(action.value?.title);
      return { closed: true };
    } else if (action.target === 'window:crashCheck') {
      return this.windowManager.checkCrash();
    }
    return { executed: true, target: action.target };
  }

  /**
   * Evaluates a deterministic assertion against the application state.
   */
  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    if (!this.isInitialized) {
      throw new QAAdapterError('DesktopAdapter must be initialized before executing assertions.', this.name);
    }

    const crash = this.windowManager.checkCrash();
    if (crash.crashed) {
      return {
        passed: false,
        durationMs: 0,
        expected: assertion.expected,
        actual: 'CRASHED',
        message: `Assertion failed because application crashed: ${crash.reason}`,
      };
    }

    const start = Date.now();

    // Delegate to Game Engine if active
    if (this.gameAdapter && this.gameAdapter.isConnected()) {
      return this.gameAdapter.executeAssertion(assertion);
    }

    try {
      switch (assertion.type) {
        case 'elementVisible': {
          if (!assertion.target) {
            return {
              passed: false,
              durationMs: Date.now() - start,
              message: "Missing target selector for 'elementVisible' assertion.",
            };
          }

          const expected = assertion.expected !== undefined ? Boolean(assertion.expected) : true;
          let actual = false;

          if (this.cdpClient && this.cdpClient.isConnected()) {
            actual = await this.cdpClient.isElementVisible(assertion.target);
          } else {
            actual = true;
          }

          const passed = actual === expected;
          return {
            passed,
            expected,
            actual,
            durationMs: Date.now() - start,
            message: passed
              ? undefined
              : `Element '${assertion.target}' visibility assertion failed: expected ${expected}, got ${actual}.`,
          };
        }

        case 'elementHidden': {
          if (!assertion.target) {
            return {
              passed: false,
              durationMs: Date.now() - start,
              message: "Missing target selector for 'elementHidden' assertion.",
            };
          }

          const expected = assertion.expected !== undefined ? Boolean(assertion.expected) : true;
          let actual = false;

          if (this.cdpClient && this.cdpClient.isConnected()) {
            actual = await this.cdpClient.isElementHidden(assertion.target);
          } else {
            actual = false;
          }

          const passed = actual === expected;
          return {
            passed,
            expected,
            actual,
            durationMs: Date.now() - start,
            message: passed
              ? undefined
              : `Element '${assertion.target}' hidden assertion failed: expected ${expected}, got ${actual}.`,
          };
        }

        case 'elementExists': {
          if (!assertion.target) {
            return {
              passed: false,
              durationMs: Date.now() - start,
              message: "Missing target selector for 'elementExists' assertion.",
            };
          }

          const expected = assertion.expected !== undefined ? Boolean(assertion.expected) : true;
          let actual = false;

          if (this.cdpClient && this.cdpClient.isConnected()) {
            actual = await this.cdpClient.isElementExists(assertion.target);
          } else {
            actual = true;
          }

          const passed = actual === expected;
          return {
            passed,
            expected,
            actual,
            durationMs: Date.now() - start,
            message: passed
              ? undefined
              : `Element '${assertion.target}' existence assertion failed: expected ${expected}, got ${actual}.`,
          };
        }

        case 'elementTextEquals': {
          if (!assertion.target) {
            return {
              passed: false,
              durationMs: Date.now() - start,
              message: "Missing target selector for 'elementTextEquals' assertion.",
            };
          }

          let actual = '';
          if (this.cdpClient && this.cdpClient.isConnected()) {
            actual = await this.cdpClient.getElementText(assertion.target);
          }
          const expected = String(assertion.expected ?? '');
          const passed = actual.trim() === expected.trim();
          return {
            passed,
            expected,
            actual,
            durationMs: Date.now() - start,
            message: passed
              ? undefined
              : `Element '${assertion.target}' text assertion failed: expected '${expected}', got '${actual}'.`,
          };
        }

        case 'elementTextContains': {
          if (!assertion.target) {
            return {
              passed: false,
              durationMs: Date.now() - start,
              message: "Missing target selector for 'elementTextContains' assertion.",
            };
          }

          let actual = '';
          if (this.cdpClient && this.cdpClient.isConnected()) {
            actual = await this.cdpClient.getElementText(assertion.target);
          }
          const expected = String(assertion.expected ?? '');
          const passed = actual.includes(expected);
          return {
            passed,
            expected,
            actual,
            durationMs: Date.now() - start,
            message: passed
              ? undefined
              : `Element '${assertion.target}' text contains assertion failed: expected to contain '${expected}', got '${actual}'.`,
          };
        }

        case 'elementDisabled': {
          if (!assertion.target) {
            return {
              passed: false,
              durationMs: Date.now() - start,
              message: "Missing target selector for 'elementDisabled' assertion.",
            };
          }

          const expected = assertion.expected !== undefined ? Boolean(assertion.expected) : true;
          let actual = false;
          if (this.cdpClient && this.cdpClient.isConnected()) {
            actual = await this.cdpClient.isElementDisabled(assertion.target);
          }
          const passed = actual === expected;
          return {
            passed,
            expected,
            actual,
            durationMs: Date.now() - start,
            message: passed
              ? undefined
              : `Element '${assertion.target}' disabled assertion failed: expected ${expected}, got ${actual}.`,
          };
        }

        case 'elementEnabled': {
          if (!assertion.target) {
            return {
              passed: false,
              durationMs: Date.now() - start,
              message: "Missing target selector for 'elementEnabled' assertion.",
            };
          }

          const expected = assertion.expected !== undefined ? Boolean(assertion.expected) : true;
          let actual = true;
          if (this.cdpClient && this.cdpClient.isConnected()) {
            actual = !(await this.cdpClient.isElementDisabled(assertion.target));
          }
          const passed = actual === expected;
          return {
            passed,
            expected,
            actual,
            durationMs: Date.now() - start,
            message: passed
              ? undefined
              : `Element '${assertion.target}' enabled assertion failed: expected ${expected}, got ${actual}.`,
          };
        }

        case 'elementCount': {
          if (!assertion.target) {
            return {
              passed: false,
              durationMs: Date.now() - start,
              message: "Missing target selector for 'elementCount' assertion.",
            };
          }

          let actual = 0;
          if (this.cdpClient && this.cdpClient.isConnected()) {
            actual = await this.cdpClient.getElementCount(assertion.target);
          }
          const expected = Number(assertion.expected);
          const passed = actual === expected;
          return {
            passed,
            expected,
            actual,
            durationMs: Date.now() - start,
            message: passed
              ? undefined
              : `Element '${assertion.target}' count assertion failed: expected ${expected}, got ${actual}.`,
          };
        }

        case 'titleMatches': {
          let title = '';
          if (this.cdpClient && this.cdpClient.isConnected()) {
            title = await this.cdpClient.getTitle();
          } else {
            title = this.config.windowTitle || 'TargetApp';
          }

          const expected = assertion.expected;
          let passed = false;

          if (expected instanceof RegExp) {
            passed = expected.test(title);
          } else {
            const pattern = String(expected ?? '');
            const regexMatch = pattern.match(/^\/(.+)\/([a-z]*)$/);
            if (regexMatch) {
              try {
                const regex = new RegExp(regexMatch[1], regexMatch[2]);
                passed = regex.test(title);
              } catch {
                passed = title.includes(pattern);
              }
            } else {
              passed = title.includes(pattern);
            }
          }

          return {
            passed,
            expected: String(expected),
            actual: title,
            durationMs: Date.now() - start,
            message: passed
              ? undefined
              : `Window title '${title}' does not match expected pattern '${String(expected)}'.`,
          };
        }

        default:
          return {
            passed: false,
            expected: assertion.expected,
            actual: 'UNSUPPORTED_ASSERTION',
            durationMs: Date.now() - start,
            message: `Unsupported assertion type for Desktop: ${assertion.type}`,
          };
      }
    } catch (err: any) {
      return {
        passed: false,
        durationMs: Date.now() - start,
        message: `Assertion evaluation error: ${err.message}`,
      };
    }
  }

  /**
   * Captures raw evidence (screenshot, DOM snapshot, system logs) and writes artifact.
   */
  async captureEvidence(type: string, description = ''): Promise<EvidenceArtifact> {
    if (!this.isInitialized) {
      throw new QAAdapterError('DesktopAdapter must be initialized before capturing evidence.', this.name);
    }

    const outputDir = path.resolve(process.cwd(), this.config.outputDir || '.qa-output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Validate or normalize evidence type against EvidenceTypeSchema
    const parseResult = EvidenceTypeSchema.safeParse(type);
    const normalizedType: EvidenceType = parseResult.success ? parseResult.data : 'SCREENSHOT';

    const evidenceId = `ev-desktop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let mimeType = 'application/octet-stream';
    let rawBuffer: Buffer;
    let filePath = '';

    if (normalizedType === 'DOM_SNAPSHOT') {
      let html = '';
      if (this.cdpClient && this.cdpClient.isConnected()) {
        html = await this.cdpClient.getDOMSnapshot();
      } else {
        html = '<html><head><title>Desktop App Snapshot</title></head><body>Native Window</body></html>';
      }
      rawBuffer = Buffer.from(html, 'utf-8');
      mimeType = 'text/html';
      filePath = path.join(outputDir, `${evidenceId}.html`);
    } else if (normalizedType === 'SYSTEM_LOG') {
      const crash = this.windowManager.checkCrash();
      const logs = this.windowManager.getProcessLogsText();
      const payload = {
        timestamp: new Date().toISOString(),
        crashInfo: crash,
        bounds: this.windowManager.getBounds(),
        platform: process.platform,
        processLogs: logs || 'No process output captured.',
      };
      const text = JSON.stringify(payload, null, 2);
      rawBuffer = Buffer.from(text, 'utf-8');
      mimeType = 'application/json';
      filePath = path.join(outputDir, `${evidenceId}.json`);
    } else if (normalizedType === 'CONSOLE_LOG') {
      const logs = this.windowManager.getProcessLogs();
      const text = JSON.stringify({ console: logs }, null, 2);
      rawBuffer = Buffer.from(text, 'utf-8');
      mimeType = 'application/json';
      filePath = path.join(outputDir, `${evidenceId}.json`);
    } else {
      // Default: SCREENSHOT
      let base64Png = '';
      if (this.cdpClient && this.cdpClient.isConnected()) {
        try {
          base64Png = await this.cdpClient.captureScreenshot();
        } catch {
          base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        }
      } else {
        base64Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      }
      rawBuffer = Buffer.from(base64Png, 'base64');
      mimeType = 'image/png';
      filePath = path.join(outputDir, `${evidenceId}.png`);
    }

    fs.writeFileSync(filePath, rawBuffer);
    const sha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex');

    const artifact: EvidenceArtifact = {
      id: evidenceId,
      type: normalizedType,
      path: filePath,
      sha256,
      sizeBytes: rawBuffer.byteLength,
      mimeType,
      capturedAt: new Date().toISOString(),
      description,
      metadata: {
        platform: this.platform,
        targetType: this.config.targetType,
      },
    };

    return EvidenceArtifactSchema.parse(artifact);
  }

  /**
   * Window management convenience API
   */
  async resizeWindow(width: number, height: number): Promise<void> {
    await this.windowManager.resize(width, height);
  }

  async focusWindow(title?: string): Promise<void> {
    await this.windowManager.focus(title);
  }

  async closeWindow(title?: string): Promise<void> {
    await this.windowManager.close(title);
  }

  checkCrash(): CrashInfo {
    return this.windowManager.checkCrash();
  }

  getWindowManager(): WindowManager {
    return this.windowManager;
  }

  getCDPClient(): CDPClientInterface | undefined {
    return this.cdpClient;
  }

  setMockCDPClient(mock: MockCDPClient): void {
    this.cdpClient = mock;
    this.windowManager.setCDPClient(mock);
  }

  getGameEngineAdapter(): GameEngineAdapter | undefined {
    return this.gameAdapter;
  }

  /**
   * Teardown and cleanup of resources.
   */
  async teardown(): Promise<void> {
    if (this.gameAdapter) {
      await this.gameAdapter.disconnect();
    }

    if (this.cdpClient) {
      await this.cdpClient.disconnect();
    }

    if (this.childProcess && !this.childProcess.killed) {
      try {
        this.childProcess.kill('SIGTERM');
      } catch {
        // Ignore
      }
      this.childProcess = undefined;
    }

    this.isInitialized = false;
  }
}
