import { ChildProcess } from 'node:child_process';
import { QAAdapterError } from '@agentic-qa/core';
import { CommandExecutor, CrashInfo, WindowBounds } from './types.js';
import { defaultCommandExecutor } from './platform-capability.js';
import { CDPClientInterface } from './cdp-client.js';

export class WindowManager {
  private childProcess?: ChildProcess;
  private pid?: number;
  private appName: string;
  private platform: string;
  private commandExecutor: CommandExecutor;
  private cdpClient?: CDPClientInterface;
  private crashInfo: CrashInfo = { crashed: false };
  private crashListeners: Array<(info: CrashInfo) => void> = [];
  private currentBounds: WindowBounds = { x: 0, y: 0, width: 1280, height: 800 };
  private processLogs: string[] = [];
  private isClosed = false;

  constructor(options?: {
    appName?: string;
    platform?: string;
    commandExecutor?: CommandExecutor;
    cdpClient?: CDPClientInterface;
    childProcess?: ChildProcess;
    pid?: number;
  }) {
    this.appName = options?.appName || 'TargetApp';
    this.platform = options?.platform || process.platform;
    this.commandExecutor = options?.commandExecutor || defaultCommandExecutor;
    this.cdpClient = options?.cdpClient;
    if (options?.childProcess) {
      this.trackProcess(options.childProcess);
    } else if (options?.pid) {
      this.pid = options.pid;
    }
  }

  setCDPClient(cdpClient: CDPClientInterface): void {
    this.cdpClient = cdpClient;
    this.cdpClient.onCrash((reason) => {
      this.handleCrash(null, 'SIGSEGV', `CDP Session reported crash: ${reason}`);
    });
  }

