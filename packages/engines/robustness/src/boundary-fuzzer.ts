import { PlatformAdapter } from '@agentic-qa/core';
import {
  ActionSpec,
  Finding,
  FindingSchema,
} from '@agentic-qa/schemas';
import {
  BoundaryFuzzerOptions,
  BoundaryFuzzerResult,
  FuzzCategory,
  FuzzPayload,
  FuzzPayloadResult,
  createActionSpec,
  createAssertionSpec,
} from './types.js';

/**
 * Standard built-in boundary and fuzz payloads database.
 */
export const DEFAULT_FUZZ_PAYLOADS: FuzzPayload[] = [
  // 1. SQL Injection strings
  {
    id: 'SQLI-01',
    name: 'Classic tautology quote bypass',
    category: 'sql_injection',
    value: "' OR '1'='1",
    description: "Classic single-quote SQL injection tautology (' OR '1'='1)",
    expectedBehavior: 'Input should be sanitized or parameterized; must return validation error or 400, not 500.',
  },
  {
    id: 'SQLI-02',
    name: 'Stacked query table drop',
    category: 'sql_injection',
    value: "'; DROP TABLE users; --",
    description: 'Stacked query attempt to drop table',
    expectedBehavior: 'Input sanitized/rejected without executing multiple statements or throwing DB error.',
  },
  {
    id: 'SQLI-03',
    name: 'Comment-out admin bypass',
    category: 'sql_injection',
    value: "admin'--",
    description: 'Admin username SQL comment delimiter',
    expectedBehavior: 'Input treated as literal string.',
  },
  {
    id: 'SQLI-04',
    name: 'Double quote tautology',
    category: 'sql_injection',
    value: '" OR ""="',
    description: 'Double-quote SQL injection tautology',
    expectedBehavior: 'Input treated as literal string.',
  },
  {
    id: 'SQLI-05',
    name: 'Union select extract',
    category: 'sql_injection',
    value: "1' UNION SELECT 1, 'admin', 'password'--",
    description: 'Union based query extraction',
    expectedBehavior: 'Input rejected or parameterized.',
  },

  // 2. XSS payloads
  {
    id: 'XSS-01',
    name: 'Classic script tag injection',
    category: 'xss',
    value: "<script>alert('XSS')</script>",
    description: 'Standard script element injection',
    expectedBehavior: 'Input escaped / sanitized; not executed as script in DOM.',
  },
  {
    id: 'XSS-02',
    name: 'Image tag error event handler',
    category: 'xss',
    value: "<img src=x onerror=alert('XSS')>",
    description: 'HTML image tag with onerror JavaScript trigger',
    expectedBehavior: 'HTML escaped or stripped.',
  },
  {
    id: 'XSS-03',
    name: 'SVG onload trigger',
    category: 'xss',
    value: '"><svg onload=alert(1)>',
    description: 'Context-breaking SVG element with onload handler',
    expectedBehavior: 'HTML escaped; attribute context preserved.',
  },
  {
    id: 'XSS-04',
    name: 'Pseudo-protocol javascript URI',
    category: 'xss',
    value: 'javascript:alert(1)',
    description: 'JavaScript pseudo-protocol payload',
    expectedBehavior: 'Rejected or sanitized as invalid URI.',
  },
  {
    id: 'XSS-05',
    name: 'Template expression injection',
    category: 'xss',
    value: '{{7*7}}',
    description: 'Server-side / client-side template expression',
    expectedBehavior: 'Rendered as literal string {{7*7}}, not evaluated to 49.',
  },

  // 3. Unicode emoji, RTL, zero-width, astral planes
  {
    id: 'UNICODE-01',
    name: 'Multi-byte emoji sequence',
    category: 'unicode',
    value: '🔥🚀🎉💩✨💯👾🦾👻🌈💥',
    description: 'High-surrogate emoji sequence',
    expectedBehavior: 'Stored and displayed properly without UTF-8 encoding corruption.',
  },
  {
    id: 'UNICODE-02',
    name: 'Zero-width joiners and spaces',
    category: 'unicode',
    value: 'user\u200Bname\u200Cwith\u200Dzero\uFEFFwidth',
    description: 'Zero-width characters (ZWSP, ZWNJ, ZWJ, BOM)',
    expectedBehavior: 'Trimmed, sanitized, or stored without crashing string parsers.',
  },
  {
    id: 'UNICODE-03',
    name: 'Right-to-Left (RTL) override',
    category: 'unicode',
    value: '\u202Ereversed_display_name\u202C',
    description: 'BiDi override character manipulating visual text flow',
    expectedBehavior: 'Handled safely without breaking surrounding UI layout or crashing.',
  },
  {
    id: 'UNICODE-04',
    name: 'Zalgo combining diacritics',
    category: 'unicode',
    value: 'T̷̡ḩ̶e̶̛ ̶̛V̸̧o̵̧i̶̛d̸',
    description: 'Deeply stacked unicode combining characters (Zalgo text)',
    expectedBehavior: 'Rendered without overflow clipping or layout explosion.',
  },
  {
    id: 'UNICODE-05',
    name: 'Astral plane CJK extension',
    category: 'unicode',
    value: '𠜎𠜱𠝹𠱓𠱸𠲖𠳏',
    description: '4-byte astral plane characters requiring surrogate pair handling',
    expectedBehavior: 'Handled without string truncation or MySQL utf8mb3 crash.',
  },

  // 4. Extremely long strings (100KB)
  {
    id: 'LONG-01',
    name: '100KB repetitive ASCII string',
    category: 'long_string',
    value: 'A'.repeat(102400), // Exactly 100 KB
    description: '100 Kilobytes continuous ASCII string',
    expectedBehavior: 'Gracefully rejected with field length validation or handled without memory leak / crash.',
  },
  {
    id: 'LONG-02',
    name: '100KB multi-byte emoji string',
    category: 'long_string',
    value: '🚀'.repeat(25600), // ~100 KB in UTF-8
    description: '100 Kilobytes 4-byte UTF-8 emoji string',
    expectedBehavior: 'Handled or rejected with length limit without buffer overflow.',
  },
  {
    id: 'LONG-03',
    name: 'Format string repetitions',
    category: 'long_string',
    value: '%s%d%n'.repeat(1000),
    description: 'Format string tokens repeated 1000 times',
    expectedBehavior: 'Treated as literal string, no format string parsing vulnerabilities.',
  },

  // 5. Negative numbers & numeric boundaries
  {
    id: 'NUM-01',
    name: 'Negative integer',
    category: 'numeric_boundary',
    value: '-1',
    description: 'Negative one value in numeric or quantity field',
    expectedBehavior: 'Validated against non-negative constraint if applicable.',
  },
  {
    id: 'NUM-02',
    name: 'Extremely large negative number',
    category: 'numeric_boundary',
    value: '-999999999999',
    description: 'Out of bounds negative number',
    expectedBehavior: 'Rejected gracefully with range validation error.',
  },
  {
    id: 'NUM-03',
    name: '32-bit signed integer minimum',
    category: 'numeric_boundary',
    value: '-2147483648',
    description: 'INT32_MIN boundary value',
    expectedBehavior: 'Handled without integer underflow or wrapping.',
  },
  {
    id: 'NUM-04',
    name: 'JavaScript MAX_SAFE_INTEGER',
    category: 'numeric_boundary',
    value: '9007199254740991',
    description: 'Number.MAX_SAFE_INTEGER boundary',
    expectedBehavior: 'Handled without precision loss or JSON deserialization failure.',
  },
  {
    id: 'NUM-05',
    name: 'Negative zero and extreme float precision',
    category: 'numeric_boundary',
    value: '-0.000000000000000000000001',
    description: 'Subnormal floating point number with negative sign',
    expectedBehavior: 'Parsed or formatted gracefully.',
  },
  {
    id: 'NUM-06',
    name: 'Special numeric tokens NaN and Infinity',
    category: 'numeric_boundary',
    value: 'NaN',
    description: 'NaN literal token',
    expectedBehavior: 'Rejected as non-numeric instead of propagating NaN state.',
  },

  // 6. Null characters and control characters
  {
    id: 'NULL-01',
    name: 'Literal null byte character',
    category: 'null_bytes',
    value: '\0',
    description: 'Null byte character (\\0 / U+0000)',
    expectedBehavior: 'Stripped or validated without C-string null termination truncation.',
  },
  {
    id: 'NULL-02',
    name: 'Embedded null byte with payload',
    category: 'null_bytes',
    value: 'admin\0.jpg',
    description: 'Null byte string termination attack',
    expectedBehavior: 'Treated securely without file extension or auth bypass.',
  },
  {
    id: 'NULL-03',
    name: 'URL encoded null byte',
    category: 'null_bytes',
    value: '%00',
    description: 'URL-encoded null byte string',
    expectedBehavior: 'Validated as invalid input or decoded safely.',
  },
  {
    id: 'NULL-04',
    name: 'Control characters and CRLF injection',
    category: 'null_bytes',
    value: 'test\r\nHeader-Injection: true\r\n\r\nbody',
    description: 'Carriage return and newline characters for header/log injection',
    expectedBehavior: 'CRLF characters stripped or escaped in single-line inputs.',
  },
  {
    id: 'NULL-05',
    name: 'Null literal strings',
    category: 'null_bytes',
    value: 'null',
    description: 'String "null" literal that could be coerced to object null',
    expectedBehavior: 'Treated as literal string "null", not coerced to null pointer.',
  },
];

