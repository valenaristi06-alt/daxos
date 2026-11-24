# Chat configurador · Fase 0 — Mapa del código (solo lectura)

**Fecha:** 2026-11-24 · **Base:** `origin/main` @ b74a9aa · **Worktree:** `/tmp/daxos-cfg` (sin commit).
**Alcance:** solo lectura. No se escribió código, no se tocó `src/baileys.js`, `package.json`, `package-lock.json`, `patches/`, ni `.env.local`. No se imprimieron datos de clientes.
**Archivos leídos:** `src/claude.js`, `src/server.js`, `src/db.js`, `src/demo-generator.js`, `src/pricecap.js`, `src/elevenlabs.js`, `public/dashboard.html`.

> La spec vive en `docs/configurador-spec.md`. Este doc la analiza; no la cumple a ciegas (ver §7).

---

## 1. Campos del panel de Configuración (6 bloques)

Pantalla = `public/dashboard.html`. El prompt se arma en `buildSystemPrompt()` (`src/claude.js:33`). Casi todo son columnas de `businesses`; el bloque "Cómo actúa" vive dentro del JSON `survey_answers`; estilo dentro del JSON `style_profile`.

### Bloque "Tu negocio"
| Nombre en pantalla | Tabla.columna | Uso en el prompt | Default |
|---|---|---|---|
| Nombre del negocio | `businesses.name` | `claude.js:35` «Sos el asistente de ventas de "X"» | — (requerido) |
| ¿Qué hacés o vendés? | `businesses.business_context` | `claude.js:41-42` «Contexto del negocio» | NULL |
| Sitio web | `businesses.website_url` | No va al prompt; dispara el resumen web (→ `website_summary`) | NULL |
| Tus precios y servicios | `businesses.pricing_info` | `claude.js:45-46` «PRECIOS Y SERVICIOS» | NULL |
| PDF para enviar al cliente | `businesses.document_path` / `document_name` | `claude.js:92-93` gatillo `[SEND_DOC]` | NULL |
| Imágenes para enviar | tabla `business_images` (`addBusinessImage`) | Se envían a pedido; no en el prompt | vacío |
| (derivado) Resumen web | `businesses.website_summary` | `claude.js:49-50` «Información extraída del sitio web… puede estar desactualizada» | NULL |

### Bloque "Horarios"
| Nombre | Tabla.columna | Uso | Default |
|---|---|---|---|
| Horario de atención | `businesses.business_hours` (JSON) + `business_hours_start`/`_end` | Lógica abierto/cerrado (`isOpenNow`) y agenda; no texto directo | NULL |
| Qué hacer cuando cerrados | `businesses.after_hours_instructions` | Inyectado por `runtimeCtx.afterHoursInstructions` cuando está cerrado | NULL |
| Teléfono de urgencias | `businesses.urgent_phone` | Mensaje de urgencia fuera de horario | NULL |

### Bloque "Cómo habla"
| Nombre | Tabla.columna | Uso | Default |
|---|---|---|---|
| Mensajes tuyos reales | `businesses.sales_examples` (JSON array) | `claude.js:53-57` «Tono y estilo — ejemplos» | NULL |
| Largo de los mensajes | `businesses.style_profile.largo_mensajes` | `claude.js:66` | "medio" si no hay |
| Cómo responde (texto/audio) | `businesses.response_mode` (`texto`/`audio_key`/`audio`) | `server.js:1036` `wantsAudio` → TTS | "texto"; audio solo Crecimiento+ |
| Velocidad | `businesses.response_delay` | Debounce de respuesta | 5 (seg) |
| Mensajes separados | `businesses.style_profile.mensajes_separados` | `claude.js:70-72` separador `\|\|\|` | off |
| (voz clonada) | `businesses.voice_id` + `voice_consent_at` | TTS con voz propia (`elevenlabs.js`) | NULL; Crecimiento+ |

