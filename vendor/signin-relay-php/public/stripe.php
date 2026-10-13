<?php
// Spektly plans on Stripe Billing: hosted Checkout (subscription mode), the Customer Portal,
// and webhooks that keep each subscription's state in the local licence database.
//
// Keys:   SPK-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX, derived from the subscription id with a secret
//         that never leaves this server, so the key is never stored and can always be re-shown.
// Access: active, trialing and past_due (Stripe is still retrying) keep a plan working until the
//         paid period ends plus 3 days of grace. canceled, unpaid, incomplete and paused do not.
//
// Secrets (spektly-signin-secrets.php, outside public_html):
//   STRIPE_SECRET_KEY      restricted key (rk_...) with the permissions listed in STRIPE-SETUP.md
//   STRIPE_WEBHOOK_SECRET  whsec_... from the webhook endpoint
// Public settings (spektly-license-config.php):
//   STRIPE_PRICES          ['price_...' => 'solo', ...]
//   STRIPE_AUTOMATIC_TAX   false until at least one tax registration is active in Stripe
declare(strict_types=1);
if (!defined('SPEKTLY_RELAY')) { http_response_code(404); exit; }

const STRIPE_API_VERSION = '2026-08-26.dahlia';
const STRIPE_INTEGRATION_ID = 'spektly-plans-qwmzrktv';
const STRIPE_LIVE_STATUSES = ['active', 'trialing', 'past_due'];
const STRIPE_GRACE_DAYS = 3;

function stripeReady(): bool { return sec('STRIPE_SECRET_KEY') !== ''; }

function stripeApi(string $method, string $path, array $params = [], ?string $idempotencyKey = null): array {
  $url = rtrim((string)(cfg()['UPSTREAM']['api.stripe.com'] ?? 'https://api.stripe.com'), '/') . $path;
  $ch = curl_init();
  $headers = ['Authorization: Bearer ' . sec('STRIPE_SECRET_KEY'), 'Stripe-Version: ' . STRIPE_API_VERSION];
  if ($idempotencyKey) $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
  $opts = [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 25, CURLOPT_HTTPHEADER => $headers];
  if ($method === 'GET') { if ($params) $url .= '?' . http_build_query($params); }
  else { $opts[CURLOPT_POST] = true; $opts[CURLOPT_POSTFIELDS] = http_build_query($params); }
  $opts[CURLOPT_URL] = $url;
  curl_setopt_array($ch, $opts);
  $text = curl_exec($ch);
  $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  return ['status' => $status, 'body' => is_string($text) ? (json_decode($text, true) ?: []) : []];
}

function stripeDb(): PDO {
  $pdo = db();
  $pdo->exec('CREATE TABLE IF NOT EXISTS stripe_subs (sub TEXT PRIMARY KEY, lic TEXT NOT NULL, customer TEXT NOT NULL, email TEXT, plan TEXT NOT NULL, status TEXT NOT NULL, period_end INTEGER NOT NULL DEFAULT 0, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)');
  $pdo->exec('CREATE INDEX IF NOT EXISTS stripe_subs_lic ON stripe_subs (lic)');
  $pdo->exec('CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, at TEXT NOT NULL)');
  return $pdo;
}

// ---- keys ----
function spkKey(string $subId): string {
  $mac = hash_hmac('sha256', "spektly-stripe-key\0" . $subId, ed_secret(actKeypair()), true);
  $bits = ''; foreach (str_split(substr($mac, 0, 16)) as $c) $bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
  $out = ''; for ($i = 0; $i + 5 <= strlen($bits) && strlen($out) < 25; $i += 5) $out .= B32[bindec(substr($bits, $i, 5))];
  return 'SPK-' . implode('-', str_split($out, 5));
}
function isSpk(string $key): bool { return preg_match('/^SPK-[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/', strtoupper(trim($key))) === 1; }
function spkLic(string $key): string { return 'stripe:' . keyHash(strtoupper(trim($key))); }

