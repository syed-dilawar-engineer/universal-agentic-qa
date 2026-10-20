import { CapabilityState, Platform } from '@agentic-qa/schemas';

export type DesktopTargetType = 'electron' | 'native' | 'game' | 'auto';

export type GameEngineType = 'unity' | 'unreal' | 'custom';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandExecutor = (command: string, args: string[]) => Promise<CommandResult>;

export type PortProber = (port: number, host?: string) => Promise<boolean>;

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CrashInfo {
  crashed: boolean;
  exitCode?: number | null;
  signal?: string | null;
  reason?: string;
  timestamp?: string;
  logsExcerpt?: string;
}

export interface GameObjectState {
  name: string;
  visible?: boolean;
  text?: string;
  enabled?: boolean;
  components?: string[];
  metadata?: Record<string, any>;
}

export interface GameEngineHookCheckResult {
  engine: GameEngineType;
  state: CapabilityState;
  missingRequirements: string[];
  reason: string;
  remediationGuide: string;
  port?: number;
  metadata?: Record<string, any>;
}

export interface DesktopAdapterConfig {
  id?: string;
  name?: string;
  platform?: Platform;
  targetType?: DesktopTargetType;
  appPath?: string;
  appArgs?: string[];
  cdpPort?: number;
  cdpEndpoint?: string;
  windowTitle?: string;
  bundleId?: string;
  processName?: string;
  gameEngine?: GameEngineType;
  gamePort?: number;
  outputDir?: string;
  platformOverride?: 'darwin' | 'win32' | 'linux';
  commandExecutor?: CommandExecutor;
  portProber?: PortProber;
}

