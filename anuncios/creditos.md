# Créditos — Anuncios "Reto 21 días" (Método Hana)

## Clips de video (Pexels)
Fuente: `motor-anuncios/stock/pexels/`. Licencia Pexels (uso libre, atribución no obligatoria).
El nombre del autor figura en cada página (no se pudo scrapear: Pexels sirve las páginas detrás de Cloudflare).

| Clip | Rol en el anuncio | URL |
|---|---|---|
| 7531376 | Protagonista sentada / meditación (cuerpo + grilla) | https://www.pexels.com/video/7531376/ |
| 7531377 | Protagonista (recorte de apoyo) | https://www.pexels.com/video/7531377/ |
| 7531378 | Protagonista postura gato (cuerpo + grilla) | https://www.pexels.com/video/7531378/ |
| 7531379 | Protagonista postura vaca (cuerpo + grilla) | https://www.pexels.com/video/7531379/ |
| 7927851 | Mujer con mancuernas, elevación (cuerpo + grilla) | https://www.pexels.com/video/7927851/ |
| 7927852 | Mujer con mancuernas, curl (cuerpo + grilla) | https://www.pexels.com/video/7927852/ |
| 8939152 | Mujer de pie con mat (hero / apertura del cuerpo + grilla) | https://www.pexels.com/video/8939152/ |
| 8374167 | Descargado pero NO usado (muestra instructora corrigiendo a alumna → va contra el brief) | https://www.pexels.com/video/8374167/ |

## Voz en off
- Proveedor: ElevenLabs (modelo `eleven_multilingual_v2`, endpoint text-to-speech with-timestamps).
- Voz: **Lucia — Warm Conversational**, es-MX (mexicana), middle-aged. `voice_id = akOBlaKhFd59YlK6xz9u`.
- Muestras descartadas en `motor-anuncios/voces/`: María de Jesús (Warm & Soothing), Diana (Warm & Expressive).
- VO larga (38s): `motor-anuncios/voces/vo-final.mp3` + `words.json` (24.6s).
- VO corta (20s): `motor-anuncios/voces/vo-short.mp3` + `words-short.json` (8s).
- Subtítulos palabra por palabra sincronizados al timestamp real de cada palabra.

## Duraciones
- `*-38s-*` principal (gancho 6s + cuerpo 21s, cortes ~3s + app 8s + cierre 3s).
- `*-20s-*` corta (gancho 5s + 3 ejercicios + app 4s + cierre 3s).

## Tipografías
- Poppins (800 ExtraBold / 900 Black) — OFL, vía `@expo-google-fonts/poppins`.
- Caveat (manuscrita, "Hasta Año Nuevo") — OFL, Google Fonts (`motor-anuncios/fonts/Caveat.ttf`).

## Tarjeta de la app (PiP)
- Capturada con Playwright de https://metodo-hana.vercel.app/plan-cd1a5b5cc7 (vista Día 1).
- Se usa la card de MOVILIDAD "Círculos de hombros y brazos" (sin foco en abdomen).

## Música
- Sin música (opcional en el brief; no se consiguió pista libre de derechos en esta tanda).

## UGC (presentadora) — calidad agencia, storyboard por frase
- Videos fuente: `motor-anuncios/ugc/guion-A.mp4`, `guion-B.mp4` (presentadora generada con IA, 704x1280).
  Marca "Presentadora generada con IA" visible todo el video (disclosure, abajo-izq).
- Subtítulos karaoke: ElevenLabs Forced Alignment del texto exacto → tiempo por palabra
  (`words-A-align.json`, `words-B-align.json`). PNG por palabra (Poppins 800, borde negro,
  palabra actual #c2456a y más grande) renderizados con Playwright (`ugc-overlays.js`).
  Numerales en pantalla: "21 días", "15 minutos", "1 minuto".
- Escenas ancladas a tiempos de palabra (cambio cada ~1.5-2.5 s): cara con punch-in (100/112%),
  grilla 3x3 de B-roll, stickers con emoji (CALISTENIA ASIÁTICA 🌸, 🎆 AÑO NUEVO, 🕒 15 MIN,
  SIN GIMNASIO), checks ✓ SIN SALTOS/SIN EQUIPO, split-screen, teléfono con quiz real del
  landing (localhost:4321) y grilla "plan 21 días" (vercel), tarjeta "Versión fácil" (vercel),
  calendario de 21 casillas (B), CTA que aparece + ▽, cierre de marca.
- Capturas: `motor-anuncios/ugc/screens/` (quiz edad/zonas/dolor/ruleta, plan-21, card-facil),
  tomadas con Playwright bloqueando facebook.com/net.
- SFX: ElevenLabs Sound Effects (pop/swoosh/ding) en `ugc/sfx/`, a volumen bajo.
- Música: ElevenLabs Music (`ugc/music.mp3`), instrumental suave, a ~-20 dB bajo la voz.
- Texto superior fijo primeros 2,5 s (para sound-off): A "15 MIN · SIN SALTOS · SIN EQUIPO",
  B "21 DÍAS ANTES DE AÑO NUEVO". Barra de progreso fina arriba en #c2456a.
- Salidas: `Hana-UGC-A-9x16.mp4` / `-4x5.mp4` (~23 s), `Hana-UGC-B-9x16.mp4` / `-4x5.mp4` (~19 s).
- Nota: las pausas >0,25 s caen en los cortes de escena (sin aire muerto); la voz conserva su
  cadencia natural en vez de recortar el audio.
