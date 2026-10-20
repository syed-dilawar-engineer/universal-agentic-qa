import { execFile } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import { CapabilityDescriptor } from '@agentic-qa/schemas';
import { CommandExecutor, CommandResult, PortProber } from './types.js';

export const defaultCommandExecutor: CommandExecutor = (
  command: string,
  args: string[]
): Promise<CommandResult> => {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 4000 }, (error, stdout, stderr) => {
      resolve({
        stdout: (stdout || '').trim(),
        stderr: (stderr || '').trim(),
        exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
      });
    });
  });
};

export const defaultPortProber: PortProber = (
  port: number,
  host = '127.0.0.1'
): Promise<boolean> => {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(800);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
};

export class PlatformCapabilityDetector {
  private commandExecutor: CommandExecutor;
  private portProber: PortProber;
  private platform: string;

  constructor(options?: {
    commandExecutor?: CommandExecutor;
    portProber?: PortProber;
    platform?: string;
  }) {
    this.commandExecutor = options?.commandExecutor || defaultCommandExecutor;
    this.portProber = options?.portProber || defaultPortProber;
    this.platform = options?.platform || process.platform;
  }

  async detectNativeDesktopCapability(): Promise<CapabilityDescriptor> {
    const os = this.platform;

    if (os === 'darwin') {
      return this.probeMacOS();
    } else if (os === 'win32') {
      return this.probeWindows();
    } else if (os === 'linux') {
      return this.probeLinux();
    } else {
      return {
        id: 'desktop-native-capability',
        name: `Desktop Automation (${os})`,
        platform: 'desktop',
        state: 'UNSUPPORTED',
        reason: `Native desktop automation is unsupported on host platform: ${os}`,
        requiredTools: [],
        missingTools: [],
        metadata: { os },
      };
    }
  }

  private async probeMacOS(): Promise<CapabilityDescriptor> {
    // 1. Check osascript binary
    const whichResult = await this.commandExecutor('which', ['osascript']);
    if (whichResult.exitCode !== 0) {
      return {
        id: 'desktop-native-macos',
        name: 'macOS Desktop Automation (AppleScript / System Events)',
        platform: 'desktop',
        state: 'BLOCKED',
        reason: 'osascript command-line tool is not found in PATH.',
        requiredTools: ['osascript', 'System Events'],
        missingTools: ['osascript'],
        metadata: { os: 'darwin' },
      };
    }

    // 2. Truthfully probe System Events & Accessibility permissions
    // If accessibility permissions are missing, macOS returns error -1743 or -1719
    const probeScript = 'tell application "System Events" to get name of first application process whose frontmost is true';
    const accessResult = await this.commandExecutor('osascript', ['-e', probeScript]);

    const isDenied =
      accessResult.exitCode !== 0 ||
      accessResult.stderr.includes('-1743') ||
      accessResult.stderr.includes('-1719') ||
      accessResult.stderr.includes('1002') ||
      accessResult.stderr.toLowerCase().includes('not allowed assistive access') ||
      accessResult.stderr.toLowerCase().includes('not authorized') ||
      accessResult.stderr.toLowerCase().includes('system events got an error');

    if (isDenied) {
      return {
        id: 'desktop-native-macos',
        name: 'macOS Desktop Automation (AppleScript / System Events)',
        platform: 'desktop',
        state: 'BLOCKED',
        reason:
          'macOS Accessibility permissions (AXIsProcessTrusted / AppleEvents) not granted for System Events. Native UI automation cannot control desktop windows or inputs without explicit permission in System Settings > Privacy & Security > Accessibility.',
        requiredTools: ['osascript', 'System Events / Accessibility Permission'],
        missingTools: ['macOS Accessibility / System Events Permission'],
        metadata: {
          os: 'darwin',
          exitCode: accessResult.exitCode,
          diagnostic: accessResult.stderr || accessResult.stdout,
        },
      };
    }

    return {
      id: 'desktop-native-macos',
      name: 'macOS Desktop Automation (AppleScript / System Events)',
      platform: 'desktop',
      state: 'AVAILABLE',
      requiredTools: ['osascript', 'System Events'],
      missingTools: [],
      metadata: {
        os: 'darwin',
        automation: 'AppleScript / System Events',
        activeApp: accessResult.stdout,
      },
    };
  }

  private async probeWindows(): Promise<CapabilityDescriptor> {
    const isPortOpen = await this.portProber(4723, '127.0.0.1');

    if (!isPortOpen) {
      return {
        id: 'desktop-native-windows',
        name: 'Windows Desktop Automation (WinAppDriver)',
        platform: 'desktop',
        state: 'BLOCKED',
        reason:
          'WinAppDriver service is not reachable on 127.0.0.1:4723. Windows native UI automation requires Windows Application Driver (WinAppDriver.exe) running in Developer Mode.',
        requiredTools: ['WinAppDriver (http://127.0.0.1:4723)'],
        missingTools: ['WinAppDriver service'],
        metadata: { os: 'win32', port: 4723 },
      };
    }

    return {
      id: 'desktop-native-windows',
      name: 'Windows Desktop Automation (WinAppDriver)',
      platform: 'desktop',
      state: 'AVAILABLE',
      requiredTools: ['WinAppDriver (http://127.0.0.1:4723)'],
      missingTools: [],
      metadata: { os: 'win32', automation: 'WinAppDriver', endpoint: 'http://127.0.0.1:4723' },
    };
  }

