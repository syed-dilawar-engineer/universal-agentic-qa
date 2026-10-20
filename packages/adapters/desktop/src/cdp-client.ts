import * as http from 'node:http';
import { QAAdapterError, QATimeoutError } from '@agentic-qa/core';

export interface CDPMessage {
  id: number;
  method?: string;
  params?: Record<string, any>;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

export interface CDPClientInterface {
  connect(endpoint?: string): Promise<void>;
  click(target: string | { x: number; y: number }): Promise<void>;
  doubleClick(target: string | { x: number; y: number }): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  clear(selector: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  wait(timeoutMs: number, selector?: string): Promise<void>;
  captureScreenshot(): Promise<string>;
  getDOMSnapshot(): Promise<string>;
  getTitle(): Promise<string>;
  navigate(url: string): Promise<void>;
  evaluate(expression: string): Promise<any>;
  isElementVisible(selector: string): Promise<boolean>;
  isElementHidden(selector: string): Promise<boolean>;
  isElementExists(selector: string): Promise<boolean>;
  getElementText(selector: string): Promise<string>;
  isElementDisabled(selector: string): Promise<boolean>;
  getElementCount(selector: string): Promise<number>;
  setWindowBounds(bounds: { width: number; height: number; x?: number; y?: number }): Promise<void>;
  focusWindow(): Promise<void>;
  close(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  onCrash(callback: (reason: string) => void): () => void;
}

export interface MockElementData {
  visible: boolean;
  text?: string;
  value?: string;
  disabled?: boolean;
}

export class MockCDPClient implements CDPClientInterface {
  private connected = false;
  private title = 'Electron Test Window';
  private currentUrl = 'file:///app/index.html';
  private elements: Map<string, MockElementData> = new Map([
    ['#app', { visible: true, text: 'Welcome to Electron App' }],
    ['#submit-btn', { visible: true, text: 'Submit', disabled: false }],
    ['#username-input', { visible: true, value: '' }],
    ['#disabled-btn', { visible: true, text: 'Disabled Button', disabled: true }],
    ['.hidden-dialog', { visible: false, text: 'Hidden' }],
  ]);
  private crashListeners: Array<(reason: string) => void> = [];
  public windowBounds = { x: 0, y: 0, width: 1024, height: 768 };

  async connect(endpoint = 'http://127.0.0.1:9222'): Promise<void> {
    this.connected = true;
  }

  async click(target: string | { x: number; y: number }): Promise<void> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');

    if (typeof target === 'string') {
      // Coordinate string format, e.g. "100,200" or "@100,200"
      if (/^@?\d+\s*,\s*\d+$/.test(target)) {
        return;
      }
      const el = this.elements.get(target);
      if (!el) {
        throw new QAAdapterError(`Element not found for selector: ${target}`, 'MockCDPClient');
      }
    }
  }

  async doubleClick(target: string | { x: number; y: number }): Promise<void> {
    await this.click(target);
  }

  async fill(selector: string, text: string): Promise<void> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    const el = this.elements.get(selector);
    if (!el) {
      throw new QAAdapterError(`Element not found for fill: ${selector}`, 'MockCDPClient');
    }
    el.value = text;
    el.text = text;
  }

  async clear(selector: string): Promise<void> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    const el = this.elements.get(selector);
    if (!el) {
      throw new QAAdapterError(`Element not found for clear: ${selector}`, 'MockCDPClient');
    }
    el.value = '';
    el.text = '';
  }

