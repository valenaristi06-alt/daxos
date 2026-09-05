const { getBusinessesWithWeeklySummary, getWeeklyStats, getUserByBusinessId } = require('./db');
const { sendWhatsAppMessage } = require('./whatsapp');

function formatAvgResponse(seconds) {
  if (seconds === null) return null;
  if (seconds < 60) return `${seconds} segundos`;
  return `${Math.round(seconds / 60)} minutos`;
}

function buildSummaryText(stats, weekLabel) {
  const lines = [
    `Resumen semanal de tu asistente`,
    ``,
    `Semana del ${weekLabel}:`,
    `- Consultas respondidas: ${stats.aiReplies}`,
    `- Derivadas a vos: ${stats.escalated}`,
  ];
  const avg = formatAvgResponse(stats.avgSeconds);
  if (avg) lines.push(`- Tiempo promedio de respuesta: ${avg}`);
  lines.push(``, `Tu asistente está activo.`);
  return lines.join('\n');
}

function getWeekLabel() {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  const fmt = (d) => d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
  return `${fmt(start)} al ${fmt(end)}`;
}

async function sendWeeklySummaries() {
  const businesses = getBusinessesWithWeeklySummary();
  let sent = 0;
  let skipped = 0;

  for (const business of businesses) {
    try {
      const stats = getWeeklyStats(business.id);
      if (stats.aiReplies === 0) { skipped++; continue; }

      const owner = getUserByBusinessId(business.id);
      if (!owner?.phone) { skipped++; continue; }

      const waCredentials = { phoneNumberId: business.phone_number_id, accessToken: business.wa_access_token };
      const text = buildSummaryText(stats, getWeekLabel());
      await sendWhatsAppMessage(owner.phone, text, waCredentials);
      sent++;
    } catch (err) {
      console.error(`[weekly-summary] business ${business.id} error:`, err.message);
    }
  }

  console.log(`[weekly-summary] sent=${sent} skipped=${skipped}`);
}

module.exports = { sendWeeklySummaries };
