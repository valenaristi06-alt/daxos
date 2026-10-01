#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '../.env.local') });

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');
const Database = require('better-sqlite3');

async function main() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const bucket    = process.env.R2_BUCKET;
  if (!accountId || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
    console.error('Missing R2 env vars. Check .env.local');
    process.exit(1);
  }

  const s3 = new S3Client({
    region:   'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

  // List and sort backups
  const res     = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'daxos-' }));
  const backups = (res.Contents || [])
    .filter(o => /^daxos-\d{4}-\d{2}-\d{2}-\d{4}\.db\.gz$/.test(o.Key))
    .sort((a, b) => a.Key.localeCompare(b.Key));

  if (!backups.length) {
    console.error('No backups found in R2.');
    process.exit(1);
  }

  const latest = backups[backups.length - 1];
  console.log(`\nTotal backups in R2: ${backups.length}`);
  console.log(`Latest: ${latest.Key} (${(latest.Size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Modified: ${latest.LastModified}\n`);

  const stamp = Date.now();
  const tmpGz = path.join(os.tmpdir(), `verify-${stamp}.db.gz`);
  const tmpDb = path.join(os.tmpdir(), `verify-${stamp}.db`);

  try {
    // Download
    process.stdout.write('Downloading...');
    const dlRes = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: latest.Key }));
    await pipeline(dlRes.Body, fs.createWriteStream(tmpGz));
    console.log(' done.');

    // Decompress
    process.stdout.write('Decompressing...');
    await pipeline(
      fs.createReadStream(tmpGz),
      zlib.createGunzip(),
      fs.createWriteStream(tmpDb),
    );
    console.log(' done.\n');

    // Open readonly — never touches production db
    const db = new Database(tmpDb, { readonly: true });
    try {
      const integrity = db.pragma('integrity_check');
      const ok = integrity.length === 1 && integrity[0].integrity_check === 'ok';
      console.log(`Integrity check: ${ok ? '✓ ok' : '✗ FAILED — ' + JSON.stringify(integrity)}`);
      console.log('');

      for (const table of ['businesses', 'conversations', 'messages', 'payments', 'pending_payments']) {
        try {
          const row = db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get();
          console.log(`  ${table.padEnd(20)} ${row.n} rows`);
        } catch (e) {
          console.log(`  ${table.padEnd(20)} (table not found)`);
        }
      }
    } finally {
      db.close();
    }

  } finally {
    for (const f of [tmpGz, tmpDb]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
  }

  console.log('\nDone. Production database was not touched.');
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
