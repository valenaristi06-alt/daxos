async function sendPauseEmail({ to, businessName, contactId, messageText, conversationId, convUrl, subject: subjectOverride }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('[resend] RESEND_API_KEY not set, skipping email');
    return;
  }

  const linkHtml = convUrl
    ? `<p><a href="${convUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">Abrir la conversación</a></p>`
    : '';
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: subjectOverride || `Nueva conversación pausada — ${businessName}`,
    html: `
      <p>Hola,</p>
      <p>Un cliente necesita atención humana en tu asistente de <strong>${escapeHtml(businessName)}</strong>.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Teléfono</td><td>${escapeHtml(contactId)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Mensaje</td><td style="max-width:400px">${escapeHtml(messageText)}</td></tr>
      </table>
      <p>El asistente pausó la conversación. Respondé vos directamente.</p>
      ${linkHtml}
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

async function sendBookingNotificationEmail({ to, businessName, clientName, reason, slots, slotCode, businessPhone, panelUrl, subjectPrefix = '' }) {
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
    subject: subjectPrefix + `Pedido de turno — ${businessName}`,
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

async function sendSaleIntentEmail({ to, businessName, clientName, clientPhone, lastMessages, convUrl, subjectPrefix = '' }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping sale intent email'); return; }

  const msgRows = (lastMessages || []).map(m => {
    const role = m.role === 'user' ? 'Cliente' : 'Asistente';
    const color = m.role === 'user' ? '#374151' : '#6b7280';
    return `<tr><td style="padding:4px 12px 4px 0;color:${color};font-weight:bold;white-space:nowrap;vertical-align:top">${escapeHtml(role)}</td><td style="color:${color}">${escapeHtml(String(m.content || ''))}</td></tr>`;
  }).join('');

  const linkHtml = convUrl
    ? `<p><a href="${convUrl}" style="background:#16a34a;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">Abrir la conversación</a></p>`
    : '';

  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: subjectPrefix + `🛒 ${businessName}: un cliente quiere comprar`,
    html: `
      <p>Hola,</p>
      <p>Un cliente mostró intención de compra en <strong>${escapeHtml(businessName)}</strong>.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Nombre</td><td>${escapeHtml(clientName || 'desconocido')}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Teléfono</td><td>${escapeHtml(clientPhone || 'desconocido')}</td></tr>
      </table>
      ${msgRows ? `<p><strong>Últimos mensajes:</strong></p><table style="border-collapse:collapse;margin:16px 0">${msgRows}</table>` : ''}
      ${linkHtml}
    `,
  };

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${t}`);
  }
}

async function sendAdminNotificationEmail({ adminEmail, event, data }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('[resend] RESEND_API_KEY not set, skipping admin notification email');
    return;
  }

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

