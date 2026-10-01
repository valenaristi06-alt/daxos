'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const { backupToFile, logError } = require('./db');
const { sendAdminNotificationEmail } = require('./email');

const BACKUP_PREFIX = 'daxos-';
const BACKUP_REGEX  = /^daxos-\d{4}-\d{2}-\d{2}-\d{4}\.db\.gz$/;
const RETENTION     = 30;

let _backupRunning = false;

function makeS3() {
  const id = process.env.R2_ACCOUNT_ID;
  if (!id || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET) {
    throw new Error('R2 env vars not set (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${id}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

// Uruguay is UTC-3 year-round (no DST)
function uyNow() {
  return new Date(Date.now() - 3 * 60 * 60 * 1000);
}

function backupKey() {
  const d = uyNow();
  const p = n => String(n).padStart(2, '0');
  return `daxos-${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}.db.gz`;
}

async function _listSorted(s3) {
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: process.env.R2_BUCKET,
    Prefix: BACKUP_PREFIX,
  }));
  return (res.Contents || [])
    .filter(o => BACKUP_REGEX.test(o.Key))
    .sort((a, b) => a.Key.localeCompare(b.Key));
}

async function getLatestBackupMeta() {
  try {
    const s3   = makeS3();
    const list = await _listSorted(s3);
    return list.length ? list[list.length - 1] : null;
  } catch {
    return null;
  }
}

async function listAllBackups() {
  const s3 = makeS3();
  return _listSorted(s3);
}

async function runBackup() {
  if (_backupRunning) {
    console.warn('[backup] already running, skipping');
    return null;
  }
  _backupRunning = true;

  const stamp = Date.now();
  const tmpDb = path.join(os.tmpdir(), `daxos-bk-${stamp}.db`);
  const tmpGz = path.join(os.tmpdir(), `daxos-bk-${stamp}.db.gz`);

  try {
    // 1. Consistent SQLite backup via better-sqlite3 API
    await backupToFile(tmpDb);

    // 2. Integrity check on the copy — abort if not ok
    const Database   = require('better-sqlite3');
    const verifyConn = new Database(tmpDb, { readonly: true });
    let integrityOk  = false;
    try {
      const rows = verifyConn.pragma('integrity_check');
      integrityOk = rows.length === 1 && rows[0].integrity_check === 'ok';
    } finally {
      verifyConn.close();
    }
    if (!integrityOk) {
      throw new Error('PRAGMA integrity_check did not return ok on backup copy — aborting upload');
    }

    // 3. Gzip the backup copy
    await pipeline(
      fs.createReadStream(tmpDb),
      zlib.createGzip({ level: 9 }),
      fs.createWriteStream(tmpGz),
    );

    // 4. Compare size against previous backup before uploading
    const s3       = makeS3();
    const existing = await _listSorted(s3);
    const prev     = existing.length ? existing[existing.length - 1] : null;
    const { size: gzSize } = fs.statSync(tmpGz);
    const tooSmall = !!(prev && prev.Size > 0 && gzSize < prev.Size / 2);

    // 5. Upload with ContentLength (R2 requires it for reliable streaming)
    const key = backupKey();
    await s3.send(new PutObjectCommand({
      Bucket:        process.env.R2_BUCKET,
      Key:           key,
      Body:          fs.createReadStream(tmpGz),
      ContentLength: gzSize,
      ContentType:   'application/gzip',
    }));

    console.log(`[backup-ok] key=${key} size=${gzSize}`);

    // 6. Retention: keep last 30, skip if size anomaly
    if (!tooSmall) {
      const excess   = existing.length + 1 - RETENTION; // +1 = the file we just uploaded
      const toDelete = excess > 0 ? existing.slice(0, excess) : [];
      for (const obj of toDelete) {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: obj.Key }));
        console.log(`[backup-retention] deleted ${obj.Key}`);
      }
    } else {
      console.warn(`[backup-warn] ${key} (${gzSize}B) < 50% of ${prev.Key} (${prev.Size}B) — retention skipped`);
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        sendAdminNotificationEmail({
          adminEmail,
          event: 'backup_anomalia_tamano',
          data: {
            nueva_copia:       key,
            tamaño_nuevo:      `${gzSize} bytes`,
            copia_anterior:    prev.Key,
            tamaño_anterior:   `${prev.Size} bytes`,
            nota: 'La copia nueva pesa menos de la mitad que la anterior. Se conservaron todas las copias viejas.',
          },
        }).catch(() => {});
      }
    }

    return { name: key, sizeBytes: gzSize };

  } catch (err) {
    logError('backup-error', err);
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      sendAdminNotificationEmail({
        adminEmail,
        event: 'backup_error',
        data: { mensaje: err.message },
      }).catch(() => {});
    }
    throw err;
  } finally {
    for (const f of [tmpDb, tmpGz]) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
    _backupRunning = false;
  }
}

// Called from the 30-min setInterval. Triggers at 04:xx Uruguay time.
async function maybeScheduledBackup() {
  const d = uyNow();
  if (d.getUTCHours() !== 4) return false;

  const latest = await getLatestBackupMeta();
  const todayUY = d.toISOString().slice(0, 10); // YYYY-MM-DD in UY time
  if (latest) {
    // Key format: daxos-YYYY-MM-DD-HHmm.db.gz — date is chars 6-15
    const lastDate = latest.Key.slice(6, 16);
    if (lastDate >= todayUY) return false;
  }

  console.log('[backup-schedule] 04:xx UY window — triggering daily backup');
  runBackup().catch(() => {});
  return true;
}

// Called from the 30-min setInterval. Fires once at 08:00-08:29 UY.
// Alerts if no backup in the last 30 hours.
async function maybeSilenceAlert() {
  const d = uyNow();
  if (d.getUTCHours() !== 8 || d.getUTCMinutes() >= 30) return;

  const latest     = await getLatestBackupMeta();
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return;

  if (!latest) {
    sendAdminNotificationEmail({
      adminEmail,
      event: 'backup_sin_copias',
      data: { nota: 'No se encontró ningún backup en R2.' },
    }).catch(() => {});
    return;
  }

  const ageMs = latest.LastModified
    ? Date.now() - new Date(latest.LastModified).getTime()
    : Infinity;

  if (ageMs > 30 * 60 * 60 * 1000) {
    console.warn(`[backup-silence] no backup in ${Math.round(ageMs / 3600000)}h`);
    sendAdminNotificationEmail({
      adminEmail,
      event: 'backup_silencio',
      data: {
        última_copia: latest.Key,
        fecha:        latest.LastModified,
        horas_sin_backup: Math.round(ageMs / 3600000),
      },
    }).catch(() => {});
  }
}

// Called once on startup (after a delay). Runs backup if last copy > 24h old.
async function startupBackupCheck() {
  const latest = await getLatestBackupMeta();
  if (!latest) {
    console.log('[backup-startup] no backups found — running now');
    return runBackup();
  }
  const ageMs = latest.LastModified
    ? Date.now() - new Date(latest.LastModified).getTime()
    : Infinity;
  if (ageMs > 24 * 60 * 60 * 1000) {
    console.log(`[backup-startup] last backup ${latest.Key} is ${Math.round(ageMs / 3600000)}h old — running now`);
    return runBackup();
  }
  console.log(`[backup-startup] last backup ${latest.Key} is fresh (${Math.round(ageMs / 3600000)}h) — skipping`);
}

module.exports = {
  runBackup,
  maybeScheduledBackup,
  maybeSilenceAlert,
  startupBackupCheck,
  getLatestBackupMeta,
  listAllBackups,
};
