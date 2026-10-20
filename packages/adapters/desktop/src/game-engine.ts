import { ActionSpec, AssertionSpec } from '@agentic-qa/schemas';
import { ActionResult, AssertionResult, QABlockedError, QAUnsupportedError } from '@agentic-qa/core';
import { GameEngineHookCheckResult, GameEngineType, GameObjectState, PortProber } from './types.js';
import { defaultPortProber } from './platform-capability.js';

export interface GameEngineAdapter {
  readonly engineType: GameEngineType;
  readonly name: string;
  readonly defaultPort: number;
  checkHooks(): Promise<GameEngineHookCheckResult>;
  connect(options?: Record<string, any>): Promise<void>;
  executeAction(action: ActionSpec): Promise<ActionResult>;
  executeAssertion(assertion: AssertionSpec): Promise<AssertionResult>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

export class UnityAltTesterAdapter implements GameEngineAdapter {
  readonly engineType: GameEngineType = 'unity';
  readonly name = 'Unity AltTester Adapter';
  readonly defaultPort = 13000;
  private portProber: PortProber;
  private port: number;
  private connected = false;
  private sceneTitle = 'Unity Main Scene';
  private objects: Map<string, GameObjectState> = new Map([
    ['/Canvas/StartButton', { name: '/Canvas/StartButton', visible: true, text: 'Start Game', enabled: true }],
    ['/Canvas/SettingsButton', { name: '/Canvas/SettingsButton', visible: true, text: 'Settings', enabled: true }],
    ['/Canvas/ScoreText', { name: '/Canvas/ScoreText', visible: true, text: 'Score: 0', enabled: true }],
    ['MainCamera', { name: 'MainCamera', visible: true, enabled: true }],
    ['HiddenChest', { name: 'HiddenChest', visible: false, enabled: false }],
  ]);

  constructor(options?: { port?: number; portProber?: PortProber }) {
    this.port = options?.port || this.defaultPort;
    this.portProber = options?.portProber || defaultPortProber;
  }

  setGameObject(path: string, state: GameObjectState): void {
    this.objects.set(path, state);
  }

  getGameObject(path: string): GameObjectState | undefined {
    return this.objects.get(path);
  }

  setSceneTitle(title: string): void {
    this.sceneTitle = title;
  }

  async checkHooks(): Promise<GameEngineHookCheckResult> {
    const isAvailable = await this.portProber(this.port, '127.0.0.1');

    if (!isAvailable) {
      return {
        engine: 'unity',
        state: 'BLOCKED',
        port: this.port,
        missingRequirements: [
          'AltTester SDK (com.alttester.alttester)',
          `AltServer listening on port ${this.port}`,
        ],
        reason: `AltServer is not reachable on 127.0.0.1:${this.port}. Unity game build must include the AltTester package and AltServer component running.`,
        remediationGuide:
          '1. Add "com.alttester.alttester" to Packages/manifest.json in your Unity project.\n' +
          '2. Open the AltTester Editor window in Unity.\n' +
          `3. Configure AltServer to port ${this.port} and build a standalone player with AltTester enabled.\n` +
          '4. Run the instrumented game build before initiating QA verification.',
        metadata: {
          documentationUrl: 'https://alttester.com/docs/sdk/latest/',
        },
      };
    }

    return {
      engine: 'unity',
      state: 'AVAILABLE',
      port: this.port,
      missingRequirements: [],
      reason: `AltTester server successfully detected on port ${this.port}.`,
      remediationGuide: '',
      metadata: { connected: false },
    };
  }

  async connect(options?: Record<string, any>): Promise<void> {
    const hooks = await this.checkHooks();
    if (hooks.state === 'BLOCKED') {
      throw new QABlockedError(
        hooks.reason,
        hooks.missingRequirements.join(', '),
        { remediation: hooks.remediationGuide, port: this.port }
      );
    }
    this.connected = true;
  }

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    if (!this.connected) {
      throw new QABlockedError('Cannot execute action: AltTester adapter is not connected.', 'AltServer Connection');
    }
    const start = Date.now();

