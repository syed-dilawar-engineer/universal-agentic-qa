import { ActionSpec, AssertionSpec } from '@agentic-qa/schemas';
import { CommandExecutor } from './executor.js';

export type MobileEngine = 'auto' | 'android' | 'ios' | 'maestro' | 'appium';

export interface MobileAdapterOptions {
  engine?: MobileEngine;
  deviceId?: string;
  appPath?: string;
  packageName?: string;
  bundleId?: string;
  activityName?: string;
  appiumServerUrl?: string;
  outputDir?: string;
  executor?: CommandExecutor;
  hostPlatform?: NodeJS.Platform;
  uiHierarchyXml?: string;
}

export interface ElementBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

export interface UIElement {
  tag: string;
  text?: string;
  resourceId?: string;
  contentDesc?: string;
  className?: string;
  packageName?: string;
  enabled: boolean;
  clickable: boolean;
  visible: boolean;
  bounds?: ElementBounds;
  attributes: Record<string, string>;
}

export interface AndroidDevice {
  id: string;
  state: 'device' | 'offline' | 'unauthorized' | string;
  model?: string;
  product?: string;
}

export interface IosSimulator {
  udid: string;
  name: string;
  state: 'Booted' | 'Shutdown' | string;
  isAvailable: boolean;
  runtime?: string;
}

export interface MobileLifecycleActions {
  launchApp(appIdentifier?: string, activityName?: string): Promise<void>;
  backgroundApp(durationMs?: number): Promise<void>;
  resumeApp(appIdentifier?: string, activityName?: string): Promise<void>;
  terminateApp(appIdentifier?: string): Promise<void>;
}
