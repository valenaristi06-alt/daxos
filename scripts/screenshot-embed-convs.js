'use strict';
/**
 * Capturas del modo embed con conversaciones: negocio de prueba con chats de ejemplo
 * (texto, foto, audio, documento; uno que espera atención y otro que atiende el dueño).
 *   - lista, un chat abierto, paso 3 normal y paso 3 al 80% — computadora y celular.
 * Capturas → /tmp/embed-convs-shots/
 * Run: node scripts/screenshot-embed-convs.js
 */
const path = require('path');
const fs   = require('fs');
const http = require('http');
const { spawn, execSync } = require('child_process');
const { chromium } = require('playwright');
const Database = require('better-sqlite3');

const TEST_PORT = 3131;
const DB_DIR    = '/tmp/screenshot-embed-convs';
const BASE      = `http://localhost:${TEST_PORT}`;
const SHOTS_DIR = '/tmp/embed-convs-shots';
const PARTNER_KEY = 'shot-partner-key';

try { execSync(`rm -rf ${DB_DIR} ${SHOTS_DIR}`); } catch (_) {}
fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(DB_DIR, { recursive: true });
let serverProc = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const data = body ? JSON.stringify(body) : null;
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ hostname: 'localhost', port: TEST_PORT, path: urlPath, method, headers }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function waitForServer() {
  for (let i = 0; i < 40; i++) { try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {} await sleep(500); }
  return false;
}

