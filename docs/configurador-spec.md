# Daxos — Chat configurador: especificación y plan

24 nov 2026 · @Vale

El chat configurador deja un asistente listo para prender en 15 minutos o menos: el dueño cuenta su negocio por escrito, por audio o con su web, Daxos completa el panel solo, pregunta únicamente lo que falta y lo prueba con 10 clientes simulados antes de prenderlo.

> **Correcciones aplicadas en Fase 0 (2026-11-24):**
> 1. Audio y voz vienen en los planes **Crecimiento y Negocio** (`planAllowsVoice`), no son un adicional aparte; en Arranque no están.
> 2. **"Tu número personal" se guarda en `users.phone`** (del dueño), no en una columna de `businesses`.
> 3. La **Fase 1 se basa en `extractBusinessData`** (extracción estructurada del demo-generator), **no** en `summarizeWebsite` (que solo da un resumen de 2-3 líneas).
> 4. El **informe en plata y el botón de seguimiento quedan fuera de la primera versión** (van después, con el agente 2).

## Objetivo y cómo medimos

El objetivo es que ningún dueño tenga que llenar el panel a mano para que su asistente funcione bien. Hoy son 26 campos en 6 bloques, y se llenan mal (ej. "XVFDV" en "¿Qué hacés o vendés?"). Un asistente mal configurado responde mal, y el negocio en prueba se va antes del día 14.

| Métrica | Cómo se mide | Meta inicial |
|---|---|---|
| Tiempo hasta prender | Del registro a la primera respuesta real a un cliente | 15 min o menos |
| Campos completados solos | % de campos que Daxos llenó sin preguntar | 70% o más cuando hay web |
| Prenden en 24 h | % de registros que conectan WhatsApp y prenden en 24 h | Medir base actual antes de lanzar |
| Prueba a pago | % de negocios en prueba que pagan | Medir base actual antes de lanzar |

Las metas son hipótesis: se ajustan con los primeros 10 negocios. Las dos últimas hay que medirlas ya, antes de construir.

## El recorrido

El dueño cuenta su negocio, confirma el borrador y lo prueba con 10 clientes simulados. Cada corrección se aplica y se vuelve a probar; prende cuando todo está bien, o cuando toca "Prender igual".

## Dónde va en el panel

El chat va arriba de todo en Configuración, encima de los 6 bloques de campos.
- **Negocio nuevo:** la página abre con el chat. Los bloques quedan abajo, cerrados, y se llenan a medida que el chat completa datos.
- **Negocio ya configurado:** arriba aparece el chat "Revisar mi asistente". Los bloques siguen abajo como hoy, para editar a mano.
- En los dos casos: cada campo que llenó el chat muestra de dónde salió (de tu web, de tu audio, lo supuse por tu rubro).

Daxos nunca pregunta lo que ya sabe: primero lee todo lo que mandó el dueño y después pregunta solo lo que falta, de a una pregunta y con botones. Con web, lo normal deberían ser 4 a 6 preguntas.

**Primer mensaje (siempre):** "Contame de tu negocio como se lo contarías a un cliente nuevo. Podés escribir, mandarme un audio o pegar tu web." Botones: Pegar mi web · Mandar audio · Escribir. Debajo: "¿Tenés Instagram? Pegá tu bio o mandame capturas de las publicaciones con precios."

**Rubro:** con lo recibido, Daxos clasifica el rubro (veterinaria, inmobiliaria, estética, comercio de productos, gastronomía, salud, servicios) y carga su paquete: valores por defecto, palabras de urgencia, temas prohibidos y casos de prueba. Solo pregunta "¿Tu negocio es una veterinaria?" si no está seguro.

### Preguntas, solo si falta el dato, en este orden

| # | Pregunta | Respuesta | ¿Bloquea prender? |
|---|---|---|---|
| 1 | ¿Qué vendés o qué servicio das? | Texto o audio | Sí |
| 2 | ¿En qué horario atendés? | Lun a vie 9 a 18 · Lun a sáb · Siempre · Otro | Sí |
| 3 | ¿Das precios? | Sí, todos · Algunos · No, que me derive | Sí |
| 4 | Pasame tus precios | Lista, foto o PDF | Sí, si en la 3 dijo Sí o Algunos |
| 5 | ¿A qué celular te aviso cuando tengas que atender vos? | Número | Sí |
| 6 | ¿Cómo te pagan y cómo entregás? | Botones de pago + Envío · Retiro · Las dos | No: si falta, el asistente dice que lo confirma el equipo |
| 7 | ¿Recibís turnos o visitas? | Sí, que agende · Sí, que me avise · No | No |
| 8 | ¿Hay algo que tu asistente nunca deba decir? | Texto, o "Nada en especial" | No |
| 9 | Pasame 3 mensajes que ya le mandaste a clientes, o un audio hablando como les hablás | Texto o audio | No: si lo saltea, usa el tono del rubro |

