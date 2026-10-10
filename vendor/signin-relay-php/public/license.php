<?php
// Spektly licensing: plan checkout links, online activation, seat limits and subscription checks.
// Included by index.php. Two kinds of keys are accepted:
//   * CH1-… keys issued by the vendor CLI (perpetual or dated), verified with the license PUBLIC key.
//   * Plan keys sold through Creem (monthly subscriptions), checked against Creem's license API.
// Activations are signed with an Ed25519 key this server generates for itself on first use; the
// private half never leaves the data folder (outside public_html). The app ships the public half.
declare(strict_types=1);
if (!defined('SPEKTLY_RELAY')) { http_response_code(404); exit; }
// Ed25519: the sodium extension when the host has it, otherwise the bundled pure-PHP copy of
// paragonie/sodium_compat (ed25519-compat.php). Both produce identical keys and signatures.
function ed(): bool { static $native = null; if ($native === null) { $native = function_exists('sodium_crypto_sign_detached'); if (!$native) require_once __DIR__ . '/ed25519-compat.php'; } return $native; }
function ed_keypair(): string { return ed() ? sodium_crypto_sign_keypair() : ParagonIE_Sodium_Core_Ed25519::keypair(); }
function ed_public(string $kp): string { return ed() ? sodium_crypto_sign_publickey($kp) : ParagonIE_Sodium_Core_Ed25519::publickey($kp); }
function ed_secret(string $kp): string { return ed() ? sodium_crypto_sign_secretkey($kp) : ParagonIE_Sodium_Core_Ed25519::secretkey($kp); }
function ed_sign(string $msg, string $sk): string { return ed() ? sodium_crypto_sign_detached($msg, $sk) : ParagonIE_Sodium_Core_Ed25519::sign_detached($msg, $sk); }
function ed_verify(string $sig, string $msg, string $pk): bool { try { return ed() ? sodium_crypto_sign_verify_detached($sig, $msg, $pk) : ParagonIE_Sodium_Core_Ed25519::verify_detached($sig, $msg, $pk); } catch (Throwable $e) { return false; } }

const LIC_DOMAIN = "CREATORHUB-LICENSE-V1\0";
const ACT_DOMAIN = "CREATORHUB-ACTIVATION-V1\0";
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LIC_EPOCH = 1767225600; // 2026-01-01T00:00:00Z
const PLANS = [
  'solo'    => ['name' => 'Solo',    'devices' => 1],
  'creator' => ['name' => 'Creator', 'devices' => 2],
  'pro'     => ['name' => 'Pro',     'devices' => 3],
  'studio'  => ['name' => 'Studio',  'devices' => 5],
  'agency'  => ['name' => 'Agency',  'devices' => 10],
];
const TIER_CODES = [1 => 'personal', 2 => 'pro', 3 => 'team', 4 => 'business', 5 => 'enterprise', 9 => 'founder', 10 => 'solo', 11 => 'creator', 12 => 'studio', 13 => 'agency'];
const SUB_TOKEN_DAYS = 10; // a plan activation must be re-confirmed online within this many days

