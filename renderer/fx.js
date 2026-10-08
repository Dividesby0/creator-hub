'use strict';
/* Spektly ambient "signal field": flowing waves drawn on a canvas.
   Used behind the startup screen and the first-run setup. Colors follow the active theme.
   Respects prefers-reduced-motion (draws one still frame). No dependencies. */
const FX = (() => {
  const runs = new Map();
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#7b6cff';
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function start(canvas, { intensity = 1 } = {}) {
    if (!canvas || runs.has(canvas)) return;
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, dpr = 1, raf = 0, t0 = performance.now();
    const motes = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.6 + 0.4, s: Math.random() * 0.25 + 0.05, p: Math.random() * 6.28 }));
    function size() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas.clientWidth || window.innerWidth; h = canvas.clientHeight || window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function frame(now) {
      const t = (now - t0) / 1000;
      const A = css('--fx-a'), B = css('--fx-b'), C = css('--fx-c'), bg = css('--bg');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      // deep glow pools
      const g1 = ctx.createRadialGradient(w * 0.18, h * 0.82, 0, w * 0.18, h * 0.82, Math.max(w, h) * 0.6);
      g1.addColorStop(0, C + 'aa'); g1.addColorStop(1, 'transparent');
      ctx.fillStyle = g1; ctx.fillRect(0, 0, w, h);
      const g2 = ctx.createRadialGradient(w * 0.85, h * 0.12, 0, w * 0.85, h * 0.12, Math.max(w, h) * 0.45);
      g2.addColorStop(0, A + '33'); g2.addColorStop(1, 'transparent');
      ctx.fillStyle = g2; ctx.fillRect(0, 0, w, h);
      // signal ribbons
      const lines = 9;
      for (let i = 0; i < lines; i++) {
        const k = i / (lines - 1);
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, A + '00'); grad.addColorStop(0.35, A + 'cc'); grad.addColorStop(0.7, B + 'cc'); grad.addColorStop(1, B + '00');
        ctx.strokeStyle = grad; ctx.globalAlpha = (0.10 + 0.32 * Math.sin(k * Math.PI)) * intensity;
        ctx.lineWidth = 1 + 1.4 * Math.sin(k * Math.PI);
        ctx.beginPath();
        const base = h * (0.42 + 0.22 * (k - 0.5));
        for (let x = -20; x <= w + 20; x += 8) {
          const u = x / w;
          const y = base
            + Math.sin(u * 6.2 + t * 0.55 + k * 2.4) * h * 0.06
            + Math.sin(u * 13.1 - t * 0.9 + k * 5.1) * h * 0.018
            + Math.sin(u * 2.3 + t * 0.21) * h * 0.05 * (1 - k);
          x < -10 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // drifting motes
      ctx.globalAlpha = 1;
      for (const m of motes) {
        const x = ((m.x + t * m.s * 0.04) % 1) * w, y = (m.y + Math.sin(t * m.s + m.p) * 0.01) * h;
        ctx.fillStyle = B; ctx.globalAlpha = 0.25 + 0.35 * Math.sin(t * m.s * 3 + m.p) ** 2;
        ctx.beginPath(); ctx.arc(x, y, m.r, 0, 6.283); ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (!reduced()) raf = requestAnimationFrame(frame);
    }
    size();
    const onResize = () => { size(); if (reduced()) frame(performance.now()); };
    window.addEventListener('resize', onResize);
    raf = requestAnimationFrame(frame);
    runs.set(canvas, () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); });
  }
  function stop(canvas) { const s = runs.get(canvas); if (s) { s(); runs.delete(canvas); } }

  // Brand mark: the Spektly three-bar emblem (from the official logo kit).
  function mark(cls = 'mark') {
    return `<img class="${cls}" src="brand/emblem.png" alt="" aria-hidden="true" draggable="false">`;
  }
  return { start, stop, mark };
})();