async function sendBillingDataEmail({ adminEmail, businessName, businessId }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping billing notification email'); return; }
  const body = {
    from: 'Daxos Admin <notificaciones@daxos.lat>',
    to: [adminEmail],
    subject: `Nuevos datos de facturación — ${businessName}`,
    html: `<p>El negocio <strong>${escapeHtml(businessName)}</strong> (id: ${Number(businessId)}) completó sus datos de facturación.</p>`,
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

async function sendPauseFollowupEmail({ to, businessName, conversationId, customerPhone, convUrl }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping pause followup email'); return; }
  const linkHtml = convUrl
    ? `<p><a href="${convUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">Abrir la conversación</a></p>`
    : '';
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: `Recordatorio — conversación sin respuesta en ${escapeHtml(businessName)}`,
    html: `<p>Hola,</p><p>Hace más de 30 minutos que la conversación con <strong>${escapeHtml(customerPhone || String(conversationId))}</strong> en <strong>${escapeHtml(businessName)}</strong> sigue sin respuesta.</p>${linkHtml}`,
  };
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

async function sendPause24hReminderEmail({ to, businessName, conversationId, customerPhone, convUrl }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping 24h pause reminder'); return; }
  const linkHtml = convUrl
    ? `<p><a href="${convUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">Abrir la conversación</a></p>`
    : '';
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: `24 horas sin atender — ${escapeHtml(businessName)}`,
    html: `<p>Hola,</p><p>La conversación con <strong>${escapeHtml(customerPhone || String(conversationId))}</strong> en <strong>${escapeHtml(businessName)}</strong> lleva 24 horas pausada sin atención.</p>${linkHtml}`,
  };
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

async function sendWaSilenceAlertEmail({ adminEmail, businessName, phoneNumber, lastMessageAt, silenceHours }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping WA silence alert'); return; }
  const lastMsgStr = lastMessageAt
    ? `<strong>${escapeHtml(lastMessageAt)}</strong>`
    : '<em>sin mensajes registrados</em>';
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [adminEmail],
    subject: `Sin mensajes entrantes — ${escapeHtml(businessName)}`,
    html: `
      <p>Hola,</p>
      <p>El negocio <strong>${escapeHtml(businessName)}</strong> (número: <strong>${escapeHtml(String(phoneNumber || ''))}</strong>) no recibió mensajes entrantes de clientes en las últimas <strong>${silenceHours} horas</strong>.</p>
      <p>Último mensaje entrante: ${lastMsgStr}</p>
      <p><strong>Qué revisar:</strong></p>
      <ul>
        <li>Kapso &gt; Números de teléfono (cartel "Necesita volver a conectarse")</li>
        <li>Meta Business &gt; Cuentas de WhatsApp (estado de la cuenta)</li>
      </ul>
    `,
  };
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

async function sendWaSilenceRecoveryEmail({ adminEmail, businessName, phoneNumber, lastMessageAt }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping WA silence recovery'); return; }
  const lastMsgStr = lastMessageAt ? `<strong>${escapeHtml(lastMessageAt)}</strong>` : '<em>desconocido</em>';
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [adminEmail],
    subject: `Mensajes recuperados — ${escapeHtml(businessName)}`,
    html: `
      <p>Hola,</p>
      <p>El negocio <strong>${escapeHtml(businessName)}</strong> (número: <strong>${escapeHtml(String(phoneNumber || ''))}</strong>) volvió a recibir mensajes entrantes.</p>
      <p>Último mensaje entrante: ${lastMsgStr}</p>
    `,
  };
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

async function sendWaHealthAlertEmail({ adminEmail, ownerEmail, businessName, phoneNumber, status, components }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping WA health alert'); return; }
  const to = [...new Set([adminEmail, ownerEmail].filter(Boolean))];
  const componentRows = Object.entries(components || {})
    .map(([k, v]) => `<li><strong>${escapeHtml(k)}</strong>: ${escapeHtml(String(v?.status ?? v ?? ''))}</li>`)
    .join('');
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to,
    subject: `WhatsApp unhealthy — ${escapeHtml(businessName)}`,
    html: `
      <p>Hola,</p>
      <p>El negocio <strong>${escapeHtml(businessName)}</strong> (número: <strong>${escapeHtml(String(phoneNumber || ''))}</strong>) reporta estado <strong>${escapeHtml(String(status))}</strong> en Kapso.</p>
      ${componentRows ? `<p><strong>Componentes:</strong></p><ul>${componentRows}</ul>` : ''}
      <p><strong>Qué revisar:</strong></p>
      <ul>
        <li>Kapso &gt; Números de teléfono (cartel "Necesita volver a conectarse")</li>
        <li>Meta Business &gt; Cuentas de WhatsApp (estado de la cuenta)</li>
      </ul>
    `,
  };
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

async function sendWaHealthRecoveryEmail({ adminEmail, ownerEmail, businessName, phoneNumber }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping WA health recovery'); return; }
  const to = [...new Set([adminEmail, ownerEmail].filter(Boolean))];
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to,
    subject: `WhatsApp recuperado — ${escapeHtml(businessName)}`,
    html: `
      <p>Hola,</p>
      <p>El negocio <strong>${escapeHtml(businessName)}</strong> (número: <strong>${escapeHtml(String(phoneNumber || ''))}</strong>) volvió a reportar estado healthy en Kapso.</p>
    `,
  };
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

async function sendPasswordResetEmail({ to, resetUrl }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping password reset email'); return; }
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: 'Restablecer contraseña — Daxos',
    html: `
      <p>Hola,</p>
      <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en Daxos.</p>
      <p>Si no fuiste vos, ignorá este email — tu contraseña no va a cambiar.</p>
      <p>
        <a href="${escapeHtml(resetUrl)}" style="background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">
          Restablecer contraseña
        </a>
      </p>
      <p style="color:#666;font-size:12px">El enlace vence en 1 hora.</p>
    `,
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

async function sendUrgentAlertEmail({ to, businessName, contactId, messageText, conversationId, convUrl, now, subjectPrefix = '' }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('[resend] RESEND_API_KEY not set, skipping urgent alert email');
    return;
  }
  const preview = messageText ? messageText.slice(0, 200) + (messageText.length > 200 ? '…' : '') : '';
  const timeStr = now ? now.toLocaleString('es-UY', { timeZone: 'America/Montevideo', hour12: false }) : '';
  const linkHtml = convUrl
    ? `<p><a href="${convUrl}" style="background:#dc2626;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">Abrir la conversación</a></p>`
    : '';
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: subjectPrefix + `🚨 URGENTE – ${businessName}`,
    html: `
      <p>Hola,</p>
      <p>Un cliente indicó algo urgente en <strong>${escapeHtml(businessName)}</strong>.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Teléfono</td><td>${escapeHtml(contactId)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666">Mensaje</td><td style="max-width:400px">${escapeHtml(preview)}</td></tr>
        ${timeStr ? `<tr><td style="padding:4px 12px 4px 0;color:#666">Hora</td><td>${escapeHtml(timeStr)}</td></tr>` : ''}
      </table>
      ${linkHtml}
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

async function sendSpendingCapEmail({ to, businessName, panelUrl, plan, dailyCap }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('[resend] RESEND_API_KEY not set, skipping email');
    return;
  }

  const linkHtml = panelUrl
    ? `<p><a href="${panelUrl}" style="background:#dc2626;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">Ver conversaciones</a></p>`
    : '';
  const upsellHtml = plan === 'arranque' && dailyCap
    ? `<p style="color:#555;font-size:13px;margin-top:16px">Tu plan incluye ${dailyCap} respuestas por día. Con el plan Crecimiento tenés 150.${panelUrl ? ` <a href="${panelUrl.replace('/conversations.html', '/dashboard.html')}">Ver planes</a>.` : ''}</p>`
    : '';
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: `⚠️ Límite diario alcanzado — ${businessName}`,
    html: `
      <p>Hola,</p>
      <p>Tu asistente <strong>${escapeHtml(businessName)}</strong> alcanzó el límite de respuestas automáticas de hoy.</p>
      <p>Por hoy, los clientes no van a recibir respuestas del bot. Contestá vos directamente desde el panel o por WhatsApp.</p>
      ${linkHtml}
      ${upsellHtml}
      <p style="color:#666;font-size:12px">Este aviso se envía una vez por día.</p>
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

async function sendOwnerBotStoppedEmail({ to, businessName, clientName, convUrl, kind, subjectPrefix = '' }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;

  const subjects = {
    hourly_cap: `⏸️ ${businessName}: asistente pausó un momento`,
    api_error:  `⚠️ ${businessName}: el asistente tuvo un problema técnico`,
    wa_error:   `⚠️ ${businessName}: falla al enviar mensaje por WhatsApp`,
  };
  const bodies = {
    hourly_cap: `
      <p>Hola,</p>
      <p>Tu asistente de <strong>${escapeHtml(businessName)}</strong> pausó temporalmente las respuestas al cliente <strong>${escapeHtml(clientName)}</strong> porque recibió muchas consultas en poco tiempo.</p>
      <p>Se reactiva automáticamente en unos minutos. Si querés atenderlo antes, podés contestarle desde el panel.</p>`,
    api_error: `
      <p>Hola,</p>
      <p>Tu asistente de <strong>${escapeHtml(businessName)}</strong> no pudo responder al cliente <strong>${escapeHtml(clientName)}</strong> por un problema técnico.</p>
      <p>Te recomendamos contestarle directamente desde el panel. Ya notificamos al equipo de Daxos.</p>`,
    wa_error: `
      <p>Hola,</p>
      <p>Tu asistente de <strong>${escapeHtml(businessName)}</strong> no pudo enviar un mensaje al cliente <strong>${escapeHtml(clientName)}</strong> por WhatsApp.</p>
      <p>Revisá la conexión de tu número en la configuración de Daxos.</p>`,
  };

  const subject  = subjectPrefix + (subjects[kind] || '');
  const bodyHtml = bodies[kind];
  if (!subjects[kind] || !bodyHtml) return;

  const linkHtml = convUrl
    ? `<p><a href="${convUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">Abrir la conversación</a></p>`
    : '';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Daxos <notificaciones@daxos.lat>', to: [to], subject, html: bodyHtml + linkHtml }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.warn('[resend] bot-stopped email failed:', res.status, t);
  }
}

function sendClaudeErrorAdminEmail({ errorType, businessId, businessName, errorMessage, subjectPrefix = '' }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn('[resend] RESEND_API_KEY not set, skipping claude error admin email');
    return Promise.resolve();
  }
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) return Promise.resolve();

  const subjects = {
    no_credits: '⚠️ Daxos: Claude sin créditos',
    server_error: '⚠️ Daxos: Claude error de servidor',
  };
  const subject = subjectPrefix + (subjects[errorType] || '⚠️ Daxos: Claude error');

  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Daxos Admin <no-reply@daxos.lat>',
      to: adminEmail,
      subject,
      text: `Error de Claude (${errorType}) para negocio ${businessName} (ID: ${businessId}).\n\nDetalle: ${errorMessage}\n\nRevisá los créditos en Anthropic.`,
    }),
  }).then(res => {
    if (!res.ok) {
      return res.text().catch(() => '').then(t => {
        console.warn('[resend] claude error admin email failed:', res.status, t);
      });
    }
  }).catch(err => {
    console.warn('[resend] claude error admin email failed:', err.message);
  });
}