function dataDir(): string {
  $d = (string)(cfg()['DATA_DIR'] ?? (dirname(__DIR__) . '/spektly-data'));
  if (!is_dir($d)) mkdir($d, 0700, true);
  return $d;
}
function db(): PDO {
  static $pdo = null;
  if ($pdo) return $pdo;
  $pdo = new PDO('sqlite:' . dataDir() . '/licenses.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
  $pdo->exec('PRAGMA busy_timeout = 5000');
  $pdo->exec("CREATE TABLE IF NOT EXISTS licenses (lic TEXT PRIMARY KEY, kind TEXT NOT NULL, plan TEXT NOT NULL, max_devices INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active')");
  $pdo->exec('CREATE TABLE IF NOT EXISTS activations (lic TEXT NOT NULL, device TEXT NOT NULL, device_name TEXT, platform TEXT, activation_id TEXT NOT NULL, activated_at TEXT NOT NULL, instance_id TEXT, PRIMARY KEY (lic, device))');
  return $pdo;
}

// ---- activation signing key (generated here, never copied anywhere) ----
function actKeypair(): string {
  $f = dataDir() . '/activation-key.bin';
  if (!is_file($f)) {
    $tmp = $f . '.' . bin2hex(random_bytes(4));
    file_put_contents($tmp, ed_keypair());
    chmod($tmp, 0600);
    // Hard links are not allowed on some shared hosts; fall back to an exclusive create.
    if (!@link($tmp, $f) && !is_file($f)) {
      $h = @fopen($f, 'x');
      if ($h) { fwrite($h, (string)file_get_contents($tmp)); fclose($h); chmod($f, 0600); }
    }
    @unlink($tmp);
    if (!is_file($f) || filesize($f) !== 96) throw new RuntimeException('Could not create the activation key.');
  }
  return (string)file_get_contents($f);
}
function actPublicB64(): string { return base64_encode(ed_public(actKeypair())); }
function b64u(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
function signActivation(array $claims): string {
  $body = json_encode($claims, JSON_UNESCAPED_SLASHES);
  return b64u($body) . '.' . b64u(ed_sign(ACT_DOMAIN . $body, ed_secret(actKeypair())));
}

// ---- CH1 keys ----
function b32decode(string $s): string {
  $clean = str_replace(['O', 'I', 'L'], ['0', '1', '1'], preg_replace('/[^0-9A-Z]/', '', strtoupper($s)));
  $bits = 0; $value = 0; $out = '';
  foreach (str_split($clean) as $ch) {
    $v = strpos(B32, $ch);
    if ($v === false) throw new RuntimeException('Invalid character in license key');
    $value = (($value << 5) | $v) & 0xFFFFFF; $bits += 5;
    if ($bits >= 8) { $out .= chr(($value >> ($bits - 8)) & 255); $bits -= 8; }
  }
  return $out;
}
function isCh1(string $key): bool { return stripos(trim($key), 'CH1-') === 0; }
function parseCh1(string $key): array {
  $buf = b32decode(substr(trim($key), 4));
  if (strlen($buf) !== 80) throw new RuntimeException('License key is incomplete or mistyped.');
  $payload = substr($buf, 0, 16); $sig = substr($buf, 16, 64);
  $pub = base64_decode(sec('LICENSE_PUBLIC_KEY'));
  if (strlen($pub) !== 32) throw new RuntimeException('Licensing is not configured on the server.');
  if (!ed_verify($sig, LIC_DOMAIN . $payload, $pub)) throw new RuntimeException('License key signature is invalid.');
  $tier = TIER_CODES[ord($payload[1])] ?? null;
  if (!$tier) throw new RuntimeException('Unknown license tier.');
  $exp = unpack('n', substr($payload, 12, 2))[1];
  if ($exp !== 0xFFFF && time() > LIC_EPOCH + ($exp + 1) * 86400) throw new RuntimeException('This license has expired.');
  return ['serial' => unpack('N', substr($payload, 4, 4))[1], 'tier' => $tier, 'maxDevices' => unpack('n', substr($payload, 2, 2))[1]];
}

// ---- Creem ----
function creem(string $path, array $body): array {
  $base = rtrim((string)(cfg()['UPSTREAM']['api.creem.io'] ?? (sec('CREEM_TEST_MODE') === '1' ? 'https://test-api.creem.io' : 'https://api.creem.io')), '/');
  $ch = curl_init($base . $path);
  curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Accept: application/json', 'Content-Type: application/json', 'x-api-key: ' . sec('CREEM_API_KEY')],
    CURLOPT_POSTFIELDS => json_encode($body)]);
  $text = curl_exec($ch);
  $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  return ['status' => $status, 'body' => is_string($text) ? (json_decode($text, true) ?: []) : []];
}
function planForProduct(string $productId): ?string {
  $p = cfg()['CREEM_PRODUCTS'][$productId] ?? null;
  return is_string($p) && isset(PLANS[$p]) ? $p : null;
}
function subUntil(?string $expiresAt): string {
  $until = time() + SUB_TOKEN_DAYS * 86400;
  if ($expiresAt) { $e = strtotime($expiresAt); if ($e) $until = min($until, $e + 3 * 86400); }
  return gmdate('Y-m-d\TH:i:s\Z', $until);
}
function keyHash(string $key): string { return hash('sha256', "spektly-plan-key\0" . trim($key)); }
function creemProblem(int $status, array $body): string {
  if ($status === 403) return 'This plan is already active on its maximum number of computers. Deactivate one from inside Spektly (Settings, License) first.';
  if ($status === 404 || $status === 400) return 'That key was not found. Copy it again from your Spektly purchase email.';
  if ($status === 410) return 'This plan has ended. Renew it at spektly.com to keep using Spektly.';
  if ($status === 401) return 'Activation is temporarily unavailable. Please try again in a few minutes.';
  return 'Activation is temporarily unavailable. Please try again in a few minutes.';
}

