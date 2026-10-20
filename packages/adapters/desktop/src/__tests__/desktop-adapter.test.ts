import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import {
  DesktopAdapter,
  PlatformCapabilityDetector,
  WindowManager,
  MockCDPClient,
  UnityAltTesterAdapter,
  UnrealAutomationAdapter,
  createGameEngineAdapter,
  CommandExecutor,
} from '../index.js';
import {
  CapabilityRegistry,
  RunLifecycle,
  QABlockedError,
  QAUnsupportedError,
  QAAdapterError,
  QATimeoutError,
} from '@agentic-qa/core';
import {
  ActionSpec,
  ActionSpecSchema,
  AssertionSpec,
  AssertionSpecSchema,
  TestPlan,
} from '@agentic-qa/schemas';

const makeAction = (spec: z.input<typeof ActionSpecSchema>): ActionSpec => ActionSpecSchema.parse(spec);
const makeAssertion = (spec: z.input<typeof AssertionSpecSchema>): AssertionSpec => AssertionSpecSchema.parse(spec);

describe('DesktopAdapter & Subsystems', () => {
  const testOutputDir = path.join(process.cwd(), '.qa-test-output');

  beforeEach(() => {
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // 1. Platform Capability Detection (Truthful Diagnostics)
  // ==========================================================================
  describe('Platform Capability Detection', () => {
    it('macOS: reports BLOCKED when Accessibility permissions are absent (-1743)', async () => {
      const mockExecutor: CommandExecutor = async (cmd, args) => {
        if (cmd === 'which' && args[0] === 'osascript') {
          return { stdout: '/usr/bin/osascript', stderr: '', exitCode: 0 };
        }
        if (cmd === 'osascript') {
          return {
            stdout: '',
            stderr: 'execution error: Not authorized to send Apple events to System Events. (-1743)',
            exitCode: 1,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const detector = new PlatformCapabilityDetector({
        platform: 'darwin',
        commandExecutor: mockExecutor,
      });

      const cap = await detector.detectNativeDesktopCapability();
      expect(cap.state).toBe('BLOCKED');
      expect(cap.missingTools).toContain('macOS Accessibility / System Events Permission');
      expect(cap.reason).toContain('Accessibility permissions (AXIsProcessTrusted / AppleEvents) not granted');
    });

    it('macOS: reports BLOCKED when osascript is missing', async () => {
      const mockExecutor: CommandExecutor = async (cmd, args) => {
        if (cmd === 'which' && args[0] === 'osascript') {
          return { stdout: '', stderr: 'osascript not found', exitCode: 1 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const detector = new PlatformCapabilityDetector({
        platform: 'darwin',
        commandExecutor: mockExecutor,
      });

      const cap = await detector.detectNativeDesktopCapability();
      expect(cap.state).toBe('BLOCKED');
      expect(cap.missingTools).toContain('osascript');
    });

    it('macOS: reports AVAILABLE when osascript and System Events succeed', async () => {
      const mockExecutor: CommandExecutor = async (cmd, args) => {
        if (cmd === 'which') return { stdout: '/usr/bin/osascript', stderr: '', exitCode: 0 };
        if (cmd === 'osascript') return { stdout: 'Finder', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const detector = new PlatformCapabilityDetector({
        platform: 'darwin',
        commandExecutor: mockExecutor,
      });

      const cap = await detector.detectNativeDesktopCapability();
      expect(cap.state).toBe('AVAILABLE');
      expect(cap.missingTools).toHaveLength(0);
      expect(cap.metadata.activeApp).toBe('Finder');
    });

    it('Windows: reports BLOCKED when WinAppDriver port 4723 is closed', async () => {
      const detector = new PlatformCapabilityDetector({
        platform: 'win32',
        portProber: async () => false,
      });

      const cap = await detector.detectNativeDesktopCapability();
      expect(cap.state).toBe('BLOCKED');
      expect(cap.missingTools).toContain('WinAppDriver service');
      expect(cap.reason).toContain('WinAppDriver service is not reachable on 127.0.0.1:4723');
    });

    it('Windows: reports AVAILABLE when WinAppDriver is listening on port 4723', async () => {
      const detector = new PlatformCapabilityDetector({
        platform: 'win32',
        portProber: async () => true,
      });

      const cap = await detector.detectNativeDesktopCapability();
      expect(cap.state).toBe('AVAILABLE');
      expect(cap.missingTools).toHaveLength(0);
    });

    it('Linux: reports BLOCKED when xdotool is missing', async () => {
      const mockExecutor: CommandExecutor = async (cmd, args) => {
        if (args[0] === 'xdotool') return { stdout: '', stderr: '', exitCode: 1 };
        if (args[0] === 'wmctrl') return { stdout: '/usr/bin/wmctrl', stderr: '', exitCode: 0 };
        return { stdout: '', stderr: '', exitCode: 0 };
      };

      const detector = new PlatformCapabilityDetector({
        platform: 'linux',
        commandExecutor: mockExecutor,
      });

      const cap = await detector.detectNativeDesktopCapability();
      expect(cap.state).toBe('BLOCKED');
      expect(cap.missingTools).toContain('xdotool');
    });

    it('Linux: reports BLOCKED when DISPLAY environment is unset', async () => {
      const origDisplay = process.env.DISPLAY;
      const origWayland = process.env.WAYLAND_DISPLAY;
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;

      try {
        const mockExecutor: CommandExecutor = async () => ({ stdout: '/usr/bin/tool', stderr: '', exitCode: 0 });
        const detector = new PlatformCapabilityDetector({
          platform: 'linux',
          commandExecutor: mockExecutor,
        });

        const cap = await detector.detectNativeDesktopCapability();
        expect(cap.state).toBe('BLOCKED');
        expect(cap.missingTools).toContain('DISPLAY environment variable');
      } finally {
        if (origDisplay) process.env.DISPLAY = origDisplay;
        if (origWayland) process.env.WAYLAND_DISPLAY = origWayland;
      }
    });

    it('Reports UNSUPPORTED for unsupported operating systems', async () => {
      const detector = new PlatformCapabilityDetector({
        platform: 'freebsd',
      });
      const cap = await detector.detectNativeDesktopCapability();
      expect(cap.state).toBe('UNSUPPORTED');
    });

    it('Electron: probes cdpEndpoint port accurately', async () => {
      let probedPort = 0;
      const detector = new PlatformCapabilityDetector({
        portProber: async (port) => {
          probedPort = port;
          return true;
        },
      });

      const cap = await detector.detectElectronCapability(9222, undefined, 'http://127.0.0.1:9444');
      expect(probedPort).toBe(9444);
      expect(cap.state).toBe('AVAILABLE');
      expect(cap.metadata.cdpPort).toBe(9444);
    });

    it('Auto-detect does NOT mask missing Electron appPath as native AVAILABLE', async () => {
      const adapter = new DesktopAdapter({
        targetType: 'auto',
        appPath: '/path/to/nonexistent/electron/binary',
        portProber: async () => false,
      });

      const cap = await adapter.getCapability();
      expect(cap.state).toBe('BLOCKED');
      expect(cap.reason).toContain('Electron executable not found');
    });
  });

  // ==========================================================================
  // 2. Game Engine Testing Integration Boundaries
  // ==========================================================================
  describe('Game Engine Testing Boundaries', () => {
    it('Unity AltTester: reports BLOCKED with explicit missing instrumentation when port 13000 is closed', async () => {
      const unityAdapter = new UnityAltTesterAdapter({
        portProber: async () => false,
      });

      const result = await unityAdapter.checkHooks();
      expect(result.state).toBe('BLOCKED');
      expect(result.missingRequirements).toContain('AltTester SDK (com.alttester.alttester)');
      expect(result.missingRequirements).toContain('AltServer listening on port 13000');
      expect(result.remediationGuide).toContain('Add "com.alttester.alttester" to Packages/manifest.json');

      await expect(unityAdapter.connect()).rejects.toThrow(QABlockedError);
    });

    it('Unity AltTester: connects successfully and evaluates actions/assertions truthfully', async () => {
      const unityAdapter = new UnityAltTesterAdapter({
        portProber: async () => true,
      });

      await unityAdapter.connect();
      expect(unityAdapter.isConnected()).toBe(true);

      // 1. Click existing game object
      const clickRes = await unityAdapter.executeAction(
        makeAction({
          type: 'click',
          target: '/Canvas/StartButton',
        })
      );
      expect(clickRes.success).toBe(true);
      expect(clickRes.output.engine).toBe('unity');

      // 2. Click missing game object should fail
      const clickMissing = await unityAdapter.executeAction(
        makeAction({
          type: 'click',
          target: '/Canvas/NonExistentButton',
        })
      );
      expect(clickMissing.success).toBe(false);
      expect(clickMissing.error).toContain('GameObject not found in Unity scene');

      // 3. Assertion: visible element passes
      const visiblePass = await unityAdapter.executeAssertion(
        makeAssertion({
          type: 'elementVisible',
          target: '/Canvas/StartButton',
          expected: true,
        })
      );
      expect(visiblePass.passed).toBe(true);

      // 4. Assertion: missing element expected visible fails truthfully
      const visibleFail = await unityAdapter.executeAssertion(
        makeAssertion({
          type: 'elementVisible',
          target: 'NonExistentObject',
          expected: true,
        })
      );
      expect(visibleFail.passed).toBe(false);
      expect(visibleFail.actual).toBe(false);

      // 5. Assertion: text equality
      const textPass = await unityAdapter.executeAssertion(
        makeAssertion({
          type: 'elementTextEquals',
          target: '/Canvas/ScoreText',
          expected: 'Score: 0',
        })
      );
      expect(textPass.passed).toBe(true);

      // 6. Assertion: text mismatch fails truthfully
      const textFail = await unityAdapter.executeAssertion(
        makeAssertion({
          type: 'elementTextEquals',
          target: '/Canvas/ScoreText',
          expected: 'Score: 9999',
        })
      );
      expect(textFail.passed).toBe(false);

      await unityAdapter.disconnect();
      expect(unityAdapter.isConnected()).toBe(false);
    });

    it('Unreal Automation: reports BLOCKED with explicit remediation when port 30010 is closed', async () => {
      const unrealAdapter = new UnrealAutomationAdapter({
        portProber: async () => false,
      });

      const result = await unrealAdapter.checkHooks();
      expect(result.state).toBe('BLOCKED');
      expect(result.missingRequirements).toContain('Unreal Engine Remote Control API plugin');
      expect(result.remediationGuide).toContain(
        'In Unreal Editor, navigate to Edit > Plugins and enable "Remote Control API"'
      );

      await expect(unrealAdapter.connect()).rejects.toThrow(QABlockedError);
    });

    it('Unreal Automation: connects and evaluates actions/assertions truthfully', async () => {
      const unrealAdapter = new UnrealAutomationAdapter({
        portProber: async () => true,
      });

      await unrealAdapter.connect();
      expect(unrealAdapter.isConnected()).toBe(true);

      // 1. Click existing actor
      const clickRes = await unrealAdapter.executeAction(
        makeAction({
          type: 'click',
          target: 'Actor_MainDoor',
        })
      );
      expect(clickRes.success).toBe(true);
      expect(clickRes.output.engine).toBe('unreal');

      // 2. Click missing actor fails
      const clickMissing = await unrealAdapter.executeAction(
        makeAction({
          type: 'click',
          target: 'MissingActor_Boss',
        })
      );
      expect(clickMissing.success).toBe(false);
      expect(clickMissing.error).toContain('Actor not found in Unreal world');

      // 3. Assertion: visible actor
      const visiblePass = await unrealAdapter.executeAssertion(
        makeAssertion({
          type: 'elementVisible',
          target: 'Actor_MainDoor',
          expected: true,
        })
      );
      expect(visiblePass.passed).toBe(true);

      // 4. Assertion: missing actor expected visible fails
      const visibleFail = await unrealAdapter.executeAssertion(
        makeAssertion({
          type: 'elementVisible',
          target: 'MissingActor_Boss',
          expected: true,
        })
      );
      expect(visibleFail.passed).toBe(false);

      await unrealAdapter.disconnect();
    });

    it('Unsupported game engine reports UNSUPPORTED and throws QAUnsupportedError', async () => {
      const customAdapter = createGameEngineAdapter('godot' as any);
      const result = await customAdapter.checkHooks();
      expect(result.state).toBe('UNSUPPORTED');
      expect(result.reason).toContain("Game engine 'godot' is not natively supported");

      await expect(customAdapter.connect()).rejects.toThrow(QAUnsupportedError);
    });

    it('DesktopAdapter transparently exposes game capability and blocks execution truthfully', async () => {
      const adapter = new DesktopAdapter({
        targetType: 'game',
        gameEngine: 'unity',
        portProber: async () => false,
      });

      const cap = await adapter.getCapability();
      expect(cap.state).toBe('BLOCKED');
      expect(cap.platform).toBe('game');
      expect(cap.missingTools).toContain('AltTester SDK (com.alttester.alttester)');

      await expect(adapter.initialize()).rejects.toThrow(QABlockedError);
    });
  });

  // ==========================================================================
  // 3. Electron App Testing Path & Actions/Assertions
  // ==========================================================================
  describe('Electron Testing Path & Actions/Assertions', () => {
    let adapter: DesktopAdapter;
    let mockCDP: MockCDPClient;

    beforeEach(async () => {
      mockCDP = new MockCDPClient();
      adapter = new DesktopAdapter({
        targetType: 'electron',
        outputDir: testOutputDir,
        portProber: async () => true,
      });
      adapter.setMockCDPClient(mockCDP);
      await adapter.initialize({ mockCdpClient: mockCDP });
    });

    afterEach(async () => {
      await adapter.teardown();
    });

    it('executes click action via selector and coordinates', async () => {
      // 1. Selector click
      const actionSel = makeAction({
        type: 'click',
        target: '#submit-btn',
      });
      const resultSel = await adapter.executeAction(actionSel);
      expect(resultSel.success).toBe(true);
      expect(resultSel.output.clicked).toBe(true);

      // 2. Coordinate string click
      const actionCoord = makeAction({
        type: 'click',
        target: '@150,250',
      });
      const resultCoord = await adapter.executeAction(actionCoord);
      expect(resultCoord.success).toBe(true);
    });

    it('executes doubleClick action', async () => {
      const action = makeAction({
        type: 'doubleClick',
        target: '#submit-btn',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
      expect(result.output.doubleClicked).toBe(true);
    });

    it('fails click action gracefully when element does not exist', async () => {
      const action = makeAction({
        type: 'click',
        target: '#non-existent-btn',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Element not found');
    });

    it('executes fill and clear actions', async () => {
      // Fill
      const fillAction = makeAction({
        type: 'fill',
        target: '#username-input',
        value: 'qa-tester-bot',
      });
      const fillRes = await adapter.executeAction(fillAction);
      expect(fillRes.success).toBe(true);
      expect(fillRes.output.filled).toBe(true);

      // Clear
      const clearAction = makeAction({
        type: 'clear',
        target: '#username-input',
      });
      const clearRes = await adapter.executeAction(clearAction);
      expect(clearRes.success).toBe(true);
      expect(clearRes.output.cleared).toBe(true);
    });

    it('executes pressKey action via CDP', async () => {
      const action = makeAction({
        type: 'pressKey',
        value: 'Enter',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
      expect(result.output.pressed).toBe(true);
    });

    it('executes wait action with selector, times out on hidden element', async () => {
      // 1. Wait on visible element passes
      const passAction = makeAction({
        type: 'wait',
        target: '#app',
        value: 100,
      });
      const passRes = await adapter.executeAction(passAction);
      expect(passRes.success).toBe(true);

      // 2. Wait on hidden element times out
      const failAction = makeAction({
        type: 'wait',
        target: '.hidden-dialog',
        value: 50,
      });
      const failRes = await adapter.executeAction(failAction);
      expect(failRes.success).toBe(false);
      expect(failRes.error).toContain('did not appear within');
    });

    it('executes snapshot action and generates valid EvidenceArtifact', async () => {
      const action = makeAction({
        type: 'snapshot',
        description: 'Verification screenshot',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
      expect(result.output.evidenceId).toBeDefined();

      const evidence = await adapter.captureEvidence('SCREENSHOT', 'Manual screenshot');
      expect(evidence.id).toBeDefined();
      expect(evidence.type).toBe('SCREENSHOT');
      expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(evidence.sizeBytes).toBeGreaterThan(0);
      expect(fs.existsSync(evidence.path)).toBe(true);
    });

    it('captures DOM_SNAPSHOT and SYSTEM_LOG evidence correctly', async () => {
      // DOM Snapshot
      const domEv = await adapter.captureEvidence('DOM_SNAPSHOT', 'Page DOM');
      expect(domEv.type).toBe('DOM_SNAPSHOT');
      expect(domEv.mimeType).toBe('text/html');
      expect(fs.existsSync(domEv.path)).toBe(true);
      const domContent = fs.readFileSync(domEv.path, 'utf-8');
      expect(domContent).toContain('Welcome to Electron App');

      // System Log
      const sysEv = await adapter.captureEvidence('SYSTEM_LOG', 'System dump');
      expect(sysEv.type).toBe('SYSTEM_LOG');
      expect(sysEv.mimeType).toBe('application/json');
      expect(fs.existsSync(sysEv.path)).toBe(true);
      const sysContent = JSON.parse(fs.readFileSync(sysEv.path, 'utf-8'));
      expect(sysContent.platform).toBeDefined();
      expect(sysContent.crashInfo).toBeDefined();
    });

    it('handles navigate and evaluate actions', async () => {
      // Navigate
      const navAction = makeAction({
        type: 'navigate',
        value: 'file:///app/settings.html',
      });
      const navRes = await adapter.executeAction(navAction);
      expect(navRes.success).toBe(true);
      expect(navRes.output.navigatedTo).toBe('file:///app/settings.html');

      // Evaluate
      const evalAction = makeAction({
        type: 'evaluate',
        value: 'document.title',
      });
      const evalRes = await adapter.executeAction(evalAction);
      expect(evalRes.success).toBe(true);
      expect(evalRes.output.result).toBe('Electron Test Window');
    });

    it('evaluates elementVisible and elementHidden assertions', async () => {
      // Visible
      const vPass = await adapter.executeAssertion(
        makeAssertion({ type: 'elementVisible', target: '#app', expected: true })
      );
      expect(vPass.passed).toBe(true);

      const vFail = await adapter.executeAssertion(
        makeAssertion({ type: 'elementVisible', target: '.hidden-dialog', expected: true })
      );
      expect(vFail.passed).toBe(false);

      // Hidden
      const hPass = await adapter.executeAssertion(
        makeAssertion({ type: 'elementHidden', target: '.hidden-dialog', expected: true })
      );
      expect(hPass.passed).toBe(true);

      const hFail = await adapter.executeAssertion(
        makeAssertion({ type: 'elementHidden', target: '#app', expected: true })
      );
      expect(hFail.passed).toBe(false);
    });

    it('evaluates elementDisabled and elementEnabled assertions', async () => {
      // Disabled
      const dPass = await adapter.executeAssertion(
        makeAssertion({ type: 'elementDisabled', target: '#disabled-btn', expected: true })
      );
      expect(dPass.passed).toBe(true);

      // Enabled
      const ePass = await adapter.executeAssertion(
        makeAssertion({ type: 'elementEnabled', target: '#submit-btn', expected: true })
      );
      expect(ePass.passed).toBe(true);
    });

    it('evaluates elementTextEquals and elementTextContains assertions', async () => {
      const tEq = await adapter.executeAssertion(
        makeAssertion({ type: 'elementTextEquals', target: '#submit-btn', expected: 'Submit' })
      );
      expect(tEq.passed).toBe(true);

      const tContains = await adapter.executeAssertion(
        makeAssertion({ type: 'elementTextContains', target: '#app', expected: 'Electron' })
      );
      expect(tContains.passed).toBe(true);
    });

    it('evaluates titleMatches with string, regex with flags, and RegExp objects', async () => {
      // 1. Substring match
      const subMatch = makeAssertion({
        type: 'titleMatches',
        expected: 'Electron Test',
      });
      const res1 = await adapter.executeAssertion(subMatch);
      expect(res1.passed).toBe(true);

      // 2. Regex string with flags
      const regexFlagMatch = makeAssertion({
        type: 'titleMatches',
        expected: '/electron.*window/i',
      });
      const res2 = await adapter.executeAssertion(regexFlagMatch);
      expect(res2.passed).toBe(true);

      // 3. RegExp object
      const regexObj = makeAssertion({
        type: 'titleMatches',
        expected: new RegExp('^Electron', 'i'),
      });
      const res3 = await adapter.executeAssertion(regexObj);
      expect(res3.passed).toBe(true);

      // 4. Mismatch
      const mismatch = makeAssertion({
        type: 'titleMatches',
        expected: 'Different App Title',
      });
      const res4 = await adapter.executeAssertion(mismatch);
      expect(res4.passed).toBe(false);
    });

    it('truthfully fails unsupported assertions instead of rubber-stamping true', async () => {
      const unsupported = makeAssertion({
        type: 'custom',
        target: 'nonExistentAssertionKind',
        expected: 'someValue',
      });
      // Test when custom has no handler
      const res = await adapter.executeAssertion(
        makeAssertion({
          type: 'status200' as any,
          expected: true,
        })
      );
      expect(res.passed).toBe(false);
      expect(res.message).toContain('Unsupported assertion type');
    });
  });

  // ==========================================================================
  // 4. Window Management & Crash Detection
  // ==========================================================================
  describe('Window Management & Crash Detection', () => {
    it('manages window resize, focus, and close', async () => {
      const mockCDP = new MockCDPClient();
      await mockCDP.connect();

      const wm = new WindowManager({
        appName: 'TestElectronApp',
        cdpClient: mockCDP,
      });

      // Resize
      await wm.resize(1920, 1080);
      expect(wm.getBounds()).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
      expect(mockCDP.windowBounds.width).toBe(1920);

      // Focus
      await expect(wm.focus()).resolves.not.toThrow();

      // Close
      await expect(wm.close()).resolves.not.toThrow();
      expect(mockCDP.isConnected()).toBe(false);

      // Intentional close should NOT flag crash
      expect(wm.checkCrash().crashed).toBe(false);
    });

    it('rejects invalid window dimensions in resize', async () => {
      const wm = new WindowManager();
      await expect(wm.resize(-500, 800)).rejects.toThrow(QAAdapterError);
      await expect(wm.resize(1024, 0)).rejects.toThrow(QAAdapterError);
    });

    it('detects crash and halts actions immediately', async () => {
      const mockCDP = new MockCDPClient();
      const adapter = new DesktopAdapter({
        targetType: 'electron',
        outputDir: testOutputDir,
        portProber: async () => true,
      });
      adapter.setMockCDPClient(mockCDP);
      await adapter.initialize({ mockCdpClient: mockCDP });

      // Before crash
      expect(adapter.checkCrash().crashed).toBe(false);

      // Simulate crash on window manager
      adapter.getWindowManager().simulateCrash(139, 'SIGSEGV');

      const crashInfo = adapter.checkCrash();
      expect(crashInfo.crashed).toBe(true);
      expect(crashInfo.exitCode).toBe(139);
      expect(crashInfo.signal).toBe('SIGSEGV');

      // Subsequent actions must fail fast
      const actionSpec = makeAction({ type: 'click', target: '#btn' });
      await expect(adapter.executeAction(actionSpec)).rejects.toThrow(QAAdapterError);

      // Subsequent assertions must report failure with crash diagnosis
      const assertionSpec = makeAssertion({ type: 'elementVisible', target: '#app' });
      const assertionResult = await adapter.executeAssertion(assertionSpec);
      expect(assertionResult.passed).toBe(false);
      expect(assertionResult.actual).toBe('CRASHED');
      expect(assertionResult.message).toContain('application crashed');

      await adapter.teardown();
    });

    it('CDP crash event triggers crash handling in adapter', async () => {
      const mockCDP = new MockCDPClient();
      const adapter = new DesktopAdapter({
        targetType: 'electron',
        outputDir: testOutputDir,
        portProber: async () => true,
      });
      adapter.setMockCDPClient(mockCDP);
      await adapter.initialize({ mockCdpClient: mockCDP });

      // Trigger CDP crash
      mockCDP.triggerCrash('Chromium render process terminated unexpectedly');

      const crash = adapter.checkCrash();
      expect(crash.crashed).toBe(true);
      expect(crash.reason).toContain('Chromium render process terminated unexpectedly');

      await adapter.teardown();
    });
  });

  // ==========================================================================
  // 5. Integration with RunLifecycle & CapabilityRegistry
  // ==========================================================================
  describe('RunLifecycle & Registry Integration', () => {
    it('registers DesktopAdapter in CapabilityRegistry and resolves capability for desktop and game', async () => {
      const registry = new CapabilityRegistry();
      const desktopAdapter = new DesktopAdapter({
        targetType: 'electron',
        portProber: async () => true,
      });
      const gameAdapter = new DesktopAdapter({
        id: 'adapter-game-unity',
        targetType: 'game',
        gameEngine: 'unity',
        platform: 'game',
        portProber: async () => true,
      });

      registry.registerAdapter(desktopAdapter);
      registry.registerAdapter(gameAdapter);

      const caps = await registry.probeAllCapabilities();
      expect(caps.some((c) => c.platform === 'desktop')).toBe(true);
      expect(caps.some((c) => c.platform === 'game')).toBe(true);

      const resolvedDesktop = await registry.resolveAdapterForTarget('desktop');
      expect(resolvedDesktop.id).toBe('adapter-desktop');

      const resolvedGame = await registry.resolveAdapterForTarget('game');
      expect(resolvedGame.id).toBe('adapter-game-unity');
    });

    it('executes full desktop test scenario via RunLifecycle', async () => {
      const mockCDP = new MockCDPClient();
      const adapter = new DesktopAdapter({
        targetType: 'electron',
        outputDir: testOutputDir,
        portProber: async () => true,
      });
      adapter.setMockCDPClient(mockCDP);

      const testPlan: TestPlan = {
        planId: 'plan-desktop-smoke',
        name: 'Electron App Smoke Test',
        targetApp: 'MyElectronApp',
        platform: 'desktop',
        environment: 'local',
        createdAt: new Date().toISOString(),
        metadata: {},
        scenarios: [
          {
            id: 'desktop-scenario-1',
            title: 'Verify main window and button click',
            description: 'Smoke test for desktop Electron app',
            platform: 'desktop',
            timeoutMs: 10000,
            retries: 0,
            tags: ['smoke'],
            expectedOutcome: 'PASS',
            steps: [
              {
                id: 'step-1',
                description: 'Verify title matches',
                continueOnFailure: false,
                assertion: makeAssertion({
                  type: 'titleMatches',
                  expected: 'Electron Test Window',
                }),
              },
              {
                id: 'step-2',
                description: 'Click submit button',
                continueOnFailure: false,
                action: makeAction({
                  type: 'click',
                  target: '#submit-btn',
                }),
              },
              {
                id: 'step-3',
                description: 'Verify app element is visible',
                continueOnFailure: false,
                assertion: makeAssertion({
                  type: 'elementVisible',
                  target: '#app',
                  expected: true,
                }),
              },
              {
                id: 'step-4',
                description: 'Capture screenshot snapshot',
                continueOnFailure: false,
                action: makeAction({
                  type: 'snapshot',
                  description: 'End of test snapshot',
                }),
              },
            ],
          },
        ],
      };

      const caps = [await adapter.getCapability()];
      const lifecycle = new RunLifecycle(adapter, testPlan, caps);
      const report = await lifecycle.execute();

      expect(report.overallStatus).toBe('PASSED');
      expect(report.summary.passed).toBe(1);
      expect(report.summary.failed).toBe(0);
      expect(report.findings).toHaveLength(0);
      expect(report.trustScore.score).toBeGreaterThan(0);

      await adapter.teardown();
    });
  });

  // ==========================================================================
  // 6. Edge Cases & Boundary Conditions
  // ==========================================================================
  describe('Edge Cases & Boundary Conditions', () => {
    it('throws QAAdapterError when executing actions on uninitialized adapter', async () => {
      const adapter = new DesktopAdapter();
      const action = makeAction({ type: 'click', target: '#btn' });
      await expect(adapter.executeAction(action)).rejects.toThrow(QAAdapterError);
    });

    it('throws QAAdapterError when evaluating assertions on uninitialized adapter', async () => {
      const adapter = new DesktopAdapter();
      const assertion = makeAssertion({ type: 'elementVisible', target: '#app' });
      await expect(adapter.executeAssertion(assertion)).rejects.toThrow(QAAdapterError);
    });

    it('throws QAAdapterError when capturing evidence on uninitialized adapter', async () => {
      const adapter = new DesktopAdapter();
      await expect(adapter.captureEvidence('SCREENSHOT')).rejects.toThrow(QAAdapterError);
    });

    it('handles rapidClicks action with numeric value and { count: 5 } object value', async () => {
      const mockCDP = new MockCDPClient();
      const adapter = new DesktopAdapter({ targetType: 'electron', outputDir: testOutputDir });
      adapter.setMockCDPClient(mockCDP);
      await adapter.initialize({ mockCdpClient: mockCDP });

      // Numeric value
      const rapidNumeric = makeAction({
        type: 'rapidClicks',
        target: '#submit-btn',
        value: 20,
      });
      const res1 = await adapter.executeAction(rapidNumeric);
      expect(res1.success).toBe(true);
      expect(res1.output.rapidClicks).toBe(20);

      // Object value: { count: 5 }
      const rapidObj = makeAction({
        type: 'rapidClicks',
        target: '#submit-btn',
        value: { count: 5 },
      });
      const res2 = await adapter.executeAction(rapidObj);
      expect(res2.success).toBe(true);
      expect(res2.output.rapidClicks).toBe(5);

      await adapter.teardown();
    });

    it('executes custom window actions (resize, focus, close, crashCheck)', async () => {
      const mockCDP = new MockCDPClient();
      const adapter = new DesktopAdapter({ targetType: 'electron', outputDir: testOutputDir });
      adapter.setMockCDPClient(mockCDP);
      await adapter.initialize({ mockCdpClient: mockCDP });

      // Resize
      const resizeAction = makeAction({
        type: 'custom',
        target: 'window:resize',
        value: { width: 800, height: 600 },
      });
      const resizeRes = await adapter.executeAction(resizeAction);
      expect(resizeRes.success).toBe(true);
      expect(resizeRes.output.resized).toBe(true);

      // Focus
      const focusAction = makeAction({
        type: 'custom',
        target: 'window:focus',
      });
      const focusRes = await adapter.executeAction(focusAction);
      expect(focusRes.success).toBe(true);
      expect(focusRes.output.focused).toBe(true);

      // Crash check
      const checkAction = makeAction({
        type: 'custom',
        target: 'window:crashCheck',
      });
      const checkRes = await adapter.executeAction(checkAction);
      expect(checkRes.success).toBe(true);
      expect(checkRes.output.crashed).toBe(false);

      // Close
      const closeAction = makeAction({
        type: 'custom',
        target: 'window:close',
      });
      const closeRes = await adapter.executeAction(closeAction);
      expect(closeRes.success).toBe(true);

      await adapter.teardown();
    });

    it('teardown is idempotent and safe when called repeatedly', async () => {
      const adapter = new DesktopAdapter({ targetType: 'electron' });
      await adapter.teardown();
      await adapter.teardown();
      expect(true).toBe(true);
    });

    it('supports custom port configuration for Unity and Unreal adapters', async () => {
      const unityCustom = new UnityAltTesterAdapter({
        port: 14500,
        portProber: async (port) => port === 14500,
      });
      const unityHooks = await unityCustom.checkHooks();
      expect(unityHooks.state).toBe('AVAILABLE');
      expect(unityHooks.port).toBe(14500);

      const unrealCustom = new UnrealAutomationAdapter({
        port: 39999,
        portProber: async (port) => port === 39999,
      });
      const unrealHooks = await unrealCustom.checkHooks();
      expect(unrealHooks.state).toBe('AVAILABLE');
      expect(unrealHooks.port).toBe(39999);
    });
  });
});
