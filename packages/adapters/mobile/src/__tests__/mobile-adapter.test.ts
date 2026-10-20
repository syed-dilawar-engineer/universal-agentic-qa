import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  QABlockedError,
  QAUnsupportedError,
  RunLifecycle,
} from '@agentic-qa/core';
import { TestPlan } from '@agentic-qa/schemas';
import {
  MobileAdapter,
  AndroidAdapter,
  IosAdapter,
  MaestroAdapter,
  AppiumAdapter,
  MockCommandExecutor,
  parseUIHierarchy,
  findElement,
  parseBounds,
} from '../index.js';

const SAMPLE_ANDROID_HIERARCHY_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example.myapp" bounds="[0,0][1080,2400]">
    <node index="0" text="Sign In" resource-id="com.example.myapp:id/btn_login" class="android.widget.Button" package="com.example.myapp" content-desc="Login button" enabled="true" clickable="true" visible-to-user="true" bounds="[100,500][500,600]" />
    <node index="1" text="Submit" resource-id="com.example.myapp:id/btn_disabled" class="android.widget.Button" package="com.example.myapp" content-desc="Submit button" enabled="false" clickable="false" visible-to-user="true" bounds="[100,700][500,800]" />
    <node index="2" text="Welcome to Antigravity QA" resource-id="com.example.myapp:id/tv_title" class="android.widget.TextView" package="com.example.myapp" content-desc="" enabled="true" clickable="false" visible-to-user="true" bounds="[100,200][980,300]" />
  </node>