### Bloque "Reglas"
| Nombre | Tabla.columna | Uso | Default |
|---|---|---|---|
| Instrucciones libres | `businesses.owner_rules` | `claude.js:96-97` «REGLAS DEL NEGOCIO» (prioridad sobre config, no sobre seguridad) | NULL |
| (aviso) | `businesses.owner_rules_warning` | Guarda la contradicción detectada al guardar (`checkOwnerRulesConflict`) | NULL |
| Documentos que el asistente lee | tabla `business_documents` (`addBusinessDocument`, `getBusinessDocumentTexts`) | Contexto de lectura (FAQ/políticas) | vacío |

### Bloque "Cómo actúa" — todo dentro de `businesses.survey_answers` (JSON)
Prompt: `claude.js:76-80` recorre el JSON y vuelca «Información del negocio: - clave: valor».
| Nombre | Clave en `survey_answers` | Uso | Default |
|---|---|---|---|
| Cuando alguien escribe primero | `prioridad` (`cerrar_rapido`/`generar_confianza`/`equilibrado`) | línea genérica del JSON | — |
| Qué decís cuando es caro | `objeciones_precio` | ídem | — |
| Pedidos de turno | `businesses.booking_enabled` / `agenda_enabled` (+ survey) | Bloque AGENDA `claude.js:104` | off |
| Qué hace si alguien no responde | `sin_respuesta` | ídem JSON | — |

### Bloque "Cuándo avisarte"
| Nombre | Tabla.columna | Uso | Default |
|---|---|---|---|
| Tu número personal | **`users.phone`** (del dueño, `setUserPhone`; `dashboard.html:1400` `u.phone`) | Destino de avisos al dueño | NULL |
| Pasar la conversación a una persona | `businesses.pause_keywords` | Pausa por palabra clave | NULL |
| Mensaje al cliente cuando se pausa | `businesses.pause_reply_text` | Respuesta automática al pausar | NULL |
| Avisos de urgencia | `businesses.urgent_alert_enabled` + `urgent_keywords` | Alerta urgente al dueño | off |
| Resumen semanal | `businesses.weekly_summary_enabled` | Email semanal | 1 (on) |
| Contactos que atendés vos | tabla `excluded_contacts` | El bot no responde a esos números | vacío |

**Ojo (≠ a lo que dice la spec):** "Tu número personal" es `users.phone`, no una columna de `businesses`. "Teléfono de urgencias" sí es `businesses.urgent_phone`. Son dos campos distintos.

---

## 2. Analizador de sitio web y generador de demos

### Analizador web (producción, panel)
- **Función:** `fetchAndSummarizeWebsite(rawUrl)` (`server.js:853`) + `summarizeWebsite(text)` (`claude.js:478`, modelo Haiku).
- **Recibe:** una URL. Fetch con guard SSRF (`src/ssrf.js`), redirects manuales revalidados, timeout, tope de bytes, UA `DaxosBot/1.0`.
- **Devuelve:** un **resumen de 2–3 líneas** (texto plano), NO campos estructurados. Se guarda en `businesses.website_summary` (`server.js:967`, no bloqueante).
- **Qué campos llena hoy:** solo `website_summary` (una frase en el prompt). **No** llena `pricing_info`, `business_hours`, etc.
- **Cuando falla (Instagram):** IG/redes bloquean bots → el fetch trae un muro de login sin contenido útil o 403. `summarizeWebsite` produce basura o tira error → se captura y `website_summary` queda NULL (no bloquea el guardado). **No hay manejo especial de IG.** La spec lo cubre pidiendo bio pegada o capturas (leídas como imagen). ✔ gap real.

### Generador de demos (prospectos)
- **Archivo:** `src/demo-generator.js` (+ `src/demo-flow.js`, `handleDemoFlow`).
- `extractBusinessData(pages, logCost)` (`demo-generator.js:32`): recibe páginas scrapeadas → Haiku extrae **JSON estructurado**: `nombre, rubro, descripcion, servicios[], preguntas_frecuentes[], promos[], sedes[], ubicacion, tono, publico`. Regla dura: **si un dato no está, `null`/`[]`, nunca inventa.**
- `buildDemoSystemPrompt(data)` + `generateDemoChatReply(...)` (Sonnet): arman y corren un asistente demo.
- **Esto es casi el motor de lectura de la Fase 1**: ya convierte texto web → esquema estructurado sin inventar. Diferencia clave vs el analizador del panel: el panel resume a una frase; el demo extrae campos. **Para el configurador conviene reusar `extractBusinessData`, no `summarizeWebsite`.**
- Nota técnica: `demo-generator.js` instancia Anthropic directo con `process.env.ANTHROPIC_API_KEY`; `claude.js` usa `getClient()` (config.local/global/env/DB). Unificar en Fase 1.

