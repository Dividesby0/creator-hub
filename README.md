# Creator Hub

A local-first desktop app for macOS and Windows. It schedules, approves, publishes, and tracks posts on **YouTube, TikTok, Instagram, Threads, Facebook Pages, and X**, and includes a built-in commercial licensing system.

- **Compose once, post everywhere.** Captions can be overridden per platform, with live character-limit and X-cost counters.
- **Approval queue.** Nothing goes live until you approve it (you can turn this off).
- **Calendar, queue, and retries.** Each platform retries on its own, so a failure on X never re-posts to TikTok.
- **Insights (v2).** One dashboard for everything: YouTube Analytics (views, watch hours, subscribers, top videos, traffic sources), Google Analytics 4 (website visitors, top pages, channels), Search Console (Google clicks, impressions, top queries, SEO opportunities), Google Business Profile (profile views, calls, website clicks, directions) and every connected social platform, each compared with the previous period. Auto-generated "What changed" highlights, 7/28/90-day ranges, one-click **PDF report** and **CSV export**.
- **Post analytics.** Follower history and per-post views, likes, comments, and shares from each platform's API.
- **One copy, always.** On Mac it offers to move itself into Applications, and after each update it moves older copies and old installer files to the Trash. On Windows the installer upgrades in place. The app tells you when a new version is out.
- **Batch import.** Load a week of posts from one JSON file (see `examples/batch-week-1.json`).
- **AI-content labels.** One checkbox sets YouTube's synthetic-media flag and TikTok's AIGC flag, and can append a disclosure hashtag.
- **Private by design.** Credentials are encrypted with the OS keychain (macOS Keychain or Windows DPAPI) and never leave the computer except to talk to each platform.

> Creator Hub posts only while it is running. Leave "Keep running in the background" and "Start at login" on, and don't let the computer sleep at posting time.

---

## 1. Run it

Requires **Node.js 20+**.

```bash
npm install
npm start          # launches the app
npm test           # 24 automated tests: licensing, scheduler, platform flows, activation server
```

**Build installers.** Mac builds must be made on a Mac, and Windows builds are best made on Windows:

```bash
npm run dist:mac   # → dist/Creator Hub-1.0.0.dmg
npm run dist:win   # → dist/Creator Hub Setup 1.0.0.exe
```

Before you sell, **code-sign** the builds:
- **Mac:** an Apple Developer ID ($99/yr) plus notarization.
- **Windows:** an OV/EV code-signing certificate.

Unsigned apps show scary warnings that hurt sales. electron-builder picks signing up automatically from the standard `CSC_LINK` / `APPLE_ID` environment variables.

---

## 2. Connect the platforms

Each platform needs a free **developer app** that you own. Creator Hub uses one fixed login redirect for the platforms that need it:

```
http://127.0.0.1:8765/callback/
```

Portals rename menus often. If a label below doesn't match, look for the nearest equivalent.

### YouTube
1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable **YouTube Data API v3**.
2. On the **OAuth consent screen**, choose External and add your Google account as a test user. **Publish the app ("In production")**; otherwise Google expires your login every 7 days.
3. Under **Credentials**, create an OAuth client ID of type **Desktop app**.
4. In Creator Hub, go to Accounts → YouTube, paste the Client ID and Secret, then click **Save & sign in**.
5. Limits:
   - Videos uploaded through a new, unaudited API project are locked to **private** until you pass Google's API audit (the "YouTube API Services – Audit and Quota Extension" form).
   - The default quota is about 6 uploads per day.