// ---- endpoints ----
function readJson(): array { return json_decode((string)file_get_contents('php://input'), true) ?: []; }
function validDevice($d): bool { return is_string($d) && preg_match('/^[0-9a-f]{32}$/', $d) === 1; }

function activate(): void {
  $b = readJson();
  $key = trim((string)($b['key'] ?? '')); $device = $b['device'] ?? '';
  if (!validDevice($device)) { out(['error' => 'Invalid device id.'], 400); return; }
  $name = substr((string)($b['deviceName'] ?? ''), 0, 80); $platform = substr((string)($b['platform'] ?? ''), 0, 20);
  $pdo = db();
  if (isCh1($key)) {
    try { $lic = parseCh1($key); } catch (RuntimeException $e) { out(['error' => $e->getMessage()], 400); return; }
    $id = 'ch1:' . $lic['serial'];
    $pdo->prepare('INSERT OR IGNORE INTO licenses (lic, kind, plan, max_devices) VALUES (?, ?, ?, ?)')->execute([$id, 'ch1', $lic['tier'], $lic['maxDevices']]);
    if (licStatus($id) === 'revoked') { out(['error' => 'This license has been revoked. Contact support.'], 403); return; }
    $act = seat($id, $device, $name, $platform, $lic['maxDevices'], null);
    if (!$act) { out(['error' => "This license is already active on {$lic['maxDevices']} computer(s). Deactivate one from inside Spektly (Settings, License) first."], 409); return; }
    out(['activation' => signActivation(['v' => 1, 'serial' => $lic['serial'], 'tier' => $lic['tier'], 'device' => $device, 'activationId' => $act['activation_id'], 'activatedAt' => $act['activated_at']])]);
    return;
  }
  if (strlen($key) < 8 || strlen($key) > 200) { out(['error' => 'That does not look like a Spektly key. Copy it again from your purchase email.'], 400); return; }
  if (sec('CREEM_API_KEY') === '') { out(['error' => 'Plan activation is not open yet.'], 503); return; }
  $id = 'creem:' . keyHash($key);
  $existing = $pdo->prepare('SELECT * FROM activations WHERE lic = ? AND device = ?'); $existing->execute([$id, $device]);
  $row = $existing->fetch(PDO::FETCH_ASSOC);
  if ($row && $row['instance_id']) {
    $r = creem('/v1/licenses/validate', ['key' => $key, 'instance_id' => $row['instance_id']]);
  } else {
    $r = creem('/v1/licenses/activate', ['key' => $key, 'instance_name' => $device]);
  }
  if ($r['status'] < 200 || $r['status'] >= 300) { out(['error' => creemProblem($r['status'], $r['body'])], $r['status'] >= 500 || $r['status'] === 401 ? 503 : 400); return; }
  $L = $r['body'];
  if (($L['status'] ?? '') !== 'active') { out(['error' => creemProblem(410, $L)], 400); return; }
  $plan = planForProduct((string)($L['product_id'] ?? ''));
  if (!$plan) { out(['error' => 'This key is for a product Spektly does not recognise. Contact support.'], 400); return; }
  $inst = $L['instance'] ?? null;
  if (is_array($inst) && array_is_list($inst)) $inst = end($inst) ?: null;
  $instanceId = $row['instance_id'] ?? (is_array($inst) ? (string)($inst['id'] ?? '') : '');
  $max = (int)($L['activation_limit'] ?? PLANS[$plan]['devices']);
  $pdo->prepare('INSERT INTO licenses (lic, kind, plan, max_devices) VALUES (?, ?, ?, ?) ON CONFLICT(lic) DO UPDATE SET plan = excluded.plan, max_devices = excluded.max_devices')->execute([$id, 'creem', $plan, $max]);
  if (licStatus($id) === 'revoked') { out(['error' => 'This license has been revoked. Contact support.'], 403); return; }
  $act = $row ?: seat($id, $device, $name, $platform, PHP_INT_MAX, $instanceId);
  out(['activation' => planToken($key, $plan, $max, $device, $act, $L['expires_at'] ?? null)]);
}
function planToken(string $key, string $plan, int $max, string $device, array $act, ?string $expiresAt): string {
  return signActivation(['v' => 2, 'kind' => 'plan', 'plan' => $plan, 'planName' => PLANS[$plan]['name'], 'keyHash' => keyHash($key), 'maxDevices' => $max,
    'device' => $device, 'activationId' => $act['activation_id'], 'activatedAt' => $act['activated_at'], 'until' => subUntil($expiresAt), 'issuedAt' => gmdate('Y-m-d\TH:i:s\Z')]);
}
function licStatus(string $id): ?string { $s = db()->prepare('SELECT status FROM licenses WHERE lic = ?'); $s->execute([$id]); $v = $s->fetchColumn(); return $v === false ? null : (string)$v; }
function seat(string $id, string $device, string $name, string $platform, int $max, ?string $instanceId): ?array {
  $pdo = db();
  $pdo->exec('BEGIN IMMEDIATE');
  try {
    $s = $pdo->prepare('SELECT activation_id, activated_at FROM activations WHERE lic = ? AND device = ?'); $s->execute([$id, $device]);
    $row = $s->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
      $c = $pdo->prepare('SELECT COUNT(*) FROM activations WHERE lic = ?'); $c->execute([$id]);
      if ((int)$c->fetchColumn() >= $max) { $pdo->exec('ROLLBACK'); return null; }
      $row = ['activation_id' => bin2hex(random_bytes(16)), 'activated_at' => gmdate('Y-m-d\TH:i:s\Z')];
      $pdo->prepare('INSERT INTO activations (lic, device, device_name, platform, activation_id, activated_at, instance_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
        ->execute([$id, $device, $name, $platform, $row['activation_id'], $row['activated_at'], $instanceId]);
    }
    $pdo->exec('COMMIT');
    return $row;
  } catch (Throwable $e) { $pdo->exec('ROLLBACK'); throw $e; }
}

