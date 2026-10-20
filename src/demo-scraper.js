'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { validateUrl, blockedReason, MAX_RESPONSE_BYTES, MAX_REDIRECTS, TIMEOUT_MS } = require('./ssrf');

const MAX_EXTRA_PAGES = 3;
const MAX_TEXT_CHARS  = 12_000; // per page before truncation

// Fetch a URL with SSRF protection + redirect following
async function fetchSafe(rawUrl, redirectsLeft = MAX_REDIRECTS) {
  await validateUrl(rawUrl, { allowHttp: false });
  const parsed = new URL(rawUrl);
  const lib = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.get(rawUrl, {
      timeout: TIMEOUT_MS,
      headers: { 'User-Agent': 'DaxosBot/1.0 (+https://daxos.ai)' },
    }, (res) => {
      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirectsLeft <= 0) return reject(new Error('Demasiadas redirecciones'));
        const next = new URL(res.headers.location, rawUrl).href;
        res.resume();
        return resolve(fetchSafe(next, redirectsLeft - 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) { res.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

// Strip HTML tags, collapse whitespace, truncate
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

// Detect JS-only page (empty body / tiny text after stripping)
function isJsOnly(html, text) {
  if (text.length < 80) return true;
  // Common SPA shells with no real content
  if (/<div id="(root|app)">\s*<\/div>/i.test(html) && text.length < 300) return true;
  return false;
}

// Extract internal links (same origin, skip anchors/assets)
function extractInternalLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const seen = new Set([base.href]);
  const links = [];
  const re = /href="([^"#?]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const u = new URL(m[1], baseUrl);
      if (u.origin !== base.origin) continue;
      if (/\.(png|jpg|jpeg|gif|svg|css|js|ico|pdf|zip|woff|ttf)$/i.test(u.pathname)) continue;
      const clean = u.origin + u.pathname;
      if (!seen.has(clean)) { seen.add(clean); links.push(clean); }
    } catch { /* skip malformed */ }
  }
  return links;
}

// Priority pages: /about, /servicios, /productos, /contacto, /nosotros, /quienes-somos
const PRIORITY_PATHS = [
  '/about', '/about-us', '/nosotros', '/quienes-somos', '/quiénes-somos',
  '/servicios', '/services', '/productos', '/products',
  '/contacto', '/contact', '/pricing', '/precios',
];

function rankLinks(links, baseUrl) {
  const base = new URL(baseUrl);
  const prioritized = [], rest = [];
  for (const l of links) {
    const p = new URL(l).pathname.toLowerCase();
    if (PRIORITY_PATHS.some((pp) => p === pp || p.startsWith(pp + '/'))) {
      prioritized.push(l);
    } else {
      rest.push(l);
    }
  }
  return [...prioritized, ...rest];
}

/**
 * Scrape a website and return structured text content.
 * Returns: { pages: [{url, text}], jsOnly: bool }
 */
async function scrapeWebsite(rawUrl) {
  // Validate before anything
  await validateUrl(rawUrl, { allowHttp: false });

  // Fetch home page
  const homeHtml = await fetchSafe(rawUrl);
  const homeText = htmlToText(homeHtml);

  if (isJsOnly(homeHtml, homeText)) {
    return { pages: [], jsOnly: true };
  }

  const pages = [{ url: rawUrl, text: homeText }];

  // Find and fetch up to MAX_EXTRA_PAGES internal pages in parallel
  const links = rankLinks(extractInternalLinks(homeHtml, rawUrl), rawUrl).slice(0, MAX_EXTRA_PAGES * 2);
  const selected = links.slice(0, MAX_EXTRA_PAGES);

  const extras = await Promise.allSettled(
    selected.map(async (link) => {
      const html = await fetchSafe(link);
      return { url: link, text: htmlToText(html) };
    })
  );

  for (const r of extras) {
    if (r.status === 'fulfilled') pages.push(r.value);
  }

  return { pages, jsOnly: false };
}

module.exports = { scrapeWebsite };
