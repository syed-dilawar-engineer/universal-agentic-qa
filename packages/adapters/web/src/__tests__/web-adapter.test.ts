import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import {
  ActionSpec,
  ActionSpecSchema,
  AssertionSpec,
  AssertionSpecSchema,
  EvidenceArtifactSchema,
  TestPlanSchema,
} from '@agentic-qa/schemas';
import { RunLifecycle } from '@agentic-qa/core';
import {
  WebAdapter,
  VIEWPORT_MATRIX,
  resolveViewport,
  LayoutCheckResult,
} from '../index.js';

function makeAction(input: z.input<typeof ActionSpecSchema>): ActionSpec {
  return ActionSpecSchema.parse(input);
}

function makeAssertion(input: z.input<typeof AssertionSpecSchema>): AssertionSpec {
  return AssertionSpecSchema.parse(input);
}

/**
 * Creates a high-fidelity mock Playwright Page, Context, and Browser for unit testing.
 */
function createMockPlaywrightEnvironment() {
  const pageEmitter = new EventEmitter();
  let currentUrl = 'https://example.com';
  let currentTitle = 'Example Domain';
  let isPageClosed = false;
  let isContextClosed = false;
  let isBrowserClosed = false;

  const elementsState = new Map<string, {
    visible: boolean;
    text: string;
    disabled: boolean;
    count: number;
  }>();

  // Prepopulate standard elements
  elementsState.set('#submit-btn', { visible: true, text: 'Submit', disabled: false, count: 1 });
  elementsState.set('#disabled-btn', { visible: true, text: 'Disabled', disabled: true, count: 1 });
  elementsState.set('#hidden-el', { visible: false, text: 'Secret', disabled: false, count: 1 });
  elementsState.set('.item', { visible: true, text: 'Item Text', disabled: false, count: 3 });

  let layoutResultMock: LayoutCheckResult = {
    hasIssues: false,
    horizontalOverflow: false,
    issues: [],
    metrics: {
      clientWidth: 1440,
      scrollWidth: 1440,
      clientHeight: 900,
      scrollHeight: 900,
    },
  };

  const domElements: Record<string, any> = {
    '#submit-btn': {
      tagName: 'BUTTON',
      id: 'submit-btn',
      className: 'btn primary',
      textContent: 'Submit',
      scrollWidth: 80,
      clientWidth: 80,
      getAttribute: (attr: string) => (attr === 'aria-label' ? 'Submit Form' : null),
      getBoundingClientRect: () => ({ width: 48, height: 48, left: 100, top: 100, right: 148, bottom: 148 }),
      querySelector: () => null,
      contains: (el: any) => el === domElements['#submit-btn'],
    },
    '#small-btn': {
      tagName: 'BUTTON',
      id: 'small-btn',
      textContent: 'Small',
      scrollWidth: 24,
      clientWidth: 24,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 24, height: 24, left: 200, top: 100, right: 224, bottom: 124 }),
      querySelector: () => null,
      contains: (el: any) => el === domElements['#small-btn'],
    },
    '#occluded-btn': {
      tagName: 'BUTTON',
      id: 'occluded-btn',
      textContent: 'Covered',
      scrollWidth: 60,
      clientWidth: 60,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 60, height: 48, left: 100, top: 100, right: 160, bottom: 148 }),
      querySelector: () => null,
      contains: () => false,
    },
    '#overflow-div': {
      tagName: 'DIV',
      id: 'overflow-div',
      textContent: 'Overflow content',
      scrollWidth: 500,
      clientWidth: 200,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 200, height: 50, left: 0, top: 0, right: 200, bottom: 50 }),
      querySelector: () => null,
      contains: () => true,
    },
    '#clean-div': {
      tagName: 'DIV',
      id: 'clean-div',
      textContent: 'Clean content',
      scrollWidth: 200,
      clientWidth: 200,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 200, height: 50, left: 0, top: 0, right: 200, bottom: 50 }),
      querySelector: () => null,
      contains: () => true,
    },
    '#truncated-text': {
      tagName: 'SPAN',
      id: 'truncated-text',
      textContent: 'Long text overflowing client bounds',
      scrollWidth: 450,
      clientWidth: 150,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 150, height: 20, left: 0, top: 0, right: 150, bottom: 20 }),
      querySelector: () => null,
      contains: () => true,
    },
    '#clean-text': {
      tagName: 'SPAN',
      id: 'clean-text',
      textContent: 'Short text fits',
      scrollWidth: 80,
      clientWidth: 100,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 100, height: 20, left: 0, top: 0, right: 100, bottom: 20 }),
      querySelector: () => null,
      contains: () => true,
    },
    '#inaccessible-btn': {
      tagName: 'BUTTON',
      id: 'inaccessible-btn',
      textContent: '',
      scrollWidth: 40,
      clientWidth: 40,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 44, height: 44, left: 0, top: 0, right: 44, bottom: 44 }),
      querySelector: () => null,
      contains: () => true,
    },
  };

  const mockPage: any = {
    on: (event: string, listener: (...args: any[]) => void) => {
      pageEmitter.on(event, listener);
      return mockPage;
    },
    off: (event: string, listener: (...args: any[]) => void) => {
      pageEmitter.off(event, listener);
      return mockPage;
    },
    emit: (event: string, ...args: any[]) => pageEmitter.emit(event, ...args),
    url: () => currentUrl,
    title: async () => currentTitle,
    goto: async (url: string, options?: any) => {
      currentUrl = url;
      return {
        status: () => 200,
        statusText: () => 'OK',
      };
    },
    click: async (target: string, options?: any) => {
      if (target === '#error-btn') throw new Error('Click failed: element not found');
      return;
    },
    dblclick: async (target: string, options?: any) => {
      return;
    },
    fill: async (target: string, value: string, options?: any) => {
      elementsState.set(target, {
        visible: true,
        text: value,
        disabled: false,
        count: 1,
      });
      return;
    },
    type: async (target: string, value: string, options?: any) => {
      const existing = elementsState.get(target)?.text || '';
      elementsState.set(target, {
        visible: true,
        text: existing + value,
        disabled: false,
        count: 1,
      });
      return;
    },
    press: async (target: string, key: string, options?: any) => {
      return;
    },
    hover: async (target: string, options?: any) => {
      return;
    },
    content: async () => `<html><body><h1>${currentTitle}</h1></body></html>`,
    screenshot: async (options?: any) => {
      // Return dummy 1x1 PNG bytes
      return Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
      ]);
    },
    waitForSelector: async (selector: string, options?: any) => {
      if (selector === '#missing') throw new Error('Timeout waiting for selector');
      return {};
    },
    waitForTimeout: async (ms: number) => {
      return;
    },
    evaluate: async (fn: any, arg?: any) => {
      if (typeof fn === 'function') {
        const fnStr = fn.toString();
        if (fnStr.includes('issues: LayoutIssue[]') || (fnStr.includes('hasHorizontalOverflow') && !arg)) {
          return layoutResultMock;
        }
        const prevWindow = (globalThis as any).window;
        const prevDocument = (globalThis as any).document;
        (globalThis as any).window = {
          scrollBy: () => {},
          scrollTo: () => {},
          innerWidth: 1440,
          innerHeight: 900,
          getComputedStyle: () => ({ display: 'block', visibility: 'visible', textOverflow: 'ellipsis' }),
        };
        (globalThis as any).document = {
          body: { scrollHeight: 2000, scrollWidth: 1440 },
          documentElement: { clientWidth: 1440, scrollWidth: 1440 },
          querySelector: (sel: string) => domElements[sel] || null,
          querySelectorAll: (sel: string) => {
            if (sel.includes('img:not([alt])')) return [];
            if (sel.includes('button')) return [domElements['#submit-btn']];
            if (sel.includes('a[href]')) return [];
            if (sel.includes('input')) return [];
            return Object.values(domElements);
          },
          elementFromPoint: (x: number, y: number) => {
            if (x === 130 && y === 124) {
              return { tagName: 'DIV', id: 'sticky-header', className: 'overlay', contains: () => false };
            }
            return domElements['#submit-btn'];
          },
        };
        try {
          return fn(arg);
        } finally {
          (globalThis as any).window = prevWindow;
          (globalThis as any).document = prevDocument;
        }
      }
      if (typeof fn === 'string') {
        return eval(fn);
      }
      return arg;
    },
    locator: (selector: string) => {
      const state = elementsState.get(selector) || {
        visible: false,
        text: '',
        disabled: false,
        count: 0,
      };
      return {
        isVisible: async () => state.visible,
        count: async () => state.count,
        innerText: async () => state.text,
        isDisabled: async () => state.disabled,
        isEnabled: async () => !state.disabled,
        click: async (options?: any) => {
          if (selector === '#error-btn') throw new Error('Click failed on locator');
          return;
        },
        pressSequentially: async (text: string, options?: any) => {
          state.text += text;
          return;
        },
        scrollIntoViewIfNeeded: async (options?: any) => {
          return;
        },
        waitFor: async (options?: any) => {
          if (!state.visible && options?.state === 'visible') {
            throw new Error('Element not visible within timeout');
          }
          return;
        },
      };
    },
    keyboard: {
      type: async (text: string) => {},
      press: async (key: string) => {},
    },
    mouse: {
      wheel: async (dx: number, dy: number) => {},
    },
    goBack: async (options?: any) => ({ status: () => 200, statusText: () => 'OK' }),
    goForward: async (options?: any) => ({ status: () => 200, statusText: () => 'OK' }),
    reload: async (options?: any) => ({ status: () => 200, statusText: () => 'OK' }),
    close: async () => {
      isPageClosed = true;
    },
    isClosed: () => isPageClosed,
  };

  const mockContext: any = {
    newPage: async () => mockPage,
    close: async () => {
      isContextClosed = true;
    },
  };

  const mockBrowser: any = {
    newContext: async (options?: any) => mockContext,
    version: () => '130.0.0.0',
    close: async () => {
      isBrowserClosed = true;
    },
  };

  return {
    mockPage,
    mockContext,
    mockBrowser,
    elementsState,
    setMockLayoutResult: (result: LayoutCheckResult) => {
      layoutResultMock = result;
    },
    setUrl: (url: string) => {
      currentUrl = url;
    },
    setTitle: (title: string) => {
      currentTitle = title;
    },
    isPageClosed: () => isPageClosed,
    isContextClosed: () => isContextClosed,
    isBrowserClosed: () => isBrowserClosed,
  };
}

