import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Platform,
  CapabilityDescriptor,
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
  EvidenceArtifactSchema,
} from '@agentic-qa/schemas';
import {
  PlatformAdapter,
  ActionResult,
  AssertionResult,
  QABlockedError,
  QAAdapterError,
} from '@agentic-qa/core';
import {
  AndroidDevice,
  MobileAdapterOptions,
  MobileLifecycleActions,
} from '../types.js';
import { CommandExecutor, DefaultCommandExecutor } from '../executor.js';
import { findElement, parseUIHierarchy } from '../uiautomator-parser.js';

export function escapeAdbInputText(text: string): string {
  return text
    .split('')
    .map((ch) => {
      if (ch === ' ') return '%s';
      if (/[\\&;()<>\'\"\$*?#!~`\[\]{}|=^]/.test(ch)) return `\\${ch}`;
      return ch;
    })
    .join('');
}

export class AndroidAdapter implements PlatformAdapter, MobileLifecycleActions {
  readonly id = 'mobile-android';
  readonly name = 'Android ADB Adapter';
  readonly platform: Platform = 'mobile';

  private executor: CommandExecutor;
  private selectedDeviceId?: string;
  private packageName?: string;
  private activityName?: string;
  private appPath?: string;
  private outputDir: string;
  private uiHierarchyXml?: string;
  private isInitialized = false;

  constructor(options: MobileAdapterOptions = {}) {
    this.executor = options.executor || new DefaultCommandExecutor();
    this.selectedDeviceId = options.deviceId;
    this.packageName = options.packageName;
    this.activityName = options.activityName;
    this.appPath = options.appPath;
    this.uiHierarchyXml = options.uiHierarchyXml;
    this.outputDir = options.outputDir || path.resolve('.qa-output', 'evidence');
  }

  setUIHierarchyXml(xml: string): void {
    this.uiHierarchyXml = xml;
  }

  private getDeviceFlag(): string[] {
    return this.selectedDeviceId ? ['-s', this.selectedDeviceId] : [];
  }

  async getCapability(): Promise<CapabilityDescriptor> {
    const versionRes = await this.executor.exec('adb', ['version']);
    if (versionRes.exitCode !== 0) {
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'BLOCKED',
        reason:
          'Android Debug Bridge (adb) is not installed or not found in PATH. ' +
          'Install Android SDK Platform-Tools: On macOS run "brew install android-platform-tools", ' +
          'on Linux run "sudo apt-get install adb", or download from https://developer.android.com/tools/releases/platform-tools ' +
          'and ensure platform-tools is added to PATH.',
        requiredTools: ['adb'],
        missingTools: ['adb'],
        metadata: {},
      };
    }

    const versionMatch = versionRes.stdout.match(/Android Debug Bridge version ([\d\.]+)/i);
    const versionStr = versionMatch ? versionMatch[1] : undefined;

    const devicesRes = await this.executor.exec('adb', ['devices', '-l']);
    if (devicesRes.exitCode !== 0) {
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'BLOCKED',
        reason: `Failed to query adb devices: ${devicesRes.stderr || 'Unknown error'}`,
        requiredTools: ['adb'],
        missingTools: [],
        metadata: {},
      };
    }

    const devices = this.parseDevices(devicesRes.stdout);
    const onlineDevices = devices.filter((d) => d.state === 'device');

    // If a specific device was configured, verify it directly
    if (this.selectedDeviceId) {
      const targetDevice = onlineDevices.find((d) => d.id === this.selectedDeviceId);
      if (!targetDevice) {
        const anyStateDevice = devices.find((d) => d.id === this.selectedDeviceId);
        if (anyStateDevice?.state === 'unauthorized') {
          return {
            id: this.id,
            name: this.name,
            platform: this.platform,
            state: 'BLOCKED',
            reason: `Configured Android device "${this.selectedDeviceId}" is unauthorized. Please accept the USB debugging RSA key prompt on the device screen.`,
            requiredTools: ['adb'],
            missingTools: ['adb'],
            metadata: { configuredDevice: this.selectedDeviceId, deviceState: 'unauthorized' },
          };
        }
        return {
          id: this.id,
          name: this.name,
          platform: this.platform,
          state: 'UNAVAILABLE',
          reason: `Configured Android device "${this.selectedDeviceId}" was not detected in online "device" state by adb.`,
          requiredTools: ['adb'],
          missingTools: [],
          metadata: { configuredDevice: this.selectedDeviceId, allDevices: devices },
        };
      }

      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'AVAILABLE',
        reason: `Configured Android device ${this.selectedDeviceId} is online and ready.`,
        requiredTools: ['adb'],
        missingTools: [],
        version: versionStr,
        metadata: {
          devices: onlineDevices,
          activeDevice: this.selectedDeviceId,
        },
      };
    }

    if (onlineDevices.length === 0) {
      const hasUnauthorized = devices.some((d) => d.state === 'unauthorized');
      if (hasUnauthorized) {
        return {
          id: this.id,
          name: this.name,
          platform: this.platform,
          state: 'BLOCKED',
          reason:
            'adb detected connected Android device(s), but all are in "unauthorized" state. ' +
            'Please unlock the device and accept the USB debugging authorization prompt on screen.',
          requiredTools: ['adb'],
          missingTools: ['adb'],
          metadata: { allDevices: devices, onlineCount: 0 },
        };
      }

      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'UNAVAILABLE',
        reason:
          'adb toolchain is installed, but no connected Android device or emulator was detected in "device" state. ' +
          'Connect an Android device with USB debugging enabled, or start an emulator via "emulator -avd <name>".',
        requiredTools: ['adb'],
        missingTools: [],
        version: versionStr,
        metadata: {
          allDevices: devices,
          onlineCount: 0,
        },
      };
    }

    const activeId = onlineDevices[0].id;

    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: 'AVAILABLE',
      reason: `Found ${onlineDevices.length} active Android device(s)/emulator(s). Active: ${activeId}`,
      requiredTools: ['adb'],
      missingTools: [],
      version: versionStr,
      metadata: {
        devices: onlineDevices,
        activeDevice: activeId,
      },
    };
  }

  private parseDevices(output: string): AndroidDevice[] {
    const lines = output.split('\n');
    const devices: AndroidDevice[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('List of devices attached')) continue;

      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const id = parts[0];
        const state = parts[1];
        const modelPart = parts.find((p) => p.startsWith('model:'));
        const productPart = parts.find((p) => p.startsWith('product:'));

        devices.push({
          id,
          state,
          model: modelPart ? modelPart.replace('model:', '') : undefined,
          product: productPart ? productPart.replace('product:', '') : undefined,
        });
      }
    }

    return devices;
  }

  async initialize(options?: Record<string, any>): Promise<void> {
    if (options?.deviceId) this.selectedDeviceId = options.deviceId;
    if (options?.packageName) this.packageName = options.packageName;
    if (options?.activityName) this.activityName = options.activityName;
    if (options?.appPath) this.appPath = options.appPath;

    const cap = await this.getCapability();
    if (cap.state !== 'AVAILABLE') {
      if (this.appPath?.endsWith('.apk') || this.appPath?.endsWith('.aab')) {
        throw new QABlockedError(
          `Cannot run APK (${path.basename(this.appPath)}): Android device/emulator is unavailable. Reason: ${cap.reason || 'No device connected'}`,
          'Android device or emulator'
        );
      }
      throw new QABlockedError(
        `Initialization blocked: Android capability is ${cap.state}. ${cap.reason || ''}`,
        cap.missingTools.join(', ') || 'online Android device'
      );
    }

    if (!this.selectedDeviceId && cap.metadata?.activeDevice) {
      this.selectedDeviceId = cap.metadata.activeDevice;
    }

    if (this.appPath && (this.appPath.endsWith('.apk') || this.appPath.endsWith('.aab'))) {
      const installRes = await this.executor.exec('adb', [
        ...this.getDeviceFlag(),
        'install',
        '-r',
        '-d',
        this.appPath,
      ]);
      if (installRes.exitCode !== 0) {
        throw new QAAdapterError(
          `Failed to install APK (${this.appPath}): ${installRes.stderr || installRes.stdout}`,
          this.name
        );
      }
    }

    this.isInitialized = true;
  }

  private async getUIHierarchyXml(): Promise<string> {
    if (this.uiHierarchyXml) {
      return this.uiHierarchyXml;
    }
    const dumpPath = '/sdcard/window_dump.xml';
    await this.executor.exec('adb', [...this.getDeviceFlag(), 'shell', 'uiautomator', 'dump', dumpPath]);
    const catRes = await this.executor.exec('adb', [...this.getDeviceFlag(), 'shell', 'cat', dumpPath]);
    return catRes.stdout;
  }

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    const start = Date.now();

    try {
      switch (action.type as string) {
        case 'tap':
        case 'click': {
          let x: number | undefined;
          let y: number | undefined;

          // 1. Check if target or value provides coordinates
          const targetCoord = action.target?.match(/^@?(-?\d+)\s*,\s*(-?\d+)$/);
          if (targetCoord) {
            x = parseInt(targetCoord[1], 10);
            y = parseInt(targetCoord[2], 10);
          } else if (typeof action.value === 'string' && action.value.match(/^@?(-?\d+)\s*,\s*(-?\d+)$/)) {
            const valCoord = action.value.match(/^@?(-?\d+)\s*,\s*(-?\d+)$/);
            if (valCoord) {
              x = parseInt(valCoord[1], 10);
              y = parseInt(valCoord[2], 10);
            }
          } else if (action.value && typeof action.value === 'object' && 'x' in action.value && 'y' in action.value) {
            x = Number(action.value.x);
            y = Number(action.value.y);
          } else if (action.target) {
            const xml = await this.getUIHierarchyXml();
            const elements = parseUIHierarchy(xml);
            const element = findElement(elements, action.target);
            if (!element || !element.bounds) {
              return {
                success: false,
                durationMs: Date.now() - start,
                error: `Element not found for target selector: ${action.target}`,
              };
            }
            x = element.bounds.centerX;
            y = element.bounds.centerY;
          }

          if (x === undefined || y === undefined) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: 'Tap action requires valid coordinates or a resolvable selector target.',
            };
          }

          const res = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'input',
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

        case 'fill':
        case 'type': {
          if (action.target) {
            const tapRes = await this.executeAction({
              type: 'tap',
              target: action.target,
              timeoutMs: action.timeoutMs,
              metadata: {},
            });
            if (!tapRes.success) {
              return tapRes;
            }
          }

          const textToType = String(action.value ?? '');
          const formattedText = escapeAdbInputText(textToType);
          const typeRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'input',
            'text',
            formattedText,
          ]);

          return {
            success: typeRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { filledText: textToType, escapedText: formattedText },
            error: typeRes.exitCode !== 0 ? typeRes.stderr : undefined,
          };
        }

        case 'scroll': {
          const direction = (action.value || action.metadata?.direction || 'down').toLowerCase();
          let x1 = 500,
            y1 = 1500,
            x2 = 500,
            y2 = 500,
            duration = 300;

          if (direction === 'up') {
            x1 = 500;
            y1 = 500;
            x2 = 500;
            y2 = 1500;
          } else if (direction === 'left') {
            x1 = 900;
            y1 = 1000;
            x2 = 100;
            y2 = 1000;
          } else if (direction === 'right') {
            x1 = 100;
            y1 = 1000;
            x2 = 900;
            y2 = 1000;
          }

          if (action.metadata?.coordinates) {
            const c = action.metadata.coordinates;
            x1 = c.x1 ?? x1;
            y1 = c.y1 ?? y1;
            x2 = c.x2 ?? x2;
            y2 = c.y2 ?? y2;
            duration = c.duration ?? duration;
          }

          const scrollRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'input',
            'swipe',
            String(x1),
            String(y1),
            String(x2),
            String(y2),
            String(duration),
          ]);

          return {
            success: scrollRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { direction, coordinates: { x1, y1, x2, y2, duration } },
            error: scrollRes.exitCode !== 0 ? scrollRes.stderr : undefined,
          };
        }

        case 'pressKey': {
          const keyInput = String(action.value ?? action.target ?? '').toUpperCase();
          const keyMap: Record<string, number> = {
            BACK: 4,
            HOME: 3,
            ENTER: 66,
            TAB: 61,
            DELETE: 67,
            BACKSPACE: 67,
            VOLUME_UP: 24,
            VOLUME_DOWN: 25,
            POWER: 26,
            APP_SWITCH: 187,
            RECENTS: 187,
            CAMERA: 27,
            MENU: 82,
            SEARCH: 84,
            ESCAPE: 111,
            DPAD_UP: 19,
            DPAD_DOWN: 20,
            DPAD_LEFT: 21,
            DPAD_RIGHT: 22,
            DPAD_CENTER: 23,
          };

          const keycode = keyMap[keyInput] ?? parseInt(keyInput, 10);
          if (isNaN(keycode)) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: `Unsupported key for Android pressKey: ${keyInput}`,
            };
          }

          const keyRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'input',
            'keyevent',
            String(keycode),
          ]);

          return {
            success: keyRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { key: keyInput, keycode },
            error: keyRes.exitCode !== 0 ? keyRes.stderr : undefined,
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
          let x = 500;
          let y = 1000;

          if (action.target) {
            const coordMatch = action.target.match(/^@?(-?\d+)\s*,\s*(-?\d+)$/);
            if (coordMatch) {
              x = parseInt(coordMatch[1], 10);
              y = parseInt(coordMatch[2], 10);
            } else {
              const xml = await this.getUIHierarchyXml();
              const elements = parseUIHierarchy(xml);
              const element = findElement(elements, action.target);
              if (element && element.bounds) {
                x = element.bounds.centerX;
                y = element.bounds.centerY;
              }
            }
          }

          const count =
            typeof action.value === 'number'
              ? action.value
              : action.metadata?.count
              ? Number(action.metadata.count)
              : 50;

          // Clear crash buffer prior to test to prevent false positives from historical crashes
          await this.executor.exec('adb', [...this.getDeviceFlag(), 'logcat', '-c', '-b', 'crash']).catch(() => {});

          // Execute rapid click loop via adb shell
          const loopCmd = `for i in $(seq 1 ${count}); do input tap ${x} ${y}; done`;
          const clickRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            loopCmd,
          ]);

          // Check if system crashed or ANR occurred
          const crashCheck = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'logcat',
            '-d',
            '-b',
            'crash',
          ]);
          const hadCrash =
            crashCheck.stdout.includes('FATAL EXCEPTION') ||
            crashCheck.stdout.includes('ANR in') ||
            crashCheck.stdout.includes('SIGSEGV') ||
            crashCheck.stdout.includes('Crash');

          return {
            success: clickRes.exitCode === 0 && !hadCrash,
            durationMs: Date.now() - start,
            output: {
              clicksAttempted: count,
              coordinates: { x, y },
              crashed: hadCrash,
              crashDetails: hadCrash ? crashCheck.stdout : undefined,
            },
            error: hadCrash ? 'Application crash or ANR detected during rapid clicks' : undefined,
          };
        }

        case 'pasteText': {
          if (action.target) {
            const tapRes = await this.executeAction({
              type: 'tap',
              target: action.target,
              timeoutMs: action.timeoutMs,
              metadata: {},
            });
            if (!tapRes.success) {
              return tapRes;
            }
          }

          const textToPaste = String(action.value ?? '');
          // Modern Android: try setting clipboard via cmd clipboard set text
          const clipRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'cmd',
            'clipboard',
            'set',
            'text',
            textToPaste,
          ]);

          if (clipRes.exitCode === 0) {
            // Trigger paste keyevent (279: KEYCODE_PASTE)
            const pasteKeyRes = await this.executor.exec('adb', [
              ...this.getDeviceFlag(),
              'shell',
              'input',
              'keyevent',
              '279',
            ]);
            return {
              success: pasteKeyRes.exitCode === 0,
              durationMs: Date.now() - start,
              output: { pastedLength: textToPaste.length, method: 'clipboard_cmd' },
              error: pasteKeyRes.exitCode !== 0 ? pasteKeyRes.stderr : undefined,
            };
          }

          // Fallback: escape and send via input text
          const formattedText = escapeAdbInputText(textToPaste);
          const typeRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'input',
            'text',
            formattedText,
          ]);

          return {
            success: typeRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { pastedLength: textToPaste.length, method: 'input_text_fallback' },
            error: typeRes.exitCode !== 0 ? typeRes.stderr : undefined,
          };
        }

        case 'deviceRotate': {
          const mode = String(action.value || 'landscape').toLowerCase();
          const targetRotation = (mode === 'portrait' || mode === '0') ? '0' : '1';

          // Disable auto-rotate
          await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'settings',
            'put',
            'system',
            'accelerometer_rotation',
            '0',
          ]);

          // Set user rotation (0 = portrait, 1 = landscape)
          const rotRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'settings',
            'put',
            'system',
            'user_rotation',
            targetRotation,
          ]);

          return {
            success: rotRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { targetRotation: targetRotation === '1' ? 'LANDSCAPE' : 'PORTRAIT' },
            error: rotRes.exitCode !== 0 ? rotRes.stderr : undefined,
          };
        }

        case 'triggerProcessDeath': {
          const targetPkg =
            action.target ||
            (typeof action.value === 'string' ? action.value : action.value?.packageName) ||
            this.packageName;

          if (!targetPkg) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: 'triggerProcessDeath requires a target packageName',
            };
          }

          // True Android Low Memory Killer (LMK) simulation:
          // Before calling am kill, send app to background first via Home key (keyevent 3)
          // because Android ActivityManagerService ignores `am kill` on foreground apps.
          await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'input',
            'keyevent',
            '3',
          ]);

          const killRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'am',
            'kill',
            targetPkg,
          ]);

          return {
            success: killRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { packageKilled: targetPkg, mechanism: 'am kill (LMK simulation)' },
            error: killRes.exitCode !== 0 ? killRes.stderr : undefined,
          };
        }

        case 'simulateNetwork': {
          const networkState = String(action.value || 'offline').toLowerCase();
          let cmdArgs: string[] = [];

          if (networkState === 'offline' || networkState === 'airplane_on') {
            cmdArgs = ['cmd', 'connectivity', 'airplane-mode', 'enable'];
          } else if (networkState === 'online' || networkState === 'airplane_off') {
            cmdArgs = ['cmd', 'connectivity', 'airplane-mode', 'disable'];
          } else if (networkState === 'wifi_off') {
            cmdArgs = ['svc', 'wifi', 'disable'];
          } else if (networkState === 'wifi_on') {
            cmdArgs = ['svc', 'wifi', 'enable'];
          } else if (networkState === 'data_off') {
            cmdArgs = ['svc', 'data', 'disable'];
          } else if (networkState === 'data_on') {
            cmdArgs = ['svc', 'data', 'enable'];
          } else {
            cmdArgs = ['cmd', 'connectivity', 'airplane-mode', 'enable'];
          }

          const netRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            ...cmdArgs,
          ]);

          return {
            success: netRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { networkState, command: cmdArgs.join(' ') },
            error: netRes.exitCode !== 0 ? netRes.stderr : undefined,
          };
        }

        case 'revokePermission': {
          const targetPkg = (typeof action.value === 'object' && action.value?.packageName) || this.packageName;
          const permission = action.target || (typeof action.value === 'string' ? action.value : action.value?.permission);
          if (!targetPkg || !permission) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: 'revokePermission requires both a target package and permission string',
            };
          }

          const revokeRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'pm',
            'revoke',
            targetPkg,
            permission,
          ]);

          return {
            success: revokeRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { package: targetPkg, revokedPermission: permission },
            error: revokeRes.exitCode !== 0 ? revokeRes.stderr : undefined,
          };
        }

        case 'darkMode':
        case 'setDarkMode': {
          const isNight =
            action.value === true ||
            action.value === 'yes' ||
            action.value === 'true' ||
            action.value === 'on' ||
            action.value?.enabled === true ||
            action.target === 'yes' ||
            action.target === 'true' ||
            action.target === 'on';
          const mode = isNight ? 'yes' : 'no';
          const modeRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'cmd',
            'uimode',
            'night',
            mode,
          ]);

          return {
            success: modeRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { darkMode: isNight, mode },
            error: modeRes.exitCode !== 0 ? modeRes.stderr : undefined,
          };
        }

        case 'setLocale':
        case 'locale': {
          const locale = String(
            action.value?.locale || action.value || action.target || 'en-US'
          );
          const localeRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'cmd',
            'locale',
            'set-locales',
            locale,
          ]);

          return {
            success: localeRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { locale },
            error: localeRes.exitCode !== 0 ? localeRes.stderr : undefined,
          };
        }

        case 'fontScale':
        case 'setFontScale': {
          const scale = String(
            action.value?.scale || action.value || action.target || '1.0'
          );
          const fontRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'settings',
            'put',
            'system',
            'font_scale',
            scale,
          ]);

          return {
            success: fontRes.exitCode === 0,
            durationMs: Date.now() - start,
            output: { fontScale: scale },
            error: fontRes.exitCode !== 0 ? fontRes.stderr : undefined,
          };
        }

        case 'custom': {
          const customTarget = String(action.target || '');
          if (customTarget === 'darkMode' || customTarget === 'setDarkMode') {
            return this.executeAction({ ...action, type: 'darkMode' as any });
          }
          if (customTarget === 'setLocale' || customTarget === 'locale') {
            return this.executeAction({ ...action, type: 'setLocale' as any });
          }
          if (customTarget === 'fontScale' || customTarget === 'setFontScale') {
            return this.executeAction({ ...action, type: 'fontScale' as any });
          }
          if (customTarget === 'app:launch') {
            await this.launchApp(action.value?.packageName, action.value?.activityName);
            return { success: true, durationMs: Date.now() - start };
          }
          if (customTarget === 'app:background') {
            await this.backgroundApp(action.value?.durationMs);
            return { success: true, durationMs: Date.now() - start };
          }
          if (customTarget === 'app:resume') {
            await this.resumeApp(action.value?.packageName, action.value?.activityName);
            return { success: true, durationMs: Date.now() - start };
          }
          if (customTarget === 'app:terminate') {
            await this.terminateApp(action.value?.packageName);
            return { success: true, durationMs: Date.now() - start };
          }

          return {
            success: false,
            durationMs: Date.now() - start,
            error: `Unknown custom action target: ${customTarget}`,
          };
        }

        default:
          return {
            success: false,
            durationMs: Date.now() - start,
            error: `Unsupported action type for AndroidAdapter: ${action.type}`,
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

    try {
      const xml = await this.getUIHierarchyXml();
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
              : `Element '${assertion.target}' was not visible or not found in UI hierarchy`,
          };
        }

        case 'elementHidden': {
          const isHidden = !element || !element.visible;
          return {
            passed: isHidden,
            expected: true,
            actual: isHidden,
            durationMs: Date.now() - start,
            message: isHidden
              ? `Element '${assertion.target}' is hidden or not present`
              : `Element '${assertion.target}' is visible in UI hierarchy`,
          };
        }

        case 'elementExists': {
          const exists = Boolean(element);
          return {
            passed: exists,
            expected: true,
            actual: exists,
            durationMs: Date.now() - start,
            message: exists
              ? `Element '${assertion.target}' exists in UI hierarchy`
              : `Element '${assertion.target}' was not found in UI hierarchy`,
          };
        }

        case 'elementTextEquals': {
          const actualText = element?.text ?? element?.contentDesc ?? '';
          const expectedText = String(assertion.expected ?? '');
          const passed = actualText === expectedText || actualText.trim() === expectedText.trim();

          return {
            passed,
            expected: assertion.expected,
            actual: actualText,
            durationMs: Date.now() - start,
            message: passed
              ? `Element '${assertion.target}' text matches expected '${assertion.expected}'`
              : `Element '${assertion.target}' text '${actualText}' did not match expected '${assertion.expected}'`,
          };
        }

        case 'elementTextContains': {
          const actualText = element?.text ?? element?.contentDesc ?? '';
          const expectedSubstring = String(assertion.expected ?? '');
          const passed = actualText.includes(expectedSubstring);

          return {
            passed,
            expected: assertion.expected,
            actual: actualText,
            durationMs: Date.now() - start,
            message: passed
              ? `Element '${assertion.target}' text '${actualText}' contains '${expectedSubstring}'`
              : `Element '${assertion.target}' text '${actualText}' does not contain '${expectedSubstring}'`,
          };
        }

        case 'elementDisabled': {
          const isDisabled = Boolean(element && element.enabled === false);
          return {
            passed: isDisabled,
            expected: true,
            actual: isDisabled,
            durationMs: Date.now() - start,
            message: isDisabled
              ? `Element '${assertion.target}' is disabled`
              : `Element '${assertion.target}' is enabled or was not found`,
          };
        }

        case 'elementEnabled': {
          const isEnabled = Boolean(element && element.enabled === true);
          return {
            passed: isEnabled,
            expected: true,
            actual: isEnabled,
            durationMs: Date.now() - start,
            message: isEnabled
              ? `Element '${assertion.target}' is enabled`
              : `Element '${assertion.target}' is disabled or was not found`,
          };
        }

        case 'consoleClean': {
          const crashRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'logcat',
            '-d',
            '-b',
            'crash',
          ]);
          const crashOutput = crashRes.stdout || '';
          const hasCrash =
            crashOutput.includes('FATAL EXCEPTION') ||
            crashOutput.includes('ANR in') ||
            crashOutput.includes('SIGSEGV') ||
            crashOutput.includes('Process died');

          return {
            passed: !hasCrash,
            expected: 'Zero fatal Android crashes or ANRs in logcat buffer',
            actual: hasCrash ? crashOutput.slice(0, 300) : 'Clean logcat buffer',
            durationMs: Date.now() - start,
            message: hasCrash
              ? `Fatal Android application crash/ANR detected: ${crashOutput.slice(0, 200)}`
              : 'Android logcat crash buffer is clean',
          };
        }

        case 'noLayoutOverflow': {
          const xml = await this.getUIHierarchyXml();
          const elements = parseUIHierarchy(xml);
          const wmRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'wm',
            'size',
          ]);
          let screenWidth = 1080;
          const match = wmRes.stdout.match(/Physical size:\s*(\d+)x(\d+)/i);
          if (match) {
            screenWidth = parseInt(match[1], 10);
          }

          const overflowing = elements.filter(
            (el) =>
              el.bounds &&
              el.bounds.right > screenWidth + 5 &&
              !el.className?.includes('ScrollView') &&
              !el.className?.includes('RecyclerView')
          );

          const passed = overflowing.length === 0;
          return {
            passed,
            expected: `All UI elements within ${screenWidth}px width`,
            actual: passed ? 'No overflowing elements' : `${overflowing.length} element(s) exceed screen width`,
            durationMs: Date.now() - start,
            message: passed
              ? `No UI horizontal layout overflow detected (screen width ${screenWidth}px)`
              : `Layout overflow detected: ${overflowing.length} element(s) extend beyond screen width ${screenWidth}px`,
          };
        }

        case 'isElementOccluded': {
          const imeRes = await this.executor.exec('adb', [
            ...this.getDeviceFlag(),
            'shell',
            'dumpsys',
            'input_method',
          ]);
          const isImeVisible = imeRes.stdout.includes('mInputShown=true');
          const isExpectedOccluded = Boolean(assertion.expected ?? false);

          if (!element || !element.bounds) {
            return {
              passed: !isImeVisible,
              expected: isExpectedOccluded,
              actual: isImeVisible,
              durationMs: Date.now() - start,
              message: 'Target element not found in UI hierarchy for occlusion check',
            };
          }

          let screenHeight = 1920;
          try {
            const wmRes = await this.executor.exec('adb', [
              ...this.getDeviceFlag(),
              'shell',
              'wm',
              'size',
            ]);
            if (wmRes.exitCode === 0) {
              const match =
                wmRes.stdout.match(/Physical size:\s*(\d+)x(\d+)/i) ||
                wmRes.stdout.match(/(\d+)x(\d+)/);
              if (match) {
                screenHeight = parseInt(match[2], 10);
              }
            }
          } catch {
            // fallback to default 1920
          }
          const estimatedKeyboardTop = screenHeight * 0.55;
          const isOccludedByKeyboard = isImeVisible && element.bounds.centerY > estimatedKeyboardTop;

          const passed = isOccludedByKeyboard === isExpectedOccluded;
          return {
            passed,
            expected: isExpectedOccluded,
            actual: isOccludedByKeyboard,
            durationMs: Date.now() - start,
            message: isOccludedByKeyboard
              ? `Element '${assertion.target}' is occluded by the soft keyboard`
              : `Element '${assertion.target}' is not occluded by the soft keyboard`,
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
              : `Touch target '${assertion.target}' violates AAA target size (${width}x${height} < ${minRequired}x${minRequired})`,
          };
        }

        case 'noSilentTruncation': {
          const actualText = element?.text ?? element?.contentDesc ?? '';
          const expectedLimit = assertion.metadata?.expectedLimit ?? assertion.expected;
          let passed = true;
          let message = 'Input length preserved without silent cut';

          if (expectedLimit && typeof expectedLimit === 'number' && actualText.length < expectedLimit) {
            passed = false;
            message = `Silent truncation detected: expected ${expectedLimit} characters but field only contains ${actualText.length} characters without notification`;
          }

          return {
            passed,
            expected: expectedLimit,
            actual: actualText.length,
            durationMs: Date.now() - start,
            message,
          };
        }

        default:
          return {
            passed: false,
            durationMs: Date.now() - start,
            message: `Unsupported assertion type for AndroidAdapter: ${assertion.type}`,
          };
      }
    } catch (err: any) {
      return {
        passed: false,
        durationMs: Date.now() - start,
        message: `Assertion evaluation failed: ${err.message}`,
      };
    }
  }

  async launchApp(pkg?: string, activity?: string): Promise<void> {
    const targetPkg = pkg || this.packageName;
    const targetAct = activity || this.activityName;

    if (!targetPkg) {
      throw new QAAdapterError('Cannot launch app: packageName is not specified.', this.name);
    }

    if (targetAct) {
      await this.executor.exec('adb', [
        ...this.getDeviceFlag(),
        'shell',
        'am',
        'start',
        '-n',
        `${targetPkg}/${targetAct}`,
      ]);
    } else {
      await this.executor.exec('adb', [
        ...this.getDeviceFlag(),
        'shell',
        'monkey',
        '-p',
        targetPkg,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ]);
    }
  }

  async backgroundApp(durationMs?: number): Promise<void> {
    // Press HOME key
    await this.executor.exec('adb', [...this.getDeviceFlag(), 'shell', 'input', 'keyevent', '3']);
    if (durationMs && durationMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    }
  }

  async resumeApp(pkg?: string, activity?: string): Promise<void> {
    await this.launchApp(pkg, activity);
  }

  async terminateApp(pkg?: string): Promise<void> {
    const targetPkg = pkg || this.packageName;
    if (!targetPkg) {
      throw new QAAdapterError('Cannot terminate app: packageName is not specified.', this.name);
    }
    await this.executor.exec('adb', [
      ...this.getDeviceFlag(),
      'shell',
      'am',
      'force-stop',
      targetPkg,
    ]);
  }

  async captureEvidence(type: string, description?: string): Promise<EvidenceArtifact> {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const timestamp = Date.now();
    const id = `ev-android-${timestamp}-${Math.floor(Math.random() * 1000)}`;
    const normalizedType = type.toUpperCase().replace(/[-\s]/g, '_');

    if (normalizedType === 'SCREENSHOT' || normalizedType === 'IMAGE') {
      const filePath = path.join(this.outputDir, `screenshot-${timestamp}.png`);
      const binaryRes = await this.executor.execBinary('adb', [
        ...this.getDeviceFlag(),
        'exec-out',
        'screencap',
        '-p',
      ]);

      let buffer: Buffer;
      // Valid PNG starts with 89 50 4E 47
      const isPng =
        binaryRes.exitCode === 0 &&
        binaryRes.stdout.length >= 8 &&
        binaryRes.stdout[0] === 0x89 &&
        binaryRes.stdout[1] === 0x50 &&
        binaryRes.stdout[2] === 0x4e &&
        binaryRes.stdout[3] === 0x47;

      if (isPng) {
        buffer = binaryRes.stdout;
      } else if (binaryRes.exitCode === 0 && binaryRes.stdout.length > 0) {
        // In mock or non-standard environments, accept non-empty stdout
        buffer = binaryRes.stdout;
      } else {
        // Fallback: save on device and pull
        const tempDevicePath = '/sdcard/qa_screen.png';
        await this.executor.exec('adb', [
          ...this.getDeviceFlag(),
          'shell',
          'screencap',
          '-p',
          tempDevicePath,
        ]);
        await this.executor.exec('adb', [
          ...this.getDeviceFlag(),
          'pull',
          tempDevicePath,
          filePath,
        ]);
        buffer = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.from('');
      }

      fs.writeFileSync(filePath, buffer);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      const artifact: EvidenceArtifact = {
        id,
        type: 'SCREENSHOT',
        path: filePath,
        sha256,
        sizeBytes: buffer.length,
        mimeType: 'image/png',
        capturedAt: new Date().toISOString(),
        description: description || 'Android device screenshot',
        metadata: {
          deviceId: this.selectedDeviceId,
        },
      };
      return EvidenceArtifactSchema.parse(artifact);
    }

    if (
      normalizedType === 'SYSTEM_LOG' ||
      normalizedType === 'CONSOLE_LOG' ||
      normalizedType === 'LOGCAT' ||
      normalizedType === 'LOG'
    ) {
      const filePath = path.join(this.outputDir, `logcat-${timestamp}.txt`);
      const logcatRes = await this.executor.exec('adb', [
        ...this.getDeviceFlag(),
        'logcat',
        '-d',
        '-t',
        '500',
      ]);

      const content = logcatRes.stdout || logcatRes.stderr || 'No logcat entries';
      const buffer = Buffer.from(content, 'utf8');
      fs.writeFileSync(filePath, buffer);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      const artifact: EvidenceArtifact = {
        id,
        type: 'SYSTEM_LOG',
        path: filePath,
        sha256,
        sizeBytes: buffer.length,
        mimeType: 'text/plain',
        capturedAt: new Date().toISOString(),
        description: description || 'Android logcat capture',
        metadata: {
          deviceId: this.selectedDeviceId,
          lineCount: content.split('\n').length,
        },
      };
      return EvidenceArtifactSchema.parse(artifact);
    }

    if (
      normalizedType === 'CRASH_EVIDENCE' ||
      normalizedType === 'CRASH' ||
      normalizedType === 'TRACE'
    ) {
      const filePath = path.join(this.outputDir, `crash-${timestamp}.txt`);
      const crashLogs = await this.executor.exec('adb', [
        ...this.getDeviceFlag(),
        'logcat',
        '-d',
        '-b',
        'crash',
      ]);
      const dropbox = await this.executor.exec('adb', [
        ...this.getDeviceFlag(),
        'shell',
        'dumpsys',
        'dropbox',
        '--print',
      ]);

      const combined = `=== CRASH BUFFER ===\n${crashLogs.stdout}\n\n=== DROPBOX DUMP ===\n${dropbox.stdout}`;
      const buffer = Buffer.from(combined, 'utf8');
      fs.writeFileSync(filePath, buffer);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      const artifact: EvidenceArtifact = {
        id,
        type: 'SYSTEM_LOG',
        path: filePath,
        sha256,
        sizeBytes: buffer.length,
        mimeType: 'text/plain',
        capturedAt: new Date().toISOString(),
        description: description || 'Android crash / dropbox evidence',
        metadata: {
          deviceId: this.selectedDeviceId,
          hasCrash: crashLogs.stdout.trim().length > 0,
        },
      };
      return EvidenceArtifactSchema.parse(artifact);
    }

    if (
      normalizedType === 'DOM_SNAPSHOT' ||
      normalizedType === 'UI_HIERARCHY' ||
      normalizedType === 'DOM'
    ) {
      const filePath = path.join(this.outputDir, `hierarchy-${timestamp}.xml`);
      const xml = await this.getUIHierarchyXml();
      const buffer = Buffer.from(xml, 'utf8');
      fs.writeFileSync(filePath, buffer);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      const artifact: EvidenceArtifact = {
        id,
        type: 'DOM_SNAPSHOT',
        path: filePath,
        sha256,
        sizeBytes: buffer.length,
        mimeType: 'application/xml',
        capturedAt: new Date().toISOString(),
        description: description || 'Android UI Automator hierarchy snapshot',
        metadata: {
          deviceId: this.selectedDeviceId,
        },
      };
      return EvidenceArtifactSchema.parse(artifact);
    }

    throw new QAAdapterError(`Unsupported evidence type: ${type}`, this.name);
  }

  async teardown(): Promise<void> {
    this.isInitialized = false;
  }
}
