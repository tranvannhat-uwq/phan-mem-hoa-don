// Keep the login doorway usable while the application module graph or Auth
// session is still loading. This script has no external dependencies.
(function () {
  const form = document.getElementById('login-form');
  const screen = document.getElementById('login-screen');
  const submit = document.getElementById('btn-login-submit');
  const status = document.getElementById('login-startup-status');
  const retry = document.getElementById('btn-retry-login-startup');
  if (!form || !screen) return;
  if (window.location.hash.toLowerCase().startsWith('#/ban-hang')) {
    screen.style.display = 'flex';
    if (submit) submit.disabled = true;
    if (status) status.textContent = 'Đang chuẩn bị kết nối đăng nhập...';
  }
  form.addEventListener('submit', function (event) {
    if (form.dataset.loginState === 'ready') return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  retry?.addEventListener('click', () => window.location.reload());
  document.getElementById('btn-close-login')?.addEventListener('click', () => {
    window.location.replace(`${window.location.pathname}${window.location.search}`);
  });
  setTimeout(() => {
    if (form.dataset.loginState === 'ready' || screen.style.display === 'none') return;
    if (status) status.textContent = 'Kết nối đang chậm. Bạn có thể tải lại để thử đăng nhập.';
    if (retry) retry.hidden = false;
  }, 15000);
}());
