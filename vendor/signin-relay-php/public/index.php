<?php
// Spektly sign-in relay (PHP, for Hostinger web hosting).
// Holds the Meta app secrets that Meta does not allow inside a downloadable app. It never stores tokens:
// it bounces the sign-in code back to the user's own computer (127.0.0.1) and, when the app asks,
// performs the secret-bearing token exchange and returns the result straight to the app.
//
// Secrets live OUTSIDE the public folder in spektly-signin-secrets.php (see secrets.example.php).
// Redirect URI to register in each platform app: https://<this host>/v1/oauth/cb/<platform>
declare(strict_types=1);
const SPEKTLY_RELAY = true;
require __DIR__ . '/license.php';

const PROVIDERS = ['tiktok', 'instagram', 'threads', 'facebook'];
const SECRET_OF = ['tiktok' => 'TIKTOK_CLIENT_SECRET', 'instagram' => 'INSTAGRAM_APP_SECRET', 'threads' => 'THREADS_APP_SECRET', 'facebook' => 'FACEBOOK_APP_SECRET'];

function cfg(): array {
  static $c = null;
  if ($c !== null) return $c;
  $c = [];
  $file = getenv('SPEKTLY_SECRETS_FILE') ?: dirname(__DIR__) . '/spektly-signin-secrets.php';
  // Non-secret licensing settings (public key, product ids, checkout links) live in their own file so
  // they can be updated without touching the secrets. Values in the secrets file win.
  $pub = getenv('SPEKTLY_LICENSE_CONFIG') ?: dirname(__DIR__) . '/spektly-license-config.php';
  if (is_file($pub)) { $v = include $pub; if (is_array($v)) $c = $v; }
  if (is_file($file)) { $v = include $file; if (is_array($v)) $c = array_merge($c, array_filter($v, fn($x) => $x !== '' && $x !== [])); }
  return $c;
}
function sec(string $k): string { return trim((string)(cfg()[$k] ?? '')); }
function upstreamBase(string $host): string { return rtrim((string)(cfg()['UPSTREAM'][$host] ?? "https://$host"), '/'); } // tests only override this

function out($data, int $status = 200): void {
  http_response_code($status);
  header('Content-Type: application/json'); header('Cache-Control: no-store');
  echo json_encode($data, JSON_UNESCAPED_SLASHES);
}
function selfOrigin(): string {
  $fwd = $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '';
  $https = $fwd === 'https' || (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (cfg()['FORCE_HTTPS'] ?? true);
  return ($https ? 'https' : 'http') . '://' . $_SERVER['HTTP_HOST'];
}
function upstream(string $url, ?array $post = null): array {
  $ch = curl_init($url);
  curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_HTTPHEADER => ['Accept: application/json']]);
  if ($post !== null) { curl_setopt($ch, CURLOPT_POST, true); curl_setopt($ch, CURLOPT_POSTFIELDS, http_build_query($post)); }
  $text = curl_exec($ch);
  $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  $body = is_string($text) ? json_decode($text, true) : null;
  if (!is_array($body)) $body = ['error' => 'bad_upstream', 'error_description' => substr((string)$text, 0, 200)];
  return ['ok' => $status >= 200 && $status < 300, 'body' => $body];
}

function callback(string $provider): void {
  if (!in_array($provider, PROVIDERS, true)) { out(['error' => 'unknown provider'], 404); return; }
  $state = (string)($_GET['state'] ?? '');
  $portStr = explode('.', $state)[0];
  $port = ctype_digit($portStr) ? (int)$portStr : 0;
  if ($port < 1024 || $port > 65535) { http_response_code(400); header('Content-Type: text/plain'); echo 'Invalid sign-in state. Go back to Spektly and click Connect again.'; return; }
  $fwd = ['state' => $state];
  foreach (['code', 'error', 'error_description'] as $k) if (isset($_GET[$k]) && $_GET[$k] !== '') $fwd[$k] = (string)$_GET[$k];
  // Only ever redirect to this computer's loopback address.
  header('Cache-Control: no-store');
  header('Location: http://127.0.0.1:' . $port . '/callback/?' . http_build_query($fwd), true, 302);
}