**Confirmación:** antes de la prueba, Daxos muestra "Esto es lo que entendí", agrupado como el panel. Cada dato lleva de dónde salió y un botón Editar. **Los precios siempre se confirman a mano**, aunque salgan de la web.

## Qué campos del panel completa

El configurador completa los mismos campos que el panel actual, sin campos nuevos; todo va a un **borrador**: la configuración real no cambia hasta que el dueño toca Prender (o Aplicar, si ya tenía una).

| Bloque | Campo | De dónde sale | ¿Se pregunta? |
|---|---|---|---|
| Tu negocio | Nombre del negocio | Web, bio o audio | Solo si no aparece |
| Tu negocio | ¿Qué hacés o vendés? | Web, bio o audio, resumido en 2-3 frases | Pregunta 1, si falta |
| Tu negocio | Sitio web | Lo que pegó | No |
| Tu negocio | Tus precios y servicios | Web, fotos de precios o PDF | Preguntas 3 y 4; siempre se confirma |
| Tu negocio | PDF para enviar al cliente | Archivo que suba | Se ofrece, no se exige |
| Tu negocio | Imágenes para enviar | Fotos que suba | Se ofrece, no se exige |
| Horarios | Horario de atención | Web o bio | Pregunta 2, si falta |
| Horarios | Qué hacer cuando estamos cerrados | Se redacta con el horario y el teléfono | No |
| Horarios | Teléfono de urgencias | Página de contacto | Solo en rubros con urgencias (veterinaria, salud) |
| Cómo habla | Mensajes tuyos reales | Mensajes o audio del dueño | Pregunta 9 |
| Cómo habla | Largo de los mensajes | Estilo de sus mensajes; si no hay, Medio | No |
| Cómo habla | Cómo responde (texto/audio) | Plan del negocio | No; **audio solo en Crecimiento y Negocio** |
| Cómo habla | Velocidad | 5 segundos | No |
| Cómo habla | Mensajes separados | Apagado | No |
| Reglas | Instrucciones libres | Envíos, pagos, cambios de la web, preguntas 6 y 8, paquete del rubro | No; se muestran para editar |
| Reglas | Documentos que el asistente lee | Preguntas frecuentes y políticas de la web | No |
| Cómo actúa | Cuando alguien escribe primero | Rubro: ticket alto → Generar confianza; ticket bajo → Equilibrado | No |
| Cómo actúa | Qué decís cuando es caro | Diferencial de la web + paquete del rubro | No |
| Cómo actúa | Pedidos de turno | Pregunta 7 | Pregunta 7 |
| Cómo actúa | Qué hace si alguien no responde | Paquete del rubro | No |
| Cuándo avisarte | **Tu número personal (`users.phone`)** | Pregunta 5 | Sí |
| Cuándo avisarte | Pasar la conversación a una persona | "hablar con una persona, reclamo" + paquete del rubro | No |
| Cuándo avisarte | Mensaje al cliente cuando se pausa | Texto por defecto | No |
| Cuándo avisarte | Avisos de urgencia | Paquete del rubro | No |
| Cuándo avisarte | Resumen semanal | Activado | No |
| Cuándo avisarte | Contactos que atendés vos | Vacío | No |

## La prueba con 10 clientes simulados

Antes de prender, Daxos le hace 10 consultas típicas del rubro al asistente real, con la configuración del borrador, y el dueño aprueba o corrige cada respuesta.

Por dentro usa lo mismo que producción (mismo armado del prompt, mismo modelo, mismas reglas, incluido el tope de precios), pero en **modo prueba**: no envía nada por WhatsApp y no suma a las 150 conversaciones ni a los topes de gasto. Un revisor automático marca cada respuesta como Bien o Revisar, con el motivo: inventó un dato, no cumplió una regla, no respondió lo que le preguntaron o es demasiado larga.

| # | Caso | Qué se prueba |
|---|---|---|
| 1 | Precio de un producto de la lista | Da el precio correcto |
| 2 | Producto que no está en la lista | No inventa precio ni stock |
| 3 | Envío y costo | No inventa zonas ni costos |
| 4 | Horario y ubicación | Da el dato exacto |
| 5 | Le parece caro | Responde sin regalar descuentos |
| 6 | Turno o visita | Pide día y hora, no confirma solo |
| 7 | Fuera de horario | Usa el mensaje de cerrado |
| 8 | Viene de un anuncio | Responde sobre el producto del anuncio |
| 9 | Pide una persona o reclama | Pausa y avisa al dueño |
| 10 | Regla especial del dueño | La cumple (ej. tope de 2 precios) |

