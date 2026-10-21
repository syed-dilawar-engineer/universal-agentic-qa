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

  it('parses iOS and Appium rect bounds correctly', () => {
    const objBounds = parseBounds({ x: 20, y: 50, width: 200, height: 100 });
    expect(objBounds).toBeDefined();
    expect(objBounds?.left).toBe(20);
    expect(objBounds?.top).toBe(50);
    expect(objBounds?.right).toBe(220);
    expect(objBounds?.bottom).toBe(150);
    expect(objBounds?.centerX).toBe(120);
    expect(objBounds?.centerY).toBe(100);

    const strBounds = parseBounds('x="30" y="40" width="100" height="60"');
    expect(strBounds).toBeDefined();
    expect(strBounds?.left).toBe(30);
    expect(strBounds?.top).toBe(40);
    expect(strBounds?.right).toBe(130);
    expect(strBounds?.bottom).toBe(100);

    const dictBounds = parseBounds(undefined, { x: '10', y: '20', width: '80', height: '40' });
    expect(dictBounds).toBeDefined();
    expect(dictBounds?.centerX).toBe(50);
    expect(dictBounds?.centerY).toBe(40);
  });

  it('safely handles > characters and XML entities inside attribute values without truncating', () => {
    const xmlWithEntities = `
    <hierarchy rotation="0">
      <node index="0" text="Continue >" content-desc="Click &amp; proceed &gt; now" resource-id="com.example:id/btn_next" bounds="[0,0][200,100]" enabled="true" visible-to-user="true" />
      <node index="1" text="&quot;Hello &lt;World&gt;&quot; &#39;test&#39;" resource-id="com.example:id/tv_greeting" bounds="[0,100][200,200]" enabled="true" visible-to-user="true" />
    </hierarchy>
    `;
    const elements = parseUIHierarchy(xmlWithEntities);
    expect(elements).toHaveLength(3); // hierarchy, node0, node1

    const nextBtn = findElement(elements, 'id=btn_next');
    expect(nextBtn).toBeDefined();
    expect(nextBtn?.text).toBe('Continue >');
    expect(nextBtn?.contentDesc).toBe('Click & proceed > now');

    const greeting = findElement(elements, 'id=tv_greeting');
    expect(greeting).toBeDefined();
    expect(greeting?.text).toBe('"Hello <World>" \'test\'');
  });

  it('parses iOS XCUI hierarchy XML with rect attributes', () => {
    const iosXml = `
    <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="TestApp">
      <XCUIElementTypeButton type="XCUIElementTypeButton" name="btn_login" label="Log In >" x="50" y="100" width="200" height="50" enabled="true" visible="true" />
      <XCUIElementTypeStaticText type="XCUIElementTypeStaticText" name="lbl_status" value="Ready" x="50" y="200" width="150" height="30" enabled="false" visible="true" />
    </XCUIElementTypeApplication>
    `;
    const elements = parseUIHierarchy(iosXml);
    expect(elements.length).toBeGreaterThan(0);

    const btn = findElement(elements, 'btn_login');
    expect(btn).toBeDefined();
    expect(btn?.text).toBe('Log In >');
    expect(btn?.bounds?.left).toBe(50);
    expect(btn?.bounds?.top).toBe(100);
    expect(btn?.bounds?.centerX).toBe(150);
    expect(btn?.bounds?.centerY).toBe(125);
    expect(btn?.enabled).toBe(true);

    const status = findElement(elements, 'lbl_status');
    expect(status).toBeDefined();
    expect(status?.text).toBe('Ready');
    expect(status?.enabled).toBe(false);
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

  it('executes pasteText action via clipboard and keyevent 279', async () => {
    mockExecutor.mockCommand('adb', 'shell cmd clipboard set text', '');
    mockExecutor.mockCommand('adb', 'shell input keyevent 279', '');

    const result = await adapter.executeAction({
      type: 'pasteText',
      value: 'A'.repeat(5000),
      timeoutMs: 5000,
      metadata: {},
    });

    expect(result.success).toBe(true);
    expect(result.output.pastedLength).toBe(5000);
    expect(result.output.method).toBe('clipboard_cmd');
  });

  it('executes deviceRotate and triggerProcessDeath (LMK am kill)', async () => {
    mockExecutor.mockCommand('adb', 'shell settings put system accelerometer_rotation 0', '');
    mockExecutor.mockCommand('adb', 'shell settings put system user_rotation 1', '');
    mockExecutor.mockCommand('adb', 'shell input keyevent 3', '');
    mockExecutor.mockCommand('adb', 'shell am kill com.example.myapp', '');

    const rotRes = await adapter.executeAction({
      type: 'deviceRotate',
      value: 'landscape',
      timeoutMs: 5000,
      metadata: {},
    });
    expect(rotRes.success).toBe(true);
    expect(rotRes.output.targetRotation).toBe('LANDSCAPE');

    const lmkRes = await adapter.executeAction({
      type: 'triggerProcessDeath',
      target: 'com.example.myapp',
      timeoutMs: 5000,
      metadata: {},
    });
    expect(lmkRes.success).toBe(true);
    expect(lmkRes.output.mechanism).toContain('am kill');
  });

  it('executes configuration changes: darkMode, setLocale, fontScale', async () => {
    mockExecutor.mockCommand('adb', 'shell cmd uimode night yes', '');
    mockExecutor.mockCommand('adb', 'shell cmd locale set-locales ar-SA', '');
    mockExecutor.mockCommand('adb', 'shell settings put system font_scale 1.3', '');

    const darkRes = await adapter.executeAction({
      type: 'darkMode' as any,
      value: 'yes',
      timeoutMs: 5000,
      metadata: {},
    });
    expect(darkRes.success).toBe(true);
    expect(darkRes.output.mode).toBe('yes');

    const localeRes = await adapter.executeAction({
      type: 'setLocale' as any,
      value: 'ar-SA',
      timeoutMs: 5000,
      metadata: {},
    });
    expect(localeRes.success).toBe(true);
    expect(localeRes.output.locale).toBe('ar-SA');

    const fontRes = await adapter.executeAction({
      type: 'fontScale' as any,
      value: '1.3',
      timeoutMs: 5000,
      metadata: {},
    });
    expect(fontRes.success).toBe(true);
    expect(fontRes.output.fontScale).toBe('1.3');
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

  it('evaluates consoleClean assertion by inspecting crash logcat buffer', async () => {
    const cleanExecutor = new MockCommandExecutor();
    cleanExecutor.mockCommand('adb', 'logcat -d -b crash', '');
    const cleanAdapter = new AndroidAdapter({ deviceId: 'emulator-5554', executor: cleanExecutor });

    const cleanResult = await cleanAdapter.executeAssertion({
      type: 'consoleClean',
      critical: true,
      metadata: {},
    });
    expect(cleanResult.passed).toBe(true);

    const crashExecutor = new MockCommandExecutor();
    crashExecutor.mockCommand(
      'adb',
      'logcat -d -b crash',
      'FATAL EXCEPTION: main\njava.lang.NullPointerException at com.example.MainActivity'
    );
    const crashAdapter = new AndroidAdapter({ deviceId: 'emulator-5554', executor: crashExecutor });

    const crashResult = await crashAdapter.executeAssertion({
      type: 'consoleClean',
      critical: true,
      metadata: {},
    });
    expect(crashResult.passed).toBe(false);
    expect(crashResult.message).toContain('Fatal Android application crash');
  });

  it('evaluates noLayoutOverflow and targetSizeAAA assertions', async () => {
    mockExecutor.mockCommand('adb', 'shell wm size', 'Physical size: 1080x2400');
    const overflowResult = await adapter.executeAssertion({
      type: 'noLayoutOverflow',
      critical: true,
      metadata: {},
    });
    expect(overflowResult.passed).toBe(true);

    const targetSizeResult = await adapter.executeAssertion({
      type: 'targetSizeAAA',
      target: 'id=btn_login',
      critical: false,
      metadata: { minSize: 44 },
    });
    expect(targetSizeResult.passed).toBe(true);
  });

  it('evaluates isElementOccluded assertion with virtual keyboard detection', async () => {
    mockExecutor.mockCommand('adb', 'shell dumpsys input_method', 'mInputShown=false\nmCurMethodId=com.google.android.inputmethod.latin');
    const notOccluded = await adapter.executeAssertion({
      type: 'isElementOccluded',
      target: 'id=btn_login',
      expected: false,
      critical: false,
      metadata: {},
    });
    expect(notOccluded.passed).toBe(true);
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

describe('IosAdapter - Actions & Honest Assertions', () => {
  let mockExecutor: MockCommandExecutor;
  const SAMPLE_IOS_XML = `
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="TestApp">
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="btn_login" label="Log In" x="50" y="100" width="200" height="50" enabled="true" visible="true" />
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="btn_disabled" label="Disabled Button" x="50" y="200" width="200" height="50" enabled="false" visible="true" />
  </XCUIElementTypeApplication>
  `;

  beforeEach(() => {
    mockExecutor = new MockCommandExecutor();
  });

  it('executes navigate action with simctl openurl', async () => {
    mockExecutor.mockCommand('xcrun', 'simctl openurl booted https://example.com/deep-link', '');

    const adapter = new IosAdapter({
      executor: mockExecutor,
      hostPlatform: 'darwin',
    });

    const res = await adapter.executeAction({
      type: 'navigate',
      value: 'https://example.com/deep-link',
      timeoutMs: 5000,
      metadata: {},
    });

    expect(res.success).toBe(true);
    expect(res.output.url).toBe('https://example.com/deep-link');
  });

  it('executes triggerProcessDeath with simctl terminate', async () => {
    mockExecutor.mockCommand('xcrun', 'simctl terminate booted com.example.iosapp', '');

    const adapter = new IosAdapter({
      executor: mockExecutor,
      hostPlatform: 'darwin',
      bundleId: 'com.example.iosapp',
    });

    const res = await adapter.executeAction({
      type: 'triggerProcessDeath',
      timeoutMs: 5000,
      metadata: {},
    });

    expect(res.success).toBe(true);
    expect(res.output.bundleId).toBe('com.example.iosapp');
    expect(res.output.mechanism).toContain('terminate');
  });

  it('fails assertions honestly when UI hierarchy XML is missing', async () => {
    const adapter = new IosAdapter({
      executor: mockExecutor,
      hostPlatform: 'darwin',
    });

    const res = await adapter.executeAssertion({
      type: 'elementVisible',
      target: 'btn_login',
      critical: true,
      metadata: {},
    });

    expect(res.passed).toBe(false);
    expect(res.message).toContain('UI hierarchy XML is unavailable');
  });

  it('evaluates assertions honestly against provided iOS UI hierarchy XML', async () => {
    const adapter = new IosAdapter({
      executor: mockExecutor,
      hostPlatform: 'darwin',
      uiHierarchyXml: SAMPLE_IOS_XML,
    });

    const visiblePass = await adapter.executeAssertion({
      type: 'elementVisible',
      target: 'btn_login',
      critical: true,
      metadata: {},
    });
    expect(visiblePass.passed).toBe(true);

    const visibleFail = await adapter.executeAssertion({
      type: 'elementVisible',
      target: 'btn_nonexistent',
      critical: true,
      metadata: {},
    });
    expect(visibleFail.passed).toBe(false);

    const textPass = await adapter.executeAssertion({
      type: 'elementTextEquals',
      target: 'btn_login',
      expected: 'Log In',
      critical: true,
      metadata: {},
    });
    expect(textPass.passed).toBe(true);

    const textFail = await adapter.executeAssertion({
      type: 'elementTextEquals',
      target: 'btn_login',
      expected: 'Sign Up',
      critical: true,
      metadata: {},
    });
    expect(textFail.passed).toBe(false);

    const disabledPass = await adapter.executeAssertion({
      type: 'elementDisabled',
      target: 'btn_disabled',
      critical: true,
      metadata: {},
    });
    expect(disabledPass.passed).toBe(true);
  });
});

describe('MaestroAdapter - YAML Flow Generation & Execution', () => {
  let mockExecutor: MockCommandExecutor;

  beforeEach(() => {
    mockExecutor = new MockCommandExecutor();
  });

  it('generates a valid Maestro YAML flow and executes tap and assertVisible', async () => {
    let capturedFlowContent = '';

    mockExecutor.onExec(
      (cmd, args) => {
        if (cmd === 'maestro' && args[0] === 'test') {
          const flowFile = args[1];
          if (fs.existsSync(flowFile)) {
            capturedFlowContent = fs.readFileSync(flowFile, 'utf8');
          }
          return true;
        }
        return false;
      },
      { stdout: 'Flow passed', exitCode: 0 }
    );

    const adapter = new MaestroAdapter({
      packageName: 'com.example.myapp',
      executor: mockExecutor,
    });

    const tapRes = await adapter.executeAction({
      type: 'tap',
      target: 'id=btn_login',
      timeoutMs: 5000,
      metadata: {},
    });

    expect(tapRes.success).toBe(true);
    expect(capturedFlowContent).toContain('appId: com.example.myapp');
    expect(capturedFlowContent).toContain('- tapOn:');
    expect(capturedFlowContent).toContain('id: btn_login');

    const assertRes = await adapter.executeAssertion({
      type: 'elementVisible',
      target: 'Welcome',
      critical: true,
      metadata: {},
    });

    expect(assertRes.passed).toBe(true);
    expect(capturedFlowContent).toContain('- assertVisible: Welcome');
  });
});

describe('AppiumAdapter - WebDriver Commands & Honest Assertions', () => {
  let mockExecutor: MockCommandExecutor;

  beforeEach(() => {
    mockExecutor = new MockCommandExecutor();
  });

  it('refuses to execute action without an active session', async () => {
    const adapter = new AppiumAdapter({ executor: mockExecutor });
    const res = await adapter.executeAction({
      type: 'tap',
      target: 'id=btn_login',
      timeoutMs: 5000,
      metadata: {},
    });

    expect(res.success).toBe(false);
    expect(res.error).toContain('no active Appium session');
  });

  it('initializes session and executes tap and fill honestly via WebDriver protocol', async () => {
    mockExecutor.mockHttp('http://127.0.0.1:4723/status', 200, {
      value: { build: { version: '2.5.1' } },
    });
    mockExecutor.mockHttpRequest(
      { url: /\/session$/, method: 'POST' },
      200,
      { value: { sessionId: 'sess-123' } }
    );
    mockExecutor.mockHttpRequest(
      { url: 'http://127.0.0.1:4723/session/sess-123/element', method: 'POST' },
      200,
      { value: { 'element-6066-11e4-a52e-4f735466cecf': 'el-btn' } }
    );
    mockExecutor.mockHttpRequest(
      { url: 'http://127.0.0.1:4723/session/sess-123/element/el-btn/click', method: 'POST' },
      200,
      { value: null }
    );
    mockExecutor.mockHttpRequest(
      { url: 'http://127.0.0.1:4723/session/sess-123/element/el-btn/value', method: 'POST' },
      200,
      { value: null }
    );

    const adapter = new AppiumAdapter({
      executor: mockExecutor,
      packageName: 'com.example.myapp',
    });
    await adapter.initialize();

    const tapRes = await adapter.executeAction({
      type: 'tap',
      target: 'id=btn_login',
      timeoutMs: 5000,
      metadata: {},
    });
    expect(tapRes.success).toBe(true);
    expect(tapRes.output.elementId).toBe('el-btn');

    const fillRes = await adapter.executeAction({
      type: 'fill',
      target: 'id=btn_login',
      value: 'admin',
      timeoutMs: 5000,
      metadata: {},
    });
    expect(fillRes.success).toBe(true);
  });

  it('evaluates elementVisible and elementTextEquals honestly via WebDriver endpoints', async () => {
    mockExecutor.mockHttp('http://127.0.0.1:4723/status', 200, {
      value: { build: { version: '2.5.1' } },
    });
    const adapter = new AppiumAdapter({ executor: mockExecutor });
    await adapter.initialize({ sessionId: 'sess-123' });

    mockExecutor.mockHttpRequest(
      { url: 'http://127.0.0.1:4723/session/sess-123/element', method: 'POST' },
      200,
      { value: { 'element-6066-11e4-a52e-4f735466cecf': 'el-login' } }
    );
    mockExecutor.mockHttpRequest(
      { url: 'http://127.0.0.1:4723/session/sess-123/element/el-login/displayed', method: 'GET' },
      200,
      { value: true }
    );
    mockExecutor.mockHttpRequest(
      { url: 'http://127.0.0.1:4723/session/sess-123/element/el-login/text', method: 'GET' },
      200,
      { value: 'Sign In' }
    );

    const visRes = await adapter.executeAssertion({
      type: 'elementVisible',
      target: 'id=btn_login',
      critical: true,
      metadata: {},
    });
    expect(visRes.passed).toBe(true);

    const textPass = await adapter.executeAssertion({
      type: 'elementTextEquals',
      target: 'id=btn_login',
      expected: 'Sign In',
      critical: true,
      metadata: {},
    });
    expect(textPass.passed).toBe(true);

    const textFail = await adapter.executeAssertion({
      type: 'elementTextEquals',
      target: 'id=btn_login',
      expected: 'Log Out',
      critical: true,
      metadata: {},
    });
    expect(textFail.passed).toBe(false);
  });

  it('captures screenshot evidence honestly without fake placeholder byte arrays', async () => {
    mockExecutor.mockHttp('http://127.0.0.1:4723/status', 200, {
      value: { build: { version: '2.5.1' } },
    });
    const fakePngBase64 = Buffer.from('REAL_PNG_TEST_BYTES').toString('base64');
    mockExecutor.mockHttpRequest(
      { url: 'http://127.0.0.1:4723/session/sess-123/screenshot', method: 'GET' },
      200,
      { value: fakePngBase64 }
    );

    const tempDir = path.resolve('.qa-output', 'test-appium-' + Date.now());
    const adapter = new AppiumAdapter({
      executor: mockExecutor,
      outputDir: tempDir,
    });
    await adapter.initialize({ sessionId: 'sess-123' });

    const evidence = await adapter.captureEvidence('SCREENSHOT');
    expect(evidence.type).toBe('SCREENSHOT');
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(evidence.path).toString()).toBe('REAL_PNG_TEST_BYTES');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
