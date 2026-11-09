'use strict';
/**
 * Enable or disable the agenda for one or all businesses.
 * Respects plan: only enables for crecimiento/a_medida/plan_cortesia.
 *
 * Usage:
 *   node scripts/enable-agenda.js --id=<business_id>   # single business
 *   node scripts/enable-agenda.js                       # all eligible businesses
 *   node scripts/enable-agenda.js --disable             # disable for all
 *   node scripts/enable-agenda.js --id=5 --disable      # disable single
 */

const { getAllBusinesses, getBusinessById, setAgendaEnabled } = require('../src/db');

const args   = process.argv.slice(2);
const disable = args.includes('--disable');
const idArg  = args.find(a => a.startsWith('--id='));
const targetId = idArg ? parseInt(idArg.split('=')[1], 10) : null;

function planOk(b) {
  return ['crecimiento', 'a_medida'].includes(b.plan) || !!b.plan_cortesia;
}

const targets = targetId
  ? (() => { const b = getBusinessById(targetId); return b ? [b] : []; })()
  : getAllBusinesses();

if (targetId && targets.length === 0) {
  console.error(`Business id=${targetId} not found.`);
  process.exit(1);
}

let changed = 0;
let skipped = 0;

for (const b of targets) {
  if (!disable && !planOk(b)) {
    console.log(`  SKIP  business_id=${b.id} "${b.name}" — plan=${b.plan} plan_cortesia=${b.plan_cortesia} (requiere crecimiento, a_medida o plan_cortesia)`);
    skipped++;
    continue;
  }
  const target = disable ? 0 : 1;
  if (b.agenda_enabled === target) {
    console.log(`  NOOP  business_id=${b.id} "${b.name}" — agenda_enabled ya es ${target}`);
    skipped++;
    continue;
  }
  setAgendaEnabled(b.id, target);
  console.log(`  SET   business_id=${b.id} "${b.name}" → agenda_enabled=${target}`);
  changed++;
}

console.log(`\nDone. changed=${changed} skipped=${skipped} total=${targets.length}`);
if (!disable) console.log('Para deshacer: node scripts/enable-agenda.js --disable');
