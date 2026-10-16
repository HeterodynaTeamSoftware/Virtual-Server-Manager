/*
Nazwa programu: Virtual Server Manager
Producent: Heterodyna Team Software
Wersja softu: v102
Programista: Adrian Podłucki
Tester app/network: Grześ :)
*/

async function bootstrap() {
  const me = await fetch('/api/me').then(r => r.json()).catch(() => ({ authenticated: false }));
  if (me.authenticated) window.location.href = '/app.html';
}
bootstrap();

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorBox = document.getElementById('loginError');
  errorBox.classList.add('hidden');
  const formData = new FormData(e.target);
  const payload = Object.fromEntries(formData.entries());

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    errorBox.textContent = data.requiresOtp ? 'To konto wymaga kodu 2FA. Wpisz kod z aplikacji TOTP albo recovery code.' : (data.error || 'Błąd logowania');
    errorBox.classList.remove('hidden');
    return;
  }
  window.location.href = '/app.html';
});

const oidcBtn = document.getElementById('oidcLoginBtn');
if (oidcBtn) oidcBtn.addEventListener('click', () => { window.location.href = '/api/oidc/login'; });
