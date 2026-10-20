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
} from '@agentic-qa/core';
import {
  MobileAdapterOptions,
  MobileEngine,
  MobileLifecycleActions,
} from './types.js';
import { CommandExecutor, DefaultCommandExecutor } from './executor.js';
import { AndroidAdapter } from './subadapters/android-adapter.js';
import { IosAdapter } from './subadapters/ios-adapter.js';
import { MaestroAdapter } from './subadapters/maestro-adapter.js';
import { AppiumAdapter } from './subadapters/appium-adapter.js';

export class MobileAdapter implements PlatformAdapter, MobileLifecycleActions {
  readonly id = 'mobile-unified';
  readonly name = 'Universal Mobile Testing Adapter';
  readonly platform: Platform = 'mobile';

  public readonly android: AndroidAdapter;
  public readonly ios: IosAdapter;
  public readonly maestro: MaestroAdapter;
  public readonly appium: AppiumAdapter;

  private engine: MobileEngine;
  private executor: CommandExecutor;
  private hostPlatform: NodeJS.Platform;
  private activeSubAdapter?: PlatformAdapter & MobileLifecycleActions;
  private options: MobileAdapterOptions;

  constructor(options: MobileAdapterOptions = {}) {
    this.options = options;
    this.executor = options.executor || new DefaultCommandExecutor();
    this.hostPlatform = options.hostPlatform || process.platform;
    this.engine = options.engine || 'auto';

    const subOpts = {
      ...options,
      executor: this.executor,
      hostPlatform: this.hostPlatform,
    };

    this.android = new AndroidAdapter(subOpts);
    this.ios = new IosAdapter(subOpts);
    this.maestro = new MaestroAdapter(subOpts);
    this.appium = new AppiumAdapter(subOpts);

    if (this.engine === 'android') {
      this.activeSubAdapter = this.android;
    } else if (this.engine === 'ios') {
      this.activeSubAdapter = this.ios;
    } else if (this.engine === 'maestro') {
      this.activeSubAdapter = this.maestro;
    } else if (this.engine === 'appium') {
      this.activeSubAdapter = this.appium;
    }
  }

  async getCapability(): Promise<CapabilityDescriptor> {
    // 1. Explicit single engine requested
    if (this.engine === 'android') {
      return this.android.getCapability();
    }
    if (this.engine === 'ios') {
      return this.ios.getCapability();
    }
    if (this.engine === 'maestro') {
      return this.maestro.getCapability();
    }
    if (this.engine === 'appium') {
      return this.appium.getCapability();
    }

    // 2. Auto-detect across all sub-adapters
    const [androidCap, iosCap, maestroCap, appiumCap] = await Promise.all([
      this.android.getCapability(),
      this.ios.getCapability(),
      this.maestro.getCapability(),
      this.appium.getCapability(),
    ]);

    const drivers = {
      android: androidCap,
      ios: iosCap,
      maestro: maestroCap,
      appium: appiumCap,
    };

    // If any driver is AVAILABLE, select it and report AVAILABLE
    if (androidCap.state === 'AVAILABLE') {
      this.activeSubAdapter = this.android;
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'AVAILABLE',
        reason: `Mobile automation is AVAILABLE via Android ADB driver (${androidCap.reason || 'device online'}).`,
        requiredTools: ['adb'],
        missingTools: [],
        version: androidCap.version,
        metadata: {
          activeDriver: 'android',
          drivers,
        },
      };
    }

