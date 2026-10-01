# Backup y restauración de la base de datos

## ¿Qué se respalda?

El archivo `daxos.db` (SQLite), que contiene todos los negocios, conversaciones, mensajes y pagos. Se copia una vez por día a las 04:00 hora de Uruguay hacia Cloudflare R2. Se conservan las últimas 30 copias.

El archivo `sessions.db` y los archivos subidos (`data/uploads`) no se incluyen en este backup.

---

## Cómo verificar que el backup funciona

Desde la terminal, en el directorio del proyecto:

```bash
node scripts/verify-backup.js
```

Esto descarga la copia más reciente de R2, la abre en modo lectura y muestra cuántos registros hay. **No toca la base de producción.**

---

## Cómo restaurar (paso a paso)

> ⚠️ Esto reemplaza todos los datos del servidor con los de la copia elegida. Hacelo solo si la base de producción está corrupta o perdida.

### Paso 1 — Detener el servidor

En Railway: abrí el servicio → **Settings → Deploy → Pause service** (o usá el botón de pausa/stop del deploy).

Esperá a que el servidor esté detenido antes de continuar.

### Paso 2 — Bajar la copia de R2

Desde la terminal (con las variables de entorno del proyecto cargadas):

```bash
node -e "
const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const fs = require('fs'); const { pipeline } = require('stream/promises');
require('dotenv').config({ path: '.env.local' });
(async () => {
  const s3 = new S3Client({
    region: 'auto',
    endpoint: 'https://' + process.env.R2_ACCOUNT_ID + '.r2.cloudflarestorage.com',
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const list = await s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET, Prefix: 'daxos-' }));
  const latest = list.Contents.filter(o => /^daxos-.*\.db\.gz$/.test(o.Key)).sort((a,b) => a.Key.localeCompare(b.Key)).pop();
  console.log('Bajando:', latest.Key);
  const res = await s3.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: latest.Key }));
  await pipeline(res.Body, fs.createWriteStream('restore.db.gz'));
  console.log('Listo: restore.db.gz');
})();
"
```

Si querés restaurar una copia específica (no la más reciente), reemplazá `latest.Key` por el nombre exacto del archivo, por ejemplo `daxos-2026-09-30-0400.db.gz`.

### Paso 3 — Descomprimir

```bash
gunzip -c restore.db.gz > restore.db
```

Esto crea `restore.db` sin modificar el `.gz`.

### Paso 4 — Subir al volumen de Railway

Desde el panel de Railway: **Variables → Volume** → montá el volumen localmente o usá el Railway CLI:

```bash
railway volume cp restore.db /app/data/daxos.db
```

Si no tenés el CLI configurado, podés hacerlo desde la consola de Railway (Shell del servicio):

```bash
# Dentro del shell de Railway
cp /tmp/restore.db /app/data/daxos.db
```

y subís el archivo con `railway run` o mediante el panel de archivos del volumen.

### Paso 5 — Verificar antes de reiniciar

Abrí la base en modo lectura desde el shell de Railway:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('/app/data/daxos.db', { readonly: true });
console.log('businesses:', db.prepare('SELECT COUNT(*) as n FROM businesses').get().n);
console.log('messages:', db.prepare('SELECT COUNT(*) as n FROM messages').get().n);
db.close();
"
```

Si los números tienen sentido, continuá.

### Paso 6 — Reiniciar el servidor

En Railway: **Settings → Deploy → Resume service** (o triggereá un nuevo deploy).

El servidor arranca, hace un WAL checkpoint y queda operativo.

---

## Forzar un backup manual

```bash
curl -X POST https://tu-dominio.railway.app/admin/backup-now \
  -H "Authorization: Bearer TU_ADMIN_SET_WA_TOKEN"
```

Devuelve el nombre y tamaño del archivo creado.

## Ver todas las copias disponibles

```bash
curl https://tu-dominio.railway.app/admin/backups \
  -H "Authorization: Bearer TU_ADMIN_SET_WA_TOKEN"
```