async function sendAgendaNewAppointmentEmail({ to, businessName, clientName, serviceName, summary, panelUrl }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('[resend] RESEND_API_KEY not set, skipping agenda new-apt email'); return; }
  const body = {
    from: 'Daxos <notificaciones@daxos.lat>',
    to: [to],
    subject: `📅 Nuevo turno confirmado — ${businessName}`,
    html: `
      <p>Hola,</p>
      <p>Se confirmó un nuevo turno en <strong>${escapeHtml(businessName)}</strong>.</p>
      <table style="border-collapse:collapse;margin:16px 0">
        <tr><td style="padding:4px 12px 4px 0;color:#666">Cliente</td><td>${escapeHtml(clientName || '—')}</td></tr>
        ${serviceName ? `<tr><td style="padding:4px 12px 4px 0;color:#666">Servicio</td><td>${escapeHtml(serviceName)}</td></tr>` : ''}
        <tr><td style="padding:4px 12px 4px 0;color:#666">Horario</td><td>${escapeHtml(summary)}</td></tr>
      </table>
      <p><a href="${escapeHtml(panelUrl)}" style="background:#C45C1A;color:#fff;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;margin-top:8px">Ver en la agenda</a></p>
      <p style="color:#666;font-size:12px">No se pudo enviar el aviso por WhatsApp — revisá la conexión de tu cuenta.</p>
    `,
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Resend ${res.status}: ${t}`); }
}

module.exports = { sendPauseEmail, sendUrgentAlertEmail, sendUnmatchedPaymentAlert, sendBookingNotificationEmail, sendWeeklySummaryEmail, sendAdminNotificationEmail, sendTrialWarningEmail, sendTrialGraceEmail, sendTrialEndedEmail, sendBillingDataEmail, sendPauseFollowupEmail, sendPause24hReminderEmail, sendWaSilenceAlertEmail, sendWaSilenceRecoveryEmail, sendWaHealthAlertEmail, sendWaHealthRecoveryEmail, sendPasswordResetEmail, sendSpendingCapEmail, sendOwnerBotStoppedEmail, sendClaudeErrorAdminEmail, sendSaleIntentEmail, sendAgendaNewAppointmentEmail };