function token(string $provider): void {
  if (!in_array($provider, PROVIDERS, true)) { out(['error' => 'unknown provider'], 404); return; }
  $b = json_decode((string)file_get_contents('php://input'), true) ?: [];
  $redirect = selfOrigin() . '/v1/oauth/cb/' . $provider;
  if (!empty($b['redirect_uri']) && $b['redirect_uri'] !== $redirect) { out(['error' => 'redirect_mismatch'], 400); return; }
  if (sec(SECRET_OF[$provider]) === '') { out(['error' => 'not_configured'], 503); return; }
  $code = (string)($b['code'] ?? '');
  if ($provider === 'tiktok') {
    $p = ($b['grant_type'] ?? '') === 'refresh_token'
      ? ['client_key' => sec('TIKTOK_CLIENT_KEY'), 'client_secret' => sec('TIKTOK_CLIENT_SECRET'), 'grant_type' => 'refresh_token', 'refresh_token' => (string)($b['refresh_token'] ?? '')]
      : ['client_key' => sec('TIKTOK_CLIENT_KEY'), 'client_secret' => sec('TIKTOK_CLIENT_SECRET'), 'grant_type' => 'authorization_code', 'code' => $code, 'redirect_uri' => $redirect];
    $r = upstream(upstreamBase('open.tiktokapis.com') . '/v2/oauth/token/', $p);
    out($r['body'], $r['ok'] ? 200 : 400); return;
  }
  if ($provider === 'instagram') {
    $s = upstream(upstreamBase('api.instagram.com') . '/oauth/access_token', ['client_id' => sec('INSTAGRAM_APP_ID'), 'client_secret' => sec('INSTAGRAM_APP_SECRET'), 'grant_type' => 'authorization_code', 'redirect_uri' => $redirect, 'code' => $code]);
    if (!$s['ok']) { out($s['body'], 400); return; }
    $l = upstream(upstreamBase('graph.instagram.com') . '/access_token?' . http_build_query(['grant_type' => 'ig_exchange_token', 'client_secret' => sec('INSTAGRAM_APP_SECRET'), 'access_token' => $s['body']['access_token'] ?? '']));
    out($l['ok'] ? $l['body'] + ['user_id' => $s['body']['user_id'] ?? null] : $l['body'], $l['ok'] ? 200 : 400); return;
  }
  if ($provider === 'threads') {
    $s = upstream(upstreamBase('graph.threads.net') . '/oauth/access_token', ['client_id' => sec('THREADS_APP_ID'), 'client_secret' => sec('THREADS_APP_SECRET'), 'grant_type' => 'authorization_code', 'redirect_uri' => $redirect, 'code' => $code]);
    if (!$s['ok']) { out($s['body'], 400); return; }
    $l = upstream(upstreamBase('graph.threads.net') . '/access_token?' . http_build_query(['grant_type' => 'th_exchange_token', 'client_secret' => sec('THREADS_APP_SECRET'), 'access_token' => $s['body']['access_token'] ?? '']));
    out($l['ok'] ? $l['body'] + ['user_id' => $s['body']['user_id'] ?? null] : $l['body'], $l['ok'] ? 200 : 400); return;
  }
  // facebook: code -> user token -> long-lived user token (Page tokens derived from it do not expire)
  $g = upstreamBase('graph.facebook.com') . '/v23.0/oauth/access_token?';
  $s = upstream($g . http_build_query(['client_id' => sec('FACEBOOK_APP_ID'), 'client_secret' => sec('FACEBOOK_APP_SECRET'), 'redirect_uri' => $redirect, 'code' => $code]));
  if (!$s['ok']) { out($s['body'], 400); return; }
  $l = upstream($g . http_build_query(['grant_type' => 'fb_exchange_token', 'client_id' => sec('FACEBOOK_APP_ID'), 'client_secret' => sec('FACEBOOK_APP_SECRET'), 'fb_exchange_token' => $s['body']['access_token'] ?? '']));
  out($l['body'], $l['ok'] ? 200 : 400);
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
try {
  if (licenseRoute($method, $path)) {}
  elseif ($method === 'GET' && str_starts_with($path, '/v1/oauth/cb/')) callback(basename($path));
  elseif ($method === 'POST' && str_starts_with($path, '/v1/oauth/token/')) token(basename($path));
  // Meta app callbacks. The relay stores no user data, so there is nothing to remove; Spektly keeps
  // tokens only on the user's own computer (Disconnect in the app deletes them).
  elseif ($method === 'POST' && $path === '/v1/meta/deauthorize') out(['ok' => true]);
  elseif ($method === 'POST' && $path === '/v1/meta/data-deletion') { $code = bin2hex(random_bytes(8)); out(['url' => 'https://spektly.com/privacy/#data-deletion', 'confirmation_code' => $code]); }
  elseif ($path === '/health') out(['ok' => true, 'platforms' => array_values(array_filter(PROVIDERS, fn($p) => sec(SECRET_OF[$p]) !== '')), 'licensing' => ['sodium' => function_exists('sodium_crypto_sign_keypair'), 'sqlite' => extension_loaded('pdo_sqlite'), 'php' => PHP_VERSION, 'keys' => sec('LICENSE_PUBLIC_KEY') !== '', 'plans' => sec('CREEM_API_KEY') !== '', 'checkout' => array_keys(array_filter((array)(cfg()['BUY_URLS'] ?? []), fn($u) => is_string($u) && str_starts_with($u, 'https://')))]]);
  elseif ($method === 'GET' && $path === '/') { header('Content-Type: text/html; charset=utf-8'); echo '<!doctype html><meta charset="utf-8"><title>Spektly sign-in</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#0b1624;color:#eef1f5;font:16px -apple-system,Segoe UI,sans-serif"><div style="text-align:center"><div style="font-weight:700;color:#7fa3cc">spektly</div><p>This address only handles sign-ins started from the Spektly app.</p></div>'; }
  else out(['error' => 'not found'], 404);
} catch (Throwable $e) { out(['error' => 'server_error'], 500); }
