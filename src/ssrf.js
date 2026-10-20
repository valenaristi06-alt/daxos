'use strict';

const net = require('net');
const dns = require('dns').promises;

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 10_000;

function blockedReason(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 127) return 'loopback';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'link-local';
    if (a === 0) return 'reserved';
    if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
    return null;
  }
  if (net.isIPv6(ip)) {
    const n = ip.toLowerCase();
    if (n === '::1') return 'loopback';
    if (n.startsWith('fe80:')) return 'link-local';
    if (n.startsWith('fc') || n.startsWith('fd')) return 'private';
    if (n.startsWith('::ffff:')) {
      const v4 = n.slice(7);
      if (net.isIPv4(v4)) return blockedReason(v4);
    }
    return null;
  }
  return 'unknown-family';
}

// allowHttp: also accept http: (default false = https only, matching original server.js behavior)
async function validateUrl(rawUrl, { allowHttp = false } = {}) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('URL inválida'); }
  const allowed = allowHttp ? ['http:', 'https:'] : ['https:'];
  if (!allowed.includes(parsed.protocol)) throw new Error('Solo se permiten URLs con ' + (allowHttp ? 'HTTP/HTTPS' : 'HTTPS'));
  const hostname = parsed.hostname;
  if (net.isIP(hostname)) {
    const reason = blockedReason(hostname);
    if (reason) throw new Error(`URL no permitida (${reason})`);
  } else {
    let address;
    try { ({ address } = await dns.lookup(hostname, { family: 0 })); } catch { throw new Error('No se pudo resolver el host'); }
    const reason = blockedReason(address);
    if (reason) throw new Error(`URL no permitida (${reason})`);
  }
}

module.exports = { blockedReason, validateUrl, MAX_RESPONSE_BYTES, MAX_REDIRECTS, TIMEOUT_MS };