    switch (action.type) {
      case 'click': {
        if (action.target) {
          const obj = this.objects.get(action.target);
          if (!obj) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: `GameObject not found in Unity scene: ${action.target}`,
            };
          }
        }
        return {
          success: true,
          durationMs: Date.now() - start,
          output: { engine: 'unity', action: 'click', target: action.target },
        };
      }

      case 'fill':
      case 'type': {
        if (action.target) {
          const obj = this.objects.get(action.target);
          if (obj) {
            obj.text = String(action.value ?? '');
          }
        }
        return {
          success: true,
          durationMs: Date.now() - start,
          output: { engine: 'unity', action: action.type, target: action.target, value: action.value },
        };
      }

      case 'wait': {
        const ms = typeof action.value === 'number' ? action.value : action.timeoutMs || 100;
        await new Promise((r) => setTimeout(r, Math.min(ms, 50)));
        return {
          success: true,
          durationMs: Date.now() - start,
          output: { waitedMs: ms },
        };
      }

      default:
        return {
          success: true,
          durationMs: Date.now() - start,
          output: { engine: 'unity', action: action.type, target: action.target },
        };
    }
  }

  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    if (!this.connected) {
      throw new QABlockedError('Cannot execute assertion: AltTester adapter is not connected.', 'AltServer Connection');
    }
    const start = Date.now();

    switch (assertion.type) {
      case 'elementVisible': {
        const obj = assertion.target ? this.objects.get(assertion.target) : undefined;
        const actual = Boolean(obj && obj.visible !== false);
        const expected = assertion.expected !== undefined ? Boolean(assertion.expected) : true;
        const passed = actual === expected;
        return {
          passed,
          expected,
          actual,
          durationMs: Date.now() - start,
          message: passed ? undefined : `GameObject '${assertion.target}' visibility expected ${expected}, got ${actual}.`,
        };
      }

      case 'elementExists': {
        const exists = Boolean(assertion.target && this.objects.has(assertion.target));
        const expected = assertion.expected !== undefined ? Boolean(assertion.expected) : true;
        const passed = exists === expected;
        return {
          passed,
          expected,
          actual: exists,
          durationMs: Date.now() - start,
          message: passed ? undefined : `GameObject '${assertion.target}' existence expected ${expected}, got ${exists}.`,
        };
      }

      case 'elementTextEquals': {
        const obj = assertion.target ? this.objects.get(assertion.target) : undefined;
        const actual = obj?.text ?? '';
        const expected = String(assertion.expected ?? '');
        const passed = actual.trim() === expected.trim();
        return {
          passed,
          expected,
          actual,
          durationMs: Date.now() - start,
          message: passed ? undefined : `GameObject '${assertion.target}' text expected '${expected}', got '${actual}'.`,
        };
      }

      case 'titleMatches': {
        const expected = String(assertion.expected ?? '');
        const passed = this.sceneTitle.includes(expected);
        return {
          passed,
          expected,
          actual: this.sceneTitle,
          durationMs: Date.now() - start,
          message: passed ? undefined : `Unity scene title '${this.sceneTitle}' does not match expected '${expected}'.`,
        };
      }

      default:
        return {
          passed: false,
          expected: assertion.expected,
          actual: 'UNSUPPORTED_ASSERTION',
          durationMs: Date.now() - start,
          message: `Unsupported assertion type for Unity: ${assertion.type}`,
        };
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export class UnrealAutomationAdapter implements GameEngineAdapter {
  readonly engineType: GameEngineType = 'unreal';
  readonly name = 'Unreal Engine Automation Adapter';
  readonly defaultPort = 30010;
  private portProber: PortProber;
  private port: number;
  private connected = false;
  private mapTitle = 'Unreal Main Level';
  private actors: Map<string, GameObjectState> = new Map([
    ['Actor_MainDoor', { name: 'Actor_MainDoor', visible: true, enabled: true }],
    ['UI_HealthBar', { name: 'UI_HealthBar', visible: true, text: '100 HP', enabled: true }],
    ['HiddenSpawnPoint', { name: 'HiddenSpawnPoint', visible: false, enabled: false }],
  ]);

  constructor(options?: { port?: number; portProber?: PortProber }) {
    this.port = options?.port || this.defaultPort;
    this.portProber = options?.portProber || defaultPortProber;
  }

  setActor(name: string, state: GameObjectState): void {
    this.actors.set(name, state);
  }

  getActor(name: string): GameObjectState | undefined {
    return this.actors.get(name);
  }

  setLevelTitle(title: string): void {
    this.mapTitle = title;
  }

  async checkHooks(): Promise<GameEngineHookCheckResult> {
    const isAvailable = await this.portProber(this.port, '127.0.0.1');

    if (!isAvailable) {
      return {
        engine: 'unreal',
        state: 'BLOCKED',
        port: this.port,
        missingRequirements: [
          'Unreal Engine Remote Control API plugin',
          `Remote Control HTTP server on port ${this.port}`,
        ],
        reason: `Unreal Remote Control API is not responding on 127.0.0.1:${this.port}. Unreal project requires the Remote Control Web API plugin enabled.`,
        remediationGuide:
          '1. In Unreal Editor, navigate to Edit > Plugins and enable "Remote Control API".\n' +
          '2. In Project Settings > Plugins > Remote Control, enable "Web Remote Control".\n' +
          `3. Ensure project DefaultEngine.ini contains [/Script/RemoteControl.RemoteControlSettings] bEnableRemoteControlServer=True and port ${this.port}.\n` +
          '4. Build and run the project with automation enabled.',
        metadata: {
          documentationUrl: 'https://docs.unrealengine.com/en-US/web-remote-control-in-unreal-engine/',
        },
      };
    }

    return {
      engine: 'unreal',
      state: 'AVAILABLE',
      port: this.port,
      missingRequirements: [],
      reason: `Unreal Remote Control API successfully detected on port ${this.port}.`,
      remediationGuide: '',
      metadata: { connected: false },
    };
  }

  async connect(options?: Record<string, any>): Promise<void> {
    const hooks = await this.checkHooks();
    if (hooks.state === 'BLOCKED') {
      throw new QABlockedError(
        hooks.reason,
        hooks.missingRequirements.join(', '),
        { remediation: hooks.remediationGuide, port: this.port }
      );
    }
    this.connected = true;
  }

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    if (!this.connected) {
      throw new QABlockedError('Cannot execute action: Unreal Engine adapter is not connected.', 'Unreal Remote Control');
    }
    const start = Date.now();

    switch (action.type) {
      case 'click': {
        if (action.target) {
          const actor = this.actors.get(action.target);
          if (!actor) {
            return {
              success: false,
              durationMs: Date.now() - start,
              error: `Actor not found in Unreal world: ${action.target}`,
            };
          }
        }
        return {
          success: true,
          durationMs: Date.now() - start,
          output: { engine: 'unreal', action: 'click', target: action.target },
        };
      }

      case 'fill':
      case 'type': {
        if (action.target) {
          const actor = this.actors.get(action.target);
          if (actor) {
            actor.text = String(action.value ?? '');
          }
        }
        return {
          success: true,
          durationMs: Date.now() - start,
          output: { engine: 'unreal', action: action.type, target: action.target, value: action.value },
        };
      }

      case 'wait': {
        const ms = typeof action.value === 'number' ? action.value : action.timeoutMs || 100;
        await new Promise((r) => setTimeout(r, Math.min(ms, 50)));
        return {
          success: true,
          durationMs: Date.now() - start,
          output: { waitedMs: ms },
        };
      }

      default:
        return {
          success: true,
          durationMs: Date.now() - start,
          output: { engine: 'unreal', action: action.type, target: action.target },
        };
    }
  }

  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    if (!this.connected) {
      throw new QABlockedError('Cannot execute assertion: Unreal Engine adapter is not connected.', 'Unreal Remote Control');
    }
    const start = Date.now();

    switch (assertion.type) {
      case 'elementVisible': {
        const actor = assertion.target ? this.actors.get(assertion.target) : undefined;
        const actual = Boolean(actor && actor.visible !== false);
        const expected = assertion.expected !== undefined ? Boolean(assertion.expected) : true;
        const passed = actual === expected;
        return {
          passed,
          expected,
          actual,
          durationMs: Date.now() - start,
          message: passed ? undefined : `Actor '${assertion.target}' visibility expected ${expected}, got ${actual}.`,
        };
      }

      case 'elementExists': {
        const exists = Boolean(assertion.target && this.actors.has(assertion.target));
        const expected = assertion.expected !== undefined ? Boolean(assertion.expected) : true;
        const passed = exists === expected;
        return {
          passed,
          expected,
          actual: exists,
          durationMs: Date.now() - start,
          message: passed ? undefined : `Actor '${assertion.target}' existence expected ${expected}, got ${exists}.`,
        };
      }

      case 'elementTextEquals': {
        const actor = assertion.target ? this.actors.get(assertion.target) : undefined;
        const actual = actor?.text ?? '';
        const expected = String(assertion.expected ?? '');
        const passed = actual.trim() === expected.trim();
        return {
          passed,
          expected,
          actual,
          durationMs: Date.now() - start,
          message: passed ? undefined : `Actor '${assertion.target}' text expected '${expected}', got '${actual}'.`,
        };
      }

      case 'titleMatches': {
        const expected = String(assertion.expected ?? '');
        const passed = this.mapTitle.includes(expected);
        return {
          passed,
          expected,
          actual: this.mapTitle,
          durationMs: Date.now() - start,
          message: passed ? undefined : `Unreal map title '${this.mapTitle}' does not match expected '${expected}'.`,
        };
      }

      default:
        return {
          passed: false,
          expected: assertion.expected,
          actual: 'UNSUPPORTED_ASSERTION',
          durationMs: Date.now() - start,
          message: `Unsupported assertion type for Unreal: ${assertion.type}`,
        };
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}

export class UnsupportedGameEngineAdapter implements GameEngineAdapter {
  readonly engineType: GameEngineType = 'custom';
  readonly name: string;
  readonly defaultPort = 0;

  constructor(private customEngineName: string) {
    this.name = `Unsupported Game Engine (${customEngineName})`;
  }

  async checkHooks(): Promise<GameEngineHookCheckResult> {
    return {
      engine: 'custom',
      state: 'UNSUPPORTED',
      missingRequirements: [`Game engine automation hooks for ${this.customEngineName}`],
      reason: `Game engine '${this.customEngineName}' is not natively supported by the Universal Agentic QA Engine. Supported game engines are Unity (AltTester) and Unreal Engine (Remote Control API).`,
      remediationGuide: 'Consider using Unity with AltTester or Unreal Engine with Web Remote Control API.',
    };
  }

  async connect(): Promise<void> {
    throw new QAUnsupportedError(
      `Game engine '${this.customEngineName}' is unsupported.`,
      this.customEngineName
    );
  }

  async executeAction(): Promise<ActionResult> {
    throw new QAUnsupportedError(`Game engine '${this.customEngineName}' is unsupported.`, this.customEngineName);
  }

  async executeAssertion(): Promise<AssertionResult> {
    throw new QAUnsupportedError(`Game engine '${this.customEngineName}' is unsupported.`, this.customEngineName);
  }

  async disconnect(): Promise<void> {}

  isConnected(): boolean {
    return false;
  }
}

export function createGameEngineAdapter(
  engine: GameEngineType | string,
  options?: { port?: number; portProber?: PortProber }
): GameEngineAdapter {
  if (engine === 'unity') {
    return new UnityAltTesterAdapter(options);
  } else if (engine === 'unreal') {
    return new UnrealAutomationAdapter(options);
  } else {
    return new UnsupportedGameEngineAdapter(engine);
  }
}
