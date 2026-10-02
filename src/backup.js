'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const { backupToFile, logError } = require('./db');
const { sendAdminNotificationEmail } = require('./email');

const BACKUP_PREFIX  = 'daxos-';
const BACKUP_REGEX   = /^daxos-\d{4}-\d{2}-\d{2}-\d{4}\.db\.gz$/;
const UPLOADS_PREFIX = 'uploads-';
const UPLOADS_REGEX  = /^uploads-\d{4}-\d{2}-\d{2}-\d{4}\.tar\.gz$/;
const RETENTION      = 30;

let _backupRunning          = false;
let _lastUploadErrorMailDate = null;   // throttle: one alert per day for uploads errors

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

function uploadsKey() {
  const d = uyNow();
  const p = n => String(n).padStart(2, '0');
  return `uploads-${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}.tar.gz`;
}

async function _listSorted(s3, prefix, regex) {
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: process.env.R2_BUCKET,
    Prefix: prefix,
  }));
  return (res.Contents || [])
    .filter(o => regex.test(o.Key))
    .sort((a, b) => a.Key.localeCompare(b.Key));
}

async function getLatestBackupMeta() {
  try {
    const s3   = makeS3();
    const list = await _listSorted(s3, BACKUP_PREFIX, BACKUP_REGEX);
    return list.length ? list[list.length - 1] : null;
  } catch {
    return null;
  }
}

async function listAllBackups() {
  const s3 = makeS3();
  return _listSorted(s3, BACKUP_PREFIX, BACKUP_REGEX);
}

async function listAllUploadsBackups() {
  const s3 = makeS3();
  return _listSorted(s3, UPLOADS_PREFIX, UPLOADS_REGEX);
}

// Packs /app/data/uploads (or local equivalent) and uploads to R2.
// Returns { name, sizeBytes } on success, null if folder missing/empty.
// Throws on actual failure so the caller can handle alerting.
async function runUploadsBackup(s3) {
  // Resolve via path so this works regardless of mount point
  const uploadsDir = path.join(__dirname, '../data/uploads');
  const parentDir  = path.dirname(uploadsDir);
  const folderName = path.basename(uploadsDir);
  const stamp      = Date.now();
  const tmpTar     = path.join(os.tmpdir(), `daxos-uploads-bk-${stamp}.tar.gz`);

  try {
    // Skip if folder missing or empty
    if (!fs.existsSync(uploadsDir)) {
      console.log('[backup-uploads-skip] uploads dir not found');
      return null;
    }
    const entries = fs.readdirSync(uploadsDir);
    if (!entries.length) {
      console.log('[backup-uploads-skip] uploads dir is empty');
      return null;
    }

    // Pack with system tar — -C changes dir so archive contains relative paths
    await new Promise((resolve, reject) => {
      execFile('tar', ['-czf', tmpTar, '-C', parentDir, folderName], err => {
        if (err) reject(err); else resolve();
      });
    });

    const { size: tarSize } = fs.statSync(tmpTar);

    // Size anomaly check
    const existingUploads = await _listSorted(s3, UPLOADS_PREFIX, UPLOADS_REGEX);
    const prevU    = existingUploads.length ? existingUploads[existingUploads.length - 1] : null;
    const tooSmall = !!(prevU && prevU.Size > 0 && tarSize < prevU.Size / 2);

    const key = uploadsKey();
    await s3.send(new PutObjectCommand({
      Bucket:        process.env.R2_BUCKET,
      Key:           key,
      Body:          fs.createReadStream(tmpTar),
      ContentLength: tarSize,
      ContentType:   'application/gzip',
    }));

    console.log(`[backup-uploads-ok] key=${key} size=${tarSize}`);

    // Retention (skip if size anomaly)
    if (!tooSmall) {
      const excess   = existingUploads.length + 1 - RETENTION;
      const toDelete = excess > 0 ? existingUploads.slice(0, excess) : [];
      for (const obj of toDelete) {
        await s3.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: obj.Key }));
        console.log(`[backup-uploads-retention] deleted ${obj.Key}`);
      }
    } else {
      console.warn(`[backup-uploads-warn] ${key} (${tarSize}B) < 50% of ${prevU.Key} (${prevU.Size}B) — retention skipped`);
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        sendAdminNotificationEmail({
          adminEmail,
          event: 'backup_anomalia_tamano',
          data: {
            nueva_copia:     key,
            tamaño_nuevo:    `${tarSize} bytes`,
            copia_anterior:  prevU.Key,
            tamaño_anterior: `${prevU.Size} bytes`,
            nota: 'Uploads backup pesa menos de la mitad que la copia anterior.',
          },
        }).catch(() => {});
      }
    }

    return { name: key, sizeBytes: tarSize };

  } finally {
    try { if (fs.existsSync(tmpTar)) fs.unlinkSync(tmpTar); } catch (_) {}
  }
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
    const existing = await _listSorted(s3, BACKUP_PREFIX, BACKUP_REGEX);
    const prev     = existing.length ? existing[existing.length - 1] : null;
    const { size: gzSize } = fs.statSync(tmpGz);
    const tooSmall = !!(prev && prev.Size > 0 && gzSize < prev.Size / 2);

    // 5. Upload DB backup with ContentLength (R2 requires it for reliable streaming)
    const key = backupKey();
    await s3.send(new PutObjectCommand({
      Bucket:        process.env.R2_BUCKET,
      Key:           key,
      Body:          fs.createReadStream(tmpGz),
      ContentLength: gzSize,
      ContentType:   'application/gzip',
    }));

    console.log(`[backup-ok] key=${key} size=${gzSize}`);

    // 6. DB retention: keep last 30, skip if size anomaly
    if (!tooSmall) {
      const excess   = existing.length + 1 - RETENTION;
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
            nueva_copia:     key,
            tamaño_nuevo:    `${gzSize} bytes`,
            copia_anterior:  prev.Key,
            tamaño_anterior: `${prev.Size} bytes`,
            nota: 'La copia nueva pesa menos de la mitad que la anterior. Se conservaron todas las copias viejas.',
          },
        }).catch(() => {});
      }
    }

    // 7. Uploads backup — failure never blocks the DB backup result
    let uploadsResult = null;
    try {
      uploadsResult = await runUploadsBackup(s3);
    } catch (uploadsErr) {
      logError('backup-error', { message: `[uploads] ${uploadsErr.message}`, stack: uploadsErr.stack || '' });
      const todayUY    = uyNow().toISOString().slice(0, 10);
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail && _lastUploadErrorMailDate !== todayUY) {
        _lastUploadErrorMailDate = todayUY;
        sendAdminNotificationEmail({
          adminEmail,
          event: 'backup_error',
          data: { mensaje: `[uploads] ${uploadsErr.message}` },
        }).catch(() => {});
      }
    }

    return { name: key, sizeBytes: gzSize, uploads: uploadsResult };

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
  const todayUY = d.toISOString().slice(0, 10);
  if (latest) {
    const lastDate = latest.Key.slice(6, 16);
    if (lastDate >= todayUY) return false;
  }

  console.log('[backup-schedule] 04:xx UY window — triggering daily backup');
  runBackup().catch(() => {});
  return true;
}

// Called from the 30-min setInterval. Fires once at 08:00-08:29 UY.
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
        última_copia:     latest.Key,
        fecha:            latest.LastModified,
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
  listAllUploadsBackups,
};
