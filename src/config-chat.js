'use strict';

// Lógica pura del chat configurador (Fase 2). Sin red ni modelo acá: el lector
// (Fase 1) produce el borrador; este módulo decide qué falta preguntar, arma el
// "Esto es lo que entendí" y el plan de cambios, y aplica al panel.

// Etiquetas de pantalla por campo (nombre del panel).
const FIELD_LABELS = {
  name: 'Nombre del negocio',
  business_context: '¿Qué hacés o vendés?',
  website_url: 'Sitio web',
  pricing_info: 'Tus precios y servicios',
  business_hours: 'Horario de atención',
  after_hours_instructions: 'Qué hacer cuando cerrados',
  urgent_phone: 'Teléfono de urgencias',
  sales_examples: 'Mensajes tuyos reales',
  'style_profile.tono': 'Tono',
  owner_rules: 'Instrucciones libres',
  reference_docs: 'Documentos (FAQ/políticas)',
  'survey_answers.objeciones_precio': 'Qué decís cuando es caro',
  turnos: 'Turnos o visitas',
  user_phone: 'Tu número personal',
  nunca_decir: 'Qué no debe decir nunca',
  pagos_entregas: 'Pagos y entregas',
  da_precios: '¿Das precios?',
};

const SOURCE_LABELS = {
  web: 'de tu web', audio: 'de tu audio', imagen: 'de tus capturas',
  texto: 'de lo que escribiste', respuesta: 'me lo dijiste', derivado: 'lo armé con tus datos',
};

// Agrupación como el panel (6 bloques).
const BLOCKS = [
  { title: 'Tu negocio', fields: ['name', 'business_context', 'website_url', 'pricing_info'] },
  { title: 'Horarios', fields: ['business_hours', 'after_hours_instructions', 'urgent_phone'] },
  { title: 'Cómo habla', fields: ['sales_examples', 'style_profile.tono'] },
  { title: 'Reglas', fields: ['owner_rules', 'reference_docs', 'nunca_decir'] },
  { title: 'Cómo actúa', fields: ['survey_answers.objeciones_precio', 'turnos', 'pagos_entregas'] },
  { title: 'Cuándo avisarte', fields: ['user_phone'] },
];

// Preguntas en orden. cond(draftMap, ctx) === true → ya lo sabe, no se pregunta.
const QUESTIONS = [
  { id: 'que_vende', field: 'business_context', text: '¿Qué vendés o qué servicio das?', type: 'text', has: (d) => !!d.business_context },
  { id: 'horario', field: 'business_hours', text: '¿En qué horario atendés?', type: 'buttons', options: ['Lun a vie 9 a 18', 'Lun a sáb', 'Siempre', 'Otro'], has: (d) => !!d.business_hours },
  { id: 'da_precios', field: 'da_precios', text: '¿Podés dar precios?', type: 'buttons', options: ['Sí', 'Algunos', 'No'], has: (d) => !!d.pricing_info || !!d.da_precios },
  { id: 'lista_precios', field: 'pricing_info', text: 'Pasame tus precios (lista, foto o PDF).', type: 'text', has: (d) => !!d.pricing_info || d.da_precios === 'No', onlyIf: (d) => d.da_precios === 'Sí' || d.da_precios === 'Algunos' },
  { id: 'celular', field: 'user_phone', text: '¿A qué celular te aviso cuando tengas que atender vos?', type: 'text', has: (d, ctx) => !!ctx.userPhone || !!d.user_phone },
  { id: 'pagos', field: 'pagos_entregas', text: '¿Cómo te pagan y cómo entregás?', type: 'text', has: (d) => !!d.pagos_entregas || /env[íi]os?:|medios de pago:/i.test(d.owner_rules || '') },
  { id: 'turnos', field: 'turnos', text: '¿Recibís turnos o visitas?', type: 'buttons', options: ['Que agende', 'Que me avise', 'No'], has: (d, ctx) => !!d.turnos || ctx.bookingEnabled },
  { id: 'nunca', field: 'nunca_decir', text: '¿Hay algo que tu asistente nunca deba decir?', type: 'buttons', options: ['Nada en especial'], freeText: true, has: (d) => !!d.nunca_decir },
  { id: 'mensajes', field: 'sales_examples', text: 'Pasame 3 mensajes que ya le mandaste a clientes, o un audio hablando como les hablás.', type: 'text', has: (d, ctx) => !!d.sales_examples || ctx.hasSalesExamples },
];

function draftToMap(rows) {
  const m = {};
  for (const r of rows || []) m[r.field] = r.value;
  return m;
}

// Próxima pregunta pendiente (o null si no falta nada bloqueante).
function nextQuestion(rows, ctx = {}) {
  const d = draftToMap(rows);
  for (const q of QUESTIONS) {
    if (q.onlyIf && !q.onlyIf(d)) continue;
    if (q.has(d, ctx)) continue;
    return { id: q.id, field: q.field, text: q.text, type: q.type, options: q.options || null, freeText: !!q.freeText };
  }
  return null;
}

