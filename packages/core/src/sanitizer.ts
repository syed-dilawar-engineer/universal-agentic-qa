/**
 * Secret and credential redaction engine.
 *
 * Sanitizes logs, DOM snapshots, errors, evidence, and reports before persistence.
 * Replaces credentials with identifiable redaction placeholders while preserving diagnostic context.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: any[]) => string);
}

export const REDACTION_RULES: RedactionRule[] = [
  // 1. Private Keys (RSA, EC, OpenSSH, etc.)
  {
    name: 'private_key',
    pattern: /-----BEGIN [A-Z0-9_-]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9_-]+ PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },

  // 2. Authorization Headers with Bearer or Basic tokens
  {
    name: 'auth_header',
    pattern: /((?:authorization|proxy-authorization)\s*:\s*)(?:Bearer|Basic)\s+[^\s"';,]+/gi,
    replacement: '$1Bearer [REDACTED]',
  },

  // 3. Bearer Tokens in prose, logs, or JSON strings
  {
    name: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replacement: 'Bearer [REDACTED]',
  },

  // 4. AWS Access Key IDs (AKIA, ASIA, ABIA, ACCA followed by 16 alphanumeric characters)
  {
    name: 'aws_access_key',
    pattern: /\b(AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },

  // 5. GitHub Personal Access Tokens (classic ghp/gho/ghu/ghs/ghr and modern fine-grained github_pat)
  {
    name: 'github_pat',
    pattern: /\b(gh[pousr]_[A-Za-z0-9_]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },

  // 6. Slack API Tokens (Bot, User, App tokens)
  {
    name: 'slack_token',
    pattern: /\bxox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,32}\b/g,
    replacement: '[REDACTED_SLACK_TOKEN]',
  },

  // 7. Stripe API Keys (secret, publishable, restricted keys for test and live)
  {
    name: 'stripe_key',
    pattern: /\b(sk|pk|rk)_(live|test)_[0-9a-zA-Z]{24,99}\b/g,
    replacement: '[REDACTED_STRIPE_KEY]',
  },

  // 8. JSON Web Tokens (JWT) (3 base64url segments starting with standard headers eyJ...)
  {
    name: 'jwt_token',
    pattern: /\beyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+\b/g,
    replacement: '[REDACTED_JWT]',
  },

  // 9. Passwords and Secret fields in JSON (e.g. "password": "...", "client_secret": "...")
  {
    name: 'json_sensitive_fields',
    pattern: /(["'](?:password|passwd|pwd|secret|client_secret|api_key|apiKey|accessToken|access_token|privateKey|private_key|cookie|set-cookie|set_cookie)["']\s*:\s*["'])([^"']+)(["'])/gi,
    replacement: '$1[REDACTED]$3',
  },

  // 10. Passwords and Secret fields in Query Strings or Key-Value pairs
  {
    name: 'kv_sensitive_fields',
    pattern: /((?:password|passwd|pwd|client_secret|api_key|apikey|access_token)=)([^\s&"'>]+)/gi,
    replacement: '$1[REDACTED]',
  },

  // 11. Cookie and Set-Cookie HTTP Headers
  {
    name: 'cookie_headers',
    pattern: /((?:cookie|set-cookie)\s*:\s*)([^\r\n"';]+(?:;[^\r\n"']*)*)/gi,
    replacement: '$1[REDACTED_COOKIE]',
  },

  // 12. OAuth URL tokens (code=, token=, session=, sig=)
  {
    name: 'oauth_url_tokens',
    pattern: /(^|[?&\s"';,])(code|token|session|sig)=([^&\s"'>#]+)/gi,
    replacement: '$1$2=[REDACTED]',
  },

  // 13. DOM Password Input Values (e.g. <input type="password" value="..."> or value="..." type="password")
  {
    name: 'dom_password_input_1',
    pattern: /(<input\b[^>]*?\btype=["']password["'][^>]*?\bvalue=["'])([^"']*)(["'][^>]*>)/gi,
    replacement: '$1[REDACTED]$3',
  },
  {
    name: 'dom_password_input_2',
    pattern: /(<input\b[^>]*?\bvalue=["'])([^"']*)(["'][^>]*?\btype=["']password["'][^>]*>)/gi,
    replacement: '$1[REDACTED]$3',
  },
];

/**
 * Sanitizes a string by applying all registered credential redaction rules.
 */
export function redactSecrets(text: string): string {
  if (typeof text !== 'string' || text.length === 0) {
    return text;
  }

  let sanitized = text;
  for (const rule of REDACTION_RULES) {
    // Reset RegExp lastIndex if global
    rule.pattern.lastIndex = 0;
    sanitized = sanitized.replace(rule.pattern, rule.replacement as any);
  }
  return sanitized;
}

/**
 * Recursively walks an object, array, or primitive and applies secret redaction to all strings.
 */
export function sanitizeObject<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }

  if (typeof input === 'string') {
    return redactSecrets(input) as unknown as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => sanitizeObject(item)) as unknown as T;
  }

  if (typeof input === 'object') {
    // Preserve Date, RegExp, Error instances
    if (input instanceof Date || input instanceof RegExp) {
      return input;
    }

    if (input instanceof Error) {
      const sanitizedErr = new (input.constructor as any)(redactSecrets(input.message));
      if (input.stack) {
        sanitizedErr.stack = redactSecrets(input.stack);
      }
      return sanitizedErr;
    }

    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
      // If key itself indicates a sensitive credential, redact string value immediately
      if (
        /^(password|passwd|secret|client_secret|apiKey|api_key|privateKey|private_key|token|cookie|set-cookie|set_cookie)$/i.test(
          key
        ) &&
        typeof value === 'string'
      ) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = sanitizeObject(value);
      }
    }
    return result as T;
  }

  return input;
}