function validateLic(): void {
  $b = readJson();
  $key = trim((string)($b['key'] ?? '')); $device = $b['device'] ?? '';
  if (!validDevice($device)) { out(['valid' => false, 'error' => 'Invalid device id.']); return; }
  $pdo = db();
  if (isCh1($key)) {
    try { $lic = parseCh1($key); } catch (RuntimeException $e) { out(['valid' => false, 'error' => $e->getMessage()]); return; }
    $id = 'ch1:' . $lic['serial'];
    if (licStatus($id) === 'revoked') { out(['valid' => false, 'error' => 'revoked']); return; }
    // Only a revoked key or a seat released by the owner ends a CH1 activation. Computers activated
    // offline by the vendor tools are not in this database and stay valid.
    $s = $pdo->prepare('SELECT COUNT(*) FROM activations WHERE lic = ?'); $s->execute([$id]);
    $any = (int)$s->fetchColumn();
    $s = $pdo->prepare('SELECT 1 FROM activations WHERE lic = ? AND device = ?'); $s->execute([$id, $device]);
    out(['valid' => (bool)$s->fetchColumn() || $any === 0]); return;
  }
  $id = 'creem:' . keyHash($key);
  $s = $pdo->prepare('SELECT a.*, l.plan, l.max_devices, l.status FROM activations a JOIN licenses l ON l.lic = a.lic WHERE a.lic = ? AND a.device = ?'); $s->execute([$id, $device]);
  $row = $s->fetch(PDO::FETCH_ASSOC);
  if (!$row) { out(['valid' => false, 'error' => 'This computer is not activated for that plan.']); return; }
  if ($row['status'] === 'revoked') { out(['valid' => false, 'error' => 'revoked']); return; }
  $r = creem('/v1/licenses/validate', ['key' => $key, 'instance_id' => $row['instance_id']]);
  if ($r['status'] >= 500 || $r['status'] === 401 || $r['status'] === 0 || $r['status'] === 429) { out(['error' => 'Plan check is temporarily unavailable.'], 503); return; }
  $L = $r['body'];
  $instOk = !is_array($L['instance'] ?? null) || array_is_list($L['instance']) || ($L['instance']['status'] ?? 'active') === 'active';
  if ($r['status'] !== 200 || ($L['status'] ?? '') !== 'active' || !$instOk) {
    out(['valid' => false, 'error' => 'Your Spektly plan has ended. Renew it at spektly.com to keep posting.']); return;
  }
  $plan = planForProduct((string)($L['product_id'] ?? '')) ?? $row['plan'];
  out(['valid' => true, 'activation' => planToken($key, $plan, (int)$row['max_devices'], $device, $row, $L['expires_at'] ?? null)]);
}