</hierarchy>`;

describe('UI Hierarchy Parser', () => {
  it('parses XML bounds correctly', () => {
    const bounds = parseBounds('[100,200][500,600]');
    expect(bounds).toBeDefined();
    expect(bounds?.left).toBe(100);
    expect(bounds?.top).toBe(200);
    expect(bounds?.right).toBe(500);
    expect(bounds?.bottom).toBe(600);
    expect(bounds?.width).toBe(400);
    expect(bounds?.height).toBe(400);
    expect(bounds?.centerX).toBe(300);
    expect(bounds?.centerY).toBe(400);
  });

  it('parses UI elements from hierarchy XML', () => {
    const elements = parseUIHierarchy(SAMPLE_ANDROID_HIERARCHY_XML);
    expect(elements.length).toBeGreaterThan(0);

    const loginBtn = findElement(elements, 'id=btn_login');
    expect(loginBtn).toBeDefined();
    expect(loginBtn?.text).toBe('Sign In');
    expect(loginBtn?.enabled).toBe(true);
    expect(loginBtn?.bounds?.centerX).toBe(300);
    expect(loginBtn?.bounds?.centerY).toBe(550);

    const disabledBtn = findElement(elements, '#btn_disabled');
    expect(disabledBtn).toBeDefined();
    expect(disabledBtn?.enabled).toBe(false);

    const textEl = findElement(elements, 'text=Welcome to Antigravity QA');
    expect(textEl).toBeDefined();
    expect(textEl?.resourceId).toBe('com.example.myapp:id/tv_title');
  });

  it('resolves direct coordinate selectors', () => {
    const elements = parseUIHierarchy(SAMPLE_ANDROID_HIERARCHY_XML);
    const coordEl = findElement(elements, '450,850');
    expect(coordEl).toBeDefined();
    expect(coordEl?.bounds?.centerX).toBe(450);
    expect(coordEl?.bounds?.centerY).toBe(850);
  });
});

describe('AndroidAdapter - Truthful Diagnostics', () => {
  let mockExecutor: MockCommandExecutor;

  beforeEach(() => {
    mockExecutor = new MockCommandExecutor();
  });

  it('reports BLOCKED with exact instructions when adb is missing', async () => {
    mockExecutor.mockCommand('adb', 'version', '', 127, 'command not found: adb');
    const adapter = new AndroidAdapter({ executor: mockExecutor });

    const cap = await adapter.getCapability();
    expect(cap.state).toBe('BLOCKED');
    expect(cap.missingTools).toContain('adb');
    expect(cap.reason).toContain('Android SDK Platform-Tools');
    expect(cap.reason).toContain('brew install android-platform-tools');
    expect(cap.reason).toContain('apt-get install adb');
  });

  it('reports UNAVAILABLE when adb is installed but no devices are attached or online', async () => {
    mockExecutor.mockCommand('adb', 'version', 'Android Debug Bridge version 1.0.41\nVersion 34.0.5-10930072');
    mockExecutor.mockCommand('adb', 'devices -l', 'List of devices attached\n\n');

    const adapter = new AndroidAdapter({ executor: mockExecutor });
    const cap = await adapter.getCapability();

    expect(cap.state).toBe('UNAVAILABLE');
    expect(cap.missingTools).toHaveLength(0);
    expect(cap.version).toBe('1.0.41');
    expect(cap.reason).toContain('no connected Android device or emulator was detected');
  });

  it('reports AVAILABLE when adb is installed and an online device is detected', async () => {
    mockExecutor.mockCommand('adb', 'version', 'Android Debug Bridge version 1.0.41');
    mockExecutor.mockCommand(
      'adb',
      'devices -l',
      'List of devices attached\nemulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n'
    );

    const adapter = new AndroidAdapter({ executor: mockExecutor });
    const cap = await adapter.getCapability();

    expect(cap.state).toBe('AVAILABLE');
    expect(cap.missingTools).toHaveLength(0);
    expect(cap.metadata.activeDevice).toBe('emulator-5554');
    expect(cap.reason).toContain('Found 1 active Android device');
  });
});

describe('IosAdapter - Truthful Diagnostics', () => {
  let mockExecutor: MockCommandExecutor;

  beforeEach(() => {
    mockExecutor = new MockCommandExecutor();
  });

  it('reports UNSUPPORTED when running on non-macOS host', async () => {
    const adapter = new IosAdapter({
      executor: mockExecutor,
      hostPlatform: 'linux',
    });

    const cap = await adapter.getCapability();
    expect(cap.state).toBe('UNSUPPORTED');
    expect(cap.reason).toContain('only supported on macOS (darwin)');
    expect(cap.missingTools).toContain('xcrun');
  });

  it('reports BLOCKED on macOS when xcrun is missing', async () => {
    mockExecutor.mockCommand('xcrun', '--version', '', 1, 'xcode-select: error: tool not found');
    const adapter = new IosAdapter({
      executor: mockExecutor,
      hostPlatform: 'darwin',
    });

    const cap = await adapter.getCapability();
    expect(cap.state).toBe('BLOCKED');
    expect(cap.missingTools).toContain('xcrun');
    expect(cap.reason).toContain('xcode-select --install');
  });

  it('reports UNAVAILABLE on macOS when Xcode is installed but no simulator is booted', async () => {
    mockExecutor.mockCommand('xcrun', '--version', 'xcrun version 72');
    mockExecutor.mockCommand(
      'xcrun',
      'simctl list devices booted -j',
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
            { udid: '123-456', name: 'iPhone 15', state: 'Shutdown', isAvailable: true },
          ],
        },
      })
    );

    const adapter = new IosAdapter({
      executor: mockExecutor,
      hostPlatform: 'darwin',
    });

    const cap = await adapter.getCapability();
    expect(cap.state).toBe('UNAVAILABLE');
    expect(cap.missingTools).toHaveLength(0);
    expect(cap.reason).toContain('no booted iOS simulator was detected');
  });

  it('reports AVAILABLE on macOS when a simulator is booted', async () => {
    mockExecutor.mockCommand('xcrun', '--version', 'xcrun version 72');
    mockExecutor.mockCommand(
      'xcrun',
      'simctl list devices booted -j',
      JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-17-0': [
            { udid: 'SIM-BOOTED-001', name: 'iPhone 15 Pro', state: 'Booted', isAvailable: true },
          ],
        },
      })
    );

    const adapter = new IosAdapter({
      executor: mockExecutor,
      hostPlatform: 'darwin',
    });

    const cap = await adapter.getCapability();
    expect(cap.state).toBe('AVAILABLE');
    expect(cap.metadata.activeDevice).toBe('SIM-BOOTED-001');
  });
});

describe('Maestro & Appium Adapters - Truthful Diagnostics', () => {
  let mockExecutor: MockCommandExecutor;

  beforeEach(() => {
    mockExecutor = new MockCommandExecutor();
  });

  it('reports Maestro BLOCKED if maestro CLI is missing', async () => {
    mockExecutor.mockCommand('maestro', '--version', '', 127);
    const adapter = new MaestroAdapter({ executor: mockExecutor });
    const cap = await adapter.getCapability();
    expect(cap.state).toBe('BLOCKED');
    expect(cap.missingTools).toContain('maestro');
    expect(cap.reason).toContain('curl -fsSL https://get.maestro.mobile.dev');
  });

  it('reports Maestro AVAILABLE if CLI is installed and adb device is online', async () => {
    mockExecutor.mockCommand('maestro', '--version', '1.38.0');
    mockExecutor.mockCommand('adb', 'devices', 'List of devices attached\nemulator-5554\tdevice\n');

    const adapter = new MaestroAdapter({ executor: mockExecutor });
    const cap = await adapter.getCapability();
    expect(cap.state).toBe('AVAILABLE');
    expect(cap.version).toBe('1.38.0');
  });

  it('reports Appium BLOCKED if server is unreachable and CLI is missing', async () => {
    mockExecutor.mockHttp('http://127.0.0.1:4723/status', 0, 'Connection refused');
    mockExecutor.mockCommand('appium', '--version', '', 127);

    const adapter = new AppiumAdapter({
      executor: mockExecutor,
      appiumServerUrl: 'http://127.0.0.1:4723',
    });

    const cap = await adapter.getCapability();
    expect(cap.state).toBe('BLOCKED');
    expect(cap.missingTools).toContain('appium');
    expect(cap.reason).toContain('npm install -g appium');
  });

  it('reports Appium UNAVAILABLE if CLI is installed but server is offline', async () => {
    mockExecutor.mockHttp('http://127.0.0.1:4723/status', 0, 'Connection refused');
    mockExecutor.mockCommand('appium', '--version', '2.5.1');

    const adapter = new AppiumAdapter({
      executor: mockExecutor,
      appiumServerUrl: 'http://127.0.0.1:4723',
    });

    const cap = await adapter.getCapability();
    expect(cap.state).toBe('UNAVAILABLE');
    expect(cap.version).toBe('2.5.1');
    expect(cap.reason).toContain('Start the Appium server using "appium"');
  });

  it('reports Appium AVAILABLE if server is running and responds with 200', async () => {
    mockExecutor.mockHttp('http://127.0.0.1:4723/status', 200, {
      value: { ready: true, build: { version: '2.5.4' } },
    });

    const adapter = new AppiumAdapter({
      executor: mockExecutor,
      appiumServerUrl: 'http://127.0.0.1:4723',
    });

    const cap = await adapter.getCapability();
    expect(cap.state).toBe('AVAILABLE');
    expect(cap.version).toBe('2.5.4');
  });
});

describe('Honest Precondition Verification - APK / IPA Execution', () => {
  let mockExecutor: MockCommandExecutor;

  beforeEach(() => {
    mockExecutor = new MockCommandExecutor();
  });

  it('refuses to claim an APK can run when no Android device is available', async () => {
    mockExecutor.mockCommand('adb', 'version', 'Android Debug Bridge version 1.0.41');
    mockExecutor.mockCommand('adb', 'devices -l', 'List of devices attached\n\n');

    const adapter = new MobileAdapter({
      engine: 'android',
      executor: mockExecutor,
      appPath: '/path/to/my-release.apk',
    });

    await expect(adapter.initialize({ appPath: '/path/to/my-release.apk' })).rejects.toThrow(
      QABlockedError
    );
  });

  it('refuses to claim an IPA can run when no iOS simulator is booted', async () => {
    mockExecutor.mockCommand('xcrun', '--version', 'xcrun 72');
    mockExecutor.mockCommand('xcrun', 'simctl list devices booted -j', JSON.stringify({ devices: {} }));

    const adapter = new MobileAdapter({
      engine: 'ios',
      executor: mockExecutor,
      hostPlatform: 'darwin',
      appPath: '/path/to/my-app.ipa',
    });

    await expect(adapter.initialize({ appPath: '/path/to/my-app.ipa' })).rejects.toThrow(
      QABlockedError
    );
  });

  it('refuses to claim an IPA can run on non-macOS host', async () => {
    const adapter = new MobileAdapter({
      engine: 'ios',
      executor: mockExecutor,
      hostPlatform: 'linux',
      appPath: '/path/to/my-app.ipa',
    });

    await expect(adapter.initialize({ appPath: '/path/to/my-app.ipa' })).rejects.toThrow(
      QAUnsupportedError
    );
  });
});

describe('AndroidAdapter - Actions & Lifecycle', () => {
  let mockExecutor: MockCommandExecutor;
  let adapter: AndroidAdapter;

  beforeEach(() => {
    mockExecutor = new MockCommandExecutor();
    // Device available
    mockExecutor.mockCommand('adb', 'version', 'Android Debug Bridge version 1.0.41');
    mockExecutor.mockCommand('adb', 'devices -l', 'emulator-5554\tdevice model:Pixel_7\n');
    mockExecutor.mockCommand('adb', 'shell uiautomator dump', 'UI hierachy dumped to: /sdcard/window_dump.xml');
    mockExecutor.mockCommand('adb', 'shell cat /sdcard/window_dump.xml', SAMPLE_ANDROID_HIERARCHY_XML);

    adapter = new AndroidAdapter({
      deviceId: 'emulator-5554',
      packageName: 'com.example.myapp',
      activityName: '.MainActivity',
      executor: mockExecutor,
    });
  });

  it('executes coordinate tap action', async () => {
    mockExecutor.mockCommand('adb', 'shell input tap 300 550', '');

    const result = await adapter.executeAction({
      type: 'tap',
      target: '300,550',
      timeoutMs: 5000,
      metadata: {},
    });

    expect(result.success).toBe(true);
    expect(result.output.tappedCoordinates).toEqual({ x: 300, y: 550 });
  });

  it('executes selector tap by finding element bounds and tapping center', async () => {
    mockExecutor.mockCommand('adb', 'shell input tap 300 550', '');

    const result = await adapter.executeAction({
      type: 'tap',
      target: 'id=btn_login',
      timeoutMs: 5000,
      metadata: {},
    });

    expect(result.success).toBe(true);
    expect(result.output.tappedCoordinates).toEqual({ x: 300, y: 550 });
  });

  it('executes fill action by focusing element and typing formatted text', async () => {
    mockExecutor.mockCommand('adb', 'shell input tap 300 550', '');
    mockExecutor.mockCommand('adb', 'shell input text test@example.com', '');

    const result = await adapter.executeAction({
      type: 'fill',
      target: 'id=btn_login',
      value: 'test@example.com',
      timeoutMs: 5000,
      metadata: {},
    });

    expect(result.success).toBe(true);
    expect(result.output.filledText).toBe('test@example.com');
  });

  it('executes scroll down action', async () => {
    mockExecutor.mockCommand('adb', 'shell input swipe 500 1500 500 500 300', '');

    const result = await adapter.executeAction({
      type: 'scroll',
      value: 'down',
      timeoutMs: 5000,
      metadata: {},
    });

    expect(result.success).toBe(true);
    expect(result.output.direction).toBe('down');
  });

  it('executes pressKey action with mapped keycode', async () => {
    mockExecutor.mockCommand('adb', 'shell input keyevent 4', '');

    const result = await adapter.executeAction({
      type: 'pressKey',
      value: 'BACK',
      timeoutMs: 5000,
      metadata: {},
    });

    expect(result.success).toBe(true);
    expect(result.output.keycode).toBe(4);
  });

  it('executes wait action', async () => {
    const start = Date.now();
    const result = await adapter.executeAction({
      type: 'wait',
      value: 50,
      timeoutMs: 5000,
      metadata: {},
    });

    expect(result.success).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('executes rapidClicks for robustness testing and checks for crash/ANR', async () => {
    mockExecutor.mockCommand('adb', 'shell for i in $(seq 1 10)', '');
    mockExecutor.mockCommand('adb', 'logcat -d -b crash', '');

    const result = await adapter.executeAction({
      type: 'rapidClicks',
      target: '500,500',
      value: 10,
      timeoutMs: 5000,
      metadata: {},
    });

    expect(result.success).toBe(true);
    expect(result.output.clicksAttempted).toBe(10);
    expect(result.output.crashed).toBe(false);
  });

  it('executes lifecycle actions: launch, background, resume, terminate', async () => {
    mockExecutor.mockCommand('adb', 'shell am start -n com.example.myapp/.MainActivity', '');
    mockExecutor.mockCommand('adb', 'shell input keyevent 3', '');
    mockExecutor.mockCommand('adb', 'shell am force-stop com.example.myapp', '');

    await adapter.launchApp('com.example.myapp', '.MainActivity');
    await adapter.backgroundApp(10);
    await adapter.resumeApp('com.example.myapp', '.MainActivity');
    await adapter.terminateApp('com.example.myapp');

    const commandsExecuted = mockExecutor.calls.map((c) => `${c.command} ${c.args.join(' ')}`);
    expect(commandsExecuted.some((cmd) => cmd.includes('am start -n com.example.myapp/.MainActivity'))).toBe(true);
    expect(commandsExecuted.some((cmd) => cmd.includes('input keyevent 3'))).toBe(true);
    expect(commandsExecuted.some((cmd) => cmd.includes('am force-stop com.example.myapp'))).toBe(true);
  });
});

describe('AndroidAdapter - Assertions', () => {
  let mockExecutor: MockCommandExecutor;
  let adapter: AndroidAdapter;

  beforeEach(() => {
    mockExecutor = new MockCommandExecutor();
    mockExecutor.mockCommand('adb', 'shell uiautomator dump', '');
    mockExecutor.mockCommand('adb', 'shell cat /sdcard/window_dump.xml', SAMPLE_ANDROID_HIERARCHY_XML);

    adapter = new AndroidAdapter({
      deviceId: 'emulator-5554',
      executor: mockExecutor,
    });
  });

  it('evaluates elementVisible assertion (pass & fail)', async () => {
    const passResult = await adapter.executeAssertion({
      type: 'elementVisible',
      target: 'id=btn_login',
      critical: true,
      metadata: {},
    });
    expect(passResult.passed).toBe(true);

    const failResult = await adapter.executeAssertion({
      type: 'elementVisible',
      target: 'id=non_existent_element',
      critical: true,
      metadata: {},
    });
    expect(failResult.passed).toBe(false);
  });

  it('evaluates elementTextEquals assertion', async () => {
    const matchResult = await adapter.executeAssertion({
      type: 'elementTextEquals',
      target: 'id=tv_title',
      expected: 'Welcome to Antigravity QA',
      critical: true,
      metadata: {},
    });
    expect(matchResult.passed).toBe(true);

    const mismatchResult = await adapter.executeAssertion({
      type: 'elementTextEquals',
      target: 'id=tv_title',
      expected: 'Wrong Title',
      critical: true,
      metadata: {},
    });
    expect(mismatchResult.passed).toBe(false);
  });

  it('evaluates elementDisabled assertion', async () => {
    const disabledResult = await adapter.executeAssertion({
      type: 'elementDisabled',
      target: 'id=btn_disabled',
      critical: true,
      metadata: {},
    });
    expect(disabledResult.passed).toBe(true);

    const notDisabledResult = await adapter.executeAssertion({
      type: 'elementDisabled',
      target: 'id=btn_login',
      critical: true,
      metadata: {},
    });
    expect(notDisabledResult.passed).toBe(false);
  });
});

describe('Evidence Capture with SHA-256 Hashes', () => {
  let mockExecutor: MockCommandExecutor;
  let tempOutputDir: string;

  beforeEach(() => {
    mockExecutor = new MockCommandExecutor();
    tempOutputDir = path.resolve('.qa-output', 'test-evidence-' + Date.now());
  });

  it('captures Android binary screenshot and produces valid SHA-256 evidence artifact', async () => {
    const fakePng = Buffer.from('FAKE_PNG_BINARY_CONTENT_' + Math.random());
    mockExecutor.mockBinary('adb', 'exec-out screencap -p', fakePng);

    const adapter = new AndroidAdapter({
      deviceId: 'emulator-5554',
      outputDir: tempOutputDir,
      executor: mockExecutor,
    });

    const evidence = await adapter.captureEvidence('SCREENSHOT', 'Test screen capture');

    expect(evidence.type).toBe('SCREENSHOT');
    expect(evidence.mimeType).toBe('image/png');
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.sizeBytes).toBe(fakePng.length);
    expect(fs.existsSync(evidence.path)).toBe(true);

    // Verify SHA-256 authenticity
    const fileBytes = fs.readFileSync(evidence.path);
    const calculatedHash = require('crypto').createHash('sha256').update(fileBytes).digest('hex');
    expect(evidence.sha256).toBe(calculatedHash);

    // Cleanup
    fs.rmSync(tempOutputDir, { recursive: true, force: true });
  });

  it('captures Android logcat output with SHA-256', async () => {
    mockExecutor.mockCommand('adb', 'logcat -d -t 500', '10-20 12:00:00.000 D/MyApp: Activity started');

    const adapter = new AndroidAdapter({
      deviceId: 'emulator-5554',
      outputDir: tempOutputDir,
      executor: mockExecutor,
    });

    const evidence = await adapter.captureEvidence('SYSTEM_LOG', 'Logcat dump');
    expect(evidence.type).toBe('SYSTEM_LOG');
    expect(evidence.mimeType).toBe('text/plain');
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.existsSync(evidence.path)).toBe(true);

    // Cleanup
    fs.rmSync(tempOutputDir, { recursive: true, force: true });
  });

  it('captures crash evidence when crash occurs', async () => {
    mockExecutor.mockCommand('adb', 'logcat -d -b crash', 'FATAL EXCEPTION: main\njava.lang.NullPointerException');
    mockExecutor.mockCommand('adb', 'shell dumpsys dropbox --print', 'DROPBOX_ENTRY_CRASH');

    const adapter = new AndroidAdapter({
      deviceId: 'emulator-5554',
      outputDir: tempOutputDir,
      executor: mockExecutor,
    });

    const evidence = await adapter.captureEvidence('CRASH_EVIDENCE');
    expect(evidence.type).toBe('SYSTEM_LOG');
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.metadata.hasCrash).toBe(true);

    // Cleanup
    fs.rmSync(tempOutputDir, { recursive: true, force: true });
  });
});

describe('Unified MobileAdapter & RunLifecycle Execution', () => {
  let mockExecutor: MockCommandExecutor;

  beforeEach(() => {
    mockExecutor = new MockCommandExecutor();
    // Android device online
    mockExecutor.mockCommand('adb', 'version', 'Android Debug Bridge version 1.0.41');
    mockExecutor.mockCommand('adb', 'devices -l', 'emulator-5554\tdevice model:Pixel_7\n');
    mockExecutor.mockCommand('adb', 'shell uiautomator dump', '');
    mockExecutor.mockCommand('adb', 'shell cat /sdcard/window_dump.xml', SAMPLE_ANDROID_HIERARCHY_XML);
    mockExecutor.mockCommand('adb', 'shell input tap 300 550', '');
    mockExecutor.mockBinary('adb', 'exec-out screencap -p', Buffer.from('PNG_BYTES'));
  });

  it('executes a mobile test plan end-to-end through RunLifecycle', async () => {
    const adapter = new MobileAdapter({
      engine: 'android',
      deviceId: 'emulator-5554',
      executor: mockExecutor,
    });

    const plan: TestPlan = {
      planId: 'plan-mobile-01',
      name: 'Mobile Login Verification',
      targetApp: 'com.example.myapp',
      platform: 'mobile',
      environment: 'emulator',
      createdAt: new Date().toISOString(),
      metadata: {},
      scenarios: [
        {
          id: 'TC-MOB-01',
          title: 'Verify Login Button Exists and is Tappable',
          description: 'Verify login button exists and is tappable',
          platform: 'mobile',
          timeoutMs: 30000,
          retries: 0,
          tags: ['mobile', 'smoke'],
          expectedOutcome: 'PASS',
          steps: [
            {
              id: 'step-1',
              description: 'Verify login button is visible',
              assertion: {
                type: 'elementVisible',
                target: 'id=btn_login',
                critical: true,
                metadata: {},
              },
              continueOnFailure: false,
            },
            {
              id: 'step-2',
              description: 'Tap login button',
              action: {
                type: 'tap',
                target: 'id=btn_login',
                timeoutMs: 5000,
                metadata: {},
              },
              continueOnFailure: false,
            },
          ],
        },
      ],
    };

    const cap = await adapter.getCapability();
    const lifecycle = new RunLifecycle(adapter, plan, [cap]);
    const report = await lifecycle.execute();

    expect(report.overallStatus).toBe('PASSED');
    expect(report.summary.passed).toBe(1);
    expect(report.summary.failed).toBe(0);
    expect(report.testResults[0].stepResults).toHaveLength(2);
    expect(report.testResults[0].stepResults[0].status).toBe('PASSED');
    expect(report.testResults[0].stepResults[1].status).toBe('PASSED');
  });
});
