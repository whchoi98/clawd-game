/**
 * Viewer address for rate limiting. Prefers `CloudFront-Viewer-Address`
 * (only present when the origin request policy forwards it), then the first
 * `X-Forwarded-For` hop as the spec prescribes, then the socket address.
 */
import type { FastifyRequest } from 'fastify';

export function clientIp(req: Pick<FastifyRequest, 'headers' | 'ip'>): string {
  const cfv = firstHeader(req.headers['cloudfront-viewer-address']);
  if (cfv) {
    const ip = stripPort(cfv.trim());
    if (ip) return ip;
  }
  const xff = firstHeader(req.headers['x-forwarded-for']);
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }
  return req.ip;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** "1.2.3.4:51234" → "1.2.3.4"; "2001:db8::1:443" → "2001:db8::1"; "[::1]:443" → "::1". */
function stripPort(s: string): string {
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end > 0 ? s.slice(1, end) : s;
  }
  const i = s.lastIndexOf(':');
  if (i < 0) return s;
  // IPv4 has exactly one colon (the port); IPv6 always has more — the last one is the port.
  return s.slice(0, i);
}