// "Esto es lo que entendí": agrupado como el panel, con origen por dato.
function summary(rows) {
  const byField = {};
  for (const r of rows || []) byField[r.field] = r;
  return BLOCKS.map((b) => ({
    title: b.title,
    items: b.fields.filter((f) => byField[f]).map((f) => ({
      field: f,
      label: FIELD_LABELS[f] || f,
      value: byField[f].value,
      source: SOURCE_LABELS[byField[f].source] || byField[f].source || '',
      needs_confirm: !!byField[f].needs_confirm,
    })),
  })).filter((b) => b.items.length > 0);
}

// Mapa borrador → columnas reales. Devuelve { businessFields, userPhone, bookingEnabled }.
function toRealValues(rows) {
  const d = draftToMap(rows);
  const biz = {};
  if (d.name != null) biz.name = d.name;
  if (d.business_context != null) biz.business_context = d.business_context;
  if (d.pricing_info != null) biz.pricing_info = d.pricing_info;
  if (d.website_url != null) biz.website_url = d.website_url;
  if (d.business_hours != null) biz.business_hours = d.business_hours;
  if (d.urgent_phone != null) biz.urgent_phone = d.urgent_phone;
  if (d.after_hours_instructions != null) biz.after_hours_instructions = d.after_hours_instructions;
  if (d.sales_examples != null) biz.sales_examples = d.sales_examples;
  // Instrucciones libres = reglas del lector + pagos/entregas + "nunca decir".
  const rules = [d.owner_rules, d.pagos_entregas ? `Pagos y entregas: ${d.pagos_entregas}` : null,
    (d.nunca_decir && d.nunca_decir !== 'Nada en especial') ? `Nunca digas: ${d.nunca_decir}` : null]
    .filter(Boolean).join('\n');
  if (rules) biz.owner_rules = rules;
  const userPhone = d.user_phone != null ? d.user_phone : undefined;
  const bookingEnabled = d.turnos ? (d.turnos === 'Que agende') : undefined;
  return { biz, userPhone, bookingEnabled };
}

// Plan de cambios vs la configuración actual (para negocios ya configurados).
function changePlan(rows, currentBiz, currentUserPhone) {
  const { biz, userPhone, bookingEnabled } = toRealValues(rows);
  const changes = [];
  const norm = (v) => (v == null ? '' : Array.isArray(v) ? v.join(' | ') : String(v));
  for (const [field, to] of Object.entries(biz)) {
    const from = currentBiz ? currentBiz[field] : null;
    if (norm(from) !== norm(to)) changes.push({ field, label: FIELD_LABELS[field] || field, from: norm(from), to: norm(to) });
  }
  if (userPhone !== undefined && norm(currentUserPhone) !== norm(userPhone)) {
    changes.push({ field: 'user_phone', label: FIELD_LABELS.user_phone, from: norm(currentUserPhone), to: norm(userPhone) });
  }
  if (bookingEnabled !== undefined && !!(currentBiz && currentBiz.booking_enabled) !== bookingEnabled) {
    changes.push({ field: 'booking_enabled', label: FIELD_LABELS.turnos, from: (currentBiz && currentBiz.booking_enabled) ? 'Sí' : 'No', to: bookingEnabled ? 'Sí' : 'No' });
  }
  return changes;
}

// Aplica solo los campos aceptados (lista de nombres). deps = { getBusinessById,
// upsertBusiness, setUserPhone, setBookingEnabled }.
function applyAccepted(businessId, rows, acceptedFields, deps) {
  const { biz, userPhone, bookingEnabled } = toRealValues(rows);
  const accept = acceptedFields ? new Set(acceptedFields) : null; // null = todos
  const ok = (f) => !accept || accept.has(f);
  const current = deps.getBusinessById(businessId) || {};
  const payload = { id: businessId };
  let touched = false;
  for (const [field, val] of Object.entries(biz)) {
    if (ok(field)) { payload[field] = val; touched = true; }
  }
  if (touched) deps.upsertBusiness({ ...current, ...payload });
  if (userPhone !== undefined && ok('user_phone')) deps.setUserPhone(deps.userId, userPhone);
  if (bookingEnabled !== undefined && ok('booking_enabled')) deps.setBookingEnabled(businessId, bookingEnabled);
  return { appliedFields: Object.keys(biz).filter(ok).concat(
    userPhone !== undefined && ok('user_phone') ? ['user_phone'] : [],
    bookingEnabled !== undefined && ok('booking_enabled') ? ['booking_enabled'] : []) };
}

module.exports = {
  FIELD_LABELS, SOURCE_LABELS, BLOCKS, QUESTIONS,
  draftToMap, nextQuestion, summary, toRealValues, changePlan, applyAccepted,
};
