#!/usr/bin/env node
'use strict';
// Test: assistant document upload (PDF text extraction) — /api/business/documents.
// Regression guard for pdf-parse v2 API break (v1 callable export removed).
// Generates its own PDFs (1, 6, 8, 9 pages). No production data.
// Run: node scripts/test-doc-upload.js

const fs   = require('fs');
const path = require('path');
const http = require('http');
const { execSync, spawn } = require('child_process');

const TEST_PORT = 3099;
const V1_PORT   = 3100;
const DB_DIR    = '/tmp/test-doc-upload';
const V1_DB_DIR = '/tmp/test-doc-upload-v1';
const BASE      = `localhost`;

let ACTIVE_PORT = TEST_PORT;
const procs = [];
let passed = 0, failed = 0;

function cleanup() {
  for (const p of procs) { try { p.kill(); } catch (_) {} }
  try { execSync(`rm -rf ${DB_DIR} ${V1_DB_DIR}`); } catch (_) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ ${label}`); failed++; }
}

// ── Minimal valid multi-page PDF generator (text per page) ───────────────────
function makePdf(nPages, lineText) {
  const objs = [];           // index 0 unused; obj numbers start at 1
  const push = (s) => { objs.push(Buffer.from(s, 'latin1')); return objs.length; };

  // 1 catalog, 2 pages, 3 font — fixed. Pages/contents follow.
  const pageRefs = [];
  const contentObjNums = [];
  const pageObjNums = [];
  for (let i = 0; i < nPages; i++) {
    pageObjNums.push(4 + i * 2);
    contentObjNums.push(5 + i * 2);
    pageRefs.push(`${4 + i * 2} 0 R`);
  }

  push(`<< /Type /Catalog /Pages 2 0 R >>`);                                     // 1
  push(`<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${nPages} >>`);     // 2
  push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);                // 3
  for (let i = 0; i < nPages; i++) {
    const stream = `BT /F1 12 Tf 72 720 Td (${lineText} page ${i + 1}) Tj ET`;
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
         `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNums[i]} 0 R >>`); // page obj
    push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);        // content obj
  }

  // Serialize with xref offsets
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length);
    const header = Buffer.from(`${i + 1} 0 obj\n`, 'latin1');
    out = Buffer.concat([out, header, objs[i], Buffer.from('\nendobj\n', 'latin1')]);
  }
  const xrefStart = out.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.concat([out, Buffer.from(xref, 'latin1')]);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = opts.headers || {};
    if (body && !opts.raw) { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    if (opts.cookie) headers['Cookie'] = opts.cookie;
    const r = http.request({ hostname: BASE, port: ACTIVE_PORT, path: urlPath, method, headers }, (res) => {
      let data = ''; const setCookie = res.headers['set-cookie'];
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data), setCookie }); }
                            catch { resolve({ status: res.statusCode, body: data, setCookie }); } });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function uploadPdf(cookie, name, pdfBuffer) {
  const B = '----daxostestboundary';
  const pre = Buffer.from(
    `--${B}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n` +
    `--${B}\r\nContent-Disposition: form-data; name="doc"; filename="${name}.pdf"\r\n` +
    `Content-Type: application/pdf\r\n\r\n`, 'latin1');
  const post = Buffer.from(`\r\n--${B}--\r\n`, 'latin1');
  const payload = Buffer.concat([pre, pdfBuffer, post]);
  return req('POST', '/api/business/documents', payload, {
    raw: true, cookie,
    headers: { 'Content-Type': `multipart/form-data; boundary=${B}`, 'Content-Length': payload.length },
  });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/health'); if (r.status === 200) return; } catch {}
    await sleep(500);
  }
  throw new Error('Server did not start in 20s');
}

function startServer(port, dbDir, extraArgs = []) {
  const proc = spawn('node', [...extraArgs, 'src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DB_DIR: dbDir, SESSION_SECRET: 'doc-upload-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  procs.push(proc);
  return proc;
}

async function main() {
  startServer(TEST_PORT, DB_DIR);
  await waitForServer();
  await sleep(500);

  // Auth + business
  const email = 'docupload@test.com';
  let r = await req('POST', '/auth/register', { email, password: 'Passw0rd!test' });
  const cookie = r.setCookie?.[0]?.split(';')[0];
  await req('PUT', '/api/business', { name: 'DocBiz' }, { cookie });

  console.log('Suite: PDF text extraction (pdf-parse v2)');

  // 1-page PDF (small text) → succeeds, text extracted
  let up = await uploadPdf(cookie, 'one', makePdf(1, 'Hola mundo'));
  assert(up.status === 200 && up.body.ok && up.body.charCount > 0,
    `1-page PDF extracted (status=${up.status}, chars=${up.body.charCount ?? up.body.error})`);

  // 6-page PDF under cap → succeeds (the reported symptom: used to 422 "No se pudo leer el archivo")
  up = await uploadPdf(cookie, 'six', makePdf(6, 'Linea'));
  assert(up.status === 200 && up.body.ok && up.body.charCount > 0,
    `6-page PDF extracted, not rejected (status=${up.status}, body=${JSON.stringify(up.body)})`);

  // 8-page PDF → still parses (no real page-count limit server-side; cap is char-based)
  up = await uploadPdf(cookie, 'eight', makePdf(8, 'X'));
  assert(up.status === 200 && up.body.ok,
    `8-page PDF extracted (status=${up.status}, body=${JSON.stringify(up.body)})`);

  // 9-page PDF (light text) → parses fine. Page COUNT is not the limit; the cap is char-based.
  up = await uploadPdf(cookie, 'nine', makePdf(9, 'Y'));
  assert(up.status === 200 && up.body.ok,
    `9-page PDF accepted — page count is not a limit (status=${up.status}, body=${JSON.stringify(up.body)})`);

  // Oversized text (> char cap) → cap_exceeded with the real reason, not a parse error.
  const big = Buffer.from('a'.repeat(13000), 'latin1');
  const B = '----daxostestboundary';
  const pre = Buffer.from(
    `--${B}\r\nContent-Disposition: form-data; name="name"\r\n\r\nbig\r\n` +
    `--${B}\r\nContent-Disposition: form-data; name="doc"; filename="big.txt"\r\n` +
    `Content-Type: text/plain\r\n\r\n`, 'latin1');
  const payload = Buffer.concat([pre, big, Buffer.from(`\r\n--${B}--\r\n`, 'latin1')]);
  up = await req('POST', '/api/business/documents', payload, {
    raw: true, cookie,
    headers: { 'Content-Type': `multipart/form-data; boundary=${B}`, 'Content-Length': payload.length },
  });
  assert(up.status === 422 && /límite de espacio/.test(up.body.error || ''),
    `oversized doc hits char cap with clear message (status=${up.status})`);

  // ── v1 compatibility: pdf-parse stubbed as a callable (v1 default export) ──
  console.log('\nSuite: PDF text extraction (pdf-parse v1 callable, stubbed)');
  startServer(V1_PORT, V1_DB_DIR, ['-r', path.join(__dirname, '_stub-pdfparse-v1.js')]);
  ACTIVE_PORT = V1_PORT;
  await waitForServer();
  await sleep(500);
  r = await req('POST', '/auth/register', { email: 'v1@test.com', password: 'Passw0rd!test' });
  const cookieV1 = r.setCookie?.[0]?.split(';')[0];
  await req('PUT', '/api/business', { name: 'DocBizV1' }, { cookie: cookieV1 });
  up = await uploadPdf(cookieV1, 'onev1', makePdf(1, 'ignored'));
  assert(up.status === 200 && up.body.ok && up.body.charCount === 'V1_STUB_TEXT'.length,
    `v1 callable export used (status=${up.status}, chars=${up.body.charCount ?? up.body.error})`);

  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
