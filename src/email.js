async function sendPauseEmail({ to, businessName, contactId, messageText, conversationId }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('[resend] RESEND_API_KEY not set, skipping email');
    return;
  }

  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: `Nueva conversación pausada — ${businessName}`,
    html: `
      <p>Hola,</p>
      <p>Un cliente necesita atención humana en tu asistente de <strong>${escapeHtml(businessName)}</strong>.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Contacto</td><td>${escapeHtml(contactId)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Mensaje</td><td style="max-width:400px">${escapeHtml(messageText)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Conversación</td><td>#${conversationId}</td></tr>
      </table>
      <p>El asistente pausó la conversación. Revisá tu panel de Daxos y respondé vos directamente si es necesario.</p>
    `,
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendUnmatchedPaymentAlert({ adminEmail, payerEmail, amount, currency, mpPaymentId }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('[resend] RESEND_API_KEY not set, skipping unmatched payment alert');
    return;
  }

  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [adminEmail],
    subject: `Pago recibido sin negocio asociado — ${payerEmail}`,
    html: `
      <p>Se recibió un pago aprobado en Mercado Pago, pero <strong>no se encontró ningún negocio registrado</strong> con el email del pagador.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Email del pagador</td><td>${escapeHtml(payerEmail)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Monto</td><td>${amount} ${currency}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">ID de pago MP</td><td>${escapeHtml(String(mpPaymentId))}</td></tr>
      </table>
      <p>El pago quedó guardado en <code>pending_payments</code>. Activá el plan manualmente desde la base de datos una vez que identifiques al usuario.</p>
    `,
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

