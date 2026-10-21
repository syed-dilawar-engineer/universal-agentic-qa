import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CapabilityDescriptor, Platform } from '@agentic-qa/schemas';

function isBinaryAvailable(binaryName: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? `where ${binaryName}` : `which ${binaryName}`;
    execSync(cmd, { stdio: 'ignore', timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function isChromeOnMac(): boolean {
  if (process.platform !== 'darwin') return false;
  return (
    fs.existsSync('/Applications/Google Chrome.app') ||
    fs.existsSync(path.join(os.homedir(), 'Applications/Google Chrome.app'))
  );
}

function hasPlaywrightCache(): boolean {
  try {
    const cacheDir =
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library/Caches/ms-playwright')
        : path.join(os.homedir(), '.cache/ms-playwright');
    if (fs.existsSync(cacheDir)) {
      const files = fs.readdirSync(cacheDir);
      return files.some((f) => f.includes('chromium') || f.includes('firefox') || f.includes('webkit'));
    }
  } catch {
    // Ignore error
  }
  return false;
}

export function probeSystemCapabilities(): CapabilityDescriptor[] {
  const descriptors: CapabilityDescriptor[] = [];

  // 1. Web Platform
  const hasChromium = isBinaryAvailable('chromium');
  const hasChrome = isBinaryAvailable('google-chrome') || isBinaryAvailable('chrome') || isChromeOnMac();
  const hasPlaywright = isBinaryAvailable('playwright') || hasPlaywrightCache();
  const webTools = ['chromium', 'google-chrome', 'playwright'];
  const missingWebTools: string[] = [];
  if (!hasChromium && !hasChrome) missingWebTools.push('chromium');
  if (!hasChrome) missingWebTools.push('google-chrome');
  if (!hasPlaywright) missingWebTools.push('playwright');

  const webState = (hasChromium || hasChrome || hasPlaywright) ? 'AVAILABLE' : 'BLOCKED';

  descriptors.push({
    id: 'system-web-browser',
    name: 'System Web Browser Engine',
    platform: 'web',
    state: webState,
    reason:
      webState === 'BLOCKED'
        ? 'No headless browser or Playwright driver detected on PATH. Install chromium or run `npx playwright install`.'
        : undefined,
    requiredTools: webTools,
    missingTools: missingWebTools,
    metadata: {
      hasChromium,
      hasChrome,
      hasPlaywright,
    },
  });

  // 2. API Platform
  const hasNode = isBinaryAvailable('node');
  const hasCurl = isBinaryAvailable('curl');
  const missingApiTools: string[] = [];
  if (!hasNode) missingApiTools.push('node');
  if (!hasCurl) missingApiTools.push('curl');

  descriptors.push({
    id: 'system-api-runner',
    name: 'Native HTTP/REST API Engine',
    platform: 'api',
    state: 'AVAILABLE',
    requiredTools: ['node', 'fetch'],
    missingTools: missingApiTools,
    metadata: {
      nodeVersion: process.version,
      hasCurl,
    },
  });

  // 3. Mobile Platform
  const isMac = process.platform === 'darwin';
  const hasAdb = isBinaryAvailable('adb');
  const hasXcrun = isMac && isBinaryAvailable('xcrun');
  const mobileMissing: string[] = [];
  if (!hasAdb) mobileMissing.push('adb');
  if (isMac && !hasXcrun) mobileMissing.push('xcrun');

  const mobileAvailable = hasAdb || hasXcrun;
  descriptors.push({
    id: 'system-mobile-driver',
    name: 'Mobile Device & Simulator Bridge',
    platform: 'mobile',
    state: mobileAvailable ? 'AVAILABLE' : 'BLOCKED',
    reason: mobileAvailable
      ? undefined
      : 'Android SDK (adb) and/or Apple Xcode command line tools (xcrun) missing.',
    requiredTools: isMac ? ['adb', 'xcrun'] : ['adb'],
    missingTools: mobileMissing,
    metadata: {
      hasAdb,
      hasXcrun,
      isDarwin: isMac,
    },
  });

  // 4. Desktop Platform
  descriptors.push({
    id: 'system-desktop-driver',
    name: 'Desktop OS Automation',
    platform: 'desktop',
    state: 'UNAVAILABLE',
    reason: 'Native desktop automation agent is not initialized or running.',
    requiredTools: ['accessibility-api'],
    missingTools: ['accessibility-api'],
    metadata: {
      os: process.platform,
      arch: process.arch,
    },
  });

  // 5. Game Platform
  descriptors.push({
    id: 'system-game-driver',
    name: 'Game Engine RPC Harness',
    platform: 'game',
    state: 'UNSUPPORTED',
    reason: 'No game engine bridge (Unity/Unreal/Godot) detected in workspace.',
    requiredTools: ['game-bridge-socket'],
    missingTools: ['game-bridge-socket'],
    metadata: {},
  });

  return descriptors;
}
