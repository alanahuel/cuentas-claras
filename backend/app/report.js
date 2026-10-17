document.getElementById('print-report')?.addEventListener('click', () => window.print());
const countdown = document.getElementById('countdown');
if (countdown) {
  let expires = Number(countdown.dataset.expires) * 1000;
  let offset = 0;
  let closed = false;
  const close = (message) => {
    closed = true;
    document.body.replaceChildren();
    const main = document.createElement('main');
    const title = document.createElement('h1');
    title.textContent = 'Informe no disponible';
    const text = document.createElement('p');
    text.textContent = message;
    main.append(title, text);
    document.body.append(main);
  };
  const tick = () => {
    if (closed) return;
    const seconds = Math.ceil((expires - Date.now() - offset) / 1000);
    if (seconds <= 0) return close('El acceso ha caducado. Solicita un enlace nuevo al titular.');
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor(seconds % 86400 / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    countdown.textContent = `Quedan ${days ? `${days} d · ` : ''}${hours} h ${minutes} min ${seconds % 60} s`;
  };
  const verify = async () => {
    if (closed) return;
    try {
      const response = await fetch(`${location.pathname}/status`, {cache: 'no-store'});
      if (!response.ok) return close('El acceso ha finalizado. Solicita un enlace nuevo al titular.');
      const status = await response.json();
      expires = status.expires * 1000;
      offset = status.now * 1000 - Date.now();
      tick();
    } catch {
      close('No se puede comprobar la vigencia del enlace. Recupera la conexión y recarga la página.');
    }
  };
  verify();
  setInterval(tick, 1000);
  setInterval(verify, 30000);
  window.addEventListener('pageshow', event => { if (event.persisted) verify(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verify(); });
}