  async pressKey(key: string): Promise<void> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
  }

  async wait(timeoutMs: number, selector?: string): Promise<void> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    if (selector) {
      const el = this.elements.get(selector);
      if (!el || el.visible === false) {
        throw new QATimeoutError(`Element ${selector} did not appear within ${timeoutMs}ms`, timeoutMs);
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 50)));
    }
  }

  async captureScreenshot(): Promise<string> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    // Returns base64 1x1 transparent png
    return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }

  async getDOMSnapshot(): Promise<string> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    return '<!DOCTYPE html><html><head><title>' + this.title + '</title></head><body><div id="app">Welcome to Electron App</div><button id="submit-btn">Submit</button></body></html>';
  }

  async getTitle(): Promise<string> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    return this.title;
  }

  setTitle(title: string): void {
    this.title = title;
  }

  async navigate(url: string): Promise<void> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    this.currentUrl = url;
  }

  getUrl(): string {
    return this.currentUrl;
  }

  async evaluate(expression: string): Promise<any> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    if (expression.includes('document.title')) return this.title;
    if (expression.includes('location.href')) return this.currentUrl;
    return true;
  }

  setElement(selector: string, data: MockElementData): void {
    this.elements.set(selector, data);
  }

  async isElementVisible(selector: string): Promise<boolean> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    const el = this.elements.get(selector);
    return Boolean(el?.visible);
  }

  async isElementHidden(selector: string): Promise<boolean> {
    const visible = await this.isElementVisible(selector);
    return !visible;
  }

  async isElementExists(selector: string): Promise<boolean> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    return this.elements.has(selector);
  }

  async getElementText(selector: string): Promise<string> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    const el = this.elements.get(selector);
    return el?.text ?? el?.value ?? '';
  }

  async isElementDisabled(selector: string): Promise<boolean> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    const el = this.elements.get(selector);
    return Boolean(el?.disabled);
  }

  async getElementCount(selector: string): Promise<number> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    return this.elements.has(selector) ? 1 : 0;
  }

  async setWindowBounds(bounds: { width: number; height: number; x?: number; y?: number }): Promise<void> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
    this.windowBounds = {
      x: bounds.x ?? this.windowBounds.x,
      y: bounds.y ?? this.windowBounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  }

  async focusWindow(): Promise<void> {
    if (!this.connected) throw new QAAdapterError('CDP Client not connected', 'MockCDPClient');
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onCrash(callback: (reason: string) => void): () => void {
    this.crashListeners.push(callback);
    return () => {
      this.crashListeners = this.crashListeners.filter((l) => l !== callback);
    };
  }

  triggerCrash(reason = 'Target crashed (mocked)'): void {
    this.connected = false;
    for (const listener of this.crashListeners) {
      listener(reason);
    }
  }
}

