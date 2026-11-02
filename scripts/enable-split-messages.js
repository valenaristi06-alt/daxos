/**
 * Mass-enable or disable split messages for all businesses.
 * Skips any business that already has mensajes_separados explicitly set to false.
 *
 * Usage:
 *   node scripts/enable-split-messages.js          # enable for all (skip explicit false)
 *   node scripts/enable-split-messages.js --disable # disable for all (skip explicit false)
 *   node scripts/enable-split-messages.js --force-all # enable/disable ignoring existing value
 */

const { getAllBusinesses, setStyleProfile, getBusinessById } = require('../src/db');

const args = process.argv.slice(2);
const targetEnabled = !args.includes('--disable');
const forceAll = args.includes('--force-all');

const businesses = getAllBusinesses();
let skipped = 0;
let changed = 0;

for (const b of businesses) {
  const existing = b.style_profile;
  const currentVal = existing?.mensajes_separados;

  // Skip if explicitly set to the opposite value and not forcing
  if (!forceAll && currentVal === !targetEnabled) {
    console.log(`  SKIP  business_id=${b.id} "${b.name}" — mensajes_separados already explicitly ${currentVal}`);
    skipped++;
    continue;
  }

  setStyleProfile(b.id, { mensajes_separados: targetEnabled });
  console.log(`  SET   business_id=${b.id} "${b.name}" → mensajes_separados=${targetEnabled}`);
  changed++;
}

console.log(`\nDone. changed=${changed} skipped=${skipped} total=${businesses.length}`);
console.log('Reversible: run again with --disable to undo.');
