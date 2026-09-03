'use strict';

const {
  getPendingBookingsByBusiness,
  confirmBooking,
  rejectBooking,
  expireBooking,
  markBookingNotified,
  markBookingReminderSent,
  getBookingsNeedingTimeout,
} = require('./db');
const { sendWhatsAppMessage } = require('./whatsapp');
const { sendPauseEmail } = require('./email');

// Build the WA message sent to the owner when a booking is created.
function buildOwnerMessage(booking, businessName) {
  const slotLines = booking.slots.map((s, i) => `  ${i + 1}️⃣ ${s}`).join('\n');
  const confirmCodes = booking.slots.map((_, i) => `*${booking.slot_code}-${i + 1}*`).join('  |  ');
  return [
    `📅 *Nuevo pedido de turno — ${businessName}*`,
    ``,
    `👤 Cliente: ${booking.client_name}`,
    `📋 Motivo: ${booking.reason}`,
    `📞 Teléfono: ${booking.customer_phone}`,
    ``,
    `Horarios propuestos:`,
    slotLines,
    ``,
    `Respondé con el código para confirmar:`,
    `${confirmCodes}  |  *${booking.slot_code}-NO*`,
  ].join('\n');
}

// Send booking notification to owner via WA. Retries once on failure, then falls back to email.
// ⚠️ WA send requires business to have phone_number_id + wa_access_token (WhatsApp connected).
async function notifyOwnerOfBooking({ business, owner, booking, waCredentials }) {
  const ownerPhone = owner?.phone;
  const msg = buildOwnerMessage(booking, business.name);
  let waSent = false;

  if (ownerPhone && waCredentials?.phoneNumberId && waCredentials?.accessToken) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await sendWhatsAppMessage(ownerPhone, msg, waCredentials);
        waSent = true;
        console.log(`[booking-notify] WA ok attempt=${attempt} booking=${booking.id} code=${booking.slot_code} owner=${ownerPhone}`);
        break;
      } catch (err) {
        console.error(`[booking-notify] WA FAILED attempt=${attempt} booking=${booking.id}: ${err.message}`);
        if (attempt === 1) await new Promise(r => setTimeout(r, 4000));
      }
    }
    if (!waSent) {
      console.error(`[booking-notify] ⛔ BOTH WA ATTEMPTS FAILED booking=${booking.id} code=${booking.slot_code} customer=${booking.customer_phone} — owner may not be notified`);
    }
  } else {
    console.error(`[booking-notify] ⛔ CANNOT SEND WA: booking=${booking.id} ownerPhone=${ownerPhone || 'missing'} waCredentials=${waCredentials?.phoneNumberId ? 'ok' : 'missing'}`);
  }

  // Email fallback — always attempt when WA didn't send
  if (!waSent && owner?.email) {
    try {
      await sendPauseEmail({
        to: owner.email,
        businessName: business.name,
        contactId: booking.customer_phone,
        messageText: `Pedido de turno de ${booking.client_name} (${booking.reason}). Horarios: ${booking.slots.join(' / ')}. Código para responder: ${booking.slot_code}`,
        conversationId: booking.conversation_id,
      });
      console.log(`[booking-notify] email fallback sent to ${owner.email} booking=${booking.id}`);
    } catch (emailErr) {
      console.error(`[booking-notify] ⛔ EMAIL FALLBACK ALSO FAILED booking=${booking.id}: ${emailErr.message}`);
    }
  }

  markBookingNotified(booking.id);
}

// Parse owner reply. Expected format: "AB-2" (confirm slot 2) or "AB-NO" (reject).
// Returns { action: 'confirm'|'reject'|'out_of_range'|'unknown' }
// Never infers an action from ambiguous input — caller must re-ask on anything other than
// 'confirm' or 'reject'.
function parseOwnerReply(text, booking) {
  const clean = text.trim().toUpperCase().replace(/\s+/g, '');
  const match = clean.match(/^([A-Z]{2})-([0-9]+|NO)$/);
  if (!match) return { action: 'unknown' };

  const [, code, value] = match;
  if (code !== booking.slot_code.toUpperCase()) return { action: 'unknown' };
  if (value === 'NO') return { action: 'reject' };

  const idx = parseInt(value, 10) - 1;
  if (idx < 0 || idx >= booking.slots.length) {
    return { action: 'out_of_range', maxSlots: booking.slots.length };
  }
  return { action: 'confirm', slotIndex: idx, slot: booking.slots[idx] };
}