/**
 * BoundaryFuzzer tests text input robustness against extreme edge cases:
 * SQL injection, XSS payloads, Unicode emoji, 100KB strings, negative numbers, and null bytes.
 * Verifies graceful validation vs unhandled 500 errors or application crashes.
 */
export class BoundaryFuzzer {
  constructor(private readonly adapter: PlatformAdapter) {}

  async run(options: BoundaryFuzzerOptions): Promise<BoundaryFuzzerResult> {
    const startTime = Date.now();
    const categories = options.categories ?? [
      'sql_injection',
      'xss',
      'unicode',
      'long_string',
      'numeric_boundary',
      'null_bytes',
    ];

    let payloads = DEFAULT_FUZZ_PAYLOADS.filter((p) => categories.includes(p.category));

    if (options.customPayloads && options.customPayloads.length > 0) {
      payloads = [...options.customPayloads, ...payloads];
    }

    if (options.fuzzIterations && options.fuzzIterations > 0) {
      payloads = payloads.slice(0, options.fuzzIterations);
    }

    const payloadResults: FuzzPayloadResult[] = [];
    const findings: Finding[] = [];

    for (const payload of payloads) {
      const payloadStart = Date.now();
      let handledGracefully = true;
      let failureError: string | undefined;
      let statusCode: number | undefined;

      try {
        // 1. Clear existing input
        await this.adapter.executeAction(
          createActionSpec({
            type: 'clear',
            target: options.targetInput,
            description: `Clearing input '${options.targetInput}' before payload ${payload.id}`,
          })
        );

        // 2. Fill with fuzz payload
        const fillResult = await this.adapter.executeAction(
          createActionSpec({
            type: 'fill',
            target: options.targetInput,
            value: payload.value,
            description: `Injecting ${payload.category} payload '${payload.name}' into '${options.targetInput}'`,
          })
        );

        if (!fillResult.success && fillResult.error) {
          // If the browser/adapter refused to fill due to crash or unhandled error
          if (!fillResult.error.toLowerCase().includes('maxlength')) {
            handledGracefully = false;
            failureError = `Failed to fill payload into input: ${fillResult.error}`;
          }
        }

        // 3. Submit form if submit target or action is configured
        if (options.submitTarget || options.submitAction) {
          const submitAction: ActionSpec =
            options.submitAction ??
            createActionSpec({
              type: 'click',
              target: options.submitTarget,
              description: `Submit form after fuzz payload ${payload.id}`,
            });

          const submitResult = await this.adapter.executeAction(submitAction);
          if (!submitResult.success && submitResult.error) {
            // Unhandled submit error
            if (submitResult.error.includes('500') || submitResult.error.toLowerCase().includes('crash')) {
              handledGracefully = false;
              failureError = `Submit action failed with crash/error: ${submitResult.error}`;
            }
          }
        }

        // 4. Assertions for graceful validation vs 500 / unhandled crash
        // A: Check for 5xx server errors / network crashes
        try {
          const networkCheck = await this.adapter.executeAssertion(
            createAssertionSpec({
              type: 'noNetworkFailures',
              message: `Verify no 500 server errors occurred on payload ${payload.id}`,
            })
          );

          if (!networkCheck.passed) {
            handledGracefully = false;
            failureError = networkCheck.message || '500 Server Error or network crash detected';
            statusCode = 500;
          }
        } catch (err: any) {
          handledGracefully = false;
          failureError = `Network assertion failed: ${err.message}`;
        }

        // B: Check for unhandled client-side JavaScript crashes
        try {
          const consoleCheck = await this.adapter.executeAssertion(
            createAssertionSpec({
              type: 'consoleClean',
              message: `Verify zero uncaught exceptions on payload ${payload.id}`,
            })
          );

          if (!consoleCheck.passed) {
            handledGracefully = false;
            failureError =
              failureError ? `${failureError}; Console crash: ${consoleCheck.message}` : consoleCheck.message;
          }
        } catch {
          // Optional
        }

        // C: Check if UI input or container is still alive (not white screen of death)
        try {
          const elementAlive = await this.adapter.executeAssertion(
            createAssertionSpec({
              type: 'elementExists',
              target: options.targetInput,
            })
          );

          if (!elementAlive.passed && !options.submitTarget) {
            handledGracefully = false;
            failureError =
              failureError ? `${failureError}; UI crashed/unmounted unexpectedly` : 'UI unmounted or crashed to blank screen';
          }
        } catch {
          // Optional
        }

        // D: Custom validator hook if provided
        if (options.validateGracefulHandling) {
          const customCheck = await options.validateGracefulHandling(payload, {
            success: handledGracefully,
            error: failureError,
          });
          if (!customCheck.handledGracefully) {
            handledGracefully = false;
            failureError = customCheck.reason || failureError || 'Custom validation marked failure';
          }
        }
      } catch (err: any) {
        handledGracefully = false;
        failureError = `Unhandled exception during fuzzer execution: ${err.message}`;
      }

      let payloadFinding: Finding | undefined;

      if (!handledGracefully) {
        const isCritical =
          statusCode === 500 ||
          failureError?.includes('500') ||
          failureError?.toLowerCase().includes('crash');

        const now = new Date().toISOString();
        payloadFinding = FindingSchema.parse({
          id: `FIND-FUZZ-${payload.id}-${Date.now()}`,
          title: `Unhandled failure on ${payload.category} payload: ${payload.name}`,
          description:
            `Boundary fuzzer injected ${payload.category} payload '${payload.name}' into '${options.targetInput}'. ` +
            `The application failed to validate gracefully and produced an unhandled crash: ${failureError}`,
          severity: isCritical ? 'CRITICAL' : 'HIGH',
          status: 'CONFIRMED',
          fixVerification: 'UNVERIFIED',
          platform: this.adapter.platform,
          preconditions: [
            `Target input selector: ${options.targetInput}`,
            `Payload category: ${payload.category}`,
            `Payload ID: ${payload.id}`,
          ],
          reproductionSteps: [
            `1. Focus target input '${options.targetInput}'.`,
            `2. Inject payload: ${payload.value.length > 100 ? `${payload.value.substring(0, 100)}... (${payload.value.length} bytes)` : JSON.stringify(payload.value)}.`,
            options.submitTarget ? `3. Click submit element '${options.submitTarget}'.` : '3. Trigger blur/change event.',
            `4. Observe unhandled error / crash: ${failureError}.`,
          ],
          expectedBehavior:
            payload.expectedBehavior ??
            `Input must be gracefully validated (e.g. 400 Bad Request or user-facing validation message), without 500 errors, unhandled exceptions, or application crashes.`,
          actualBehavior: `Application crashed or threw unhandled error: ${failureError}`,
          evidenceIds: [],
          reproducibilityCount: 1,
          reproducibilitySuccessRate: 1.0,
          logsExcerpt: failureError,
          detectedAt: now,
          metadata: {
            payloadId: payload.id,
            payloadName: payload.name,
            category: payload.category,
            targetInput: options.targetInput,
            payloadLength: payload.value.length,
            error: failureError,
          },
        });

        findings.push(payloadFinding);
      }

      payloadResults.push({
        payload,
        success: handledGracefully,
        handledGracefully,
        statusCode,
        error: failureError,
        durationMs: Date.now() - payloadStart,
        finding: payloadFinding,
      });
    }

    const passedCount = payloadResults.filter((r) => r.handledGracefully).length;
    const failedCount = payloadResults.filter((r) => !r.handledGracefully).length;
    const passed = failedCount === 0;

    return {
      passed,
      targetInput: options.targetInput,
      totalTested: payloadResults.length,
      passedCount,
      failedCount,
      payloadResults,
      findings,
      durationMs: Date.now() - startTime,
    };
  }
}