  private async probeLinux(): Promise<CapabilityDescriptor> {
    const missing: string[] = [];

    const xdotoolRes = await this.commandExecutor('which', ['xdotool']);
    if (xdotoolRes.exitCode !== 0) {
      missing.push('xdotool');
    }

    const wmctrlRes = await this.commandExecutor('which', ['wmctrl']);
    if (wmctrlRes.exitCode !== 0) {
      missing.push('wmctrl');
    }

    if (missing.length > 0) {
      return {
        id: 'desktop-native-linux',
        name: 'Linux Desktop Automation (xdotool / wmctrl)',
        platform: 'desktop',
        state: 'BLOCKED',
        reason: `Missing Linux X11 automation binaries: ${missing.join(', ')}. Install via: sudo apt-get install ${missing.join(' ')}`,
        requiredTools: ['xdotool', 'wmctrl'],
        missingTools: missing,
        metadata: { os: 'linux' },
      };
    }

    // Check display environment
    const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    if (!hasDisplay) {
      return {
        id: 'desktop-native-linux',
        name: 'Linux Desktop Automation (xdotool / wmctrl)',
        platform: 'desktop',
        state: 'BLOCKED',
        reason:
          'No active graphical display server detected (both DISPLAY and WAYLAND_DISPLAY are unset). Running in a headless terminal without a virtual display (e.g. Xvfb).',
        requiredTools: ['xdotool', 'wmctrl', 'X11/Wayland Display Server'],
        missingTools: ['DISPLAY environment variable'],
        metadata: { os: 'linux' },
      };
    }

    return {
      id: 'desktop-native-linux',
      name: 'Linux Desktop Automation (xdotool / wmctrl)',
      platform: 'desktop',
      state: 'AVAILABLE',
      requiredTools: ['xdotool', 'wmctrl'],
      missingTools: [],
      metadata: {
        os: 'linux',
        automation: 'xdotool / wmctrl',
        display: process.env.DISPLAY || process.env.WAYLAND_DISPLAY,
      },
    };
  }

  async detectElectronCapability(
    cdpPort = 9222,
    appPath?: string,
    cdpEndpoint?: string
  ): Promise<CapabilityDescriptor> {
    let effectivePort = cdpPort;
    let effectiveHost = '127.0.0.1';

    if (cdpEndpoint) {
      try {
        const urlStr = cdpEndpoint.startsWith('ws://')
          ? cdpEndpoint.replace(/^ws:\/\//, 'http://')
          : cdpEndpoint.startsWith('wss://')
          ? cdpEndpoint.replace(/^wss:\/\//, 'https://')
          : cdpEndpoint;
        const parsed = new URL(urlStr);
        if (parsed.port) {
          effectivePort = parseInt(parsed.port, 10);
        }
        if (parsed.hostname) {
          effectiveHost = parsed.hostname;
        }
      } catch {
        // Fall back to cdpPort / 127.0.0.1
      }
    }

    const isPortOpen = await this.portProber(effectivePort, effectiveHost);

    if (isPortOpen) {
      return {
        id: 'desktop-electron-cdp',
        name: 'Electron App Automation (Chromium Remote Debugging / CDP)',
        platform: 'desktop',
        state: 'AVAILABLE',
        requiredTools: ['Chromium DevTools Protocol'],
        missingTools: [],
        metadata: {
          protocol: 'CDP',
          cdpPort: effectivePort,
          cdpHost: effectiveHost,
          endpoint: cdpEndpoint || `http://${effectiveHost}:${effectivePort}`,
        },
      };
    }

    if (appPath) {
      let exists = fs.existsSync(appPath);
      let resolvedPath = appPath;

      if (!exists && !appPath.includes('/') && !appPath.includes('\\')) {
        const whichRes = await this.commandExecutor('which', [appPath]);
        if (whichRes.exitCode === 0 && whichRes.stdout) {
          exists = true;
          resolvedPath = whichRes.stdout;
        }
      }

      if (exists) {
        return {
          id: 'desktop-electron-cdp',
          name: 'Electron App Automation (Chromium Remote Debugging / CDP)',
          platform: 'desktop',
          state: 'AVAILABLE',
          requiredTools: ['Electron Binary'],
          missingTools: [],
          metadata: {
            appPath: resolvedPath,
            cdpPort: effectivePort,
            launchable: true,
          },
        };
      } else {
        return {
          id: 'desktop-electron-cdp',
          name: 'Electron App Automation (Chromium Remote Debugging / CDP)',
          platform: 'desktop',
          state: 'BLOCKED',
          reason: `Electron executable not found at specified appPath: ${appPath}`,
          requiredTools: ['Electron Binary'],
          missingTools: [appPath],
          metadata: { appPath, cdpPort: effectivePort },
        };
      }
    }

    return {
      id: 'desktop-electron-cdp',
      name: 'Electron App Automation (Chromium Remote Debugging / CDP)',
      platform: 'desktop',
      state: 'UNAVAILABLE',
      reason: `No active Electron CDP endpoint found listening on ${effectiveHost}:${effectivePort} and no appPath specified for launch.`,
      requiredTools: ['Electron CDP Endpoint'],
      missingTools: [`Port ${effectivePort}`],
      metadata: { cdpPort: effectivePort, host: effectiveHost },
    };
  }
}

