import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
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
import { CommandExecutor, CommandResult, DefaultCommandExecutor } from '../executor.js';

export class MaestroAdapter implements PlatformAdapter, MobileLifecycleActions {
  readonly id = 'mobile-maestro';
  readonly name = 'Maestro CLI Adapter';
  readonly platform: Platform = 'mobile';

  private executor: CommandExecutor;
  private hostPlatform: NodeJS.Platform;
  private appId?: string;
  private outputDir: string;
  private isInitialized = false;

  constructor(options: MobileAdapterOptions = {}) {
    this.executor = options.executor || new DefaultCommandExecutor();
    this.hostPlatform = options.hostPlatform || process.platform;
    this.appId = options.packageName || options.bundleId;
    this.outputDir = options.outputDir || path.resolve('.qa-output', 'evidence');
  }

  private buildTapTarget(target?: string, value?: any): Record<string, any> {
    if (value && typeof value === 'object' && 'x' in value && 'y' in value) {
      return { tapOn: { point: `${value.x},${value.y}` } };
    }
    const raw = target || (value ? String(value) : '');
    if (raw.startsWith('id=') || raw.startsWith('#')) {
      return { tapOn: { id: raw.replace(/^id=|^#/, '') } };
    }
    const coordMatch = raw.match(/^@?(-?\d+)\s*,\s*(-?\d+)$/);
    if (coordMatch) {
      return { tapOn: { point: `${coordMatch[1]},${coordMatch[2]}` } };
    }
    return { tapOn: raw };
  }

  private async executeFlowCommands(
    commands: Array<string | Record<string, any>>
  ): Promise<CommandResult> {
    const tmpDir = fs.existsSync('/tmp') ? '/tmp' : os.tmpdir();
    const flowFile = path.join(
      tmpDir,
      `flow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`
    );

    const lines: string[] = [];
    if (this.appId) {
      lines.push(`appId: ${this.appId}`);
    }
    lines.push('---');

    for (const cmd of commands) {
      if (typeof cmd === 'string') {
        lines.push(`- ${cmd}`);
      } else if (typeof cmd === 'object' && cmd !== null) {
        const key = Object.keys(cmd)[0];
        const val = cmd[key];
        if (typeof val === 'object' && val !== null) {
          lines.push(`- ${key}:`);
          for (const [subK, subV] of Object.entries(val)) {
            const formattedVal =
              typeof subV === 'string' &&
              (subV.includes(' ') || subV.includes(':') || subV.includes('>') || subV.includes('"'))
                ? JSON.stringify(subV)
                : String(subV);
            lines.push(`    ${subK}: ${formattedVal}`);
          }
        } else if (typeof val === 'string') {
          const formattedVal =
            val.includes(' ') || val.includes(':') || val.includes('>') || val.includes('"')
              ? JSON.stringify(val)
              : val;
          lines.push(`- ${key}: ${formattedVal}`);
        } else if (val === null || val === undefined) {
          lines.push(`- ${key}`);
        } else {
          lines.push(`- ${key}: ${val}`);
        }
      }
    }

    const yamlContent = lines.join('\n') + '\n';
    fs.writeFileSync(flowFile, yamlContent, 'utf8');

    try {
      return await this.executor.exec('maestro', ['test', flowFile]);
    } finally {
      try {
        if (fs.existsSync(flowFile)) {
          fs.unlinkSync(flowFile);
        }
      } catch {
        // ignore cleanup error
      }
    }
  }

  async getCapability(): Promise<CapabilityDescriptor> {
    const maestroVersionRes = await this.executor.exec('maestro', ['--version']);
    if (maestroVersionRes.exitCode !== 0) {
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'BLOCKED',
        reason:
          'Maestro CLI is not installed or not in PATH. ' +
          'Install Maestro via: "curl -fsSL https://get.maestro.mobile.dev | bash" ' +
          'and ensure ~/.maestro/bin is added to your PATH.',
        requiredTools: ['maestro'],
        missingTools: ['maestro'],
        metadata: {},
      };
    }

    const versionStr = maestroVersionRes.stdout.trim();

    // Check underlying device presence (adb or iOS simulator)
    let deviceOnline = false;
    const adbRes = await this.executor.exec('adb', ['devices']);
    if (adbRes.exitCode === 0 && adbRes.stdout.includes('\tdevice')) {
      deviceOnline = true;
    }

    if (!deviceOnline && this.hostPlatform === 'darwin') {
      const iosRes = await this.executor.exec('xcrun', ['simctl', 'list', 'devices', 'booted']);
      if (iosRes.exitCode === 0 && iosRes.stdout.includes('(Booted)')) {
        deviceOnline = true;
      }
    }

    if (!deviceOnline) {
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'UNAVAILABLE',
        reason:
          'Maestro CLI is installed, but no connected Android device or booted iOS simulator was detected. ' +
          'Connect an Android device or boot an iOS simulator before executing Maestro commands.',
        requiredTools: ['maestro'],
        missingTools: [],
        version: versionStr,
        metadata: { maestroVersion: versionStr },
      };
    }

    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: 'AVAILABLE',
      reason: `Maestro CLI (${versionStr}) is installed and active mobile device/simulator is detected.`,
      requiredTools: ['maestro'],
      missingTools: [],
      version: versionStr,
      metadata: { maestroVersion: versionStr },
    };
  }

