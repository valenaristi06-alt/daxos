function toast(msg, type = 'ok') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML = `<span class="toast-dot"></span><span>${msg}</span>`;
  container.appendChild(el);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('toast-show'));
  });

  const dur = type === 'err' ? 5000 : 3000;
  setTimeout(() => {
    el.classList.remove('toast-show');
    el.classList.add('toast-hide');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, dur);
}
