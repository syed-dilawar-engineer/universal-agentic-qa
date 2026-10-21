/**
 * Security controls: Cloud metadata IP and SSRF protection.
 *
 * Blocks access to cloud metadata endpoints:
 * - AWS / Azure / GCP metadata: 169.254.169.254 (and 169.254.0.0/16 link-local range)
 * - Alibaba Cloud metadata: 100.100.100.200
 * - GCP metadata DNS names: metadata.google.internal, metadata.internal, instance-data
 * - Alternative encodings: decimal, hexadecimal, octal, IPv6-mapped IPv4
 * - Dangerous schemes: file:, gopher:, ftp:, javascript:, etc.
 */

const BLOCKED_HOSTNAMES = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'metadata.google.internal',
  'metadata.internal',
  'instance-data',
]);

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'data:', 'blob:', 'about:']);

/**
 * Checks whether an IPv4 address string (e.g. "169.254.1.2") falls in 169.254.0.0/16 (link-local)
 */
function isLinkLocalIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length === 4 && parts.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
    return parts[0] === 169 && parts[1] === 254;
  }
  return false;
}

/**
 * Converts a 32-bit integer (e.g. from decimal or hex IP notation) to dotted IPv4 string
 */
function intToIpv4(num: number): string {
  return [
    (num >>> 24) & 255,
    (num >>> 16) & 255,
    (num >>> 8) & 255,
    num & 255,
  ].join('.');
}

/**
 * Normalizes host strings and resolves decimal/hex representations to IP
 */
function normalizeHost(host: string): string {
  let cleaned = host.toLowerCase().trim();

  // Strip port if present
  if (cleaned.includes(':') && !cleaned.startsWith('[')) {
    cleaned = cleaned.split(':')[0];
  }

  // Strip brackets if IPv6 (e.g. "[::ffff:169.254.169.254]" -> "::ffff:169.254.169.254")
  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    cleaned = cleaned.slice(1, -1);
  }

  // Handle IPv6-mapped IPv4 (e.g. "::ffff:169.254.169.254" or "0:0:0:0:0:ffff:169.254.169.254")
  if (cleaned.startsWith('::ffff:') || cleaned.includes(':ffff:')) {
    const lastColon = cleaned.lastIndexOf(':');
    const mapped = cleaned.substring(lastColon + 1);
    if (mapped.includes('.')) {
      return mapped;
    }
  }

  // Check if entire host is a decimal number (e.g. 2852039166 -> 169.254.169.254)
  if (/^\d+$/.test(cleaned)) {
    const num = parseInt(cleaned, 10);
    if (num >= 0 && num <= 4294967295) {
      return intToIpv4(num);
    }
  }

  // Check if entire host is hex number (e.g. 0xa9fea9fe -> 169.254.169.254)
  if (/^0x[0-9a-f]+$/i.test(cleaned)) {
    const num = parseInt(cleaned, 16);
    if (num >= 0 && num <= 4294967295) {
      return intToIpv4(num);
    }
  }

  return cleaned;
}

export interface SecurityCheckResult {
  blocked: boolean;
  reason?: string;
  normalizedHost?: string;
  scheme?: string;
}

/**
 * Validates whether a URL or destination targets a forbidden cloud metadata or SSRF endpoint.
 */
export function isBlockedMetadataUrl(targetUrl: string | URL): SecurityCheckResult {
  let parsedUrl: URL;

  try {
    if (targetUrl instanceof URL) {
      parsedUrl = targetUrl;
    } else {
      const trimmed = String(targetUrl).trim();
      // Handle scheme-less URLs by prefixing with http:// for parsing
      if (!trimmed.includes('://') && !trimmed.startsWith('//')) {
        parsedUrl = new URL(`http://${trimmed}`);
      } else {
        parsedUrl = new URL(trimmed);
      }
    }
  } catch (err: any) {
    // If URL cannot be parsed, check string match for known metadata endpoints
    const rawStr = String(targetUrl).toLowerCase();
    for (const blocked of BLOCKED_HOSTNAMES) {
      if (rawStr.includes(blocked)) {
        return {
          blocked: true,
          reason: `Unparseable URL containing blocked metadata destination: "${blocked}"`,
        };
      }
    }
    return {
      blocked: true,
      reason: `Malformed or invalid URL destination: ${err.message}`,
    };
  }

  const scheme = parsedUrl.protocol.toLowerCase();

  // 1. Validate Scheme
  if (!ALLOWED_SCHEMES.has(scheme)) {
    return {
      blocked: true,
      reason: `Forbidden URL scheme "${scheme}". Only HTTP and HTTPS are permitted for network automation.`,
      scheme,
    };
  }

  // Internal browser schemes (about:blank, data:, blob:) are permitted
  if (scheme === 'about:' || scheme === 'data:' || scheme === 'blob:') {
    return { blocked: false, scheme };
  }

  const normalizedHost = normalizeHost(parsedUrl.hostname);

  // 2. Check exact matches in blocked hostnames set
  if (BLOCKED_HOSTNAMES.has(normalizedHost)) {
    return {
      blocked: true,
      reason: `Outbound request to cloud metadata endpoint "${normalizedHost}" is blocked by security policy.`,
      normalizedHost,
      scheme,
    };
  }

  // 3. Check domain suffixes (e.g. *.metadata.google.internal)
  if (
    normalizedHost.endsWith('.metadata.google.internal') ||
    normalizedHost.endsWith('.metadata.internal')
  ) {
    return {
      blocked: true,
      reason: `Outbound request to cloud metadata domain "${normalizedHost}" is blocked by security policy.`,
      normalizedHost,
      scheme,
    };
  }

  // 4. Check Link-Local 169.254.0.0/16 IPv4 range
  if (isLinkLocalIpv4(normalizedHost)) {
    return {
      blocked: true,
      reason: `Outbound request to link-local IP range (169.254.0.0/16) "${normalizedHost}" is blocked by security policy.`,
      normalizedHost,
      scheme,
    };
  }

  // 5. Check IPv6 link-local prefix (fe80::)
  if (normalizedHost.startsWith('fe80:') || normalizedHost.startsWith('fe80::')) {
    return {
      blocked: true,
      reason: `Outbound request to IPv6 link-local address "${normalizedHost}" is blocked by security policy.`,
      normalizedHost,
      scheme,
    };
  }

  // Legitimate destination (including localhost, 127.0.0.1, external web targets)
  return {
    blocked: false,
    normalizedHost,
    scheme,
  };
}
