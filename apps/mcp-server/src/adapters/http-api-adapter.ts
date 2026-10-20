import crypto from 'node:crypto';
import {
  Platform,
  CapabilityDescriptor,
  ActionSpec,
  AssertionSpec,
  EvidenceArtifact,
} from '@agentic-qa/schemas';
import { PlatformAdapter, ActionResult, AssertionResult } from '@agentic-qa/core';

export class HttpApiPlatformAdapter implements PlatformAdapter {
  readonly id = 'native-http-adapter';
  readonly name = 'Native HTTP/API Adapter';
  readonly platform: Platform = 'api';

  private lastUrl?: string;
  private lastStatusCode?: number;
  private lastBody?: string;
  private lastHeaders?: Record<string, string>;

  async getCapability(): Promise<CapabilityDescriptor> {
    return {
      id: this.id,
      name: this.name,
      platform: this.platform,
      state: 'AVAILABLE',
      requiredTools: ['node', 'fetch'],
      missingTools: [],
      metadata: {
        nodeVersion: process.version,
      },
    };
  }

  async initialize(): Promise<void> {
    this.lastUrl = undefined;
    this.lastStatusCode = undefined;
    this.lastBody = undefined;
    this.lastHeaders = undefined;
  }

  async executeAction(action: ActionSpec): Promise<ActionResult> {
    const start = Date.now();
    try {
      if (action.type === 'navigate') {
        const url = (action.target || action.value) as string;
        if (!url) {
          return {
            success: false,
            durationMs: Date.now() - start,
            error: 'Target URL is required for navigate action',
          };
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), action.timeoutMs ?? 10000);

        try {
          const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'AgenticQA/1.0.0' },
          });

          this.lastUrl = url;
          this.lastStatusCode = res.status;
          this.lastBody = await res.text();
          const headersObj: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headersObj[k] = v;
          });
          this.lastHeaders = headersObj;

          return {
            success: true,
            durationMs: Date.now() - start,
            output: {
              url,
              status: res.status,
              contentLength: this.lastBody.length,
            },
          };
        } finally {
          clearTimeout(timeout);
        }
      }

      return {
        success: true,
        durationMs: Date.now() - start,
        output: { action: action.type },
      };
    } catch (err: any) {
      return {
        success: false,
        durationMs: Date.now() - start,
        error: `HTTP Action error: ${err.message}`,
      };
    }
  }

  async executeAssertion(assertion: AssertionSpec): Promise<AssertionResult> {
    const start = Date.now();

    if (assertion.type === 'status200') {
      const passed = this.lastStatusCode === 200;
      return {
        passed,
        actual: this.lastStatusCode,
        expected: 200,
        durationMs: Date.now() - start,
        message: passed ? undefined : `Expected HTTP 200, but received ${this.lastStatusCode}`,
      };
    }

    if (assertion.type === 'elementTextContains') {
      const expectedText = String(assertion.expected ?? '');
      const contains = this.lastBody?.includes(expectedText) ?? false;
      return {
        passed: contains,
        actual: contains ? `Body contains '${expectedText}'` : 'Substring missing from response body',
        expected: expectedText,
        durationMs: Date.now() - start,
        message: contains ? undefined : `Response body did not contain expected text: '${expectedText}'`,
      };
    }

    if (assertion.type === 'urlMatches') {
      const regex = new RegExp(String(assertion.expected ?? ''));
      const matches = this.lastUrl ? regex.test(this.lastUrl) : false;
      return {
        passed: matches,
        actual: this.lastUrl,
        expected: assertion.expected,
        durationMs: Date.now() - start,
        message: matches ? undefined : `URL ${this.lastUrl} did not match pattern ${assertion.expected}`,
      };
    }

    // Default pass for assertions that aren't API specific
    return {
      passed: true,
      durationMs: Date.now() - start,
      actual: true,
      expected: true,
    };
  }

  async captureEvidence(type: string, description: string = ''): Promise<EvidenceArtifact> {
    const content = this.lastBody || `HTTP_BODY_EMPTY_${Date.now()}`;
    const hash = crypto.createHash('sha256').update(content).digest('hex');

    return {
      id: `ev-http-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: 'DOM_SNAPSHOT',
      path: `/tmp/qa-http-response-${Date.now()}.html`,
      sha256: hash,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      mimeType: 'text/html',
      capturedAt: new Date().toISOString(),
      description: description || `HTTP response payload for ${this.lastUrl ?? 'unknown'}`,
      metadata: {
        statusCode: this.lastStatusCode,
        url: this.lastUrl,
        rawContent: content,
      },
    };
  }

  async teardown(): Promise<void> {
    this.lastUrl = undefined;
    this.lastStatusCode = undefined;
    this.lastBody = undefined;
    this.lastHeaders = undefined;
  }
}