function deactivateLic(): void {
  $b = readJson();
  $key = trim((string)($b['key'] ?? '')); $device = $b['device'] ?? '';
  if (!validDevice($device)) { out(['error' => 'Invalid device id.'], 400); return; }
  if (isCh1($key)) {
    try { $lic = parseCh1($key); } catch (RuntimeException $e) { out(['error' => $e->getMessage()], 400); return; }
    $id = 'ch1:' . $lic['serial'];
  } else $id = 'creem:' . keyHash($key);
  $s = db()->prepare('SELECT instance_id FROM activations WHERE lic = ? AND device = ?'); $s->execute([$id, $device]);
  $inst = $s->fetchColumn();
  if ($inst && !isCh1($key)) creem('/v1/licenses/deactivate', ['key' => $key, 'instance_id' => $inst]);
  db()->prepare('DELETE FROM activations WHERE lic = ? AND device = ?')->execute([$id, $device]);
  out(['ok' => true]);
}

function buy(string $plan): void {
  $url = (string)(cfg()['BUY_URLS'][$plan] ?? '');
  header('Cache-Control: no-store');
  if (!isset(PLANS[$plan])) { header('Location: https://spektly.com/#plans', true, 302); return; }
  if (!preg_match('#^https://#', $url)) {
    header('Content-Type: text/html; charset=utf-8'); http_response_code(503);
    echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Spektly checkout</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#10164A;color:#EEF2FF;font:17px -apple-system,Segoe UI,sans-serif;padding:24px"><div style="max-width:420px;text-align:center"><p style="font-weight:700;font-size:22px">Checkout for the ' . htmlspecialchars(PLANS[$plan]['name']) . ' plan opens soon.</p><p>Email <a style="color:#9DF0FF" href="mailto:info@spektly.com">info@spektly.com</a> and we will set you up by hand.</p><p><a style="color:#9DF0FF" href="https://spektly.com/#plans">Back to plans</a></p></div>';
    return;
  }
  header('Location: ' . $url, true, 302);
}

function admin(string $path): void {
  $tok = sec('ADMIN_TOKEN');
  if ($tok === '' || !hash_equals('Bearer ' . $tok, (string)($_SERVER['HTTP_AUTHORIZATION'] ?? ''))) { out(['error' => 'unauthorized'], 401); return; }
  $lic = rawurldecode(basename($path));
  if (str_starts_with($path, '/v1/admin/revoke/')) { db()->prepare("INSERT INTO licenses (lic, kind, plan, max_devices, status) VALUES (?, '', '', 0, 'revoked') ON CONFLICT(lic) DO UPDATE SET status = 'revoked'")->execute([$lic]); out(['ok' => true]); return; }
  if (str_starts_with($path, '/v1/admin/release/')) { db()->prepare('DELETE FROM activations WHERE lic = ?')->execute([$lic]); out(['ok' => true]); return; }
  $s = db()->prepare('SELECT device, device_name, platform, activated_at FROM activations WHERE lic = ?'); $s->execute([$lic]);
  out(['activations' => $s->fetchAll(PDO::FETCH_ASSOC)]);
}

