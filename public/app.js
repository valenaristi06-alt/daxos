fetch('/health')
  .then((res) => res.json())
  .then((data) => {
    document.getElementById('health').textContent = data.status;
  })
  .catch(() => {
    document.getElementById('health').textContent = 'error';
  });
