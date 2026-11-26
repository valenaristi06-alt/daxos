'use strict';

/**
 * Disk usage of the data volume (Railway volume mounted at /app/data, 500 MB today).
 * Uses statfs on the data dir. If DISK_CAP_MB is set, usage is instead the size of the
 * data dir measured against that cap (for hosts where statfs reports the host disk).
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DB_DIR || path.join(__dirname, '../data');

function _dirBytes(dir) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += _dirBytes(p);
      else if (e.isFile()) total += fs.statSync(p).size;
    } catch (_) {}
  }
  return total;
}

// → { totalBytes, usedBytes, freeBytes, pct (0..1), source }
function getDiskUsage(dir = DATA_DIR) {
  const capMb = Number(process.env.DISK_CAP_MB);
  if (Number.isFinite(capMb) && capMb > 0) {
    const totalBytes = capMb * 1024 * 1024;
    const usedBytes = _dirBytes(dir);
    return { totalBytes, usedBytes, freeBytes: Math.max(0, totalBytes - usedBytes), pct: usedBytes / totalBytes, source: 'cap' };
  }
  const st = fs.statfsSync(dir);
  const totalBytes = st.blocks * st.bsize;
  const freeBytes = st.bavail * st.bsize;
  const usedBytes = totalBytes - st.bfree * st.bsize;
  return { totalBytes, usedBytes, freeBytes, pct: totalBytes > 0 ? usedBytes / totalBytes : 0, source: 'statfs' };
}

// Cached for a minute: called on every incoming media file.
let _cache = null, _cacheAt = 0;
function diskUsageCached() {
  if (_cache && Date.now() - _cacheAt < 60_000) return _cache;
  try { _cache = getDiskUsage(); } catch (_) { _cache = null; }
  _cacheAt = Date.now();
  return _cache;
}
function _resetDiskCache() { _cache = null; _cacheAt = 0; }

const mb = (b) => `${Math.round(b / 1024 / 1024)} MB`;

module.exports = { getDiskUsage, diskUsageCached, _resetDiskCache, mb, DATA_DIR };