// ---- subscription state ----
function stripePlanFor(array $sub): ?string {
  $map = (array)(cfg()['STRIPE_PRICES'] ?? []);
  foreach ((array)($sub['items']['data'] ?? []) as $item) {
    $p = $map[$item['price']['id'] ?? ''] ?? null;
    if (is_string($p) && isset(PLANS[$p])) return $p;
  }
  return null;
}
function stripePeriodEnd(array $sub): int {
  $end = (int)($sub['current_period_end'] ?? 0); // older API versions
  foreach ((array)($sub['items']['data'] ?? []) as $item) $end = max($end, (int)($item['current_period_end'] ?? 0));
  return $end;
}
// Always re-read the subscription from Stripe so out-of-order events cannot leave stale state.
function stripeSyncSubscription(string $subId): ?array {
  $r = stripeApi('GET', '/v1/subscriptions/' . rawurlencode($subId), ['expand' => ['customer']]);
  if ($r['status'] !== 200) throw new RuntimeException('Stripe subscription read failed: ' . $r['status']);
  $sub = $r['body'];
  $plan = stripePlanFor($sub);
  if (!$plan) return null; // not a Spektly plan price; ignore
  $customer = is_array($sub['customer']) ? $sub['customer'] : ['id' => (string)$sub['customer']];
  $key = spkKey($sub['id']); $lic = spkLic($key);
  $pdo = stripeDb();
  $pdo->prepare('INSERT INTO stripe_subs (sub, lic, customer, email, plan, status, period_end, cancel_at_period_end, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sub) DO UPDATE SET customer = excluded.customer, email = COALESCE(excluded.email, email), plan = excluded.plan, status = excluded.status, period_end = excluded.period_end, cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at')
    ->execute([$sub['id'], $lic, $customer['id'], $customer['email'] ?? null, $plan, (string)$sub['status'], stripePeriodEnd($sub), !empty($sub['cancel_at_period_end']) ? 1 : 0, gmdate('Y-m-d\TH:i:s\Z')]);
  $pdo->prepare("INSERT INTO licenses (lic, kind, plan, max_devices) VALUES (?, 'stripe', ?, ?) ON CONFLICT(lic) DO UPDATE SET plan = excluded.plan, max_devices = excluded.max_devices")
    ->execute([$lic, $plan, PLANS[$plan]['devices']]);
  return ['sub' => $sub, 'plan' => $plan, 'key' => $key, 'email' => $customer['email'] ?? null];
}
function stripeLicState(string $lic): ?array {
  $s = stripeDb()->prepare('SELECT * FROM stripe_subs WHERE lic = ?'); $s->execute([$lic]);
  $row = $s->fetch(PDO::FETCH_ASSOC);
  return $row ?: null;
}
function stripeAccessUntil(array $row): ?int {
  if (!in_array($row['status'], STRIPE_LIVE_STATUSES, true)) return null;
  $until = (int)$row['period_end'] + STRIPE_GRACE_DAYS * 86400;
  return $until > time() ? $until : null;
}
function stripePlanEndedMessage(array $row): string {
  if ($row['status'] === 'past_due' || $row['status'] === 'unpaid') return 'Your last Spektly payment did not go through. Update your card at spektly.com/account to keep posting.';
  return 'Your Spektly plan has ended. Renew it at spektly.com to keep posting.';
}