// Called from the webhook when an incoming message is from the owner's phone.
// Returns true if the message was consumed as a booking reply (caller should `continue`).
// Returns false if it doesn't look like a booking reply — caller falls through to normal flow.
async function handleOwnerBookingReply({ business, ownerPhone, text, waCredentials }) {
  const clean = text.trim().toUpperCase().replace(/\s+/g, '');
  const codeMatch = clean.match(/^([A-Z]{2})-/);
  if (!codeMatch) return false; // Not booking reply format — let normal flow handle it

  const code = codeMatch[1];
  const pending = getPendingBookingsByBusiness(business.id);
  const booking = pending.find(b => b.slot_code === code);

  if (!booking) {
    console.log(`[booking-owner-reply] business=${business.id} code=${code} — no pending booking`);
    await sendWhatsAppMessage(
      ownerPhone,
      `No encontré ningún turno pendiente con el código *${code}*. Revisá el código e intentá de nuevo.`,
      waCredentials
    ).catch(err => console.error('[booking-owner-reply] send error:', err.message));
    return true;
  }

  const parsed = parseOwnerReply(text, booking);
  console.log(`[booking-owner-reply] business=${business.id} booking=${booking.id} code=${code} action=${parsed.action} raw="${text}"`);

  if (parsed.action === 'unknown') {
    const hint = booking.slots.map((s, i) => `*${booking.slot_code}-${i + 1}*: ${s}`).join('\n');
    await sendWhatsAppMessage(
      ownerPhone,
      `No entendí tu respuesta para el turno *${booking.slot_code}*.\n\nPara confirmar:\n${hint}\n\nPara rechazar: *${booking.slot_code}-NO*`,
      waCredentials
    ).catch(err => console.error('[booking-owner-reply] re-ask failed:', err.message));
    return true;
  }

  if (parsed.action === 'out_of_range') {
    await sendWhatsAppMessage(
      ownerPhone,
      `El turno *${booking.slot_code}* tiene ${booking.slots.length} opciones. Respondé con *${booking.slot_code}-1* a *${booking.slot_code}-${booking.slots.length}*, o *${booking.slot_code}-NO* para rechazar.`,
      waCredentials
    ).catch(err => console.error('[booking-owner-reply] out-of-range send failed:', err.message));
    return true;
  }

  if (parsed.action === 'confirm') {
    confirmBooking(booking.id, parsed.slot);
    await sendWhatsAppMessage(
      booking.customer_phone,
      `✅ Turno confirmado, ${booking.client_name}.\n\n📅 ${parsed.slot}\n📋 ${booking.reason}\n\nNos vemos entonces.`,
      waCredentials
    ).catch(err => console.error(`[booking-confirm] send-to-client ${booking.customer_phone} failed: ${err.message}`));
    await sendWhatsAppMessage(
      ownerPhone,
      `✅ Confirmado. Se le avisó a ${booking.client_name} para *${parsed.slot}*.`,
      waCredentials
    ).catch(err => console.error(`[booking-confirm] confirm-to-owner failed: ${err.message}`));
    console.log(`[booking-confirm] booking=${booking.id} slot="${parsed.slot}" client=${booking.customer_phone}`);
    return true;
  }

  if (parsed.action === 'reject') {
    rejectBooking(booking.id);
    await sendWhatsAppMessage(
      booking.customer_phone,
      `Hola ${booking.client_name}, lamentablemente el dueño no puede atenderte en ninguno de los horarios propuestos. Escribile directamente para coordinar otro momento.`,
      waCredentials
    ).catch(err => console.error(`[booking-reject] send-to-client ${booking.customer_phone} failed: ${err.message}`));
    await sendWhatsAppMessage(
      ownerPhone,
      `❌ Turno ${booking.slot_code} rechazado. Se le notificó a ${booking.client_name}.`,
      waCredentials
    ).catch(err => console.error(`[booking-reject] confirm-to-owner failed: ${err.message}`));
    console.log(`[booking-reject] booking=${booking.id} client=${booking.customer_phone}`);
    return true;
  }

  return false;
}

// Periodic job — call via setInterval every 30 minutes.
// getCredentialsForBusiness: async (businessId) => { business, owner, waCredentials }
// ⚠️ WA sends inside this function require credentials — logs error and skips if missing.
async function checkBookingTimeouts({ getCredentialsForBusiness }) {
  let timedOut;
  try {
    timedOut = getBookingsNeedingTimeout();
  } catch (err) {
    console.error('[booking-timeout] DB query failed:', err.message);
    return;
  }
  if (!timedOut.length) return;

  for (const booking of timedOut) {
    try {
      const { business, owner, waCredentials } = await getCredentialsForBusiness(booking.business_id);
      if (!business) {
        console.error(`[booking-timeout] booking=${booking.id} business=${booking.business_id} not found — skipping`);
        continue;
      }

      if (booking.reminder_sent_at) {
        // Reminder already sent and still no reply — expire
        expireBooking(booking.id);
        if (waCredentials?.phoneNumberId) {
          await sendWhatsAppMessage(
            booking.customer_phone,
            `Hola ${booking.client_name}, no pudimos confirmar tu turno a tiempo. Si querés intentarlo de nuevo, escribinos cuando quieras.`,
            waCredentials
          ).catch(err => console.error(`[booking-timeout] expire-client-notify failed booking=${booking.id}: ${err.message}`));
        }
        console.log(`[booking-timeout] expired booking=${booking.id} customer=${booking.customer_phone}`);
      } else {
        // First timeout — send reminder to owner
        if (owner?.phone && waCredentials?.phoneNumberId) {
          const hint = booking.slots.map((s, i) => `  ${i + 1}️⃣ ${s}`).join('\n');
          await sendWhatsAppMessage(
            owner.phone,
            `⏰ *Recordatorio de turno pendiente (${booking.slot_code})*\n\nCliente: ${booking.client_name}\nMotivo: ${booking.reason}\n\n${hint}\n\nRespuesta pendiente: *${booking.slot_code}-1*, *${booking.slot_code}-2*, *${booking.slot_code}-3* o *${booking.slot_code}-NO*`,
            waCredentials
          ).catch(err => console.error(`[booking-timeout] reminder-to-owner failed booking=${booking.id}: ${err.message}`));
        } else {
          console.error(`[booking-timeout] ⛔ CANNOT SEND REMINDER: booking=${booking.id} ownerPhone=${owner?.phone || 'missing'} waCredentials=${waCredentials?.phoneNumberId ? 'ok' : 'missing'}`);
        }
        markBookingReminderSent(booking.id);
        console.log(`[booking-timeout] reminder sent booking=${booking.id} owner=${owner?.phone}`);
      }
    } catch (err) {
      console.error(`[booking-timeout] error processing booking=${booking.id}: ${err.message}`);
    }
  }
}

module.exports = {
  notifyOwnerOfBooking,
  handleOwnerBookingReply,
  checkBookingTimeouts,
  parseOwnerReply, // exported for unit testing
};