### TikTok
1. At [developers.tiktok.com](https://developers.tiktok.com/apps), create an app and add **Login Kit (Desktop)** and the **Content Posting API**.
2. Register the redirect URI above and request these scopes: `user.info.basic`, `user.info.stats`, `video.upload`, `video.publish`, `video.list`.
3. While the app is unaudited, add your TikTok account as a sandbox target user.
4. In Creator Hub, paste the Client key and secret, then choose a mode:
   - **drafts** (default): works before audit. The video lands in your TikTok inbox, and you tap Post in the app. You can have at most 5 pending drafts per day.
   - **direct**: posts automatically, but only as private (SELF_ONLY) until TikTok audits your app.

### Instagram
1. The Instagram account must be a **Professional** (Creator or Business) account.
2. At [developers.facebook.com](https://developers.facebook.com/apps), create an app and add the **Instagram** product.
3. Under **API setup with Instagram login**, add your account and **Generate token**. You need the permissions `instagram_business_basic` and `instagram_business_content_publish`.
4. In Creator Hub, paste the token and leave the account ID blank so it is auto-detected. The app refreshes the 60-day token for you.
5. **Reels** upload straight from your disk. **Single images** must be at a public URL, because Meta downloads them; put that URL in the post's "Public media URL" field.

### Threads
1. In the same Meta developer app (or a new one), add the **Threads API** use case with `threads_basic`, `threads_content_publish`, and `threads_manage_insights`.
2. Add your Threads account as a **tester** and accept the invite in the Threads app under Settings → Account → Website permissions.
3. Generate a **long-lived** user token and paste it into Creator Hub, which refreshes it automatically.
4. Text posts work directly. Images and video must be at a public URL.

### Facebook Page
1. In **Graph API Explorer**, get a User token with these permissions: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `read_insights`.
2. Exchange it for a long-lived token, then call `GET /me/accounts`. Copy your Page's **access_token** and **id**; long-lived Page tokens don't expire.
3. Paste both into Creator Hub. Videos and photos upload straight from disk.

### X
1. In the [X developer portal](https://developer.x.com/en/portal/dashboard), open your app and go to **User authentication settings**:
   - Choose **OAuth 2.0**, with type **Native App**.
   - Set permissions to **Read and write**.
   - Add the callback URI above.
2. X API access is **pay-per-use** (about $0.015 per post, $0.20 if the post contains a link). Load credits in the developer console.
3. In Creator Hub, paste the Client ID, then click **Save & sign in**. X analytics reads also cost money, so they are **off by default** (Settings → Fetch X analytics).

---

### Google Insights (YouTube Analytics, GA4, Search Console, Business Profile)
1. In the same Google Cloud project as YouTube, enable: **YouTube Analytics API**, **Google Analytics Data API**, **Google Analytics Admin API**, **Google Search Console API**. For Business Profile also enable **My Business Account Management**, **My Business Business Information** and **Business Profile Performance** APIs. Google requires an access request before these three work.
2. Open **Insights** → **Save & sign in with Google**. It reuses your YouTube OAuth client automatically. Approve every permission (all read-only).
3. Pick your GA4 property, Search Console site and Business Profile location under **Data sources**. If you only have one of each, it's picked automatically.
4. Anything not set up just shows a short note on its tab; the other tabs keep working.

## 3. Weekly workflow (with Claude)

1. Claude drafts the scripts and captions and produces media with Artlist.
2. Claude hands you one folder: the media files plus a `batch.json`.
3. In Creator Hub, click **Import batch** and pick the `batch.json`. Posts land in **Approvals**.
4. Review, then click **Approve all**. The scheduler posts each one on time and records links and analytics.

Batch format:

```json
{ "posts": [ {
  "title": "…", "caption": "…",
  "media": "relative/or/absolute/path.mp4",
  "platforms": ["youtube","tiktok","instagram","threads","facebook","x"],
  "scheduledAt": "2026-10-05T09:00:00-07:00",
  "aiGenerated": true,
  "publicMediaUrl": "https://… (only for IG images / Threads media)",
  "overrides": { "youtube": { "title": "…", "privacy": "public", "tags": "a, b" },
                 "x": { "caption": "shorter version for X" },
                 "tiktok": { "privacy": "PUBLIC_TO_EVERYONE" } }
} ] }
```

---

## 4. Licensing: vendor operations

Everything in `vendor/` is **for you only**. It is excluded from the app build and from git.

| File | What it is | Keep secret? |
|---|---|---|
| `vendor/keys/license-private.key.json` | Signs license keys (Ed25519) | **Yes.** Sealed with your passphrase (scrypt + AES-256-GCM) |
| `vendor/keys/activation-private.key.json` | Signs device activations | **Yes.** Also goes into the activation server as a secret |
| `vendor/ledger.json` | Every issued serial, and offline activations | Yes |
| `vendor/issued/*.csv` | The license keys you sell | Yes, until sold |
| `src/license/keys.json` | Public keys and revocation list, shipped in the app | No |

**Back up `vendor/keys/` and your passphrase offline**, for example on two USB drives and in a password manager. If you lose them, you can never issue or activate another key for this build.

### Common tasks

```bash
# Issue keys (see docs/LICENSING-AND-PRICING.md for editions and pricing)
npm run vendor:issue -- --tier personal --count 500
npm run vendor:issue -- --tier team --devices 5 --expires 2027-10-01 --licensee "Acme LLC"

# Offline activation desk (works without the server)
npm run vendor:activate -- --request REQ-xxxxxxxx          # prints the activation code to send back
npm run vendor:activate -- --release 100001 --device <id>  # customer changed computers
npm run vendor:activate -- --revoke 100001                 # refund / leaked key
npm run vendor:activate -- --show 100001
```

Set `CH_VENDOR_PASSPHRASE` in your shell to skip the passphrase prompt when batch-issuing.

### Deploy the activation server (enables one-click "Activate online")

This runs free on Cloudflare Workers plus D1.

```bash
cd vendor/activation-server
npm i -g wrangler && wrangler login
wrangler d1 create creator-hub-licenses        # copy the database_id into wrangler.toml
wrangler d1 execute creator-hub-licenses --remote --file=schema.sql
node ../keygen.js --worker-secret              # copy the printed value, then:
wrangler secret put ACTIVATION_PRIVATE_KEY
wrangler secret put LICENSE_PUBLIC_KEY         # the licensePublicKey value in src/license/keys.json
wrangler secret put ADMIN_TOKEN                # any long random string
wrangler deploy                                # prints https://creator-hub-activation.<you>.workers.dev
cd ../.. && node vendor/keygen.js --server https://creator-hub-activation.<you>.workers.dev
```

Rebuild the app so it contains the server URL. You can put the server on your own domain under Workers → Custom Domains.

Admin calls:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://…/v1/admin/revoke/100001
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://…/v1/admin/release/100001
curl        -H "Authorization: Bearer $ADMIN_TOKEN" https://…/v1/admin/license/100001
```

After deploying, add a rate-limiting rule for `/v1/*` in the Cloudflare dashboard, for example 20 requests per minute per IP.

### Security model

- **License key:** `CH1-…` is Crockford-base32 of a 16-byte payload plus a 64-byte **Ed25519** signature.
  - The payload holds edition, device count, serial, issue date, updates-until date, and expiry.
  - Keys are verifiable offline; they can't be forged or edited without the private key.
- **Activation:** a separate Ed25519 keypair signs `{serial, device-hash, activationId}`.
  - The device hash is SHA-256 of the OS machine ID (macOS IOPlatformUUID or Windows MachineGuid).
  - An activation copied to another computer fails.
  - A leak of the server's activation key can't mint new license keys.
- **Seat limits:** enforced by an atomic SQL insert on the server; tested against concurrent activation races.
- **Local secrets:** platform tokens and the license file are encrypted with the OS keychain via Electron `safeStorage`, falling back to AES-256-GCM.
- **Renderer:** runs sandboxed with context isolation, no Node access, and a strict script CSP.
- **Limit:** no client-side licensing is uncrackable. Code-sign, enable Electron fuses at packaging time, and ship updates regularly. See `docs/LICENSING-AND-PRICING.md`.

---

## 5. Known limits

- The app has been tested against mocked platform responses that follow each platform's current docs, but **not yet against your live accounts**. Expect to fix a detail or two on the first real post to each platform. The error text in Queue shows exactly what the platform said.
- It posts only while the computer is awake and the app is running.
- Instagram images and Threads media need a public URL. Reels, Facebook, YouTube, TikTok, and X upload directly from disk.
- It uses Meta Graph API **v23.0**. Meta retires versions about 2 years after release; bump `VERSION` in the Instagram and Facebook adapters when needed.