---

## 3. Reuso de lo que ya existe

| Pieza | Dónde | Cómo reusarla en el configurador |
|---|---|---|
| **Transcripción de audio** | `transcribeAudio(buffer, contentType)` (`elevenlabs.js:176`, ElevenLabs Scribe). Ya se usa para audios de clientes (`server.js:4118`). | El dueño manda audio → mismo `transcribeAudio` → texto que entra al motor de lectura. La spec pide **borrar el audio después** (hoy no se persiste el buffer: se transcribe y se descarta → ya alineado). |
| **Detector de contradicciones** | `checkOwnerRulesConflict(business, ownerRules, opts)` + `buildOwnerRulesConflictPrompt` (`claude.js:492-532`). Haiku, JSON `{conflict, message}`, **falla-abierto** (ante error no bloquea), `opts.call` inyectable para tests. | Antes de aplicar una corrección/regla nueva (Fase 4) y en "Esto es lo que entendí", correrlo sobre el borrador. Ya es testeable sin red. |
| **Tope de precios** | `src/pricecap.js`: `findPrices`, `extractPrices`, `enforcePriceCap(reply, priorSet, remaining)`, `DEFERRAL`. En el prompt: `claude.js:286-293` (`runtimeCtx.priceCap`). | La prueba con clientes simulados (Fase 3) debe correr con el **mismo `runtimeCtx.priceCap`** y post-procesar con `enforcePriceCap`, para que el caso 10 ("pasame 5 precios con tope 2") se comporte igual que producción. |

---

## 4. Planes y respuestas con audio/voz

- **Planes (código):** `MP_AMOUNT_TO_PLAN` (`server.js:29`): `arranque`=2990, `crecimiento`=5990, `a_medida`=12990 (la UI lo llama "Negocio"; internamente `a_medida`).
- **Topes diarios** (`server.js:33-34`): Anthropic calls `{arranque:70, crecimiento:150, a_medida:300}`; TTS chars `{arranque:20000, crecimiento:100000, a_medida:500000}`.
- **Audio/voz:** `planAllowsVoice = ['crecimiento','a_medida']` (`dashboard.html:1339`). En Arranque el bloque de voz está bloqueado (`voice-plan-lock`). `response_mode`: `texto` (todos), `audio_key` (audio solo en el 1er/mensaje clave, `server.js:1036`), `audio` (siempre). TTS con `voice_id` = voz clonada propia.
- **Conclusión para el configurador:** audio/voz **viene en Crecimiento y Negocio**, no en Arranque; no es un adicional aparte, es parte del plan. El configurador **solo debe ofrecer audio si `planAllowsVoice`** (riesgo de la spec: "ofrecer lo que el plan no incluye"). ✔ coincide con la spec.

---

## 5. Pantalla de Configuración y dónde va el chat

- **Archivos que la arman:** `public/dashboard.html` (los 6 bloques de campos, form + JS inline de carga/guardado contra `/api/business`), `public/dashboard.css` (estilos), y el backend `PUT /api/business` (`server.js`, un solo endpoint que recibe todas las columnas + `survey_answers`).
- **Cómo poner el chat arriba de todo:** insertar un panel nuevo como **primer hijo** del contenedor de bloques en `dashboard.html`, antes del primer `.config`/bloque. Lógica por flag de negocio:
  - **Negocio nuevo (sin datos):** abrir con el chat expandido; los 6 bloques debajo, colapsados, y que se vayan llenando/mostrando a medida que el chat aplica datos al borrador.
  - **Negocio ya configurado:** arriba una tarjeta "Revisar mi asistente" (chat colapsado); los bloques siguen **igual que hoy** para editar a mano.
  - En ambos: cada campo que llenó el chat muestra su **origen** (web/audio/supuesto) — requiere un dato de procedencia por campo (lo provee la tabla borrador, §8).
