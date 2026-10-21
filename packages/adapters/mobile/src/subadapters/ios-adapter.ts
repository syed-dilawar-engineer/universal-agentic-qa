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
  QAUnsupportedError,
  QAAdapterError,
} from '@agentic-qa/core';
import {
  IosSimulator,
  MobileAdapterOptions,
  MobileLifecycleActions,
} from '../types.js';
import { CommandExecutor, DefaultCommandExecutor } from '../executor.js';
import { findElement, parseUIHierarchy } from '../uiautomator-parser.js';

export class IosAdapter implements PlatformAdapter, MobileLifecycleActions {
  readonly id = 'mobile-ios';
  readonly name = 'iOS Simulator Adapter';
  readonly platform: Platform = 'mobile';

  private executor: CommandExecutor;
  private hostPlatform: NodeJS.Platform;
  private selectedDeviceId?: string;
  private bundleId?: string;
  private appPath?: string;
  private outputDir: string;
  private isInitialized = false;
  private uiHierarchyXml?: string;

  constructor(options: MobileAdapterOptions = {}) {
    this.executor = options.executor || new DefaultCommandExecutor();
    this.hostPlatform = options.hostPlatform || process.platform;
    this.selectedDeviceId = options.deviceId;
    this.bundleId = options.bundleId;
    this.appPath = options.appPath;
    this.outputDir = options.outputDir || path.resolve('.qa-output', 'evidence');
    this.uiHierarchyXml = options.uiHierarchyXml;
  }

  private async getUIHierarchyXml(): Promise<string> {
    if (this.uiHierarchyXml) {
      return this.uiHierarchyXml;
    }
    return '';
  }

  private getDeviceFlag(): string {
    return this.selectedDeviceId || 'booted';
  }

  async getCapability(): Promise<CapabilityDescriptor> {
    // 1. Host platform check: iOS automation is strictly macOS only
    if (this.hostPlatform !== 'darwin') {
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'UNSUPPORTED',
        reason: `iOS simulator testing is only supported on macOS (darwin). Current host platform is: ${this.hostPlatform}.`,
        requiredTools: ['xcrun', 'Xcode'],
        missingTools: ['xcrun', 'Xcode'],
        metadata: { hostPlatform: this.hostPlatform },
      };
    }

