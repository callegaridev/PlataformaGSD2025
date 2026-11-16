const loginForm = document.getElementById('login-form');
const resetForm = document.getElementById('password-reset-form');
const message = document.getElementById('login-message');
const resetToken = new URLSearchParams(window.location.hash.slice(1)).get('reset');

if (resetToken) {
  loginForm.hidden = true;
  resetForm.hidden = false;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.getElementById('email').value.trim(),
        password: document.getElementById('password').value
      })
    });
    const data = await response.json();
    if (!response.ok) {
      message.textContent = data.error || 'Não foi possível entrar.';
      return;
    }

    localStorage.setItem('setor', data.user.sector);
    localStorage.setItem('userId', data.user.id);
    localStorage.setItem('userEmail', data.user.email);
    localStorage.setItem('nome', data.user.name);
    localStorage.setItem('role', data.user.role);

    if (['presidente', 'vice-presidente'].includes(data.user.role)) {
      window.location.href = '/presidente/index_presidente.html';
    } else if (data.user.role === 'coordenador') {
      window.location.href = '/coordenador/index_coordenador.html';
    } else if (data.user.role === 'membro') {
      window.location.href = '/membro/index_membro.html';
    } else {
      message.textContent = 'Perfil de usuário desconhecido.';
    }
  } catch {
    message.textContent = 'Erro ao conectar ao servidor.';
  }
});

resetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  try {
    const response = await fetch('/api/password/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: resetToken,
        password: document.getElementById('new-password').value
      })
    });
    const data = await response.json();
    if (!response.ok) {
      message.textContent = data.error || 'Não foi possível redefinir a senha.';
      return;
    }
    resetForm.hidden = true;
    loginForm.hidden = false;
    message.textContent = 'Senha redefinida. Entre com sua nova senha.';
  } catch {
    message.textContent = 'Erro ao conectar ao servidor.';
  }
});