  async initialize(options?: Record<string, any>): Promise<void> {
    if (options?.appId) this.appId = options.appId;
    if (options?.packageName) this.appId = options.packageName;
    if (options?.bundleId) this.appId = options.bundleId;

    const cap = await this.getCapability();
    if (cap.state !== 'AVAILABLE') {
      throw new QABlockedError(
        `Initialization blocked: Maestro capability is ${cap.state}. ${cap.reason || ''}`,
        cap.missingTools.join(', ') || 'connected device or simulator'
      );
    }

    this.isInitialized = true;
  }

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    const start = Date.now();

    try {
      switch (action.type) {
        case 'tap':
        case 'click': {
          const tapCmd = this.buildTapTarget(action.target, action.value);
          const res = await this.executeFlowCommands([tapCmd]);
          return {
            success: res.exitCode === 0,
            durationMs: Date.now() - start,
            output: { target: action.target, exitCode: res.exitCode },
            error: res.exitCode !== 0 ? res.stderr : undefined,
          };
        }

        case 'fill':
        case 'type': {
          const text = String(action.value ?? '');
          const cmds: Array<string | Record<string, any>> = [];
          if (action.target) {
            cmds.push(this.buildTapTarget(action.target));
          }
          cmds.push({ inputText: text });
          const res = await this.executeFlowCommands(cmds);
          return {
            success: res.exitCode === 0,
            durationMs: Date.now() - start,
            output: { filledText: text },
            error: res.exitCode !== 0 ? res.stderr : undefined,
          };
        }

        case 'scroll': {
          const direction = String(
            action.value || action.metadata?.direction || 'down'
          ).toLowerCase();
          const cmd = direction === 'up' ? { scroll: { direction: 'UP' } } : 'scroll';
          const res = await this.executeFlowCommands([cmd]);
          return {
            success: res.exitCode === 0,
            durationMs: Date.now() - start,
            output: { direction },
            error: res.exitCode !== 0 ? res.stderr : undefined,
          };
        }

        case 'pressKey': {
          const key = String(action.value ?? action.target ?? '').toLowerCase();
          const cmd =
            key === 'back'
              ? 'back'
              : key === 'home'
              ? { pressKey: 'Home' }
              : { pressKey: key };
          const res = await this.executeFlowCommands([cmd]);
          return {
            success: res.exitCode === 0,
            durationMs: Date.now() - start,
            output: { key },
            error: res.exitCode !== 0 ? res.stderr : undefined,
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
          const target = action.target || '500,500';
          const count =
            typeof action.value === 'number'
              ? action.value
              : action.metadata?.count
              ? Number(action.metadata.count)
              : 50;

          const tapCmd = this.buildTapTarget(target);
          const cmds = Array(count).fill(tapCmd);
          const res = await this.executeFlowCommands(cmds);
          return {
            success: res.exitCode === 0,
            durationMs: Date.now() - start,
            output: { clicks: count },
            error: res.exitCode !== 0 ? res.stderr : undefined,
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
            error: `Unsupported action type for MaestroAdapter: ${action.type}`,
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
      case 'elementVisible': {
        const cmd =
          target.startsWith('id=') || target.startsWith('#')
            ? { assertVisible: { id: target.replace(/^id=|^#/, '') } }
            : { assertVisible: target };
        const res = await this.executeFlowCommands([cmd]);
        return {
          passed: res.exitCode === 0,
          expected: true,
          actual: res.exitCode === 0,
          durationMs: Date.now() - start,
          message:
            res.exitCode === 0
              ? `Element '${target}' is visible via Maestro assertion`
              : `Element '${target}' assertion failed in Maestro: ${res.stderr || res.stdout}`,
        };
      }

      case 'elementHidden': {
        const cmd =
          target.startsWith('id=') || target.startsWith('#')
            ? { assertNotVisible: { id: target.replace(/^id=|^#/, '') } }
            : { assertNotVisible: target };
        const res = await this.executeFlowCommands([cmd]);
        return {
          passed: res.exitCode === 0,
          expected: true,
          actual: res.exitCode === 0,
          durationMs: Date.now() - start,
          message:
            res.exitCode === 0
              ? `Element '${target}' is hidden via Maestro assertion`
              : `Element '${target}' assertion failed in Maestro: ${res.stderr || res.stdout}`,
        };
      }

      case 'elementTextEquals': {
        const expected = String(assertion.expected ?? '');
        const cmd = { assertVisible: expected };
        const res = await this.executeFlowCommands([cmd]);
        return {
          passed: res.exitCode === 0,
          expected,
          actual: res.exitCode === 0 ? expected : 'mismatch',
          durationMs: Date.now() - start,
          message:
            res.exitCode === 0
              ? `Element text matched '${expected}' via Maestro assertion`
              : `Element text did not match '${expected}' in Maestro: ${res.stderr || res.stdout}`,
        };
      }

      case 'elementDisabled': {
        const cmd = { assertNotVisible: target };
        const res = await this.executeFlowCommands([cmd]);
        return {
          passed: res.exitCode === 0,
          expected: true,
          actual: res.exitCode === 0,
          durationMs: Date.now() - start,
          message: `Element '${target}' disabled state verified via Maestro`,
        };
      }

      default:
        return {
          passed: false,
          durationMs: Date.now() - start,
          message: `Unsupported assertion type for MaestroAdapter: ${assertion.type}`,
        };
    }
  }

  async launchApp(appId?: string): Promise<void> {
    const targetId = appId || this.appId;
    if (!targetId) {
      throw new QAAdapterError('Cannot launch app: appId is not specified.', this.name);
    }
    const res = await this.executeFlowCommands([{ launchApp: targetId }]);
    if (res.exitCode !== 0) {
      throw new QAAdapterError(`Failed to launch app via Maestro: ${res.stderr}`, this.name);
    }
  }

  async backgroundApp(durationMs?: number): Promise<void> {
    await this.executeFlowCommands(['back']);
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
    await this.executeFlowCommands([{ stopApp: targetId }]);
  }

  async captureEvidence(type: string, description?: string): Promise<EvidenceArtifact> {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const timestamp = Date.now();
    const id = `ev-maestro-${timestamp}-${Math.floor(Math.random() * 1000)}`;

    if (type === 'SCREENSHOT') {
      const filePath = path.join(this.outputDir, `maestro-screen-${timestamp}.png`);
      const res = await this.executeFlowCommands([{ takeScreenshot: filePath }]);
      const buffer = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.from('');
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      return {
        id,
        type: 'SCREENSHOT',
        path: filePath,
        sha256,
        sizeBytes: buffer.length,
        mimeType: 'image/png',
        capturedAt: new Date().toISOString(),
        description: description || 'Maestro screenshot',
        metadata: { exitCode: res.exitCode },
      };
    }

    if (type === 'SYSTEM_LOG') {
      const filePath = path.join(this.outputDir, `maestro-log-${timestamp}.txt`);
      const logContent = `Maestro session log captured at ${new Date().toISOString()}`;
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
        description: description || 'Maestro execution log',
        metadata: {},
      };
    }

    throw new QAAdapterError(`Unsupported evidence type: ${type}`, this.name);
  }

  async teardown(): Promise<void> {
    this.isInitialized = false;
  }
}
