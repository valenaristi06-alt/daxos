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

module.exports = { sendPauseEmail, sendUnmatchedPaymentAlert };