  trackProcess(cp: ChildProcess): void {
    this.childProcess = cp;
    this.pid = cp.pid;
    this.isClosed = false;

    if (cp.stdout) {
      cp.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        this.appendLogs(`[stdout] ${text}`);
      });
    }

    if (cp.stderr) {
      cp.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        this.appendLogs(`[stderr] ${text}`);
      });
    }

    cp.on('exit', (code, signal) => {
      if (this.isClosed) {
        return;
      }
      if (code !== 0 && code !== null) {
        const excerpt = this.getProcessLogsText();
        this.handleCrash(
          code,
          signal,
          `Process ${cp.pid} exited with non-zero exit code: ${code}${excerpt ? `\nLogs:\n${excerpt}` : ''}`
        );
      } else if (signal && signal !== 'SIGTERM' && signal !== 'SIGINT') {
        this.handleCrash(code, signal, `Process ${cp.pid} killed by fatal signal: ${signal}`);
      }
    });

    cp.on('error', (err) => {
      if (this.isClosed) {
        return;
      }
      this.handleCrash(null, undefined, `Process error: ${err.message}`);
    });
  }

  private appendLogs(entry: string): void {
    this.processLogs.push(entry);
    if (this.processLogs.length > 500) {
      this.processLogs.shift();
    }
  }

  getProcessLogs(): string[] {
    return [...this.processLogs];
  }

  getProcessLogsText(): string {
    return this.processLogs.slice(-20).join('\n');
  }

  private handleCrash(exitCode: number | null, signal?: string | null, reason?: string): void {
    this.crashInfo = {
      crashed: true,
      exitCode,
      signal,
      reason: reason || 'Target application terminated unexpectedly.',
      timestamp: new Date().toISOString(),
      logsExcerpt: this.getProcessLogsText(),
    };

    for (const listener of this.crashListeners) {
      listener(this.crashInfo);
    }
  }

  simulateCrash(exitCode = 139, signal = 'SIGSEGV'): void {
    this.handleCrash(exitCode, signal, `Simulated application crash (exitCode ${exitCode}, signal ${signal})`);
  }

  checkCrash(): CrashInfo {
    if (this.isClosed) {
      return { ...this.crashInfo };
    }

    if (!this.crashInfo.crashed && this.pid) {
      try {
        process.kill(this.pid, 0);
      } catch (err: any) {
        if (err.code === 'ESRCH') {
          this.handleCrash(-1, null, `Process with PID ${this.pid} is no longer running.`);
        }
      }
    }
    return { ...this.crashInfo };
  }

  isProcessAlive(): boolean {
    if (this.crashInfo.crashed || this.isClosed) return false;
    if (!this.pid) return true;
    try {
      process.kill(this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  onCrash(callback: (info: CrashInfo) => void): () => void {
    this.crashListeners.push(callback);
    return () => {
      this.crashListeners = this.crashListeners.filter((l) => l !== callback);
    };
  }

  async resize(width: number, height: number): Promise<void> {
    if (width <= 0 || height <= 0 || isNaN(width) || isNaN(height)) {
      throw new QAAdapterError(
        `Invalid window dimensions: width and height must be positive numbers (got ${width}x${height}).`,
        'WindowManager'
      );
    }

    if (this.cdpClient && this.cdpClient.isConnected()) {
      await this.cdpClient.setWindowBounds({ width, height });
      this.currentBounds.width = width;
      this.currentBounds.height = height;
      return;
    }

    if (this.platform === 'darwin') {
      const script = `tell application "System Events" to tell process "${this.appName}" to set size of front window to {${width}, ${height}}`;
      const res = await this.commandExecutor('osascript', ['-e', script]);
      if (res.exitCode !== 0 && !res.stderr.includes('already')) {
        // Fallback or warning
      }
    } else if (this.platform === 'linux') {
      await this.commandExecutor('wmctrl', ['-r', this.appName, '-e', `0,-1,-1,${width},${height}`]);
    } else if (this.platform === 'win32') {
      const psScript = `(Get-Process -Name "${this.appName}" -ErrorAction SilentlyContinue).MainWindowHandle`;
      await this.commandExecutor('powershell', ['-Command', psScript]);
    }

    this.currentBounds.width = width;
    this.currentBounds.height = height;
  }

  async focus(windowTitle?: string): Promise<void> {
    const target = windowTitle || this.appName;

    if (this.cdpClient && this.cdpClient.isConnected()) {
      await this.cdpClient.focusWindow();
      return;
    }

    if (this.platform === 'darwin') {
      const script = `tell application "${target}" to activate`;
      await this.commandExecutor('osascript', ['-e', script]);
    } else if (this.platform === 'linux') {
      await this.commandExecutor('wmctrl', ['-a', target]);
    } else if (this.platform === 'win32') {
      await this.commandExecutor('powershell', [
        '-Command',
        `$wshell = New-Object -ComObject wscript.shell; $wshell.AppActivate('${target}')`,
      ]);
    }
  }

  async close(windowTitle?: string): Promise<void> {
    this.isClosed = true;
    const target = windowTitle || this.appName;

    if (this.cdpClient && this.cdpClient.isConnected()) {
      await this.cdpClient.close();
      return;
    }

    if (this.platform === 'darwin') {
      const script = `tell application "${target}" to quit`;
      await this.commandExecutor('osascript', ['-e', script]);
    } else if (this.platform === 'linux') {
      await this.commandExecutor('wmctrl', ['-c', target]);
    } else if (this.platform === 'win32') {
      await this.commandExecutor('powershell', [
        '-Command',
        `Stop-Process -Name "${target}" -Force -ErrorAction SilentlyContinue`,
      ]);
    }

    if (this.childProcess && !this.childProcess.killed) {
      try {
        this.childProcess.kill('SIGTERM');
      } catch {
        // Process might already be dead
      }
    }
  }

  getBounds(): WindowBounds {
    return { ...this.currentBounds };
  }

  setBounds(bounds: Partial<WindowBounds>): void {
    this.currentBounds = {
      ...this.currentBounds,
      ...bounds,
    };
  }
}