// ---- endpoints used by the app (called from activate/validate in license.php) ----
function stripeActivate(string $key, string $device, string $name, string $platform): void {
  $lic = spkLic($key);
  $row = stripeLicState($lic);
  if (!$row) { out(['error' => 'That key was not found. Copy it again from your Spektly purchase page or email.'], 400); return; }
  if (licStatus($lic) === 'revoked') { out(['error' => 'This license has been revoked. Contact support.'], 403); return; }
  $until = stripeAccessUntil($row);
  if (!$until) { out(['error' => stripePlanEndedMessage($row)], 400); return; }
  $max = PLANS[$row['plan']]['devices'];
  $act = seat($lic, $device, $name, $platform, $max, null);
  if (!$act) { out(['error' => "This plan is already active on $max computer(s). Deactivate one from inside Spektly (Settings, License) first."], 409); return; }
  out(['activation' => planToken(trim($key), $row['plan'], $max, $device, $act, gmdate('Y-m-d\TH:i:s\Z', $until))]);
}
function stripeValidate(string $key, string $device): void {
  $lic = spkLic($key);
  $row = stripeLicState($lic);
  $s = db()->prepare('SELECT * FROM activations WHERE lic = ? AND device = ?'); $s->execute([$lic, $device]);
  $act = $s->fetch(PDO::FETCH_ASSOC);
  if (!$row || !$act) { out(['valid' => false, 'error' => 'This computer is not activated for that plan.']); return; }
  if (licStatus($lic) === 'revoked') { out(['valid' => false, 'error' => 'revoked']); return; }
  $until = stripeAccessUntil($row);
  if (!$until) { out(['valid' => false, 'error' => stripePlanEndedMessage($row)]); return; }
  out(['valid' => true, 'activation' => planToken(trim($key), $row['plan'], PLANS[$row['plan']]['devices'], $device, $act, gmdate('Y-m-d\TH:i:s\Z', $until))]);
}

// ---- Checkout ----
function stripeBuy(string $plan): void {
  header('Cache-Control: no-store');
  $price = array_search($plan, (array)(cfg()['STRIPE_PRICES'] ?? []), true);
  if (!stripeReady() || !is_string($price)) { buy($plan); return; } // falls back to the "opens soon" page
  $params = [
    'mode' => 'subscription',
    'line_items' => [['price' => $price, 'quantity' => 1]],
    'success_url' => 'https://spektly.com/thanks/?session_id={CHECKOUT_SESSION_ID}',
    'cancel_url' => 'https://spektly.com/#plans',
    'allow_promotion_codes' => 'true',
    'billing_address_collection' => 'auto',
    'subscription_data' => ['metadata' => ['plan' => $plan]],
    'integration_identifier' => STRIPE_INTEGRATION_ID,
  ];
  if (!empty(cfg()['STRIPE_AUTOMATIC_TAX'])) {
    $params['automatic_tax'] = ['enabled' => 'true'];
    $params['tax_id_collection'] = ['enabled' => 'true'];
  }
  $r = stripeApi('POST', '/v1/checkout/sessions', $params, 'cs-' . bin2hex(random_bytes(12)));
  $url = (string)($r['body']['url'] ?? '');
  if ($r['status'] !== 200 || !str_starts_with($url, 'https://checkout.stripe.com/')) {
    error_log('Stripe checkout failed: ' . $r['status'] . ' ' . ($r['body']['error']['message'] ?? ''));
    header('Content-Type: text/html; charset=utf-8'); http_response_code(503);
    echo '<!doctype html><meta charset="utf-8"><title>Spektly checkout</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#10164A;color:#EEF2FF;font:17px -apple-system,Segoe UI,sans-serif;padding:24px"><p>Checkout is busy right now. Please try again in a minute.</p>';
    return;
  }
  header('Location: ' . $url, true, 303);
}

// The thanks page asks for the key with the Checkout Session id (unguessable, single customer).
function stripeSessionKey(): void {
  header('Cache-Control: no-store');
  header('Access-Control-Allow-Origin: https://spektly.com');
  header('Vary: Origin');
  $id = (string)($_GET['session_id'] ?? '');
  if (!preg_match('/^cs_(test|live)_[A-Za-z0-9]{10,200}$/', $id)) { out(['error' => 'bad session'], 400); return; }
  $r = stripeApi('GET', '/v1/checkout/sessions/' . rawurlencode($id));
  $s = $r['body'];
  if ($r['status'] !== 200 || ($s['mode'] ?? '') !== 'subscription' || empty($s['subscription'])) { out(['error' => 'not found'], 404); return; }
  if (!in_array($s['payment_status'] ?? '', ['paid', 'no_payment_required'], true)) { out(['pending' => true]); return; }
  $sync = stripeSyncSubscription((string)$s['subscription']);
  if (!$sync) { out(['error' => 'not a Spektly plan'], 404); return; }
  out(['key' => $sync['key'], 'plan' => PLANS[$sync['plan']]['name'], 'email' => $s['customer_details']['email'] ?? $sync['email']]);
}

