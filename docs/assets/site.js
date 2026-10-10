(() => {
  'use strict';
  // The header clock shows the hour of the section you're reading.
  const clock = document.getElementById('clock');
  const hours = [...document.querySelectorAll('[data-hour]')];
  if (clock && hours.length && 'IntersectionObserver' in window) {
    clock.textContent = hours[0].dataset.hour;
    const io = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) clock.textContent = e.target.dataset.hour; }, { rootMargin: '-45% 0px -50% 0px' });
    hours.forEach(h => io.observe(h));
  }
  // 18:00: the six posts go out once, when the section comes into view.
  const fire = document.getElementById('fire');
  if (fire && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { fire.classList.add('go'); io.disconnect(); } }, { threshold: 0.35 });
    io.observe(fire);
  } else if (fire) fire.classList.add('go');

  // Point the main download button at the installer for this computer.
  const ua = navigator.userAgent || '';
  const os = /Windows/i.test(ua) ? 'win' : /Mac OS X|Macintosh/i.test(ua) ? 'mac-arm' : null;
  const target = os && document.querySelector(`[data-os="${os}"]`);
  const primary = document.querySelector('[data-dl-primary]');
  if (target && primary) { primary.href = target.href; primary.textContent = os === 'win' ? 'Download for Windows' : 'Download for Mac'; }
  if (target) {
    document.querySelectorAll('[data-os]').forEach(a => { a.classList.toggle('now', a === target); a.classList.toggle('paper', a !== target); });
  }

  // Account forms: show the result and carry the order reference from checkout.
  const q = new URLSearchParams(location.search);
  const flash = document.getElementById('flash');
  if (flash) {
    const msg = q.get('joined') ? ['ok', 'Your account is set up. Thanks for being here.']
      : q.get('error') === 'email' ? ['bad', 'That email address does not look right. Try again.']
      : q.get('error') ? ['bad', 'Too many tries from this network. Wait a few minutes and try again.'] : null;
    if (msg) { flash.className = 'flash ' + msg[0]; flash.textContent = msg[1]; }
  }
  const ref = q.get('order_id') || q.get('checkout_id') || q.get('customer_id') || '';
  document.querySelectorAll('#ref').forEach(i => { i.value = ref.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80); });
})();