describe('WebAdapter', () => {
  const testOutputDir = path.resolve(process.cwd(), '.qa-test-output');

  afterEach(() => {
    // Clean up test output directory
    if (fs.existsSync(testOutputDir)) {
      fs.rmSync(testOutputDir, { recursive: true, force: true });
    }
  });

  describe('Capability Probing (getCapability)', () => {
    it('returns BLOCKED with npx playwright install instructions when browser is not installed or launch fails', async () => {
      const adapter = new WebAdapter({
        browserType: 'chromium',
        outputDir: testOutputDir,
      });

      const capability = await adapter.getCapability();
      expect(capability.id).toBe('web-adapter');
      expect(capability.platform).toBe('web');

      // On environment without pre-installed chromium, must report BLOCKED
      if (capability.state === 'BLOCKED') {
        expect(capability.reason).toContain('npx playwright install');
        expect(capability.missingTools).toContain('chromium');
      } else {
        expect(capability.state).toBe('AVAILABLE');
        expect(capability.version).toBeDefined();
      }
    });

    it('returns UNSUPPORTED when an invalid browser engine is configured', async () => {
      const adapter = new WebAdapter({
        browserType: 'invalid-browser' as any,
      });

      const capability = await adapter.getCapability();
      expect(capability.state).toBe('UNSUPPORTED');
      expect(capability.reason).toContain('not supported by Playwright');
    });
  });

  describe('Viewport Resolution & Matrix', () => {
    it('correctly maps all 6 viewport matrix breakpoints (320, 360, 390, 768, 1024, 1440)', () => {
      expect(resolveViewport(320)).toEqual(VIEWPORT_MATRIX[320]);
      expect(resolveViewport(360)).toEqual(VIEWPORT_MATRIX[360]);
      expect(resolveViewport(390)).toEqual(VIEWPORT_MATRIX[390]);
      expect(resolveViewport(768)).toEqual(VIEWPORT_MATRIX[768]);
      expect(resolveViewport(1024)).toEqual(VIEWPORT_MATRIX[1024]);
      expect(resolveViewport(1440)).toEqual(VIEWPORT_MATRIX[1440]);

      expect(VIEWPORT_MATRIX[320]).toEqual({ width: 320, height: 568 });
      expect(VIEWPORT_MATRIX[360]).toEqual({ width: 360, height: 640 });
      expect(VIEWPORT_MATRIX[390]).toEqual({ width: 390, height: 844 });
      expect(VIEWPORT_MATRIX[768]).toEqual({ width: 768, height: 1024 });
      expect(VIEWPORT_MATRIX[1024]).toEqual({ width: 1024, height: 768 });
      expect(VIEWPORT_MATRIX[1440]).toEqual({ width: 1440, height: 900 });
    });

    it('handles named viewport strings and custom dimension objects', () => {
      expect(resolveViewport('mobile-sm')).toEqual({ width: 320, height: 568 });
      expect(resolveViewport('tablet')).toEqual({ width: 768, height: 1024 });
      expect(resolveViewport('desktop')).toEqual({ width: 1440, height: 900 });
      expect(resolveViewport({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
      expect(resolveViewport(undefined)).toEqual({ width: 1440, height: 900 });
    });
  });

  describe('Action Execution (executeAction)', () => {
    let mockEnv: ReturnType<typeof createMockPlaywrightEnvironment>;
    let adapter: WebAdapter;

    beforeEach(async () => {
      mockEnv = createMockPlaywrightEnvironment();
      adapter = new WebAdapter({
        outputDir: testOutputDir,
        customPage: mockEnv.mockPage,
        customContext: mockEnv.mockContext,
        customBrowser: mockEnv.mockBrowser,
      });
      await adapter.initialize();
    });

    afterEach(async () => {
      await adapter.teardown();
    });

    it('executes navigate action and returns target URL and response info', async () => {
      const action = makeAction({
        type: 'navigate',
        value: 'https://test.example.org/dashboard',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
      expect(result.output.url).toBe('https://test.example.org/dashboard');
      expect(result.output.status).toBe(200);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('returns error when navigate action is called with empty URL', async () => {
      const action = makeAction({
        type: 'navigate',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(false);
      expect(result.error).toContain('navigate action requires a target or value URL');
    });

    it('executes click action', async () => {
      const action = makeAction({
        type: 'click',
        target: '#submit-btn',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
      expect(result.output.target).toBe('#submit-btn');
    });

    it('handles click failure gracefully', async () => {
      const action = makeAction({
        type: 'click',
        target: '#error-btn',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Click failed');
    });

    it('executes doubleClick action', async () => {
      const action = makeAction({
        type: 'doubleClick',
        target: '#submit-btn',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
    });

    it('executes fill action and updates element text', async () => {
      const action = makeAction({
        type: 'fill',
        target: '#username',
        value: 'qa-tester',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
      expect(result.output.value).toBe('qa-tester');

      // Verify assertion on filled text
      const assertResult = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementTextEquals',
          target: '#username',
          expected: 'qa-tester',
        })
      );
      expect(assertResult.passed).toBe(true);
    });

    it('executes type action', async () => {
      const action = makeAction({
        type: 'type',
        target: '#submit-btn',
        value: ' Clicked',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
      expect(result.output.value).toBe(' Clicked');
    });

    it('executes clear action', async () => {
      const action = makeAction({
        type: 'clear',
        target: '#submit-btn',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
    });

    it('executes pressKey action', async () => {
      const action = makeAction({
        type: 'pressKey',
        target: '#submit-btn',
        value: 'Enter',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
      expect(result.output.key).toBe('Enter');
    });

    it('executes hover action', async () => {
      const action = makeAction({
        type: 'hover',
        target: '#submit-btn',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
    });

    it('executes scroll action with delta, bottom, top, and element target', async () => {
      // Scroll by number
      const resNum = await adapter.executeAction(makeAction({ type: 'scroll', value: 400 }));
      expect(resNum.success).toBe(true);

      // Scroll to bottom
      const resBottom = await adapter.executeAction(makeAction({ type: 'scroll', value: 'bottom' }));
      expect(resBottom.success).toBe(true);

      // Scroll to top
      const resTop = await adapter.executeAction(makeAction({ type: 'scroll', value: 'top' }));
      expect(resTop.success).toBe(true);

      // Scroll to target element
      const resTarget = await adapter.executeAction(makeAction({ type: 'scroll', target: '#submit-btn' }));
      expect(resTarget.success).toBe(true);
    });

    it('executes wait action with timeout and selector', async () => {
      const resTimeout = await adapter.executeAction(makeAction({ type: 'wait', value: 10 }));
      expect(resTimeout.success).toBe(true);

      const resSelector = await adapter.executeAction(makeAction({ type: 'wait', target: '#submit-btn' }));
      expect(resSelector.success).toBe(true);
    });

    it('executes snapshot action returning htmlLength, title, and url', async () => {
      const result = await adapter.executeAction(makeAction({ type: 'snapshot' }));
      expect(result.success).toBe(true);
      expect(result.output.htmlLength).toBeGreaterThan(0);
      expect(result.output.title).toBe('Example Domain');
      expect(result.output.url).toBe('https://example.com');
    });

    it('executes rapidClicks action for stress/fuzz robustness testing', async () => {
      const action = makeAction({
        type: 'rapidClicks',
        target: '#submit-btn',
        value: 20,
        metadata: { intervalMs: 0 },
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
      expect(result.output.clicksPerformed).toBe(20);
    });

    it('executes evaluate action', async () => {
      const action = makeAction({
        type: 'evaluate',
        value: '2 + 2',
      });
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(true);
      expect(result.output.result).toBe(4);
    });

    it('executes goBack, goForward, and reload actions', async () => {
      const backRes = await adapter.executeAction(
        makeAction({ type: 'goBack' })
      );
      expect(backRes.success).toBe(true);
      expect(backRes.output.status).toBe(200);

      const fwdRes = await adapter.executeAction(
        makeAction({ type: 'goForward' })
      );
      expect(fwdRes.success).toBe(true);
      expect(fwdRes.output.status).toBe(200);

      const reloadRes = await adapter.executeAction(
        makeAction({ type: 'reload' })
      );
      expect(reloadRes.success).toBe(true);
      expect(reloadRes.output.status).toBe(200);
    });

    it('handles unsupported action type without throwing unhandled rejection', async () => {
      const action: any = {
        type: 'unknown-nonexistent-action',
      };
      const result = await adapter.executeAction(action);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported action type');
    });
  });

  describe('Assertion Evaluation (executeAssertion)', () => {
    let mockEnv: ReturnType<typeof createMockPlaywrightEnvironment>;
    let adapter: WebAdapter;

    beforeEach(async () => {
      mockEnv = createMockPlaywrightEnvironment();
      adapter = new WebAdapter({
        outputDir: testOutputDir,
        customPage: mockEnv.mockPage,
        customContext: mockEnv.mockContext,
        customBrowser: mockEnv.mockBrowser,
      });
      await adapter.initialize();
    });

    afterEach(async () => {
      await adapter.teardown();
    });

    it('evaluates elementVisible and elementHidden assertions', async () => {
      const visPass = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementVisible',
          target: '#submit-btn',
        })
      );
      expect(visPass.passed).toBe(true);

      const visFail = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementVisible',
          target: '#hidden-el',
        })
      );
      expect(visFail.passed).toBe(false);

      const hidPass = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementHidden',
          target: '#hidden-el',
        })
      );
      expect(hidPass.passed).toBe(true);
    });

    it('evaluates elementTextEquals and elementTextContains assertions', async () => {
      const equalsPass = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementTextEquals',
          target: '#submit-btn',
          expected: 'Submit',
        })
      );
      expect(equalsPass.passed).toBe(true);

      const equalsFail = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementTextEquals',
          target: '#submit-btn',
          expected: 'Cancel',
        })
      );
      expect(equalsFail.passed).toBe(false);
      expect(equalsFail.actual).toBe('Submit');

      const containsPass = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementTextContains',
          target: '#submit-btn',
          expected: 'Sub',
        })
      );
      expect(containsPass.passed).toBe(true);
    });

    it('evaluates elementDisabled and elementEnabled assertions', async () => {
      const disabledPass = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementDisabled',
          target: '#disabled-btn',
        })
      );
      expect(disabledPass.passed).toBe(true);

      const enabledPass = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementEnabled',
          target: '#submit-btn',
        })
      );
      expect(enabledPass.passed).toBe(true);

      const enabledFail = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementEnabled',
          target: '#disabled-btn',
        })
      );
      expect(enabledFail.passed).toBe(false);
    });

    it('evaluates elementCount assertion', async () => {
      const countPass = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementCount',
          target: '.item',
          expected: 3,
        })
      );
      expect(countPass.passed).toBe(true);

      const countFail = await adapter.executeAssertion(
        makeAssertion({
          type: 'elementCount',
          target: '.item',
          expected: 5,
        })
      );
      expect(countFail.passed).toBe(false);
      expect(countFail.actual).toBe(3);
    });

    it('evaluates urlMatches and titleMatches assertions', async () => {
      const urlPass = await adapter.executeAssertion(
        makeAssertion({
          type: 'urlMatches',
          expected: 'example\\.com',
        })
      );
      expect(urlPass.passed).toBe(true);

      const titlePass = await adapter.executeAssertion(
        makeAssertion({
          type: 'titleMatches',
          expected: 'Example Domain',
        })
      );
      expect(titlePass.passed).toBe(true);

      const titleFail = await adapter.executeAssertion(
        makeAssertion({
          type: 'titleMatches',
          expected: 'Nonexistent Title',
        })
      );
      expect(titleFail.passed).toBe(false);
    });

    it('evaluates consoleClean assertion tracking unhandled console errors and pageerrors', async () => {
      // Initially clean
      const initialClean = await adapter.executeAssertion(
        makeAssertion({
          type: 'consoleClean',
        })
      );
      expect(initialClean.passed).toBe(true);
      expect(initialClean.actual).toBe(0);

      // Simulate console error
      mockEnv.mockPage.emit('console', {
        type: () => 'error',
        text: () => 'Uncaught TypeError: Cannot read properties of undefined',
        location: () => ({ url: 'https://example.com/app.js', lineNumber: 42 }),
      });

      const afterError = await adapter.executeAssertion(
        makeAssertion({
          type: 'consoleClean',
        })
      );
      expect(afterError.passed).toBe(false);
      expect(afterError.actual).toBe(1);
      expect(afterError.message).toContain('TypeError');

      // Simulate uncaught pageerror
      mockEnv.mockPage.emit('pageerror', new Error('Unhandled promise rejection in bundle.js'));

      const afterPageError = await adapter.executeAssertion(
        makeAssertion({
          type: 'consoleClean',
        })
      );
      expect(afterPageError.passed).toBe(false);
      expect(afterPageError.actual).toBe(2);
    });

    it('evaluates noNetworkFailures assertion tracking HTTP 4xx/5xx and failed requests', async () => {
      // Initially zero failures
      const initialPass = await adapter.executeAssertion(
        makeAssertion({
          type: 'noNetworkFailures',
        })
      );
      expect(initialPass.passed).toBe(true);

      // Simulate 404 response
      mockEnv.mockPage.emit('response', {
        status: () => 404,
        statusText: () => 'Not Found',
        url: () => 'https://example.com/api/user/999',
        request: () => ({ method: () => 'GET' }),
      });

      const after404 = await adapter.executeAssertion(
        makeAssertion({
          type: 'noNetworkFailures',
        })
      );
      expect(after404.passed).toBe(false);
      expect(after404.actual).toBe(1);
      expect(after404.message).toContain('404');

      // Simulate network request failed
      mockEnv.mockPage.emit('requestfailed', {
        url: () => 'https://example.com/api/analytics',
        method: () => 'POST',
        failure: () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }),
      });

      const afterFailedReq = await adapter.executeAssertion(
        makeAssertion({
          type: 'noNetworkFailures',
        })
      );
      expect(afterFailedReq.passed).toBe(false);
      expect(afterFailedReq.actual).toBe(2);
      expect(afterFailedReq.message).toContain('ERR_CONNECTION_REFUSED');
    });

    it('evaluates noHydrationMismatch detecting React 18/19 hydration errors and dev-mode warnings', async () => {
      // 1. Initial clean state passes
      const cleanPass = await adapter.executeAssertion(
        makeAssertion({ type: 'noHydrationMismatch' })
      );
      expect(cleanPass.passed).toBe(true);
      expect(cleanPass.actual).toBe(0);

      // 2. React 18/19 error #418 via console error
      mockEnv.mockPage.emit('console', {
        type: () => 'error',
        text: () => 'Minified React error #418; visit https://reactjs.org/docs/error-decoder.html?invariant=418 for full message or use the non-minified dev environment for full errors and additional helpful warnings.',
        location: () => ({ url: 'https://example.com/app.js', lineNumber: 42 }),
      });

      const fail418 = await adapter.executeAssertion(
        makeAssertion({ type: 'noHydrationMismatch' })
      );
      expect(fail418.passed).toBe(false);
      expect(fail418.actual).toBe(1);
      expect(fail418.message).toContain('Minified React error #418');

      // 3. Dev-mode React console.warn matching Hydration / did not match
      mockEnv.mockPage.emit('console', {
        type: () => 'warning',
        text: () => 'Warning: Text content did not match. Server: "Welcome" Client: "Welcome Back"',
        location: () => ({ url: 'https://example.com/app.js', lineNumber: 100 }),
      });

      const failDevWarn = await adapter.executeAssertion(
        makeAssertion({ type: 'noHydrationMismatch' })
      );
      expect(failDevWarn.passed).toBe(false);
      expect(failDevWarn.actual).toBe(2);

      // 4. Pageerror with Hydration failed
      mockEnv.mockPage.emit('pageerror', new Error('Hydration failed because the initial UI does not match what was rendered on the server.'));
      const failPageError = await adapter.executeAssertion(
        makeAssertion({ type: 'noHydrationMismatch' })
      );
      expect(failPageError.passed).toBe(false);
      expect(failPageError.actual).toBe(3);
    });

    it('evaluates isElementOccluded detecting when button is occluded by sticky header or modal', async () => {
      // Non-occluded button
      const cleanPass = await adapter.executeAssertion(
        makeAssertion({ type: 'isElementOccluded', target: '#submit-btn' })
      );
      expect(cleanPass.passed).toBe(true);
      expect(cleanPass.actual).toBe(false);

      // Occluded button covered by sticky-header
      const occludedFail = await adapter.executeAssertion(
        makeAssertion({ type: 'isElementOccluded', target: '#occluded-btn' })
      );
      expect(occludedFail.passed).toBe(false);
      expect(occludedFail.actual).toBe(true);
      expect(occludedFail.message).toContain('is occluded');

      // When explicitly expecting occlusion
      const occludedPass = await adapter.executeAssertion(
        makeAssertion({ type: 'isElementOccluded', target: '#occluded-btn', expected: true })
      );
      expect(occludedPass.passed).toBe(true);
      expect(occludedPass.actual).toBe(true);
    });

    it('evaluates targetSizeAAA asserting WCAG 2.2 AAA minimum 44x44 touch targets', async () => {
      // 48x48 button meets AAA
      const passAAA = await adapter.executeAssertion(
        makeAssertion({ type: 'targetSizeAAA', target: '#submit-btn' })
      );
      expect(passAAA.passed).toBe(true);
      expect(passAAA.actual).toBe('48x48px');

      // 24x24 button fails AAA
      const failAAA = await adapter.executeAssertion(
        makeAssertion({ type: 'targetSizeAAA', target: '#small-btn' })
      );
      expect(failAAA.passed).toBe(false);
      expect(failAAA.actual).toBe('24x24px');
      expect(failAAA.message).toContain('fails WCAG 2.2 AAA');
    });

    it('evaluates noLayoutOverflow on target elements and page layout', async () => {
      // Element with no overflow (scrollWidth <= clientWidth)
      const passEl = await adapter.executeAssertion(
        makeAssertion({ type: 'noLayoutOverflow', target: '#clean-div' })
      );
      expect(passEl.passed).toBe(true);

      // Element with overflow (scrollWidth > clientWidth)
      const failEl = await adapter.executeAssertion(
        makeAssertion({ type: 'noLayoutOverflow', target: '#overflow-div' })
      );
      expect(failEl.passed).toBe(false);
      expect(failEl.actual).toContain('scrollWidth');

      // Page level
      const pagePass = await adapter.executeAssertion(
        makeAssertion({ type: 'noLayoutOverflow' })
      );
      expect(pagePass.passed).toBe(true);
    });

    it('evaluates noTextTruncation detecting clipped/ellipsis text content', async () => {
      // Clean text element (scrollWidth <= clientWidth)
      const passText = await adapter.executeAssertion(
        makeAssertion({ type: 'noTextTruncation', target: '#clean-text' })
      );
      expect(passText.passed).toBe(true);
      expect(passText.actual).toBe('not truncated');

      // Truncated text element (scrollWidth > clientWidth)
      const failText = await adapter.executeAssertion(
        makeAssertion({ type: 'noTextTruncation', target: '#truncated-text' })
      );
      expect(failText.passed).toBe(false);
      expect(failText.actual).toContain('scrollWidth (450px) > clientWidth (150px)');
    });

    it('evaluates noAccessibilityViolations for target and full-page inspection', async () => {
      // Target button with aria-label
      const passTarget = await adapter.executeAssertion(
        makeAssertion({ type: 'noAccessibilityViolations', target: '#submit-btn' })
      );
      expect(passTarget.passed).toBe(true);
      expect(passTarget.actual).toBe(true);

      // Target button missing accessible name
      const failTarget = await adapter.executeAssertion(
        makeAssertion({ type: 'noAccessibilityViolations', target: '#inaccessible-btn' })
      );
      expect(failTarget.passed).toBe(false);
      expect(failTarget.actual).toBe(false);
      expect(failTarget.message).toContain('missing accessible name');

      // Page inspection without target
      const pageInspection = await adapter.executeAssertion(
        makeAssertion({ type: 'noAccessibilityViolations' })
      );
      expect(pageInspection.passed).toBe(true);
      expect(pageInspection.actual).toBe(0);
    });
  });

  describe('Evidence Capture (captureEvidence)', () => {
    let mockEnv: ReturnType<typeof createMockPlaywrightEnvironment>;
    let adapter: WebAdapter;

    beforeEach(async () => {
      mockEnv = createMockPlaywrightEnvironment();
      adapter = new WebAdapter({
        outputDir: testOutputDir,
        customPage: mockEnv.mockPage,
        customContext: mockEnv.mockContext,
        customBrowser: mockEnv.mockBrowser,
      });
      await adapter.initialize();
    });

    afterEach(async () => {
      await adapter.teardown();
    });

    it('captures full-page screenshot, writes to output directory, and computes valid SHA-256', async () => {
      const artifact = await adapter.captureEvidence('SCREENSHOT', 'Full page snapshot before click');

      // Validate against EvidenceArtifactSchema
      expect(() => EvidenceArtifactSchema.parse(artifact)).not.toThrow();
      expect(artifact.type).toBe('SCREENSHOT');
      expect(artifact.mimeType).toBe('image/png');
      expect(fs.existsSync(artifact.path)).toBe(true);
      expect(artifact.sizeBytes).toBeGreaterThan(0);

      // Verify SHA-256 hash
      const fileBytes = fs.readFileSync(artifact.path);
      const computedHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
      expect(artifact.sha256).toBe(computedHash);
    });

    it('captures DOM snapshot as valid HTML evidence artifact', async () => {
      const artifact = await adapter.captureEvidence('DOM_SNAPSHOT', 'DOM dump');

      expect(artifact.type).toBe('DOM_SNAPSHOT');
      expect(artifact.mimeType).toBe('text/html');
      expect(fs.existsSync(artifact.path)).toBe(true);
      const content = fs.readFileSync(artifact.path, 'utf-8');
      expect(content).toContain('Example Domain');
    });

    it('captures CONSOLE_LOG evidence artifact', async () => {
      mockEnv.mockPage.emit('console', {
        type: () => 'info',
        text: () => 'Application started',
        location: () => ({ url: 'https://example.com', lineNumber: 1 }),
      });

      const artifact = await adapter.captureEvidence('CONSOLE_LOG', 'Console entries');
      expect(artifact.type).toBe('CONSOLE_LOG');
      expect(artifact.mimeType).toBe('application/json');
      expect(fs.existsSync(artifact.path)).toBe(true);
    });
  });

  describe('Layout Checks (checkLayout)', () => {
    let mockEnv: ReturnType<typeof createMockPlaywrightEnvironment>;
    let adapter: WebAdapter;

    beforeEach(async () => {
      mockEnv = createMockPlaywrightEnvironment();
      adapter = new WebAdapter({
        outputDir: testOutputDir,
        customPage: mockEnv.mockPage,
        customContext: mockEnv.mockContext,
        customBrowser: mockEnv.mockBrowser,
      });
      await adapter.initialize();
    });

    afterEach(async () => {
      await adapter.teardown();
    });

    it('reports no issues when page layout is completely valid', async () => {
      mockEnv.setMockLayoutResult({
        hasIssues: false,
        horizontalOverflow: false,
        issues: [],
        metrics: {
          clientWidth: 1440,
          scrollWidth: 1440,
          clientHeight: 900,
          scrollHeight: 900,
        },
      });

      const result = await adapter.checkLayout();
      expect(result.hasIssues).toBe(false);
      expect(result.horizontalOverflow).toBe(false);
      expect(result.issues).toHaveLength(0);

      // Also verify through custom layout assertion
      const assertion = await adapter.executeAssertion(
        makeAssertion({
          type: 'custom',
          target: 'layout',
        })
      );
      expect(assertion.passed).toBe(true);
    });

    it('detects horizontal overflow when scrollWidth > clientWidth', async () => {
      mockEnv.setMockLayoutResult({
        hasIssues: true,
        horizontalOverflow: true,
        issues: [
          {
            type: 'HORIZONTAL_OVERFLOW',
            selector: '#wide-table',
            tagName: 'table',
            details: 'Element extends 250px beyond viewport width (1440px).',
            rect: { x: 0, y: 100, width: 1690, height: 400 },
          },
        ],
        metrics: {
          clientWidth: 1440,
          scrollWidth: 1690,
          clientHeight: 900,
          scrollHeight: 900,
        },
      });

      const result = await adapter.checkLayout();
      expect(result.hasIssues).toBe(true);
      expect(result.horizontalOverflow).toBe(true);
      expect(result.issues[0].type).toBe('HORIZONTAL_OVERFLOW');
      expect(result.issues[0].selector).toBe('#wide-table');

      // Verify custom layout assertion catches it and fails
      const assertion = await adapter.executeAssertion(
        makeAssertion({
          type: 'custom',
          target: 'layout',
        })
      );
      expect(assertion.passed).toBe(false);
      expect(assertion.message).toContain('HORIZONTAL_OVERFLOW');
    });

    it('detects clipped elements with overflow:hidden and truncated scrollHeight', async () => {
      mockEnv.setMockLayoutResult({
        hasIssues: true,
        horizontalOverflow: false,
        issues: [
          {
            type: 'CLIPPED_ELEMENT',
            selector: '.card-description',
            tagName: 'div',
            details: 'Vertical clipping: scrollHeight (180px) exceeds clientHeight (60px) with overflow: hidden',
            rect: { x: 50, y: 200, width: 300, height: 60 },
          },
        ],
        metrics: {
          clientWidth: 1440,
          scrollWidth: 1440,
          clientHeight: 900,
          scrollHeight: 900,
        },
      });

      const result = await adapter.checkLayout();
      expect(result.hasIssues).toBe(true);
      expect(result.issues.some((i) => i.type === 'CLIPPED_ELEMENT')).toBe(true);
    });

    it('detects offscreen controls positioned outside viewport coordinates', async () => {
      mockEnv.setMockLayoutResult({
        hasIssues: true,
        horizontalOverflow: false,
        issues: [
          {
            type: 'OFFSCREEN_CONTROL',
            selector: '#hidden-modal-action',
            tagName: 'button',
            details: 'Interactive control is outside visible bounds at (x: -9999, y: 0, w: 100, h: 40)',
            rect: { x: -9999, y: 0, width: 100, height: 40 },
          },
        ],
        metrics: {
          clientWidth: 1440,
          scrollWidth: 1440,
          clientHeight: 900,
          scrollHeight: 900,
        },
      });

      const result = await adapter.checkLayout();
      expect(result.hasIssues).toBe(true);
      expect(result.issues.some((i) => i.type === 'OFFSCREEN_CONTROL')).toBe(true);
    });
  });

  describe('Teardown and Lifecycle Cleanup', () => {
    it('safely closes page, context, and browser and resets internal state', async () => {
      const mockEnv = createMockPlaywrightEnvironment();
      const adapter = new WebAdapter({
        customPage: mockEnv.mockPage,
        customContext: mockEnv.mockContext,
        customBrowser: mockEnv.mockBrowser,
      });

      await adapter.initialize();
      expect(adapter.getPage()).toBeDefined();
      expect(adapter.getContext()).toBeDefined();
      expect(adapter.getBrowser()).toBeDefined();

      await adapter.teardown();

      expect(mockEnv.isPageClosed()).toBe(true);
      expect(mockEnv.isContextClosed()).toBe(true);
      expect(mockEnv.isBrowserClosed()).toBe(true);
      expect(adapter.getPage()).toBeUndefined();
      expect(adapter.getContext()).toBeUndefined();
      expect(adapter.getBrowser()).toBeUndefined();

      // Subsequent calls to teardown should not throw (idempotent)
      await expect(adapter.teardown()).resolves.toBeUndefined();
    });

    it('handles teardown cleanly when page.close() throws', async () => {
      const mockEnv = createMockPlaywrightEnvironment();
      mockEnv.mockPage.close = async () => {
        throw new Error('Forced page close failure');
      };

      const adapter = new WebAdapter({
        customPage: mockEnv.mockPage,
        customContext: mockEnv.mockContext,
        customBrowser: mockEnv.mockBrowser,
      });

      await adapter.initialize();
      // Should still close context and browser via finally blocks
      await expect(adapter.teardown()).resolves.toBeUndefined();
      expect(mockEnv.isContextClosed()).toBe(true);
      expect(mockEnv.isBrowserClosed()).toBe(true);
    });
  });

  describe('Uninitialized & Boundary Edge Cases', () => {
    it('returns structured errors when actions or assertions are called on uninitialized adapter', async () => {
      const uninitAdapter = new WebAdapter();

      const actionRes = await uninitAdapter.executeAction(
        makeAction({ type: 'click', target: '#btn' })
      );
      expect(actionRes.success).toBe(false);
      expect(actionRes.error).toContain('not initialized');

      const assertRes = await uninitAdapter.executeAssertion(
        makeAssertion({ type: 'elementVisible', target: '#btn' })
      );
      expect(assertRes.passed).toBe(false);
      expect(assertRes.message).toContain('not initialized');

      await expect(uninitAdapter.captureEvidence('SCREENSHOT')).rejects.toThrow('not initialized');
      await expect(uninitAdapter.checkLayout()).rejects.toThrow('not initialized');
      await expect(uninitAdapter.teardown()).resolves.toBeUndefined();
    });

    it('evaluates status200 assertion against network requests', async () => {
      const mockEnv = createMockPlaywrightEnvironment();
      const adapter = new WebAdapter({
        customPage: mockEnv.mockPage,
        customContext: mockEnv.mockContext,
        customBrowser: mockEnv.mockBrowser,
      });
      await adapter.initialize();

      // Simulate a 200 response for main document
      mockEnv.mockPage.emit('response', {
        status: () => 200,
        statusText: () => 'OK',
        url: () => 'https://example.com/',
        request: () => ({ method: () => 'GET' }),
      });

      const passRes = await adapter.executeAssertion(
        makeAssertion({ type: 'status200' })
      );
      expect(passRes.passed).toBe(true);
      expect(passRes.actual).toBe(200);

      // Simulate a 204 beacon and favicon: status200 should still check main document, not 204 beacon/favicon
      mockEnv.mockPage.emit('response', {
        status: () => 204,
        statusText: () => 'No Content',
        url: () => 'https://example.com/beacon',
        request: () => ({ method: () => 'POST' }),
      });
      mockEnv.mockPage.emit('response', {
        status: () => 204,
        statusText: () => 'No Content',
        url: () => 'https://example.com/favicon.ico',
        request: () => ({ method: () => 'GET' }),
      });

      const beaconPassRes = await adapter.executeAssertion(
        makeAssertion({ type: 'status200' })
      );
      expect(beaconPassRes.passed).toBe(true);
      expect(beaconPassRes.actual).toBe(200);

      // Simulate a 500 response on an API endpoint
      mockEnv.mockPage.emit('response', {
        status: () => 500,
        statusText: () => 'Internal Server Error',
        url: () => 'https://example.com/api',
        request: () => ({ method: () => 'POST' }),
      });

      // Target URL matching evaluates status for that specific request
      const failRes = await adapter.executeAssertion(
        makeAssertion({ type: 'status200', target: 'https://example.com/api' })
      );
      expect(failRes.passed).toBe(false);
      expect(failRes.actual).toBe(500);

      await adapter.teardown();
    });

    it('clears error logs and allows diagnostics inspection', async () => {
      const mockEnv = createMockPlaywrightEnvironment();
      const adapter = new WebAdapter({
        customPage: mockEnv.mockPage,
        customContext: mockEnv.mockContext,
        customBrowser: mockEnv.mockBrowser,
      });
      await adapter.initialize();

      mockEnv.mockPage.emit('console', {
        type: () => 'error',
        text: () => 'Test error message',
        location: () => undefined,
      });

      expect(adapter.getConsoleErrors()).toHaveLength(1);
      expect(adapter.getConsoleLogs()).toHaveLength(1);

      adapter.clearErrors();
      expect(adapter.getConsoleErrors()).toHaveLength(0);

      await adapter.teardown();
    });
  });

  describe('Integration with @agentic-qa/core RunLifecycle', () => {
    it('executes a complete multi-step test plan through RunLifecycle with WebAdapter', async () => {
      const mockEnv = createMockPlaywrightEnvironment();
      const adapter = new WebAdapter({
        outputDir: testOutputDir,
        customPage: mockEnv.mockPage,
        customContext: mockEnv.mockContext,
        customBrowser: mockEnv.mockBrowser,
      });

      const testPlan = TestPlanSchema.parse({
        planId: 'plan-web-01',
        name: 'Web Smoke Test Plan',
        targetApp: 'https://example.com',
        platform: 'web',
        environment: 'staging',
        createdAt: new Date().toISOString(),
        metadata: {},
        scenarios: [
          {
            id: 'TC-01',
            title: 'Verify Page Navigation and Submit Button Presence',
            description: 'Navigate to app, verify title, click submit, verify console is clean',
            platform: 'web',
            timeoutMs: 30000,
            retries: 0,
            tags: ['smoke', 'web'],
            expectedOutcome: 'PASS',
            steps: [
              {
                id: 'S-01',
                description: 'Navigate to target web application',
                action: {
                  type: 'navigate',
                  value: 'https://example.com',
                },
                assertion: {
                  type: 'urlMatches',
                  expected: 'example\\.com',
                },
                continueOnFailure: false,
              },
              {
                id: 'S-02',
                description: 'Verify submit button is visible and click it',
                action: {
                  type: 'click',
                  target: '#submit-btn',
                },
                assertion: {
                  type: 'elementVisible',
                  target: '#submit-btn',
                },
                continueOnFailure: false,
              },
              {
                id: 'S-03',
                description: 'Verify console remains clean with zero errors',
                assertion: {
                  type: 'consoleClean',
                },
                continueOnFailure: false,
              },
            ],
          },
        ],
      });

      // Mock capability as AVAILABLE for this integration test
      vi.spyOn(adapter, 'getCapability').mockResolvedValue({
        id: adapter.id,
        name: adapter.name,
        platform: 'web',
        state: 'AVAILABLE',
        requiredTools: ['playwright', 'chromium'],
        missingTools: [],
        metadata: {},
      });

      const lifecycle = new RunLifecycle(adapter, testPlan, [
        {
          id: adapter.id,
          name: adapter.name,
          platform: 'web',
          state: 'AVAILABLE',
          requiredTools: ['playwright', 'chromium'],
          missingTools: [],
          metadata: {},
        },
      ]);

      const report = await lifecycle.execute();

      expect(report.overallStatus).toBe('PASSED');
      expect(report.summary.totalTests).toBe(1);
      expect(report.summary.passed).toBe(1);
      expect(report.summary.failed).toBe(0);
      expect(report.trustScore.score).toBeGreaterThan(0);
      expect(report.testResults[0].stepResults).toHaveLength(3);
      expect(report.testResults[0].stepResults.every((s) => s.status === 'PASSED')).toBe(true);
    });
  });
});