    if (iosCap.state === 'AVAILABLE') {
      this.activeSubAdapter = this.ios;
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'AVAILABLE',
        reason: `Mobile automation is AVAILABLE via iOS Simulator driver (${iosCap.reason || 'simulator booted'}).`,
        requiredTools: ['xcrun'],
        missingTools: [],
        version: iosCap.version,
        metadata: {
          activeDriver: 'ios',
          drivers,
        },
      };
    }

    if (maestroCap.state === 'AVAILABLE') {
      this.activeSubAdapter = this.maestro;
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'AVAILABLE',
        reason: `Mobile automation is AVAILABLE via Maestro CLI driver (${maestroCap.version}).`,
        requiredTools: ['maestro'],
        missingTools: [],
        version: maestroCap.version,
        metadata: {
          activeDriver: 'maestro',
          drivers,
        },
      };
    }

    if (appiumCap.state === 'AVAILABLE') {
      this.activeSubAdapter = this.appium;
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'AVAILABLE',
        reason: `Mobile automation is AVAILABLE via Appium Server (${appiumCap.version}).`,
        requiredTools: ['appium'],
        missingTools: [],
        version: appiumCap.version,
        metadata: {
          activeDriver: 'appium',
          drivers,
        },
      };
    }

    // If no driver is AVAILABLE, check if any tool is installed but offline (UNAVAILABLE)
    const anyUnavailable = [androidCap, iosCap, maestroCap, appiumCap].find(
      (c) => c.state === 'UNAVAILABLE'
    );
    if (anyUnavailable) {
      return {
        id: this.id,
        name: this.name,
        platform: this.platform,
        state: 'UNAVAILABLE',
        reason: `Mobile toolchain is detected but no active device/simulator or server is running. ${anyUnavailable.reason || ''}`,
        requiredTools: ['adb', 'xcrun'],
        missingTools: [],
        metadata: { drivers },
      };
    }

    // Otherwise, missing mandatory tools -> BLOCKED
    const missingTools = Array.from(
      new Set([
        ...androidCap.missingTools,
        ...maestroCap.missingTools,
        ...appiumCap.missingTools,
      ])
    );

    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: 'BLOCKED',
      reason:
        'No mobile automation drivers are operational. Missing required toolchains: ' +
        `${missingTools.join(', ')}. Android: ${androidCap.reason || 'missing adb'}. iOS: ${iosCap.reason || 'unsupported/offline'}.`,
      requiredTools: ['adb', 'xcrun', 'maestro', 'appium'],
      missingTools,
      metadata: { drivers },
    };
  }

  async initialize(options?: Record<string, any>): Promise<void> {
    const appPath = options?.appPath || this.options.appPath;

    // Never claim an APK or IPA can run if emulator/device is unavailable:
    if (appPath) {
      const ext = path.extname(appPath).toLowerCase();
      if (ext === '.apk' || ext === '.aab') {
        this.activeSubAdapter = this.android;
        const cap = await this.android.getCapability();
        if (cap.state !== 'AVAILABLE') {
          throw new QABlockedError(
            `Cannot run APK (${path.basename(appPath)}): Android device/emulator is unavailable. Reason: ${cap.reason || 'No connected device in device state.'}`,
            'Connected Android device or emulator'
          );
        }
      } else if (ext === '.ipa' || ext === '.app') {
        if (this.hostPlatform !== 'darwin') {
          throw new QAUnsupportedError(
            `Cannot run iOS IPA/APP (${path.basename(appPath)}): iOS simulation requires macOS host, but current platform is ${this.hostPlatform}.`,
            this.hostPlatform
          );
        }
        this.activeSubAdapter = this.ios;
        const cap = await this.ios.getCapability();
        if (cap.state !== 'AVAILABLE') {
          throw new QABlockedError(
            `Cannot run IPA (${path.basename(appPath)}): iOS simulator is unavailable. Reason: ${cap.reason || 'No booted simulator.'}`,
            'Booted iOS simulator'
          );
        }
      }
    }

    // Resolve active adapter if still unset
    if (!this.activeSubAdapter) {
      const cap = await this.getCapability();
      if (cap.state === 'BLOCKED' || cap.state === 'UNSUPPORTED') {
        throw new QABlockedError(
          `Initialization blocked: MobileAdapter is ${cap.state}. ${cap.reason || ''}`,
          cap.missingTools.join(', ') || 'Mobile toolchain'
        );
      }
      if (cap.state === 'UNAVAILABLE') {
        throw new QABlockedError(
          `Initialization blocked: MobileAdapter is ${cap.state}. ${cap.reason || ''}`,
          'Online mobile device, simulator, or server'
        );
      }
    }

    if (!this.activeSubAdapter) {
      throw new QABlockedError(
        'Initialization blocked: Unable to resolve active mobile sub-adapter.',
        'Mobile automation driver'
      );
    }

    await this.activeSubAdapter.initialize(options);
  }

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    const adapter = await this.resolveActiveAdapter();
    return adapter.executeAction(action);
  }

  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    const adapter = await this.resolveActiveAdapter();
    return adapter.executeAssertion(assertion);
  }

  async captureEvidence(type: string, description?: string): Promise<EvidenceArtifact> {
    const adapter = await this.resolveActiveAdapter();
    return adapter.captureEvidence(type, description);
  }

  async launchApp(appId?: string, activityName?: string): Promise<void> {
    const adapter = await this.resolveActiveAdapter();
    return adapter.launchApp(appId, activityName);
  }

  async backgroundApp(durationMs?: number): Promise<void> {
    const adapter = await this.resolveActiveAdapter();
    return adapter.backgroundApp(durationMs);
  }

  async resumeApp(appId?: string, activityName?: string): Promise<void> {
    const adapter = await this.resolveActiveAdapter();
    return adapter.resumeApp(appId, activityName);
  }

  async terminateApp(appId?: string): Promise<void> {
    const adapter = await this.resolveActiveAdapter();
    return adapter.terminateApp(appId);
  }

  async teardown(): Promise<void> {
    if (this.activeSubAdapter) {
      await this.activeSubAdapter.teardown();
    }
  }

  private async resolveActiveAdapter(): Promise<PlatformAdapter & MobileLifecycleActions> {
    if (this.activeSubAdapter) {
      return this.activeSubAdapter;
    }
    await this.getCapability();
    if (this.activeSubAdapter) {
      return this.activeSubAdapter;
    }
    // Default to android sub-adapter if unresolved
    return this.android;
  }
}