Una lista de 10 tarjetas con su estado. Al tocar una, se abre la charla con burbujas como WhatsApp. Debajo de cada respuesta: Está bien y Corregir. Corregir abre un cuadro para escribir o mandar un audio.

**Cuando el dueño corrige:**
1. Daxos decide dónde va: un dato, una regla (Instrucciones libres) o un límite que necesita código (como el tope de precios). En el último caso no promete nada: avisa al equipo de Daxos.
2. Muestra el cambio antes de aplicarlo: "Voy a agregar a tus reglas: '…'. ¿Lo aplico?"
3. Al confirmar, corre el detector de contradicciones sobre el cambio.
4. Repite ese caso y los afectados, y muestra la respuesta de antes y la de ahora.

**Se puede prender** cuando no queda ningún caso en Revisar, o cuando el dueño toca "Prender igual" (queda registrado).

**Costo:** estimado US$0,10 a 0,30 por prueba completa (10 casos, ~3 llamadas cada uno, con prompt en caché). Hipótesis; se mide en Fase 3. Límite: 5 pruebas completas por día por negocio.

## Informe semanal (fuera de la primera versión)

El informe en plata y el botón "Escribirles a los que no compraron" van después del configurador, con el agente 2 (seguimiento). No forman parte de la v1.

## Límites y riesgos

El riesgo principal es que el configurador invente datos del negocio con tono seguro; por eso todo dato muestra de dónde salió y los precios se confirman siempre.

| Riesgo | Qué pasaría | Mitigación |
|---|---|---|
| Instagram no se puede leer automáticamente | Bloquea a los lectores automáticos | Pedir la bio pegada o capturas, y leer las capturas como imágenes |
| Datos inventados al completar | El asistente dice un precio o plazo falso | Origen visible, precios confirmados a mano, revisor automático en la prueba |
| Pisar la configuración de un cliente actual | Se pierde lo ajustado | Borrador separado; en negocios ya configurados solo propone cambios, aceptados uno por uno |
| Costo y abuso de la prueba | Gasto de modelo sin control | 5 pruebas/día por negocio y costo registrado |
| Audios del dueño | Guardar voz que no se necesita | Se transcriben con el sistema que ya existe y el audio se borra después |
| Ofrecer lo que el plan no incluye | El dueño elige audio en Arranque y no funciona | El configurador solo ofrece lo que incluye su plan (`planAllowsVoice`) |
| Paquetes de rubro mal hechos | Un consultorio que da diagnósticos | Empezar con 3 rubros (productos, veterinaria, inmobiliaria) + uno genérico |

## Plan para Claude Code (6 fases)

Reglas de todas las fases: git worktree (no tocar la carpeta principal), un commit por fase, nada de push sin "aprobado". No agregar dependencias sin preguntar. No tocar `src/baileys.js`, `patches/`, `package.json` ni `package-lock.json`. No leer `.env.local`. Migraciones idempotentes, con el siguiente número libre (hoy la última es 027). Suites una a la vez, con limpieza de puertos; fallas permitidas: `test-pause-keyword` 77/78 y `test-bh-real`. Publicación: merge a main con `--no-ff`, push de main y fast-forward a `fix/colbet-lid`, sin `--force`.

0. **Fase 0:** mapa, solo lectura. Entrega: `docs/configurador-fase0.md`.
1. **Fase 1:** motor de lectura, sin pantalla. Recibe texto, audio, una URL o imágenes, y devuelve un borrador con el mismo esquema del panel, con origen y confianza por campo. El borrador vive en una tabla aparte (`config_drafts`, migración 028). Tests con páginas guardadas, nunca la web en vivo. Condición: con la web de Artesanías guardada, llena ≥70% de los campos sin inventar ningún precio, basado en `extractBusinessData`.
2. **Fase 2:** el chat del configurador. Primer mensaje, rubro, preguntas solo de lo que falta, "Esto es lo que entendí" y Aplicar. Arriba de todo en Configuración. Flag por negocio desde el admin. Condición: capturas desktop y mobile; un negocio sin el flag no cambia en nada.
3. **Fase 3:** la prueba con clientes simulados. Modo prueba que no envía por WhatsApp ni suma a contadores (con test que lo demuestre), 3 rubros iniciales, revisor automático, costo registrado y límite diario. Condición: reportar el costo real de una prueba completa.
4. **Fase 4:** correcciones habladas. La corrección se traduce en un dato, una regla o un aviso al equipo; muestra el cambio, lo aplica al confirmar, corre el detector de contradicciones y repite los casos afectados.
5. **Fase 5:** lanzamiento. Activado para todos los registros nuevos. Los clientes actuales lo ven como "Revisar mi asistente". Eventos del embudo para medir las 4 métricas.

Después del lanzamiento: el informe semanal con plata estimada y el botón de seguimiento, junto con el agente 2.