- **Activación:** por negocio, con un flag desde el admin (Fase 2). Un negocio **sin el flag no cambia en nada** (condición de aceptación).
- Reutilizable: ya hay patrón de "activar feature por negocio desde admin" y el banner/aviso con tokens del panel (de la tarea bot_paused). No hacen falta componentes nuevos.

---

## 6. El mismo motor web → demo de venta desde una URL (sin crear negocio)

Ya existe y es el camino: `extractBusinessData(pages)` → JSON estructurado → `buildDemoSystemPrompt(data)` → `generateDemoChatReply(...)` (`src/demo-generator.js`). El demo-flow corre **sin crear un `businesses` real** (opera sobre `data` en memoria + tablas `demo*`: `createDemo`, `getDemo`, `logDemoCost`, con topes por IP/teléfono/global).
**Plan de reuso:** el motor de lectura de la Fase 1 produce el mismo esquema estructurado que `extractBusinessData`. Con ese esquema podés: (a) llenar el borrador del panel (configurador), o (b) alimentar `buildDemoSystemPrompt` para una demo de venta pública desde una URL — **la misma extracción sirve para las dos cosas**. Recomendación: un único `src/reader.js` (o extender `demo-generator.js`) que devuelva el esquema; configurador y demo lo consumen.

---

## 7. Revisión crítica de la spec