// ---- customer accounts (sign-up after checkout, giveaways opt-in) ----
function accountSignup(): void {
  $back = 'https://spektly.com/account/';
  $email = strtolower(trim((string)($_POST['email'] ?? '')));
  $key = trim((string)($_POST['key'] ?? ''));
  $name = substr(trim((string)($_POST['name'] ?? '')), 0, 80);
  $give = !empty($_POST['giveaways']) ? 1 : 0;
  $news = !empty($_POST['updates']) ? 1 : 0;
  $ref = substr(preg_replace('/[^A-Za-z0-9_\-]/', '', (string)($_POST['ref'] ?? '')), 0, 80);
  if (!empty($_POST['website'])) { header('Location: ' . $back . '?joined=1', true, 303); return; } // honeypot
  if (!filter_var($email, FILTER_VALIDATE_EMAIL) || strlen($email) > 200) { header('Location: ' . $back . '?error=email', true, 303); return; }
  $pdo = db();
  $pdo->exec('CREATE TABLE IF NOT EXISTS customers (email TEXT PRIMARY KEY, name TEXT, giveaways INTEGER NOT NULL DEFAULT 0, updates INTEGER NOT NULL DEFAULT 0, ref TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  $pdo->exec('CREATE TABLE IF NOT EXISTS customer_keys (email TEXT NOT NULL, lic TEXT NOT NULL, added_at TEXT NOT NULL, PRIMARY KEY (email, lic))');
  $pdo->exec('CREATE TABLE IF NOT EXISTS signup_hits (ip TEXT NOT NULL, at INTEGER NOT NULL)');
  $ip = hash('sha256', 'ip\0' . ($_SERVER['REMOTE_ADDR'] ?? ''));
  $pdo->prepare('DELETE FROM signup_hits WHERE at < ?')->execute([time() - 3600]);
  $c = $pdo->prepare('SELECT COUNT(*) FROM signup_hits WHERE ip = ?'); $c->execute([$ip]);
  if ((int)$c->fetchColumn() >= 20) { header('Location: ' . $back . '?error=busy', true, 303); return; }
  $pdo->prepare('INSERT INTO signup_hits (ip, at) VALUES (?, ?)')->execute([$ip, time()]);
  $now = gmdate('Y-m-d\TH:i:s\Z');
  $pdo->prepare('INSERT INTO customers (email, name, giveaways, updates, ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, \'\'), name), giveaways = excluded.giveaways, updates = excluded.updates, ref = COALESCE(NULLIF(excluded.ref, \'\'), ref), updated_at = excluded.updated_at')
    ->execute([$email, $name, $give, $news, $ref, $now, $now]);
  if ($key !== '' && strlen($key) <= 200) {
    $lic = isCh1($key) ? (function () use ($key) { try { return 'ch1:' . parseCh1($key)['serial']; } catch (Throwable $e) { return null; } })() : 'creem:' . keyHash($key);
    if ($lic) $pdo->prepare('INSERT OR IGNORE INTO customer_keys (email, lic, added_at) VALUES (?, ?, ?)')->execute([$email, $lic, $now]);
  }
  header('Location: ' . $back . '?joined=1', true, 303);
}

function licenseRoute(string $method, string $path): bool {
  if ($method === 'POST' && $path === '/v1/account/signup') { accountSignup(); return true; }
  if ($method === 'POST' && $path === '/v1/activate') { activate(); return true; }
  if ($method === 'POST' && $path === '/v1/validate') { validateLic(); return true; }
  if ($method === 'POST' && $path === '/v1/deactivate') { deactivateLic(); return true; }
  if ($method === 'GET' && $path === '/v1/activation-key') { out(['activationPublicKey' => actPublicB64()]); return true; }
  if ($method === 'GET' && preg_match('#^/buy/([a-z]+)/?$#', $path, $m)) { buy($m[1]); return true; }
  if (str_starts_with($path, '/v1/admin/')) { admin($path); return true; }
  return false;
}
