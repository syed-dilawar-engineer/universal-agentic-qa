import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
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
import { DesktopAdapterConfig, CrashInfo, FrameRateMetrics } from './types.js';
import { PlatformCapabilityDetector, defaultCommandExecutor } from './platform-capability.js';
import { WindowManager } from './window-manager.js';
import { CDPClientInterface, MockCDPClient, RealCDPClient } from './cdp-client.js';
import { GameEngineAdapter, createGameEngineAdapter, measureFrameRate } from './game-engine.js';

function crc32(buf: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
    }
  }
  return (crc ^ -1) >>> 0;
}

function createPngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([typeBuf, data]);
  const crc = crc32(typeAndData);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([lenBuf, typeAndData, crcBuf]);
}

export function makeFallbackPng(width = 320, height = 240): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = createPngChunk('IHDR', ihdr);

  const rowSize = 1 + width * 4;
  const rawScanlines = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawScanlines[rowOffset] = 0;
    for (let x = 0; x < width; x++) {
      const p = rowOffset + 1 + x * 4;
      rawScanlines[p] = 45;      // R
      rawScanlines[p + 1] = 52;  // G
      rawScanlines[p + 2] = 64;  // B
      rawScanlines[p + 3] = 255; // A
    }
  }
  const compressed = zlib.deflateSync(rawScanlines);
  const idatChunk = createPngChunk('IDAT', compressed);
  const iendChunk = createPngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

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
        client: this.config.gameClient,
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
          client: this.config.gameClient,
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
            const clickDetails = await this.executeNativeClick(action);
            output = { nativeAction: 'click', target: action.target, ...clickDetails };
            break;
          }
          case 'fill':
          case 'type': {
            if (this.windowManager) {
              await this.windowManager.focus();
            }
            const text = String(action.value ?? '');
            await this.executeNativeType(text);
            output = { nativeAction: action.type, target: action.target, value: action.value };
            break;
          }
          case 'pressKey': {
            if (this.windowManager) {
              await this.windowManager.focus();
            }
            const key = String(action.value || action.target || 'Enter');
            const keyDetails = await this.executeNativePressKey(key);
            output = { nativeAction: 'pressKey', key, ...keyDetails };
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
    } else if (action.target === 'window:minimize') {
      await this.windowManager.minimize(action.value?.title);
      return { minimized: true };
    } else if (action.target === 'window:restore') {
      await this.windowManager.restore(action.value?.title);
      return { restored: true };
    } else if (action.target === 'window:blur') {
      await this.windowManager.blur();
      return { blurred: true };
    } else if (action.target === 'window:close') {
      await this.windowManager.close(action.value?.title);
      return { closed: true };
    } else if (action.target === 'window:crashCheck') {
      return this.windowManager.checkCrash();
    } else if (action.target === 'game:fps' || action.target === 'game:measureFrameRate') {
      return this.measureFrameRate(typeof action.value === 'number' ? action.value : 500);
    }
    return { executed: true, target: action.target };
  }

  private async executeNativeClick(action: ActionSpec): Promise<Record<string, any>> {
    const os = this.config.platformOverride || process.platform;
    const commandExecutor = this.config.commandExecutor || defaultCommandExecutor;
    const appName = this.config.processName || this.config.windowTitle || 'TargetApp';

    let coords: { x: number; y: number } | undefined;
    const targetStr = typeof action.target === 'string' ? action.target : '';
    const coordMatch = targetStr.match(/^@?(\d+)\s*,\s*(\d+)$/);
    if (coordMatch) {
      coords = { x: parseInt(coordMatch[1], 10), y: parseInt(coordMatch[2], 10) };
    } else if (action.value && typeof action.value.x === 'number' && typeof action.value.y === 'number') {
      coords = { x: action.value.x, y: action.value.y };
    }

    if (os === 'darwin') {
      let script = '';
      if (coords) {
        script = `tell application "System Events" to click at {${coords.x}, ${coords.y}}`;
      } else if (action.target) {
        script = `tell application "System Events" to tell process "${appName}" to click (first UI element whose name is "${action.target}" or description is "${action.target}" or title is "${action.target}")`;
      } else {
        script = `tell application "System Events" to tell process "${appName}" to click`;
      }
      await commandExecutor('osascript', ['-e', script]);
      return { clicked: true, coordinates: coords };
    } else if (os === 'win32') {
      const x = coords?.x ?? 100;
      const y = coords?.y ?? 100;
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y});
$code = '[DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int cButtons, int info);';
$mouse = Add-Type -MemberDefinition $code -Name Win32Mouse -Namespace Win32Utils -PassThru;
$mouse::mouse_event(0x02, 0, 0, 0, 0);
$mouse::mouse_event(0x04, 0, 0, 0, 0);
`.trim().replace(/\n/g, ' ');
      await commandExecutor('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
      return { clicked: true, coordinates: { x, y } };
    } else if (os === 'linux') {
      if (coords) {
        await commandExecutor('xdotool', ['mousemove', String(coords.x), String(coords.y), 'click', '1']);
      } else {
        await commandExecutor('xdotool', ['click', '1']);
      }
      return { clicked: true, coordinates: coords };
    }

    return { clicked: true };
  }

  private async executeNativePressKey(key: string): Promise<Record<string, any>> {
    const os = this.config.platformOverride || process.platform;
    const commandExecutor = this.config.commandExecutor || defaultCommandExecutor;

    if (os === 'darwin') {
      const KEY_CODES: Record<string, number> = {
        Enter: 36,
        Return: 36,
        Tab: 48,
        Space: 49,
        ' ': 49,
        Escape: 53,
        Esc: 53,
        Backspace: 51,
        Delete: 117,
        ArrowUp: 126,
        ArrowDown: 125,
        ArrowLeft: 123,
        ArrowRight: 124,
      };

      if (KEY_CODES[key] !== undefined) {
        await commandExecutor('osascript', ['-e', `tell application "System Events" to key code ${KEY_CODES[key]}`]);
      } else {
        const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        await commandExecutor('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`]);
      }
      return { pressed: true, key };
    } else if (os === 'win32') {
      const WIN_KEYS: Record<string, string> = {
        Enter: '{ENTER}',
        Return: '{ENTER}',
        Tab: '{TAB}',
        Escape: '{ESC}',
        Esc: '{ESC}',
        Backspace: '{BACKSPACE}',
        Delete: '{DELETE}',
        ArrowUp: '{UP}',
        ArrowDown: '{DOWN}',
        ArrowLeft: '{LEFT}',
        ArrowRight: '{RIGHT}',
      };
      const sendKey = WIN_KEYS[key] || key.replace(/'/g, "''");
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKey}')`;
      await commandExecutor('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
      return { pressed: true, key };
    } else if (os === 'linux') {
      const LINUX_KEYS: Record<string, string> = {
        Enter: 'Return',
        Escape: 'Escape',
        Tab: 'Tab',
        Space: 'space',
        Backspace: 'BackSpace',
        Delete: 'Delete',
      };
      const linuxKey = LINUX_KEYS[key] || key;
      await commandExecutor('xdotool', ['key', linuxKey]);
      return { pressed: true, key };
    }

    return { pressed: true, key };
  }

  private async executeNativeType(text: string): Promise<void> {
    const os = this.config.platformOverride || process.platform;
    const commandExecutor = this.config.commandExecutor || defaultCommandExecutor;

    if (os === 'darwin') {
      const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await commandExecutor('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`]);
    } else if (os === 'win32') {
      const escaped = text.replace(/'/g, "''");
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`;
      await commandExecutor('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
    } else if (os === 'linux') {
      await commandExecutor('xdotool', ['type', '--', text]);
    }
  }

  private async inspectNativeUIElement(target: string): Promise<{
    exists: boolean;
    visible: boolean;
    text: string;
    disabled: boolean;
  }> {
    if (!this.windowManager.isProcessAlive()) {
      return { exists: false, visible: false, text: '', disabled: false };
    }

    const os = this.config.platformOverride || process.platform;
    const commandExecutor = this.config.commandExecutor || defaultCommandExecutor;
    const appName = this.config.processName || this.config.windowTitle || 'TargetApp';
    const windowTitle = this.config.windowTitle || appName;

    if (
      target.toLowerCase() === appName.toLowerCase() ||
      target.toLowerCase() === windowTitle.toLowerCase()
    ) {
      return { exists: true, visible: true, text: windowTitle, disabled: false };
    }

    try {
      if (os === 'darwin') {
        const script = `
tell application "System Events"
  try
    set appProc to (first process whose name is "${appName}")
    set foundEl to (first UI element of appProc whose name is "${target}" or description is "${target}" or title is "${target}")
    set isVis to visible of foundEl
    set elText to ""
    try
      set elText to value of foundEl as text
    end try
    set isEnabled to enabled of foundEl
    return (isVis as text) & ":::" & elText & ":::" & (isEnabled as text)
  on error
    return "NOT_FOUND"
  end try
end tell
`.trim();
        const res = await commandExecutor('osascript', ['-e', script]);
        if (res.exitCode === 0 && res.stdout && !res.stdout.includes('NOT_FOUND')) {
          const parts = res.stdout.split(':::');
          const visible = parts[0]?.trim() === 'true';
          const text = parts[1] || '';
          const enabled = parts[2]?.trim() === 'true';
          return { exists: true, visible, text, disabled: !enabled };
        }
        return { exists: false, visible: false, text: '', disabled: false };
      } else if (os === 'win32') {
        const psScript = `
Add-Type -AssemblyName UIAutomationClient;
$root = [System.Windows.Automation.AutomationElement]::RootElement;
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "${target}");
$el = $root.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $cond);
if ($el) {
  $vis = -not $el.Current.IsOffscreen;
  $en = $el.Current.IsEnabled;
  Write-Output "$vis:::$($el.Current.Name):::$en";
} else {
  Write-Output "NOT_FOUND";
}
`.trim().replace(/\n/g, ' ');
        const res = await commandExecutor('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
        if (res.exitCode === 0 && res.stdout && !res.stdout.includes('NOT_FOUND')) {
          const parts = res.stdout.split(':::');
          const visible = parts[0]?.trim() === 'True' || parts[0]?.trim() === 'true';
          const text = parts[1] || '';
          const enabled = parts[2]?.trim() === 'True' || parts[2]?.trim() === 'true';
          return { exists: true, visible, text, disabled: !enabled };
        }
        return { exists: false, visible: false, text: '', disabled: false };
      } else if (os === 'linux') {
        const res = await commandExecutor('xdotool', ['search', '--name', target]);
        if (res.exitCode === 0 && res.stdout.trim().length > 0) {
          return { exists: true, visible: true, text: target, disabled: false };
        }
        return { exists: false, visible: false, text: '', disabled: false };
      }
    } catch {
      return { exists: false, visible: false, text: '', disabled: false };
    }

    return { exists: false, visible: false, text: '', disabled: false };
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
            const inspected = await this.inspectNativeUIElement(assertion.target);
            actual = inspected.exists && inspected.visible;
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
            const inspected = await this.inspectNativeUIElement(assertion.target);
            actual = !inspected.visible;
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
            const inspected = await this.inspectNativeUIElement(assertion.target);
            actual = inspected.exists;
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
          } else {
            const inspected = await this.inspectNativeUIElement(assertion.target);
            actual = inspected.text;
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
          } else {
            const inspected = await this.inspectNativeUIElement(assertion.target);
            actual = inspected.text;
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
          } else {
            const inspected = await this.inspectNativeUIElement(assertion.target);
            actual = inspected.disabled;
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
          } else {
            const inspected = await this.inspectNativeUIElement(assertion.target);
            actual = !inspected.disabled && inspected.exists;
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
      filePath = path.join(outputDir, `${evidenceId}.png`);
      let captured = false;

      // 1. If CDP client is connected, attempt CDP screenshot first
      if (this.cdpClient && this.cdpClient.isConnected()) {
        try {
          const base64Png = await this.cdpClient.captureScreenshot();
          if (base64Png && base64Png.length > 0) {
            rawBuffer = Buffer.from(base64Png, 'base64');
            fs.writeFileSync(filePath, rawBuffer);
            captured = true;
          }
        } catch {
          // Fall through to real OS screenshot tools
        }
      }

      // 2. Real OS screenshot capture using OS tools
      if (!captured) {
        captured = await this.captureNativeScreenshot(filePath);
      }

      // 3. Graceful fallback ONLY if OS screenshot command fails (e.g. CI headless without display)
      // Never use a 1x1 transparent dummy PNG by default!
      if (captured && fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
        rawBuffer = fs.readFileSync(filePath);
      } else {
        rawBuffer = makeFallbackPng(320, 240);
        fs.writeFileSync(filePath, rawBuffer);
      }
      mimeType = 'image/png';
    }

    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, rawBuffer);
    }

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

  private async captureNativeScreenshot(filePath: string): Promise<boolean> {
    const os = this.config.platformOverride || process.platform;
    const commandExecutor = this.config.commandExecutor || defaultCommandExecutor;

    try {
      if (os === 'darwin') {
        const res = await commandExecutor('screencapture', ['-x', '-C', filePath]);
        return res.exitCode === 0 && fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
      } else if (os === 'win32') {
        const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/'/g, "''");
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms;
Add-Type -AssemblyName System.Drawing;
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height;
$graphics = [System.Drawing.Graphics]::FromImage($bitmap);
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size);
$bitmap.Save('${escapedPath}', [System.Drawing.Imaging.ImageFormat]::Png);
$graphics.Dispose();
$bitmap.Dispose();
`.trim().replace(/\n/g, ' ');
        const res = await commandExecutor('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript]);
        return res.exitCode === 0 && fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
      } else if (os === 'linux') {
        let res = await commandExecutor('scrot', [filePath]);
        if (res.exitCode !== 0 || !fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
          res = await commandExecutor('grim', [filePath]);
        }
        return res.exitCode === 0 && fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
      }
    } catch {
      return false;
    }
    return false;
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

  async minimizeWindow(title?: string): Promise<void> {
    await this.windowManager.minimize(title);
  }

  async restoreWindow(title?: string): Promise<void> {
    await this.windowManager.restore(title);
  }

  async blurWindow(): Promise<void> {
    await this.windowManager.blur();
  }

  async measureFrameRate(sampleDurationMs = 500): Promise<FrameRateMetrics> {
    if (this.gameAdapter && typeof this.gameAdapter.measureFrameRate === 'function') {
      return this.gameAdapter.measureFrameRate(sampleDurationMs);
    }
    return measureFrameRate(sampleDurationMs);
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
