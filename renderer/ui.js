'use strict';
/* Shared UI: modal dialogs with a scrim (replace window.confirm), and themes. */
const Modal = (() => {
  let stack = [];
  function open({ title = '', html = '', actions = [], wide = false, dismissable = true, id = '' } = {}) {
    return new Promise(resolve => {
      const scrim = document.createElement('div');
      scrim.className = 'modal-scrim';
      scrim.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" ${id ? `data-modal="${id}"` : ''}>
        ${dismissable ? '<button class="x" aria-label="Close" data-modal-close>&times;</button>' : ''}
        ${title ? `<h2>${title}</h2>` : ''}<div class="modal-body">${html}</div>
        ${actions.length ? `<div class="actions">${actions.map((a, i) => `<button class="btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}" data-modal-act="${i}">${a.label}</button>`).join('')}</div>` : ''}
      </div>`;
      const entry = { scrim, resolve, dismissable, id };
      const close = value => {
        if (!stack.includes(entry)) return;
        stack = stack.filter(e => e !== entry);
        scrim.classList.add('closing');
        setTimeout(() => scrim.remove(), 170);
        document.removeEventListener('keydown', onKey);
        resolve(value);
      };
      entry.close = close;
      const onKey = e => { if (e.key === 'Escape' && dismissable && stack[stack.length - 1] === entry) close(undefined); };
      scrim.addEventListener('click', e => {
        if (e.target === scrim && dismissable) return close(undefined);
        if (e.target.closest('[data-modal-close]')) return close(undefined);
        const b = e.target.closest('[data-modal-act]');
        if (b) close(actions[+b.dataset.modalAct].value ?? true);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(scrim);
      stack.push(entry);
      setTimeout(() => (scrim.querySelector('.btn.primary') || scrim.querySelector('button'))?.focus(), 30);
    });
  }
  const confirm = (message, { title = 'Are you sure?', ok = 'Continue', danger = false } = {}) =>
    open({ title, html: `<p class="muted" style="margin:0">${message}</p>`, actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: !danger, danger }] }).then(v => v === true);
  const top = () => stack[stack.length - 1];
  const closeAll = () => [...stack].forEach(e => e.close(undefined));
  const body = id => document.querySelector(`.modal[data-modal="${id}"] .modal-body`);
  const closeById = id => stack.filter(e => e.id === id).forEach(e => e.close(undefined));
  return { open, confirm, top, closeAll, closeById, body };
})();

const Theme = (() => {
  const LIST = [
    { id: 'spektly', name: 'Dusk', bg: '#0f1440', a: '#9df0ff', b: '#b9a3ff' },
    { id: 'ivory', name: 'Ivory', bg: '#f7f4ee', a: '#4f74a0', b: '#0e1b2b' },
    { id: 'midnight', name: 'Midnight', bg: '#0a0e1c', a: '#7b6cff', b: '#2fd4f0' },
    { id: 'aurora', name: 'Aurora', bg: '#061a1a', a: '#45e0b4', b: '#b99cff' },
    { id: 'ultraviolet', name: 'Ultraviolet', bg: '#12081f', a: '#ff4fc8', b: '#8f7bff' },
    { id: 'ember', name: 'Ember', bg: '#17110e', a: '#ff9f43', b: '#ff5e7e' },
    { id: 'daylight', name: 'Dawn', bg: '#eef2ff', a: '#3550ff', b: '#8b5cf6' }
  ];
  function apply(id) {
    if (!LIST.some(t => t.id === id)) id = 'spektly';
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem('ch-theme', id); } catch (_) {}
    return id;
  }
  function boot() { let id = 'spektly'; try { id = localStorage.getItem('ch-theme') || id; } catch (_) {} apply(id); }
  const picker = current => `<div class="themes">${LIST.map(t => `<button class="theme-sw ${t.id === current ? 'on' : ''}" data-theme-pick="${t.id}" aria-label="${t.name} theme">
      <div class="pv" style="background:${t.bg}"><s style="background:${t.b}"></s><b style="background:${t.a}"></b></div><div class="nm">${t.name}</div></button>`).join('')}</div>`;
  return { LIST, apply, boot, picker };
})();
Theme.boot();