async function sendBookingNotificationEmail({ to, businessName, clientName, reason, slots, slotCode, businessPhone, panelUrl }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping booking email'); return; }

  const slotList = slots.map((s, i) => `
    <li style="margin-bottom:6px">
      <strong>${escapeHtml(slotCode)}-${i + 1}</strong> → ${escapeHtml(s)}
    </li>`).join('');

  const waHint = businessPhone
    ? `Respondé por WhatsApp al <strong>${escapeHtml(businessPhone)}</strong> con el código correspondiente.`
    : 'Respondé por WhatsApp al número de tu negocio con el código correspondiente.';

  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: `Pedido de turno — ${businessName}`,
    html: `
      <p>Hola,</p>
      <p>Nuevo pedido de turno en <strong>${escapeHtml(businessName)}</strong>.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Cliente</td><td>${escapeHtml(clientName)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Motivo</td><td>${escapeHtml(reason)}</td></tr>
      </table>
      <p><strong>Para confirmar, elegí un horario respondiendo el código:</strong></p>
      <ul style="margin:0 0 16px 0;padding-left:20px">${slotList}
        <li style="margin-top:6px"><strong>${escapeHtml(slotCode)}-NO</strong> → rechazar todos los horarios</li>
      </ul>
      <p>${waHint}</p>
      <p>O gestioná el turno desde tu panel: <a href="${panelUrl}">${panelUrl}</a></p>
    `,
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

async function sendWeeklySummaryEmail({ to, businessName, stats, weekLabel }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping weekly email'); return; }

  const rows = [
    `<tr><td style="padding:4px 12px 4px 0;color:#666">Consultas respondidas</td><td>${stats.aiReplies}</td></tr>`,
    `<tr><td style="padding:4px 12px 4px 0;color:#666">Derivadas a vos</td><td>${stats.escalated}</td></tr>`,
  ];
  if (stats.avgSeconds !== null) {
    const avg = stats.avgSeconds < 60 ? `${stats.avgSeconds} seg` : `${Math.round(stats.avgSeconds / 60)} min`;
    rows.push(`<tr><td style="padding:4px 12px 4px 0;color:#666">Tiempo promedio de respuesta</td><td>${avg}</td></tr>`);
  }
  if (stats.autoResumed > 0) {
    rows.push(`<tr><td style="padding:4px 12px 4px 0;color:#666">Conversaciones reactivadas</td><td>${stats.autoResumed}</td></tr>`);
  }

  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: `Resumen semanal — ${businessName}`,
    html: `
      <p>Resumen de la semana del ${escapeHtml(weekLabel)} para <strong>${escapeHtml(businessName)}</strong>.</p>
      <table style="border-collapse:collapse;margin:16px 0">${rows.join('')}</table>
      <p>Tu asistente está activo.</p>
    `,
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

async function sendAdminNotificationEmail({ adminEmail, event, data }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;

  const subjects = {
    registration:           `Nuevo registro — ${data.email}`,
    wa_connected:           `WhatsApp conectado — ${data.businessName}`,
    incomplete_connection:  `Conexión incompleta — ${data.businessName}`,
    backup_error:           `⚠️ Error en backup — Daxos`,
    backup_anomalia_tamano: `⚠️ Backup anómalo (tamaño) — Daxos`,
    backup_silencio:        `⚠️ Sin backup en más de 30h — Daxos`,
    backup_sin_copias:      `⚠️ Sin backups en R2 — Daxos`,
  };
  const subject = subjects[event] || `Daxos Admin: ${event}`;

  const rows = Object.entries(data)
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#666">${escapeHtml(k)}</td><td>${escapeHtml(String(v ?? ''))}</td></tr>`)
    .join('');

  const body = {
    from: 'Daxos Admin <notificaciones@daxos.lat>',
    to: [adminEmail],
    subject,
    html: `<p>Evento: <strong>${escapeHtml(event)}</strong></p><table style="border-collapse:collapse;margin:16px 0">${rows}</table>`,
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${text}`);
  }
}

const PLAN_LINK = 'https://wa.me/59892052508?text=Quiero%20activar%20mi%20plan';

async function sendTrialWarningEmail({ to, businessName, convCount, convLimit, dayNum, dayLimit }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping trial warning email'); return; }
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: `Tu prueba de Daxos está llegando al final — ${businessName}`,
    html: `
      <p>Hola,</p>
      <p>Tu período de prueba de <strong>${escapeHtml(businessName)}</strong> está llegando al final.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Días de prueba</td><td>${dayNum} de ${dayLimit}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Conversaciones</td><td>${convCount} de ${convLimit}</td></tr>
      </table>
      <p>Cuando llegues al día ${dayLimit} o a las ${convLimit} conversaciones, la prueba termina. Tus clientes recibirán un período de gracia de 72 horas antes de que el bot deje de responder.</p>
      <p><a href="${PLAN_LINK}" style="background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">Activar mi plan</a></p>
    `,
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

async function sendTrialGraceEmail({ to, businessName, graceConvsLeft, graceHoursLeft }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping trial grace email'); return; }
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: `Tu prueba de Daxos venció — el bot sigue respondiendo por ahora — ${businessName}`,
    html: `
      <p>Hola,</p>
      <p>La prueba de <strong>${escapeHtml(businessName)}</strong> llegó a su límite, pero el bot sigue respondiendo en modo de gracia.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Tiempo restante</td><td>≈${Math.ceil(graceHoursLeft)} horas</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Conversaciones restantes</td><td>${graceConvsLeft}</td></tr>
      </table>
      <p>Cuando alguno de esos dos límites se agote, el bot dejará de responder y tus clientes verán un mensaje indicando que alguien del negocio los va a contactar.</p>
      <p><a href="${PLAN_LINK}" style="background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">Activar mi plan</a></p>
    `,
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

async function sendTrialEndedEmail({ to, businessName }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping trial ended email'); return; }
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: `El período de prueba de Daxos terminó — ${businessName}`,
    html: `
      <p>Hola,</p>
      <p>El período de prueba de <strong>${escapeHtml(businessName)}</strong> terminó. El bot dejó de responder automáticamente.</p>
      <p>Tus clientes reciben el siguiente mensaje: <em>"En este momento no puedo responder, alguien del negocio te va a contestar a la brevedad."</em></p>
      <p><a href="${PLAN_LINK}" style="background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">Activar mi plan</a></p>
    `,
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

module.exports = { sendPauseEmail, sendUnmatchedPaymentAlert, sendBookingNotificationEmail, sendWeeklySummaryEmail, sendAdminNotificationEmail, sendTrialWarningEmail, sendTrialGraceEmail, sendTrialEndedEmail };
