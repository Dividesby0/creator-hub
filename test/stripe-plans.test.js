'use strict';
// Stripe Billing end to end: real `php -S` licensing server, a stand-in Stripe API that returns
// objects shaped exactly like the sandbox returned them (API 2026-08-26.dahlia), signed webhooks,
// and the app's own activation verifier.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const core = require('../src/license/core');
const phpOk = spawnSync('php', ['-r', "echo extension_loaded('pdo_sqlite') && extension_loaded('curl') ? 'y' : 'n';"]);
const hasPhp = phpOk.status === 0 && String(phpOk.stdout) === 'y';
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
function req(url, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((res, rej) => {
    const r = http.request(url, { method, headers, agent: false }, x => { let b = ''; x.on('data', d => b += d); x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: b })); });
    r.on('error', rej); if (body) r.write(body); r.end();
  });
}
const json = (url, o) => req(url, { method: 'POST', body: JSON.stringify(o), headers: { 'content-type': 'application/json' } });
const dev = n => crypto.createHash('md5').update('dev' + n).digest('hex');
const WHSEC = 'whsec_test_' + crypto.randomBytes(12).toString('hex');
const sign = (payload, t = Math.floor(Date.now() / 1000), secret = WHSEC) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;

test('Stripe plans: checkout, signed webhooks, key on thanks page, activation, seats, failed payment, cancel, portal', { skip: !hasPhp && 'php with pdo_sqlite and curl not installed' }, async () => {
  const PRICES = { price_pro: 'pro', price_studio: 'studio' };
  const now = Math.floor(Date.now() / 1000);
  // subscription as the sandbox returns it: period end on the item, customer expandable
  const sub = {
    id: 'sub_TEST123', object: 'subscription', status: 'active', cancel_at_period_end: false, customer: 'cus_TEST',
    items: { object: 'list', data: [{ id: 'si_1', current_period_start: now, current_period_end: now + 30 * 86400, price: { id: 'price_pro', product: 'spektly_pro' } }] },
  };
  const session = { id: 'cs_test_' + 'a'.repeat(40), object: 'checkout.session', mode: 'subscription', payment_status: 'paid', subscription: sub.id, customer_details: { email: 'buyer@example.com' } };
  const seen = [];
  const stripe = http.createServer((rq, rs) => {
    let b = ''; rq.on('data', d => b += d); rq.on('end', () => {
      seen.push({ method: rq.method, url: rq.url, auth: rq.headers.authorization, version: rq.headers['stripe-version'], idem: rq.headers['idempotency-key'], body: b });
      rs.setHeader('content-type', 'application/json');
      const send = (st, o) => { rs.statusCode = st; rs.end(JSON.stringify(o)); };
      if (rq.method === 'POST' && rq.url === '/v1/checkout/sessions') return send(200, { ...session, url: 'https://checkout.stripe.com/c/pay/' + session.id });
      if (rq.method === 'GET' && rq.url.startsWith('/v1/checkout/sessions/')) return send(200, session);
      if (rq.method === 'GET' && rq.url.startsWith('/v1/subscriptions/' + sub.id)) return send(200, { ...sub, customer: { id: 'cus_TEST', object: 'customer', email: 'buyer@example.com' } });
      if (rq.method === 'POST' && rq.url === '/v1/billing_portal/sessions') return send(200, { url: 'https://billing.stripe.com/p/session/test_abc' });
      send(404, { error: { message: 'no route' } });
    });
  });
  const sport = await listen(stripe);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stripe-')), secrets = path.join(dir, 'secrets.php'), data = path.join(dir, 'data');
  fs.writeFileSync(secrets, `<?php return ['FORCE_HTTPS' => false, 'DATA_DIR' => '${data.replace(/\\/g, '/')}', 'LICENSE_PUBLIC_KEY' => '', 'STRIPE_SECRET_KEY' => 'rk_test_fake', 'STRIPE_WEBHOOK_SECRET' => '${WHSEC}',
    'STRIPE_PRICES' => ${'[' + Object.entries(PRICES).map(([k, v]) => `'${k}' => '${v}'`).join(', ') + ']'}, 'UPSTREAM' => ['api.stripe.com' => 'http://127.0.0.1:${sport}']];`);
  const tmpSrv = http.createServer(); const pport = await listen(tmpSrv); tmpSrv.close();
  const docroot = path.join(__dirname, '..', 'vendor', 'signin-relay-php', 'public');
  const php = spawn('php', ['-S', `127.0.0.1:${pport}`, '-t', docroot, path.join(docroot, 'index.php')], { env: { ...process.env, SPEKTLY_SECRETS_FILE: secrets }, stdio: 'ignore' });
  const S = `http://127.0.0.1:${pport}`;
  const hook = (type, object, opts = {}) => {
    const payload = JSON.stringify({ id: opts.id || 'evt_' + crypto.randomBytes(6).toString('hex'), object: 'event', type, data: { object } });
    return req(S + '/v1/stripe/webhook', { method: 'POST', body: payload, headers: { 'content-type': 'application/json', 'stripe-signature': opts.sig || sign(payload) } });
  };
  try {
    for (let i = 0; i < 50; i++) { try { await req(S + '/health'); break; } catch (_) { await new Promise(r => setTimeout(r, 100)); } }
    const health = JSON.parse((await req(S + '/health')).body).licensing.stripe;
    assert.deepStrictEqual(health, { key: true, webhook: true, prices: ['pro', 'studio'], automaticTax: false });

    // 1. Checkout: subscription mode, the plan's price, no payment_method_types, tagged, idempotent
    const buy = await req(S + '/buy/pro');
    assert.strictEqual(buy.status, 303);
    assert.match(buy.headers.location, /^https:\/\/checkout\.stripe\.com\//);
    const cs = seen.find(s => s.url === '/v1/checkout/sessions');
    const q = new URLSearchParams(cs.body);
    assert.strictEqual(q.get('mode'), 'subscription');
    assert.strictEqual(q.get('line_items[0][price]'), 'price_pro');
    assert.strictEqual(q.get('success_url'), 'https://spektly.com/thanks/?session_id={CHECKOUT_SESSION_ID}');
    assert.match(q.get('integration_identifier'), /^spektly-plans-[a-z]{8}$/);
    assert.ok(![...q.keys()].some(k => k.startsWith('payment_method_types')), 'must not pin payment_method_types');
    assert.ok(![...q.keys()].some(k => k.startsWith('automatic_tax')), 'automatic tax stays off until a registration exists');
    assert.strictEqual(cs.auth, 'Bearer rk_test_fake');
    assert.strictEqual(cs.version, '2026-08-26.dahlia');
    assert.ok(cs.idem, 'POST carries an Idempotency-Key');
    assert.strictEqual((await req(S + '/buy/agency')).status, 503, 'a plan with no Stripe price shows the opens-soon page');

    // 2. Webhooks: bad, stale and missing signatures are refused; a good one is processed once
    const payload = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', data: { object: session } });
    assert.strictEqual((await req(S + '/v1/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': sign(payload, undefined, 'whsec_wrong') } })).status, 400);
    assert.strictEqual((await req(S + '/v1/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': sign(payload, Math.floor(Date.now() / 1000) - 3600) } })).status, 400);
    assert.strictEqual((await req(S + '/v1/stripe/webhook', { method: 'POST', body: payload })).status, 400);
    const w1 = await hook('checkout.session.completed', session, { id: 'evt_done_1' });
    assert.strictEqual(w1.status, 200);
    assert.deepStrictEqual(JSON.parse((await hook('checkout.session.completed', session, { id: 'evt_done_1' })).body), { ok: true, duplicate: true });

    // 3. Thanks page gets the key from the session id
    assert.strictEqual((await req(S + '/v1/stripe/session?session_id=nope')).status, 400);
    const got = JSON.parse((await req(S + '/v1/stripe/session?session_id=' + session.id)).body);
    assert.match(got.key, /^SPK-[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/);
    assert.strictEqual(got.plan, 'Pro'); assert.strictEqual(got.email, 'buyer@example.com');
    assert.strictEqual(JSON.parse((await req(S + '/v1/stripe/session?session_id=' + session.id)).body).key, got.key, 'same key every time');
    const key = got.key;

    // 4. Activation verifies with the app's own checker; Pro allows 3 computers
    const pub = core.publicKeyFromRawB64(JSON.parse((await req(S + '/v1/activation-key')).body).activationPublicKey);
    const act = async (n, k = key) => json(S + '/v1/activate', { key: k, device: dev(n), deviceName: 'pc' + n, platform: 'darwin' });
    const a1 = JSON.parse((await act(1)).body);
    const claims = core.verifyActivation(a1.activation, { activationPublicKeys: [pub], device: dev(1), key });
    assert.strictEqual(claims.tierName, 'Pro');
    assert.strictEqual((await act(1, key.toLowerCase())).status, 200, 'key is case-insensitive');
    assert.strictEqual((await act(2)).status, 200); assert.strictEqual((await act(3)).status, 200);
    const a4 = await act(4); assert.strictEqual(a4.status, 409); assert.match(JSON.parse(a4.body).error, /3 computer/);
    assert.strictEqual((await act(9, 'SPK-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA')).status, 400, 'unknown key');
    const val = async n => JSON.parse((await json(S + '/v1/validate', { key, device: dev(n) })).body);
    assert.strictEqual((await val(1)).valid, true);
    assert.strictEqual((await val(7)).valid, false, 'a computer that never activated');

    // 5. Upgrade to Studio in the portal: 5 seats now
    sub.items.data[0].price = { id: 'price_studio', product: 'spektly_studio' };
    assert.strictEqual((await hook('customer.subscription.updated', sub)).status, 200);
    assert.strictEqual((await act(4)).status, 200);
    assert.strictEqual(core.verifyActivation((await val(4)).activation, { activationPublicKeys: [pub], device: dev(4), key }).tierName, 'Studio');

    // 6. A failed renewal (past_due) keeps working while Stripe retries
    sub.status = 'past_due';
    assert.strictEqual((await hook('invoice.payment_failed', { id: 'in_1', object: 'invoice', parent: { subscription_details: { subscription: sub.id } } })).status, 200);
    assert.strictEqual((await val(1)).valid, true);
    // ...and stops once Stripe gives up (unpaid), with a pay-your-bill message
    sub.status = 'unpaid';
    await hook('customer.subscription.updated', sub);
    const v = await val(1); assert.strictEqual(v.valid, false); assert.match(v.error, /payment did not go through/);
    // paying the invoice restores it
    sub.status = 'active';
    await hook('invoice.paid', { id: 'in_1', object: 'invoice', parent: { subscription_details: { subscription: sub.id } } });
    assert.strictEqual((await val(1)).valid, true);

    // 7. Portal: the key identifies the customer
    const p = await req(S + '/v1/billing/portal', { method: 'POST', body: 'key=' + encodeURIComponent(key), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.strictEqual(p.status, 303); assert.strictEqual(p.headers.location, 'https://billing.stripe.com/p/session/test_abc');
    assert.strictEqual(new URLSearchParams(seen.find(s => s.url === '/v1/billing_portal/sessions').body).get('customer'), 'cus_TEST');
    const bad = await req(S + '/v1/billing/portal', { method: 'POST', body: 'key=nope', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.match(bad.headers.location, /account\/\?error=key/);

    // 8. Cancellation at period end keeps access until the period ends; deletion ends it
    sub.cancel_at_period_end = true;
    await hook('customer.subscription.updated', sub);
    assert.strictEqual((await val(2)).valid, true);
    sub.status = 'canceled';
    await hook('customer.subscription.deleted', sub);
    const end = await val(2); assert.strictEqual(end.valid, false); assert.match(end.error, /plan has ended/);
    assert.strictEqual((await act(5)).status, 400);

    // 9. Deactivating frees a seat record
    assert.deepStrictEqual(JSON.parse((await json(S + '/v1/deactivate', { key, device: dev(3) })).body), { ok: true });
  } finally { php.kill(); stripe.close(); }
});
