'use strict';
const $ = s => document.querySelector(s);
if (typeof FX !== 'undefined') { $('#licMark').innerHTML = FX.mark('mark'); $('#licMark svg').style.width = '34px'; $('#licMark svg').style.height = '34px'; FX.start($('#bgfx'), { intensity: 0.6 }); }
const clean = m => String(m?.message || m).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const showErr = m => { $('#err').innerHTML = ''; if (m) { const d = document.createElement('div'); d.className = 'note'; d.textContent = m; $('#err').appendChild(d); window.scrollTo(0, 0); } };
const needEula = () => { if (!$('#accept').checked) { showErr('Please read and accept the License Agreement first.'); return false; } return true; };

(async () => {
  const st = await hub.license.status();
  $('#device').textContent = st.device;
  if (st.error) showErr(st.error);
  if (!st.server) { $('#online').disabled = true; $('#onlineNote').textContent = 'Online activation is not configured for this build. Use offline activation below.'; }
  $('#eula').textContent = await hub.license.eula();
})();

let timer;
$('#key').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const k = $('#key').value.trim();
    if (!k) return ($('#keyInfo').textContent = '');
    try {
      const l = await hub.license.check(k);
      $('#keyInfo').innerHTML = '';
      $('#keyInfo').append(`✓ Valid ${l.tierName} license #${l.serial} · ${l.maxDevices} device${l.maxDevices > 1 ? 's' : ''} · updates ${l.updatesUntil ? 'until ' + l.updatesUntil : 'for life'}`);
      $('#keyInfo').style.color = 'var(--ok)';
    } catch (e) { $('#keyInfo').textContent = clean(e); $('#keyInfo').style.color = 'var(--bad)'; }
  }, 250);
});

$('#online').addEventListener('click', async () => {
  showErr(''); if (!needEula()) return;
  $('#online').disabled = true; $('#online').textContent = 'Activating…';
  try { await hub.license.activateOnline($('#key').value.trim(), true); $('#online').textContent = 'Activated ✓'; }
  catch (e) { showErr(clean(e)); $('#online').disabled = false; $('#online').textContent = 'Activate online'; }
});

$('#genReq').addEventListener('click', async () => {
  showErr('');
  try { $('#req').textContent = await hub.license.requestCode($('#key').value.trim()); $('#req').hidden = false; $('#copyReq').hidden = false; }
  catch (e) { showErr(clean(e)); }
});
$('#copyReq').addEventListener('click', () => navigator.clipboard.writeText($('#req').textContent).then(() => ($('#copyReq').textContent = 'Copied')));

$('#offline').addEventListener('click', async () => {
  showErr(''); if (!needEula()) return;
  try { await hub.license.activateOffline($('#key').value.trim(), $('#act').value.trim(), true); $('#offline').textContent = 'Activated ✓'; }
  catch (e) { showErr(clean(e)); }
});