// ---- Customer Portal: the licence key proves which customer this is ----
function stripePortal(): void {
  header('Cache-Control: no-store');
  $key = trim((string)($_POST['key'] ?? (readJson()['key'] ?? '')));
  $back = 'https://spektly.com/account/';
  $row = isSpk($key) ? stripeLicState(spkLic($key)) : null;
  if (!$row) { header('Location: ' . $back . '?error=key', true, 303); return; }
  $r = stripeApi('POST', '/v1/billing_portal/sessions', ['customer' => $row['customer'], 'return_url' => $back]);
  $url = (string)($r['body']['url'] ?? '');
  if ($r['status'] !== 200 || !str_starts_with($url, 'https://billing.stripe.com/')) { header('Location: ' . $back . '?error=busy', true, 303); return; }
  header('Location: ' . $url, true, 303);
}

// ---- webhooks ----
function stripeVerify(string $payload, string $header, string $secret, int $tolerance = 300): ?array {
  $t = null; $sigs = [];
  foreach (explode(',', $header) as $part) {
    [$k, $v] = array_pad(explode('=', trim($part), 2), 2, '');
    if ($k === 't') $t = (int)$v; elseif ($k === 'v1') $sigs[] = $v;
  }
  if (!$t || !$sigs || abs(time() - $t) > $tolerance) return null;
  $expected = hash_hmac('sha256', $t . '.' . $payload, $secret);
  foreach ($sigs as $s) if (hash_equals($expected, $s)) return json_decode($payload, true) ?: null;
  return null;
}
function stripeWebhook(): void {
  $secret = sec('STRIPE_WEBHOOK_SECRET');
  $payload = (string)file_get_contents('php://input');
  $event = $secret !== '' ? stripeVerify($payload, (string)($_SERVER['HTTP_STRIPE_SIGNATURE'] ?? ''), $secret) : null;
  if (!$event || empty($event['id'])) { out(['error' => 'bad signature'], 400); return; }
  $pdo = stripeDb();
  $seen = $pdo->prepare('SELECT 1 FROM stripe_events WHERE id = ?'); $seen->execute([$event['id']]);
  if ($seen->fetchColumn()) { out(['ok' => true, 'duplicate' => true]); return; }
  $o = $event['data']['object'] ?? [];
  $subId = null;
  switch ($event['type']) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (($o['mode'] ?? '') === 'subscription' && in_array($o['payment_status'] ?? '', ['paid', 'no_payment_required'], true)) $subId = $o['subscription'] ?? null;
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'customer.subscription.paused':
    case 'customer.subscription.resumed':
      $subId = $o['id'] ?? null;
      break;
    case 'invoice.paid':
    case 'invoice.payment_failed':
      $subId = $o['parent']['subscription_details']['subscription'] ?? ($o['subscription'] ?? null);
      break;
  }
  try {
    if (is_string($subId) && $subId !== '') stripeSyncSubscription($subId);
  } catch (Throwable $e) {
    error_log('Stripe webhook ' . $event['type'] . ' failed: ' . $e->getMessage());
    out(['error' => 'retry'], 500); return; // Stripe retries; the event is not marked as seen
  }
  $pdo->prepare('INSERT OR IGNORE INTO stripe_events (id, type, at) VALUES (?, ?, ?)')->execute([$event['id'], (string)$event['type'], gmdate('Y-m-d\TH:i:s\Z')]);
  out(['ok' => true]);
}

function stripeRoute(string $method, string $path): bool {
  if ($method === 'POST' && $path === '/v1/stripe/webhook') { stripeWebhook(); return true; }
  if ($method === 'GET' && $path === '/v1/stripe/session') { stripeSessionKey(); return true; }
  if ($method === 'POST' && $path === '/v1/billing/portal') { stripePortal(); return true; }
  if ($method === 'GET' && preg_match('#^/buy/([a-z]+)/?$#', $path, $m)) { stripeBuy($m[1]); return true; }
  return false;
}