// 1.2 s tone as WAV (plays in Chromium).
function makeWav() {
  const rate = 8000, n = Math.floor(rate * 1.2);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 6) * 6000 * Math.sin(i / n * Math.PI)), 44 + i * 2);
  return buf;
}
function makePdf() {
  return Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  // Foto de ejemplo (un "producto") generada con el navegador.
  const ph = await browser.newPage({ viewport: { width: 480, height: 480 } });
  await ph.setContent(`<div style="width:480px;height:480px;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(circle at 30% 30%,#fde68a,#f59e0b 45%,#92400e);font:700 150px system-ui">🎂</div>`);
  const photo = await ph.screenshot({ type: 'jpeg', quality: 85 });
  await ph.close();

  serverProc = spawn('node', ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(TEST_PORT), DB_DIR, SESSION_SECRET: 'shot-secret',
      PARTNER_CRM_KEY: PARTNER_KEY, PARTNER_EMBED_ORIGINS: 'https://pupi-pi.vercel.app', PARTNER_NAME: 'Pupi',
      APP_URL: BASE, NODE_ENV: '', RAILWAY_ENVIRONMENT: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', d => { const s = String(d); if (/error|Error/.test(s)) process.stderr.write(s); });
  if (!(await waitForServer())) throw new Error('server did not start');
  await sleep(300);

  const bearer = { headers: { Authorization: `Bearer ${PARTNER_KEY}` } };
  await req('POST', '/api/partner/businesses', { crm_user_id: 'shot_1', name: 'Dulce Hogar Pastelería', email: 'dulce@shot.com' }, bearer);
  await req('POST', '/api/partner/businesses/quota', { crm_user_id: 'shot_1', conv_cap: 300, spend_cap_usd: 1000 }, bearer);

  // Negocio de prueba: WhatsApp "conectado" + conversaciones de ejemplo.
  const db = new Database(path.join(DB_DIR, 'daxos.db'));
  const bizId = db.prepare("SELECT id FROM businesses WHERE crm_user_id='shot_1'").get().id;
  db.prepare("UPDATE businesses SET phone_number_id='pnid-shot', wa_provider='meta', wa_access_token='fake', wa_connected_at=datetime('now'), business_context='Pastelería artesanal' WHERE id=?").run(bizId);
  const mediaDir = path.join(DB_DIR, 'media', String(bizId));
  fs.mkdirSync(mediaDir, { recursive: true });
  const conv = (phone) => db.prepare('INSERT INTO conversations (business_id, customer_id) VALUES (?, ?)').run(bizId, phone).lastInsertRowid;
  const msg = (c, role, content, minsAgo, media) => {
    const id = db.prepare(`INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, datetime('now', ?))`).run(c, role, content, `-${minsAgo} minutes`).lastInsertRowid;
    if (media) {
      const f = path.join(mediaDir, `${id}.${media.ext}`);
      fs.writeFileSync(f, media.buf);
      db.prepare('UPDATE messages SET media_kind=?, media_mime=?, media_name=?, media_path=? WHERE id=?').run(media.kind, media.mime, media.name || null, f, id);
    }
  };

  // 1) Cliente con foto + audio + documento (el chat que se abre en la captura)
  const c1 = conv('59899412387');
  msg(c1, 'user', 'Hola! Quería encargar una torta para el sábado', 95);
  msg(c1, 'assistant', '¡Hola! Claro 😊 ¿Para cuántas personas sería y qué sabor te gustaría?', 94);
  msg(c1, 'user', '[imagen] Algo así, para 15 personas', 40, { kind: 'image', mime: 'image/jpeg', ext: 'jpg', buf: photo });
  msg(c1, 'assistant', 'Qué linda 😍 Para 15 personas la torta de chocolate con crema sale $1.450. ¿La retirás o te la enviamos?', 39);
  msg(c1, 'user', 'La retiro yo. Te mando un audio con los detalles del cartel', 12, { kind: 'audio', mime: 'audio/wav', ext: 'wav', buf: makeWav() });
  msg(c1, 'user', '[documento: pedido-cumple-sofi.pdf]', 11, { kind: 'document', mime: 'application/pdf', ext: 'pdf', name: 'pedido-cumple-sofi.pdf', buf: makePdf() });
  msg(c1, 'assistant', 'Perfecto, ya lo anoté: retiro el sábado, cartel "Feliz cumple Sofi". ¿Te confirmo el horario de retiro?', 10);
  // Ajustar el audio: que el texto sea la transcripción
  db.prepare("UPDATE messages SET content='Que diga Feliz cumple Sofi, en letras rosadas' WHERE conversation_id=? AND media_kind='audio'").run(c1);

  // 2) Cliente que pidió hablar con una persona → espera atención
  const c2 = conv('59898765432');
  msg(c2, 'user', 'Buenas, tengo un problema con un pedido de ayer', 25);
  msg(c2, 'assistant', 'Te paso con una persona del equipo, te escribe en cuanto pueda 💗', 25);
  msg(c2, 'user', 'Quiero hablar con alguien por favor', 6);
  db.prepare("UPDATE conversations SET needs_attention=1, paused_at=unixepoch(), paused_reason='keyword' WHERE id=?").run(c2);

  // 3) Chat que atiende el dueño ("Atiendo yo")
  const c3 = conv('59891234567');
  msg(c3, 'user', '¿Hacen tortas sin TACC?', 180);
  msg(c3, 'assistant', 'Sí, hacemos. Te paso los sabores disponibles en un ratito.', 170);
  db.prepare('UPDATE conversations SET needs_attention=1, paused_at=NULL, human_paused_at=unixepoch(), needs_human=0 WHERE id=?').run(c3);

  // 4) y 5) chats normales
  const c4 = conv('59894455667');
  msg(c4, 'user', '¿Hasta qué hora abren hoy?', 60 * 26);
  msg(c4, 'assistant', 'Hoy abrimos hasta las 20 h 🕗', 60 * 26);
  const c5 = conv('59897788990');
  msg(c5, 'user', 'Gracias! Quedó riquísima', 60 * 50);
  msg(c5, 'assistant', '¡Qué alegría! Gracias a vos 💛', 60 * 50);
  db.pragma('wal_checkpoint(FULL)');
  db.close();

  async function openEmbed(w, h) {
    const ll = await req('POST', '/api/partner/login-link', { crm_user_id: 'shot_1', mode: 'embed', theme: {} }, bearer);
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.route('**/connect.facebook.net/**', r => r.abort());
    await page.goto(ll.body.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#embed-convs:not([hidden]) .conv-item', { timeout: 10000 });
    await sleep(400);
    return { ctx, page };
  }
  const snap = async (page, name) => {
    const file = path.join(SHOTS_DIR, name);
    await page.screenshot({ path: file, fullPage: true });
    console.log('  📸 ' + file);
  };

  for (const [label, w, h] of [['compu', 1280, 800], ['celu', 390, 760]]) {
    // Lista
    let { ctx, page } = await openEmbed(w, h);
    await snap(page, `1-lista-${label}.png`);
    // Chat abierto (el de la foto/audio/documento)
    await page.click(`.conv-item:has-text("412 387")`);
    await page.waitForSelector('.media-img img[src^="blob:"]', { timeout: 8000 });
    await page.waitForSelector('.media-audio audio[src^="blob:"]', { timeout: 8000 });
    await sleep(600);
    await snap(page, `2-chat-abierto-${label}.png`);
    // Paso 3 normal (Ajustes del asistente)
    await page.click('#btn-open-settings');
    await page.waitForSelector('#embed-steps:not([hidden])');
    await sleep(500);
    await page.locator('#step-3').scrollIntoViewIfNeeded();
    await page.locator('#step-3').screenshot({ path: path.join(SHOTS_DIR, `3-paso3-normal-${label}.png`) });
    console.log('  📸 ' + path.join(SHOTS_DIR, `3-paso3-normal-${label}.png`));
    await snap(page, `3b-ajustes-completo-${label}.png`);
    await ctx.close();
  }

  // 80% del plan: tope de 6 conversaciones con 5 en el mes (83%).
  await req('POST', '/api/partner/businesses/quota', { crm_user_id: 'shot_1', conv_cap: 6, spend_cap_usd: 1000 }, bearer);
  for (const [label, w, h] of [['compu', 1280, 800], ['celu', 390, 760]]) {
    const { ctx, page } = await openEmbed(w, h);
    await page.click('#btn-open-settings');
    await page.waitForSelector('#limit-notice:not([hidden])', { timeout: 5000 });
    await sleep(400);
    await page.locator('#step-3').scrollIntoViewIfNeeded();
    await page.locator('#step-3').screenshot({ path: path.join(SHOTS_DIR, `4-paso3-80-${label}.png`) });
    console.log('  📸 ' + path.join(SHOTS_DIR, `4-paso3-80-${label}.png`));
    await ctx.close();
  }

  await browser.close();
}

main()
  .catch(e => { console.error('Fatal:', e.message); process.exitCode = 1; })
  .finally(() => { if (serverProc) serverProc.kill('SIGTERM'); try { execSync(`rm -rf ${DB_DIR}`); } catch (_) {} });
