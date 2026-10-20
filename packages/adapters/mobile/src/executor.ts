import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BinaryCommandResult {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
}

export interface HttpResponse {
  status: number;
  body: any;
}

export interface HttpRequestOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: any;
  timeoutMs?: number;
}

export interface CommandExecutor {
  exec(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
  ): Promise<CommandResult>;

  execBinary(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
  ): Promise<BinaryCommandResult>;

  httpGet(url: string, timeoutMs?: number): Promise<HttpResponse>;

  httpRequest?(options: HttpRequestOptions): Promise<HttpResponse>;
}

export class DefaultCommandExecutor implements CommandExecutor {
  async exec(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}
  ): Promise<CommandResult> {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 30000,
        env: options.env ? { ...process.env, ...options.env } : process.env,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large logs/dumps
      });

      return {
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode: 0,
      };
    } catch (err: any) {
      return {
        stdout: err.stdout ? err.stdout.toString() : '',
        stderr: err.stderr ? err.stderr.toString() : err.message || '',
        exitCode: typeof err.code === 'number' ? err.code : 1,
      };
    }
  }

  async execBinary(
    command: string,
    args: string[],
    options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}
  ): Promise<BinaryCommandResult> {
    return new Promise((resolve) => {
      const child = execFile(
        command,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs ?? 30000,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          encoding: 'buffer',
          maxBuffer: 50 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve({
              stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''),
              stderr: stderr ? stderr.toString('utf8') : error.message,
              exitCode: typeof error.code === 'number' ? error.code : 1,
            });
          } else {
            resolve({
              stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout || ''),
              stderr: stderr ? stderr.toString('utf8') : '',
              exitCode: 0,
            });
          }
        }
      );
    });
  }

  async httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
    const timeoutMs = options.timeoutMs ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = { ...options.headers };
      let bodyContent: any = options.body;
      if (bodyContent && typeof bodyContent === 'object' && !(bodyContent instanceof Buffer)) {
        bodyContent = JSON.stringify(bodyContent);
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
      }

      const res = await fetch(options.url, {
        method: options.method || 'GET',
        headers,
        body: bodyContent,
        signal: controller.signal,
      });

      const text = await res.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: res.status, body };
    } catch (err: any) {
      return { status: 0, body: err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  async httpGet(url: string, timeoutMs: number = 5000): Promise<HttpResponse> {
    return this.httpRequest({ method: 'GET', url, timeoutMs });
  }
}

export interface ExecCallRecord {
  command: string;
  args: string[];
  options?: any;
}

export class MockCommandExecutor implements CommandExecutor {
  private handlers: Array<{
    matcher: (command: string, args: string[]) => boolean;
    result: CommandResult | BinaryCommandResult;
  }> = [];

  private httpHandlers: Array<{
    matcher: (url: string, method?: string) => boolean;
    response: HttpResponse;
  }> = [];

  public calls: ExecCallRecord[] = [];
  public httpCalls: Array<{ url: string; method?: string; body?: any }> = [];

  onExec(
    matcher: (command: string, args: string[]) => boolean,
    result: Partial<CommandResult> & { binary?: Buffer }
  ): this {
    const binary = result.binary;
    this.handlers.push({
      matcher,
      result: {
        stdout: binary ?? (result.stdout ?? ''),
        stderr: result.stderr ?? '',
        exitCode: result.exitCode ?? 0,
      } as any,
    });
    return this;
  }

  mockCommand(
    commandMatch: string | RegExp,
    argsMatch: string | RegExp | undefined,
    stdout: string,
    exitCode = 0,
    stderr = ''
  ): this {
    return this.onExec(
      (cmd, args) => {
        const cmdMatches =
          typeof commandMatch === 'string' ? cmd === commandMatch : commandMatch.test(cmd);
        if (!cmdMatches) return false;
        if (!argsMatch) return true;
        const argsStr = args.join(' ');
        return typeof argsMatch === 'string'
          ? argsStr.includes(argsMatch)
          : argsMatch.test(argsStr);
      },
      { stdout, stderr, exitCode }
    );
  }

  mockBinary(
    commandMatch: string | RegExp,
    argsMatch: string | RegExp | undefined,
    stdout: Buffer,
    exitCode = 0,
    stderr = ''
  ): this {
    return this.onExec(
      (cmd, args) => {
        const cmdMatches =
          typeof commandMatch === 'string' ? cmd === commandMatch : commandMatch.test(cmd);
        if (!cmdMatches) return false;
        if (!argsMatch) return true;
        const argsStr = args.join(' ');
        return typeof argsMatch === 'string'
          ? argsStr.includes(argsMatch)
          : argsMatch.test(argsStr);
      },
      { binary: stdout, stderr, exitCode }
    );
  }

  mockHttp(urlMatch: string | RegExp, status: number, body: any): this {
    return this.mockHttpRequest({ url: urlMatch }, status, body);
  }

  mockHttpRequest(
    matcher: { url: string | RegExp; method?: string },
    status: number,
    body: any
  ): this {
    this.httpHandlers.push({
      matcher: (url: string, method?: string) => {
        const urlMatches =
          typeof matcher.url === 'string' ? url.includes(matcher.url) : matcher.url.test(url);
        if (!urlMatches) return false;
        if (matcher.method && method) {
          return matcher.method.toUpperCase() === method.toUpperCase();
        }
        return true;
      },
      response: { status, body },
    });
    return this;
  }

  async exec(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
  ): Promise<CommandResult> {
    this.calls.push({ command, args, options });

    for (const h of this.handlers) {
      if (h.matcher(command, args)) {
        const res = h.result;
        return {
          stdout: Buffer.isBuffer(res.stdout) ? res.stdout.toString('utf8') : (res.stdout as string),
          stderr: res.stderr,
          exitCode: res.exitCode,
        };
      }
    }

    return {
      stdout: '',
      stderr: `Mock executor: no mock configured for command: ${command} ${args.join(' ')}`,
      exitCode: 127,
    };
  }

  async execBinary(
    command: string,
    args: string[],
    options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
  ): Promise<BinaryCommandResult> {
    this.calls.push({ command, args, options });

    for (const h of this.handlers) {
      if (h.matcher(command, args)) {
        const res = h.result;
        return {
          stdout: Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout as string),
          stderr: res.stderr,
          exitCode: res.exitCode,
        };
      }
    }

    return {
      stdout: Buffer.alloc(0),
      stderr: `Mock executor: no mock configured for binary command: ${command} ${args.join(' ')}`,
      exitCode: 127,
    };
  }

  async httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
    const method = (options.method || 'GET').toUpperCase();
    this.httpCalls.push({ url: options.url, method, body: options.body });

    for (const h of this.httpHandlers) {
      if (h.matcher(options.url, method)) {
        return h.response;
      }
    }

    return { status: 404, body: 'Not found in mock' };
  }

  async httpGet(url: string): Promise<HttpResponse> {
    return this.httpRequest({ method: 'GET', url });
  }

  clear(): void {
    this.handlers = [];
    this.httpHandlers = [];
    this.calls = [];
    this.httpCalls = [];
  }
}
