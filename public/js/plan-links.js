// Payment subscription links — change here to update landing and dashboard at once
const PLAN_PAYMENT_LINKS = {
  arranque:    'https://mpago.la/21dFEqv',
  crecimiento: 'https://mpago.la/1p6rYFk',
  a_medida:    'https://mpago.la/1D3SSYi',
};

document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-plan-link]').forEach(function (el) {
    const plan = el.getAttribute('data-plan-link');
    if (PLAN_PAYMENT_LINKS[plan]) el.href = PLAN_PAYMENT_LINKS[plan];
  });
});