**Qué está muy bien:** origen por dato + precios siempre a mano (ataca el riesgo #1: inventar con tono seguro); borrador separado (no pisa al cliente actual); prueba con el mismo prompt/modelo/tope que producción; medir las 2 métricas de base ANTES de construir.

**Qué cambiaría / falta:**
1. **"Tu número personal" = `users.phone`, no `businesses`.** La spec lo lista como campo del panel; en el código es del usuario. El borrador/motor tiene que saber escribir en `users`, no solo en `businesses`. Definirlo explícito en Fase 1.
2. **El analizador del panel NO extrae campos** (solo un resumen). La spec asume que "lee la web y llena 70%". El que llena es `extractBusinessData` (demo). **Fase 1 debe basarse en ese**, no en `summarizeWebsite`. Si no, el 70% no se alcanza.
3. **`survey_answers` y `style_profile` son JSON, no columnas.** El motor debe escribir dentro de esos blobs con las claves exactas (`prioridad`, `objeciones_precio`, `sin_respuesta`, `largo_mensajes`, `mensajes_separados`…) o el prompt no los toma. Riesgo de claves mal escritas → agregar validación de esquema.
4. **Precios desde imágenes/PDF:** la spec pide leer capturas de precios y PDF. Hoy las imágenes de cliente se interpretan en el prompt, pero **no hay un extractor de precios de imagen/PDF a texto estructurado**. Es trabajo nuevo real (visión). Marcarlo como dependencia de la Fase 1, no gratis.
5. **Idempotencia del "Aplicar" en negocio configurado:** la spec dice "propone cambios uno por uno". Falta definir el **diff** campo por campo (viejo vs nuevo) y que aceptar uno no pise otros. Debe vivir en la tabla borrador.
6. **Costo/línea de la prueba:** la estimación US$0,10–0,30 depende del caché de prompt; con 10 casos × ~3 llamadas puede subir. Ok medirlo en Fase 3, pero poner el **límite de 5/día desde el día 1** (ya contemplado).
7. **Unificar el cliente Anthropic** (`demo-generator.js` usa env directo; `claude.js` usa `getClient()`). Si no, en algunos entornos (sin env, con key en DB) el motor falla silencioso.

**Qué sacaría de la v1 (para que sea excelente ya):** el **informe en plata** y el **botón de seguimiento** (la propia spec los manda después, con el agente 2) — fuera de v1. Audio del dueño en la v1 del chat: útil pero agrega STT + manejo de archivos; se puede diferir a después de que el texto/web funcione, sin bloquear el núcleo. Empezar con **3 rubros + genérico** (ya acordado), no los 7.

---

## 8. Plan Fase 1 y Fase 2

### Fase 1 — Motor de lectura (sin pantalla)
- **Entrada:** texto / audio (→ `transcribeAudio`) / URL (→ fetch con SSRF + `extractBusinessData`) / imágenes (visión, campo nuevo). **Salida:** borrador con el esquema del panel + **origen y confianza por campo**.
- **Archivos a tocar:** nuevo `src/reader.js` (orquesta extracción y arma el borrador; reusa `demo-generator.extractBusinessData`, `summarizeWebsite`, `transcribeAudio`); `src/db.js` (migración 028 + funciones del borrador); `src/claude.js` (exportar helpers si hace falta, sin cambiar prompts). **No tocar** `server.js` de producción todavía (sin pantalla).
- **Tabla borrador (migración 028, idempotente):**
  ```
  config_drafts(
    id INTEGER PK,
    business_id INTEGER NOT NULL REFERENCES businesses(id),
    field TEXT NOT NULL,           -- 'business_context','pricing_info','survey_answers.prioridad',...
    value TEXT,                    -- valor propuesto (JSON si aplica)
    source TEXT,                   -- 'web'|'audio'|'texto'|'rubro'|'imagen'
    confidence REAL,               -- 0..1
    status TEXT DEFAULT 'pending', -- 'pending'|'applied'|'discarded'
    created_at TEXT DEFAULT (datetime('now'))
  )
  ```
  Idempotente (patrón `applied('028_config_drafts')` + `schema_migrations` como 025–027). **Vacía = no cambia nada** en producción (ninguna lectura la consulta aún).
- **Tests (páginas guardadas, nunca web en vivo):** fixtures en `scripts/fixtures/` (HTML de Artesanías MYV guardado). `scripts/test-reader.js`: con esa página llena **≥70% de los campos** y **0 precios inventados** (comparar contra lista real). Mock del modelo vía `opts.call` (como `checkOwnerRulesConflict`) para no pegarle a la API.
- **Riesgos de romper lo que anda:** bajo si el motor no se enchufa a `generateReply`/`PUT /api/business`. Riesgo real: la migración 028 corre en el arranque de `db.js` → tiene que ser no-fatal (try/catch como 025–027).
- **Horas:** 10–14 h (motor + migración + fixtures + tests). +4–6 h si entra extracción de precios desde imagen/PDF (visión).

### Fase 2 — El chat del configurador
- **Archivos:** `public/dashboard.html` (panel del chat arriba de los bloques), `public/dashboard.css` (estilos reusando tokens), JS del chat (inline o `public/js/config-chat.js`), `src/server.js` (endpoints: `POST /api/config-chat/message`, `GET/POST /api/config-chat/draft`, `POST /api/config-chat/apply`), flag por negocio desde admin.
- **Flujo:** primer mensaje fijo → clasificar rubro → preguntar solo lo que falta (de a una, con botones) → "Esto es lo que entendí" (agrupado como el panel, con origen + Editar, precios siempre confirmados) → **Aplicar** (escribe `businesses`/`users`/JSON desde el borrador; corre `checkOwnerRulesConflict`).
- **Tests / condición:** capturas desktop (1280) y mobile (390) antes de aprobar; **un negocio sin el flag no cambia en nada** (test que lo demuestre, estilo `test-bot-pause`).
- **Riesgos:** pisar config existente → el "Aplicar" en negocio configurado debe ser diff por campo, aceptado uno por uno (nunca bulk). Mantener `PUT /api/business` intacto (el chat usa endpoints nuevos, no reescribe el form).
- **Horas:** 16–22 h (UI chat + endpoints + "esto es lo que entendí" + apply + flag + capturas + test de aislamiento).

**Reglas de todas las fases (recordatorio):** worktree, 1 commit por fase, sin push sin "aprobado", sin dependencias nuevas, no tocar `baileys.js`/`patches`/`package*.json`, migraciones idempotentes con el próximo número libre (**028**), suites de a una con limpieza de puertos (permitidas: `test-pause-keyword` 77/78 y `test-bh-real`), publicar con merge `--no-ff` a main + push + ff a `fix/colbet-lid` sin `--force`.