const VIRTUAL_KEY_CODES: Record<string, number> = {
  Enter: 13,
  Return: 13,
  Tab: 9,
  Backspace: 8,
  Escape: 27,
  Esc: 27,
  Space: 32,
  ' ': 32,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

export class RealCDPClient implements CDPClientInterface {
  private ws: any = null;
  private connected = false;
  private messageId = 1;
  private pendingRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>();
  private crashListeners: Array<(reason: string) => void> = [];
  private endpoint: string;

  constructor(endpoint = 'http://127.0.0.1:9222') {
    this.endpoint = endpoint;
  }

  async connect(customEndpoint?: string): Promise<void> {
    if (customEndpoint) {
      this.endpoint = customEndpoint;
    }

    const wsUrl = await this.resolveWebSocketDebuggerUrl(this.endpoint);
    if (!wsUrl) {
      throw new QAAdapterError(
        `Failed to resolve WebSocket debugger URL from CDP endpoint: ${this.endpoint}`,
        'RealCDPClient'
      );
    }

    const WebSocketCtor = (globalThis as any).WebSocket;
    if (!WebSocketCtor) {
      throw new QAAdapterError('WebSocket API is not available in current runtime.', 'RealCDPClient');
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocketCtor(wsUrl);

        this.ws.onopen = () => {
          this.connected = true;
          Promise.all([
            this.sendCommand('Page.enable'),
            this.sendCommand('DOM.enable'),
            this.sendCommand('Runtime.enable'),
          ])
            .then(() => resolve())
            .catch(reject);
        };

        this.ws.onmessage = (event: any) => {
          try {
            const data: CDPMessage = JSON.parse(event.data);
            if (data.id && this.pendingRequests.has(data.id)) {
              const pending = this.pendingRequests.get(data.id)!;
              this.pendingRequests.delete(data.id);
              if (data.error) {
                pending.reject(new QAAdapterError(`CDP Error: ${data.error.message}`, 'RealCDPClient', data.error));
              } else {
                pending.resolve(data.result);
              }
            } else if (data.method === 'Inspector.targetCrashed') {
              const crashMsg = 'Inspector.targetCrashed event received from CDP session';
              this.rejectAllPending(new QAAdapterError(crashMsg, 'RealCDPClient'));
              for (const listener of this.crashListeners) {
                listener(crashMsg);
              }
            }
          } catch {
            // Ignore parse errors on malformed messages
          }
        };

        this.ws.onerror = (err: any) => {
          const errMsg = err?.message || 'WebSocket connection error';
          if (!this.connected) {
            reject(new QAAdapterError(`CDP WebSocket error: ${errMsg}`, 'RealCDPClient'));
          } else {
            this.rejectAllPending(new QAAdapterError(`CDP WebSocket error: ${errMsg}`, 'RealCDPClient'));
          }
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.rejectAllPending(new QAAdapterError('CDP WebSocket connection closed unexpectedly.', 'RealCDPClient'));
        };
      } catch (err: any) {
        reject(new QAAdapterError(`Failed to initialize WebSocket: ${err.message}`, 'RealCDPClient'));
      }
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [, req] of this.pendingRequests.entries()) {
      req.reject(error);
    }
    this.pendingRequests.clear();
  }

  private sendCommand(method: string, params?: Record<string, any>, timeoutMs = 10000): Promise<any> {
    if (!this.connected || !this.ws) {
      return Promise.reject(new QAAdapterError('CDP connection is not established.', 'RealCDPClient'));
    }

    const id = this.messageId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new QATimeoutError(`CDP command '${method}' timed out after ${timeoutMs}ms`, timeoutMs));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.ws.send(payload);
      } catch (err: any) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new QAAdapterError(`Failed to send CDP command: ${err.message}`, 'RealCDPClient', err));
      }
    });
  }

  private async resolveWebSocketDebuggerUrl(endpoint: string): Promise<string | null> {
    if (endpoint.startsWith('ws://') || endpoint.startsWith('wss://')) {
      return endpoint;
    }

    // 1. Try /json/list to find the active page/window target
    const pageWsUrl = await new Promise<string | null>((resolve) => {
      const url = new URL('/json/list', endpoint);
      http
        .get(url.toString(), (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              const targets = JSON.parse(body);
              if (Array.isArray(targets) && targets.length > 0) {
                const page = targets.find((t: any) => t.type === 'page' && t.webSocketDebuggerUrl);
                resolve(page ? page.webSocketDebuggerUrl : targets[0].webSocketDebuggerUrl || null);
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        })
        .on('error', () => {
          resolve(null);
        });
    });

    if (pageWsUrl) return pageWsUrl;

    // 2. Fallback to /json/version
    return new Promise((resolve) => {
      const url = new URL('/json/version', endpoint);
      http
        .get(url.toString(), (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              resolve(json.webSocketDebuggerUrl || null);
            } catch {
              resolve(null);
            }
          });
        })
        .on('error', () => {
          resolve(null);
        });
    });
  }

  async click(target: string | { x: number; y: number }): Promise<void> {
    if (typeof target === 'string') {
      const coordMatch = target.match(/^@?(\d+)\s*,\s*(\d+)$/);
      if (coordMatch) {
        const x = parseInt(coordMatch[1], 10);
        const y = parseInt(coordMatch[2], 10);
        await this.click({ x, y });
        return;
      }

      const script = `(() => {
        const el = document.querySelector(${JSON.stringify(target)});
        if (!el) return false;
        el.click();
        return true;
      })()`;
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      });
      if (!result?.result?.value) {
        throw new QAAdapterError(`Target element not found for click: ${target}`, 'RealCDPClient');
      }
    } else {
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: target.x,
        y: target.y,
        button: 'left',
        clickCount: 1,
      });
      await this.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: target.x,
        y: target.y,
        button: 'left',
        clickCount: 1,
      });
    }
  }

  async doubleClick(target: string | { x: number; y: number }): Promise<void> {
    if (typeof target === 'string') {
      const coordMatch = target.match(/^@?(\d+)\s*,\s*(\d+)$/);
      if (coordMatch) {
        const x = parseInt(coordMatch[1], 10);
        const y = parseInt(coordMatch[2], 10);
        await this.doubleClick({ x, y });
        return;
      }

      const script = `(() => {
        const el = document.querySelector(${JSON.stringify(target)});
        if (!el) return false;
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        return true;
      })()`;
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      });
      if (!result?.result?.value) {
        throw new QAAdapterError(`Target element not found for doubleClick: ${target}`, 'RealCDPClient');
      }
    } else {
      for (let i = 1; i <= 2; i++) {
        await this.sendCommand('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: target.x,
          y: target.y,
          button: 'left',
          clickCount: i,
        });
        await this.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: target.x,
          y: target.y,
          button: 'left',
          clickCount: i,
        });
      }
    }
  }

  async fill(selector: string, text: string): Promise<void> {
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      if ('value' in el) {
        el.value = ${JSON.stringify(text)};
      } else {
        el.textContent = ${JSON.stringify(text)};
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`;
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    });
    if (!result?.result?.value) {
      throw new QAAdapterError(`Element not found for fill: ${selector}`, 'RealCDPClient');
    }
  }

  async clear(selector: string): Promise<void> {
    await this.fill(selector, '');
  }

  async pressKey(key: string): Promise<void> {
    const windowsVirtualKeyCode = VIRTUAL_KEY_CODES[key];
    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      windowsVirtualKeyCode,
      text: key.length === 1 ? key : undefined,
    });
    await this.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      windowsVirtualKeyCode,
    });
  }

  async wait(timeoutMs: number, selector?: string): Promise<void> {
    if (!selector) {
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      return;
    }

    const start = Date.now();
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    })()`;

    while (Date.now() - start < timeoutMs) {
      const result = await this.sendCommand('Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      });
      if (result?.result?.value) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new QATimeoutError(`Element ${selector} did not appear within ${timeoutMs}ms`, timeoutMs);
  }

  async captureScreenshot(): Promise<string> {
    const res = await this.sendCommand('Page.captureScreenshot', { format: 'png' });
    return res.data;
  }

  async getDOMSnapshot(): Promise<string> {
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: 'document.documentElement.outerHTML',
      returnByValue: true,
    });
    return result?.result?.value || '';
  }

  async getTitle(): Promise<string> {
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    return result?.result?.value || '';
  }

  async navigate(url: string): Promise<void> {
    await this.sendCommand('Page.navigate', { url });
  }

  async evaluate(expression: string): Promise<any> {
    const result = await this.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    return result?.result?.value;
  }

  async isElementVisible(selector: string): Promise<boolean> {
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        parseFloat(style.opacity || '1') > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    })()`;
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    });
    return Boolean(result?.result?.value);
  }

  async isElementHidden(selector: string): Promise<boolean> {
    const visible = await this.isElementVisible(selector);
    return !visible;
  }

  async isElementExists(selector: string): Promise<boolean> {
    const script = `Boolean(document.querySelector(${JSON.stringify(selector)}))`;
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    });
    return Boolean(result?.result?.value);
  }

  async getElementText(selector: string): Promise<string> {
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return '';
      return el.innerText ?? el.textContent ?? '';
    })()`;
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    });
    return String(result?.result?.value ?? '');
  }

  async isElementDisabled(selector: string): Promise<boolean> {
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      return Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
    })()`;
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    });
    return Boolean(result?.result?.value);
  }

  async getElementCount(selector: string): Promise<number> {
    const script = `document.querySelectorAll(${JSON.stringify(selector)}).length`;
    const result = await this.sendCommand('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    });
    return Number(result?.result?.value ?? 0);
  }

  async setWindowBounds(bounds: { width: number; height: number; x?: number; y?: number }): Promise<void> {
    try {
      await this.sendCommand('Browser.setWindowBounds', {
        windowId: 1,
        bounds: {
          width: bounds.width,
          height: bounds.height,
          left: bounds.x,
          top: bounds.y,
        },
      });
    } catch {
      await this.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: bounds.width,
        height: bounds.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
  }

  async focusWindow(): Promise<void> {
    await this.sendCommand('Page.bringToFront');
  }

  async close(): Promise<void> {
    try {
      await this.sendCommand('Browser.close');
    } catch {
      // Ignore if browser already closing
    }
    await this.disconnect();
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore
      }
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onCrash(callback: (reason: string) => void): () => void {
    this.crashListeners.push(callback);
    return () => {
      this.crashListeners = this.crashListeners.filter((l) => l !== callback);
    };
  }
}
