#!/usr/bin/env node
'use strict';
// El control isBotMuted vive en la capa común de envío (whatsapp.js), último paso
// antes de Meta/Kapso/Baileys. Con el negocio pausado, NINGÚN tipo de envío a cliente
// sale; los avisos al dueño (bypassPause) sí. Sin red: el bloqueo retorna antes de enviar.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DB_DIR = '/tmp/test-pause-send-db';
execSync(`rm -rf ${DB_DIR}`); fs.mkdirSync(DB_DIR, { recursive: true });
process.env.DB_DIR = DB_DIR;

const db = require('../src/db');
const wa = require('../src/whatsapp');

let passed = 0, failed = 0;
function assert(c, l) { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l}`); failed++; } }

(async () => {
  // Negocio pausado (pnid-muted) y activo (pnid-active).
  const muted = db.upsertBusiness({ name: 'Pausado' });
  db.saveConfigDraft && null;
  const active = db.upsertBusiness({ name: 'Activo' });
  // set phone_number_id + pausa
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(DB_DIR, 'daxos.db'));
  raw.prepare('UPDATE businesses SET phone_number_id = ? WHERE id = ?').run('pnid-muted', muted.id);
  raw.prepare('UPDATE businesses SET phone_number_id = ? WHERE id = ?').run('pnid-active', active.id);
  raw.close();
  db.setBotPaused(muted.id, true);

  const mutedCreds  = { phoneNumberId: 'pnid-muted', provider: 'meta', accessToken: 'x' };
  const activeCreds = { phoneNumberId: 'pnid-active', provider: 'meta', accessToken: 'x' };

  // ── Un test por cada tipo de envío: pausado → bloqueado (skipped), sin tocar la red ──
  console.log('Suite: cada tipo de envío queda bloqueado con el negocio pausado');
  const r1 = await wa.sendWhatsAppMessage('598999', 'hola', mutedCreds);
  assert(r1 && r1.skipped === 'bot_paused', 'sendWhatsAppMessage bloqueado');
  const r2 = await wa.sendWhatsAppAudio('598999', 'mediaid', mutedCreds);
  assert(r2 && r2.skipped === 'bot_paused', 'sendWhatsAppAudio bloqueado');
  const r3 = await wa.sendWhatsAppImage('598999', 'mediaid', null, mutedCreds);
  assert(r3 && r3.skipped === 'bot_paused', 'sendWhatsAppImage bloqueado');
  const r4 = await wa.sendWhatsAppDocument('598999', 'mediaid', 'f.pdf', mutedCreds);
  assert(r4 && r4.skipped === 'bot_paused', 'sendWhatsAppDocument bloqueado');

  // baileys también entra por el mismo chokepoint (no se toca baileys.js).
  const r5 = await wa.sendWhatsAppMessage('598999', 'hola', { phoneNumberId: 'pnid-muted', provider: 'baileys' });
  assert(r5 && r5.skipped === 'bot_paused', 'provider baileys también bloqueado');

  // ── Avisos al dueño NO se bloquean (bypassPause) ──
  console.log('Avisos al dueño / envío manual no se bloquean');
  assert(wa.isSendBlocked(mutedCreds) === true, 'pausado sin bypass → bloqueado');
  assert(wa.isSendBlocked(mutedCreds, { bypassPause: true }) === false, 'pausado con bypassPause (aviso al dueño) → NO bloqueado');

  // ── Negocio activo (no pausado) envía normal ──
  console.log('Negocio sin pausar no se bloquea');
  assert(wa.isSendBlocked(activeCreds) === false, 'negocio activo → no bloqueado');
  assert(wa.isSendBlocked({}) === false, 'sin phoneNumberId → no bloqueado (no rompe)');

  console.log(`\n── Resultados ── passed=${passed} failed=${failed}`);
  db.closeDb && db.closeDb();
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
