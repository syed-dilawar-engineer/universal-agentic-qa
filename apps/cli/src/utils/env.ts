import { execSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export interface DoctorCheckResult {
  name: string;
  category: 'runtime' | 'browser' | 'mobile' | 'adapter' | 'system';
  status: 'ok' | 'warning' | 'missing' | 'unsupported';
  version?: string;
  path?: string;
  details?: string;
}

export interface DoctorReport {
  ok: boolean;
  platform: string;
  arch: string;
  checks: DoctorCheckResult[];
}

export interface EnvDetector {
  checkCommand(command: string): { success: boolean; output: string };
  checkPath(filePath: string): boolean;
  getNodeVersion(): string;
  getPlatform(): string;
  getArch(): string;
}

export class DefaultEnvDetector implements EnvDetector {
  checkCommand(command: string): { success: boolean; output: string } {
    try {
      const output = execSync(command, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: err.message || '' };
    }
  }

  checkPath(filePath: string): boolean {
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  getNodeVersion(): string {
    return process.version;
  }

  getPlatform(): string {
    return os.platform();
  }

  getArch(): string {
    return os.arch();
  }
}

export function detectRuntimes(env: EnvDetector): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];

  // 1. Node.js
  const nodeVer = env.getNodeVersion();
  const majorNode = parseInt(nodeVer.replace(/^v/, '').split('.')[0], 10);
  if (majorNode >= 20) {
    results.push({
      name: 'Node.js',
      category: 'runtime',
      status: 'ok',
      version: nodeVer,
      details: 'Node.js runtime meets >= 20.0.0 requirement',
    });
  } else {
    results.push({
      name: 'Node.js',
      category: 'runtime',
      status: 'warning',
      version: nodeVer,
      details: 'Node.js version is below recommended >= 20.0.0',
    });
  }

  // 2. Python
  const py3 = env.checkCommand('python3 --version');
  if (py3.success) {
    results.push({
      name: 'Python',
      category: 'runtime',
      status: 'ok',
      version: py3.output.replace(/^Python\s+/, ''),
      details: 'Python 3 runtime is available',
    });
  } else {
    const py = env.checkCommand('python --version');
    if (py.success) {
      results.push({
        name: 'Python',
        category: 'runtime',
        status: 'ok',
        version: py.output.replace(/^Python\s+/, ''),
        details: 'Python runtime is available',
      });
    } else {
      results.push({
        name: 'Python',
        category: 'runtime',
        status: 'missing',
        details: 'Python runtime not found in PATH (optional for core web QA, needed for specialized ML/adapters)',
      });
    }
  }

  return results;
}

export function detectBrowsers(env: EnvDetector): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];

  // Playwright check
  const pwCheck = env.checkCommand('npx playwright --version');
  const hasPlaywright = pwCheck.success;

  // Chromium / Chrome check
  const chromeCheck = env.checkCommand('google-chrome --version');
  const chromiumCheck = env.checkCommand('chromium --version');
  const macChromeExists = env.checkPath('/Applications/Google Chrome.app');

  let browserFound = false;
  let browserVersion: string | undefined;
  let browserName = 'Chromium / Chrome';

  if (chromiumCheck.success) {
    browserFound = true;
    browserVersion = chromiumCheck.output;
    browserName = 'Chromium';
  } else if (chromeCheck.success) {
    browserFound = true;
    browserVersion = chromeCheck.output;
    browserName = 'Google Chrome';
  } else if (macChromeExists) {
    browserFound = true;
    browserVersion = 'Installed (/Applications/Google Chrome.app)';
    browserName = 'Google Chrome';
  }

  if (browserFound || hasPlaywright) {
    results.push({
      name: 'Chromium / Chrome Browser',
      category: 'browser',
      status: 'ok',
      version: browserVersion || (hasPlaywright ? pwCheck.output : undefined),
      details: hasPlaywright
        ? `Playwright available: ${pwCheck.output}`
        : `${browserName} detected`,
    });
  } else {
    results.push({
      name: 'Chromium / Chrome Browser',
      category: 'browser',
      status: 'warning',
      details: 'Neither Chrome/Chromium nor Playwright was detected. Headless Web tests may require installing Playwright (npx playwright install).',
    });
  }

  return results;
}

export function detectMobileTools(env: EnvDetector): DoctorCheckResult[] {
  const results: DoctorCheckResult[] = [];
  const platform = env.getPlatform();

  // Android: adb
  const adbCheck = env.checkCommand('adb version');
  if (adbCheck.success) {
    const firstLine = adbCheck.output.split('\n')[0];
    results.push({
      name: 'Android Debug Bridge (adb)',
      category: 'mobile',
      status: 'ok',
      version: firstLine,
      details: 'Android SDK tools detected',
    });
  } else {
    results.push({
      name: 'Android Debug Bridge (adb)',
      category: 'mobile',
      status: 'missing',
      details: 'Android adb tool not found in PATH (required for Android mobile testing)',
    });
  }

  // iOS: xcrun simctl
  if (platform === 'darwin') {
    const simctlCheck = env.checkCommand('xcrun simctl list pairs');
    if (simctlCheck.success) {
      results.push({
        name: 'Apple iOS Simulator (simctl)',
        category: 'mobile',
        status: 'ok',
        details: 'Apple Xcode xcrun simctl detected',
      });
    } else {
      results.push({
        name: 'Apple iOS Simulator (simctl)',
        category: 'mobile',
        status: 'missing',
        details: 'xcrun simctl failed or Xcode Command Line Tools not installed (required for iOS testing)',
      });
    }
  } else {
    results.push({
      name: 'Apple iOS Simulator (simctl)',
      category: 'mobile',
      status: 'unsupported',
      details: `iOS Simulator is only supported on macOS (current host: ${platform})`,
    });
  }

  return results;
}

export function runFullDoctor(env: EnvDetector = new DefaultEnvDetector()): DoctorReport {
  const runtimes = detectRuntimes(env);
  const browsers = detectBrowsers(env);
  const mobile = detectMobileTools(env);

  const checks = [...runtimes, ...browsers, ...mobile];
  const nodeCheck = checks.find(c => c.name === 'Node.js');
  const ok = nodeCheck ? nodeCheck.status === 'ok' : true;

  return {
    ok,
    platform: env.getPlatform(),
    arch: env.getArch(),
    checks,
  };
}