    // 2. Check xcrun presence
    const xcrunCheck = await this.executor.exec('xcrun', ['--version']);
    if (xcrunCheck.exitCode !== 0) {
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'BLOCKED',
        reason:
          'Xcode command line tools (xcrun) are not installed or not in PATH. ' +
          'Install via "xcode-select --install" and launch Xcode to accept the developer agreement.',
        requiredTools: ['xcrun'],
        missingTools: ['xcrun'],
        metadata: {},
      };
    }

    // 3. Query booted simulators via xcrun simctl list devices
    const simctlRes = await this.executor.exec('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
    let bootedDevices: IosSimulator[] = [];

    if (simctlRes.exitCode === 0 && simctlRes.stdout.trim().startsWith('{')) {
      bootedDevices = this.parseSimulatorsJson(simctlRes.stdout);
    } else {
      // Fallback: parse plain text if -j is not supported or failed
      const textRes = await this.executor.exec('xcrun', ['simctl', 'list', 'devices']);
      if (textRes.exitCode === 0) {
        bootedDevices = this.parseSimulatorsText(textRes.stdout);
      }
    }

    if (bootedDevices.length === 0) {
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'UNAVAILABLE',
        reason:
          'Xcode and xcrun are installed, but no booted iOS simulator was detected. ' +
          'Boot an iOS simulator via "xcrun simctl boot <device-udid>" or open Simulator.app.',
        requiredTools: ['xcrun'],
        missingTools: [],
        version: xcrunCheck.stdout.trim(),
        metadata: { bootedCount: 0 },
      };
    }

    const activeUdid =
      this.selectedDeviceId && bootedDevices.some((d) => d.udid === this.selectedDeviceId)
        ? this.selectedDeviceId
        : bootedDevices[0].udid;

    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: 'AVAILABLE',
      reason: `Found ${bootedDevices.length} booted iOS simulator(s). Active simulator: ${activeUdid}`,
      requiredTools: ['xcrun'],
      missingTools: [],
      version: xcrunCheck.stdout.trim(),
      metadata: {
        bootedSimulators: bootedDevices,
        activeDevice: activeUdid,
      },
    };
  }

  private parseSimulatorsJson(jsonStr: string): IosSimulator[] {
    const list: IosSimulator[] = [];
    try {
      const data = JSON.parse(jsonStr);
      const devicesMap = data.devices || {};
      for (const [runtime, devices] of Object.entries<any[]>(devicesMap)) {
        if (Array.isArray(devices)) {
          for (const d of devices) {
            if (d.state === 'Booted') {
              list.push({
                udid: d.udid,
                name: d.name,
                state: d.state,
                isAvailable: d.isAvailable ?? true,
                runtime,
              });
            }
          }
        }
      }
    } catch {
      // fallback
    }
    return list;
  }

  private parseSimulatorsText(output: string): IosSimulator[] {
    const list: IosSimulator[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      if (line.includes('(Booted)')) {
        const match = line.match(/^([^(]+)\s*\(([-A-F0-9]+)\)\s*\(Booted\)/i);
        if (match) {
          list.push({
            udid: match[2].trim(),
            name: match[1].trim(),
            state: 'Booted',
            isAvailable: true,
          });
        }
      }
    }
    return list;
  }

  async initialize(options?: Record<string, any>): Promise<void> {
    if (options?.deviceId) this.selectedDeviceId = options.deviceId;
    if (options?.bundleId) this.bundleId = options.bundleId;
    if (options?.appPath) this.appPath = options.appPath;

    if (this.hostPlatform !== 'darwin') {
      throw new QAUnsupportedError(
        `Cannot initialize iOS testing on non-macOS platform: ${this.hostPlatform}`,
        this.hostPlatform
      );
    }

    const cap = await this.getCapability();
    if (cap.state !== 'AVAILABLE') {
      if (
        this.appPath?.endsWith('.ipa') ||
        this.appPath?.endsWith('.app') ||
        this.appPath?.endsWith('.zip')
      ) {
        throw new QABlockedError(
          `Cannot run IPA/APP (${path.basename(this.appPath)}): No booted iOS simulator detected. Reason: ${cap.reason || 'Simulator offline'}`,
          'Booted iOS Simulator'
        );
      }
      throw new QABlockedError(
        `Initialization blocked: iOS capability is ${cap.state}. ${cap.reason || ''}`,
        cap.missingTools.join(', ') || 'booted simulator'
      );
    }

    if (!this.selectedDeviceId && cap.metadata?.activeDevice) {
      this.selectedDeviceId = cap.metadata.activeDevice;
    }

    if (this.appPath && (this.appPath.endsWith('.app') || this.appPath.endsWith('.ipa'))) {
      const installRes = await this.executor.exec('xcrun', [
        'simctl',
        'install',
        this.getDeviceFlag(),
        this.appPath,
      ]);
      if (installRes.exitCode !== 0) {
        throw new QAAdapterError(
          `Failed to install iOS app (${this.appPath}): ${installRes.stderr || installRes.stdout}`,
          this.name
        );
      }
    }

    this.isInitialized = true;
  }

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    const start = Date.now();

    try {
      switch (action.type) {
        case 'tap':
        case 'click': {
          let x = 200;
          let y = 400;

          if (action.target) {
            const coordMatch = action.target.match(/^@?(\d+)\s*,\s*(\d+)$/);
            if (coordMatch) {
              x = parseInt(coordMatch[1], 10);
              y = parseInt(coordMatch[2], 10);
            } else {
              const xml = await this.getUIHierarchyXml();
              if (xml) {
                const elements = parseUIHierarchy(xml);
                const el = findElement(elements, action.target);
                if (el && el.bounds) {
                  x = el.bounds.centerX;
                  y = el.bounds.centerY;
                }
              }
            }
          } else if (action.value && typeof action.value === 'object' && 'x' in action.value) {
            x = action.value.x;
            y = action.value.y;
          }

          // Use xcrun simctl io <device> tap <x> <y>
          const res = await this.executor.exec('xcrun', [
            'simctl',
            'io',
            this.getDeviceFlag(),
            'tap',
            String(x),
            String(y),
          ]);

          return {
            success: res.exitCode === 0,
            durationMs: Date.now() - start,
            output: { tappedCoordinates: { x, y } },
            error: res.exitCode !== 0 ? res.stderr : undefined,
          };
        }

        case 'navigate': {
          const url = String(action.value || action.target || '');
          if (!url) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: 'navigate action requires a target URL or deep link',
            };
          }

          const res = await this.executor.exec('xcrun', [
            'simctl',
            'openurl',
            this.getDeviceFlag(),
            url,
          ]);

          return {
            success: res.exitCode === 0,
            durationMs: Date.now() - start,
            output: { url },
            error: res.exitCode !== 0 ? res.stderr : undefined,
          };
        }

        case 'triggerProcessDeath': {
          const targetBundle =
            action.target ||
            (typeof action.value === 'string' ? action.value : action.value?.bundleId) ||
            this.bundleId;

          if (!targetBundle) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: 'triggerProcessDeath requires a target bundleId',
            };
          }

          const termRes = await this.executor.exec('xcrun', [
            'simctl',
            'terminate',
            this.getDeviceFlag(),
            targetBundle,
          ]);

          return {
            success: termRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { bundleId: targetBundle, mechanism: 'xcrun simctl terminate' },
            error: termRes.exitCode !== 0 ? termRes.stderr : undefined,
          };
        }

        case 'fill':
        case 'type': {
          if (action.target) {
            await this.executeAction({
              type: 'tap',
              target: action.target,
              timeoutMs: action.timeoutMs,
              metadata: {},
            });
          }

          const textToType = String(action.value ?? '');
          const res = await this.executor.exec('xcrun', [
            'simctl',
            'io',
            this.getDeviceFlag(),
            'text',
            textToType,
          ]);

          return {
            success: res.exitCode === 0,
            durationMs: Date.now() - start,
            output: { filledText: textToType },
            error: res.exitCode !== 0 ? res.stderr : undefined,
          };
        }

        case 'scroll': {
          const direction = (action.value || action.metadata?.direction || 'down').toLowerCase();
          let x1 = 200,
            y1 = 600,
            x2 = 200,
            y2 = 200;

          if (direction === 'up') {
            x1 = 200;
            y1 = 200;
            x2 = 200;
            y2 = 600;
          }

          if (action.metadata?.coordinates) {
            const c = action.metadata.coordinates;
            x1 = c.x1 ?? x1;
            y1 = c.y1 ?? y1;
            x2 = c.x2 ?? x2;
            y2 = c.y2 ?? y2;
          }

          const res = await this.executor.exec('xcrun', [
            'simctl',
            'io',
            this.getDeviceFlag(),
            'swipe',
            String(x1),
            String(y1),
            String(x2),
            String(y2),
          ]);

          return {
            success: res.exitCode === 0,
            durationMs: Date.now() - start,
            output: { direction, coordinates: { x1, y1, x2, y2 } },
            error: res.exitCode !== 0 ? res.stderr : undefined,
          };
        }

        case 'pressKey': {
          const keyInput = String(action.value ?? action.target ?? '').toLowerCase();
          // xcrun simctl sendkey / home
          const res = await this.executor.exec('xcrun', [
            'simctl',
            'io',
            this.getDeviceFlag(),
            'sendkey',
            keyInput,
          ]);

          return {
            success: res.exitCode === 0,
            durationMs: Date.now() - start,
            output: { key: keyInput },
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
          let x = 200;
          let y = 400;
          if (action.target) {
            const coordMatch = action.target.match(/^@?(\d+)\s*,\s*(\d+)$/);
            if (coordMatch) {
              x = parseInt(coordMatch[1], 10);
              y = parseInt(coordMatch[2], 10);
            }
          }

          const count =
            typeof action.value === 'number'
              ? action.value
              : action.metadata?.count
              ? Number(action.metadata.count)
              : 50;

          let successCount = 0;
          for (let i = 0; i < count; i++) {
            const res = await this.executor.exec('xcrun', [
              'simctl',
              'io',
              this.getDeviceFlag(),
              'tap',
              String(x),
              String(y),
            ]);
            if (res.exitCode === 0) successCount++;
          }

          return {
            success: successCount > 0,
            durationMs: Date.now() - start,
            output: { clicksAttempted: count, successfulClicks: successCount },
          };
        }

        case 'custom': {
          const customTarget = String(action.target || '');
          if (customTarget === 'app:launch') {
            await this.launchApp(action.value?.bundleId);
            return { success: true, durationMs: Date.now() - start };
          }
          if (customTarget === 'app:background') {
            await this.backgroundApp(action.value?.durationMs);
            return { success: true, durationMs: Date.now() - start };
          }
          if (customTarget === 'app:resume') {
            await this.resumeApp(action.value?.bundleId);
            return { success: true, durationMs: Date.now() - start };
          }
          if (customTarget === 'app:terminate') {
            await this.terminateApp(action.value?.bundleId);
            return { success: true, durationMs: Date.now() - start };
          }

          return {
            success: false,
            durationMs: Date.now() - start,
            error: `Unknown custom action target for iOS: ${customTarget}`,
          };
        }

        default:
          return {
            success: false,
            durationMs: Date.now() - start,
            error: `Unsupported action type for IosAdapter: ${action.type}`,
          };
      }
    } catch (err: any) {
      return {
        success: false,
        durationMs: Date.now() - start,
        error: err.message || 'Action failed',
      };
    }
  }

  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    const start = Date.now();
    const xml = await this.getUIHierarchyXml();
    if (!xml || xml.trim().length === 0) {
      return {
        passed: false,
        expected: assertion.expected,
        actual: undefined,
        durationMs: Date.now() - start,
        message: `Cannot evaluate assertion '${assertion.type}': UI hierarchy XML is unavailable for iOS Simulator. Provide uiHierarchyXml or configure an accessibility inspector.`,
      };
    }

    const elements = parseUIHierarchy(xml);
    const element = assertion.target ? findElement(elements, assertion.target) : undefined;

    switch (assertion.type) {
      case 'elementVisible': {
        const passed = Boolean(element && element.visible);
        return {
          passed,
          expected: true,
          actual: passed,
          durationMs: Date.now() - start,
          message: passed
            ? `Element '${assertion.target}' is visible`
            : `Element '${assertion.target}' is not visible or not found in UI hierarchy`,
        };
      }

      case 'elementHidden': {
        const passed = !element || !element.visible;
        return {
          passed,
          expected: true,
          actual: passed,
          durationMs: Date.now() - start,
          message: passed
            ? `Element '${assertion.target}' is hidden or absent`
            : `Element '${assertion.target}' is visible`,
        };
      }

      case 'elementExists': {
        const passed = Boolean(element);
        return {
          passed,
          expected: true,
          actual: passed,
          durationMs: Date.now() - start,
          message: passed
            ? `Element '${assertion.target}' exists in UI hierarchy`
            : `Element '${assertion.target}' not found in UI hierarchy`,
        };
      }

      case 'elementTextEquals': {
        if (!element) {
          return {
            passed: false,
            expected: assertion.expected,
            actual: undefined,
            durationMs: Date.now() - start,
            message: `Element '${assertion.target}' not found in UI hierarchy`,
          };
        }
        const expected = String(assertion.expected ?? '');
        const actual = element.text ?? '';
        const passed = actual === expected;
        return {
          passed,
          expected,
          actual,
          durationMs: Date.now() - start,
          message: passed
            ? `Element '${assertion.target}' text matched expected '${expected}'`
            : `Element '${assertion.target}' text '${actual}' did not match expected '${expected}'`,
        };
      }

      case 'elementTextContains': {
        if (!element) {
          return {
            passed: false,
            expected: assertion.expected,
            actual: undefined,
            durationMs: Date.now() - start,
            message: `Element '${assertion.target}' not found in UI hierarchy`,
          };
        }
        const expected = String(assertion.expected ?? '');
        const actual = element.text ?? '';
        const passed = actual.includes(expected);
        return {
          passed,
          expected,
          actual,
          durationMs: Date.now() - start,
          message: passed
            ? `Element '${assertion.target}' text contains expected '${expected}'`
            : `Element '${assertion.target}' text '${actual}' does not contain '${expected}'`,
        };
      }

      case 'elementDisabled': {
        if (!element) {
          return {
            passed: false,
            expected: true,
            actual: undefined,
            durationMs: Date.now() - start,
            message: `Element '${assertion.target}' not found in UI hierarchy`,
          };
        }
        const passed = !element.enabled;
        return {
          passed,
          expected: true,
          actual: passed,
          durationMs: Date.now() - start,
          message: passed
            ? `Element '${assertion.target}' is disabled`
            : `Element '${assertion.target}' is enabled (expected disabled)`,
        };
      }

      case 'elementEnabled': {
        if (!element) {
          return {
            passed: false,
            expected: true,
            actual: undefined,
            durationMs: Date.now() - start,
            message: `Element '${assertion.target}' not found in UI hierarchy`,
          };
        }
        const passed = Boolean(element.enabled);
        return {
          passed,
          expected: true,
          actual: passed,
          durationMs: Date.now() - start,
          message: passed
            ? `Element '${assertion.target}' is enabled`
            : `Element '${assertion.target}' is disabled (expected enabled)`,
        };
      }

      case 'targetSizeAAA': {
        if (!element || !element.bounds) {
          return {
            passed: false,
            expected: 'At least 44x44 touch target area',
            actual: 'Element not found',
            durationMs: Date.now() - start,
            message: `Target element '${assertion.target}' not found for WCAG touch target check`,
          };
        }
        const width = element.bounds.width;
        const height = element.bounds.height;
        const minRequired = assertion.metadata?.minSize ?? 44;
        const passed = width >= minRequired && height >= minRequired;
        return {
          passed,
          expected: `>= ${minRequired}x${minRequired}`,
          actual: `${width}x${height}`,
          durationMs: Date.now() - start,
          message: passed
            ? `Touch target '${assertion.target}' meets AAA target size (${width}x${height} >= ${minRequired}x${minRequired})`
            : `Touch target '${assertion.target}' does NOT meet AAA target size (${width}x${height} < ${minRequired}x${minRequired})`,
        };
      }

      default:
        return {
          passed: false,
          durationMs: Date.now() - start,
          message: `Unsupported assertion type for IosAdapter: ${assertion.type}`,
        };
    }
  }

  async launchApp(bundleId?: string): Promise<void> {
    const targetBundle = bundleId || this.bundleId;
    if (!targetBundle) {
      throw new QAAdapterError('Cannot launch iOS app: bundleId is not specified.', this.name);
    }
    const res = await this.executor.exec('xcrun', [
      'simctl',
      'launch',
      this.getDeviceFlag(),
      targetBundle,
    ]);
    if (res.exitCode !== 0) {
      throw new QAAdapterError(`Failed to launch iOS app (${targetBundle}): ${res.stderr}`, this.name);
    }
  }

  async backgroundApp(durationMs?: number): Promise<void> {
    // Send home button key or terminate to background
    await this.executor.exec('xcrun', [
      'simctl',
      'io',
      this.getDeviceFlag(),
      'sendkey',
      'home',
    ]);
    if (durationMs && durationMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    }
  }

  async resumeApp(bundleId?: string): Promise<void> {
    await this.launchApp(bundleId);
  }

  async terminateApp(bundleId?: string): Promise<void> {
    const targetBundle = bundleId || this.bundleId;
    if (!targetBundle) {
      throw new QAAdapterError('Cannot terminate iOS app: bundleId is not specified.', this.name);
    }
    await this.executor.exec('xcrun', [
      'simctl',
      'terminate',
      this.getDeviceFlag(),
      targetBundle,
    ]);
  }

  async captureEvidence(type: string, description?: string): Promise<EvidenceArtifact> {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const timestamp = Date.now();
    const id = `ev-ios-${timestamp}-${Math.floor(Math.random() * 1000)}`;

    if (type === 'SCREENSHOT') {
      const filePath = path.join(this.outputDir, `ios-screenshot-${timestamp}.png`);
      const res = await this.executor.exec('xcrun', [
        'simctl',
        'io',
        this.getDeviceFlag(),
        'screenshot',
        filePath,
      ]);

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
        description: description || 'iOS simulator screenshot',
        metadata: {
          deviceId: this.selectedDeviceId,
          exitCode: res.exitCode,
        },
      };
    }

    if (
      type === 'DOM_SNAPSHOT' ||
      type === 'UI_HIERARCHY' ||
      type === 'DOM'
    ) {
      const filePath = path.join(this.outputDir, `ios-hierarchy-${timestamp}.xml`);
      const xml = await this.getUIHierarchyXml();
      const buffer = Buffer.from(xml, 'utf8');
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
        description: description || 'iOS simulator UI hierarchy',
        metadata: {
          deviceId: this.selectedDeviceId,
        },
      };
    }

    if (type === 'SYSTEM_LOG' || type === 'CONSOLE_LOG') {
      const filePath = path.join(this.outputDir, `ios-log-${timestamp}.txt`);
      const logRes = await this.executor.exec('xcrun', [
        'simctl',
        'spawn',
        this.getDeviceFlag(),
        'log',
        'show',
        '--last',
        '2m',
      ]);

      const content = logRes.stdout || logRes.stderr || 'No iOS logs';
      const buffer = Buffer.from(content, 'utf8');
      fs.writeFileSync(filePath, buffer);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      return {
        id,
        type: 'SYSTEM_LOG',
        path: filePath,
        sha256,
        sizeBytes: buffer.length,
        mimeType: 'text/plain',
        capturedAt: new Date().toISOString(),
        description: description || 'iOS simulator system logs',
        metadata: {
          deviceId: this.selectedDeviceId,
        },
      };
    }

    throw new QAAdapterError(`Unsupported evidence type: ${type}`, this.name);
  }

  async teardown(): Promise<void> {
    this.isInitialized = false;
  }
}
