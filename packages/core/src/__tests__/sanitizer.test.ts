import { describe, it, expect } from 'vitest';
import { redactSecrets, sanitizeObject } from '../sanitizer.js';

describe('Sanitizer - Credential & Secret Redaction', () => {
  describe('Cookie and Set-Cookie Header Redaction', () => {
    it('redacts Cookie headers in request headers and logs', () => {
      const input = 'GET /api/user HTTP/1.1\r\nHost: example.com\r\nCookie: session_id=abc12345; auth_token=secret_987\r\nAccept: */*';
      const output = redactSecrets(input);
      expect(output).toContain('Cookie: [REDACTED_COOKIE]');
      expect(output).not.toContain('session_id=abc12345');
      expect(output).not.toContain('auth_token=secret_987');
      expect(output).toContain('Host: example.com');
    });

    it('redacts Set-Cookie headers in response logs and headers', () => {
      const input = 'HTTP/1.1 200 OK\r\nSet-Cookie: token=xyz999; Path=/; Secure; HttpOnly; SameSite=Strict\r\nContent-Type: application/json';
      const output = redactSecrets(input);
      expect(output).toContain('Set-Cookie: [REDACTED_COOKIE]');
      expect(output).not.toContain('xyz999');
      expect(output).toContain('Content-Type: application/json');
    });

    it('redacts case-insensitive and quoted cookie headers in HAR or JSON logs', () => {
      const input = '{"headers": "cookie: auth=secret_cookie_value"}';
      const output = redactSecrets(input);
      expect(output).toContain('cookie: [REDACTED_COOKIE]');
      expect(output).not.toContain('secret_cookie_value');
    });
  });

  describe('OAuth URL Token Redaction (code=, token=, session=, sig=)', () => {
    it('redacts OAuth authorization code in query strings (?code=)', () => {
      const url = 'https://auth.example.com/callback?code=splat_42_oauth_code_here&state=xyz';
      const sanitized = redactSecrets(url);
      expect(sanitized).toBe('https://auth.example.com/callback?code=[REDACTED]&state=xyz');
    });

    it('redacts token query parameter (&token=)', () => {
      const url = 'https://api.example.com/v1/resource?user=alice&token=tok_super_secret_token_123';
      const sanitized = redactSecrets(url);
      expect(sanitized).toBe('https://api.example.com/v1/resource?user=alice&token=[REDACTED]');
    });

    it('redacts session query parameter (?session=)', () => {
      const url = 'https://example.com/dashboard?session=sess_abc987654321';
      const sanitized = redactSecrets(url);
      expect(sanitized).toBe('https://example.com/dashboard?session=[REDACTED]');
    });

    it('redacts sig signature query parameter (&sig=)', () => {
      const url = 'https://storage.example.com/files/download?expires=1700000000&sig=c0ffee1234567890abcdef';
      const sanitized = redactSecrets(url);
      expect(sanitized).toBe('https://storage.example.com/files/download?expires=1700000000&sig=[REDACTED]');
    });

    it('does NOT corrupt non-sensitive parameters containing code or token', () => {
      const url = 'https://example.com/search?country-code=US&status-code=200&zip-code=90210';
      const sanitized = redactSecrets(url);
      expect(sanitized).toBe('https://example.com/search?country-code=US&status-code=200&zip-code=90210');
    });
  });

  describe('sanitizeObject Deep Sanitization', () => {
    it('redacts sensitive keys including cookie and tokens', () => {
      const obj = {
        name: 'test',
        password: 'my-password',
        cookie: 'session_cookie=abc',
        nested: {
          token: 'jwt-like-token',
          url: 'https://example.com/oauth?code=secret_code',
        },
      };

      const result = sanitizeObject(obj);
      expect(result.password).toBe('[REDACTED]');
      expect(result.cookie).toBe('[REDACTED]');
      expect(result.nested.token).toBe('[REDACTED]');
      expect(result.nested.url).toBe('https://example.com/oauth?code=[REDACTED]');
      expect(result.name).toBe('test');
    });
  });
});
