# Creator Hub — Editions, Pricing & Licensing Policy

*Draft for launch. Prices are recommendations; adjust after your first 50–100 sales.*

## Why these prices

Hosted schedulers bill every month, forever:

- Buffer: about $6 per channel per month. Six channels is about $36/month, or $432/year.
- Metricool: from about €20/month.
- Later: from about $18.75/month.
- Hootsuite and Sprout Social: $79–$99+ per user per month.

Creator Hub is **local-first**. You have no servers to pay for per customer, so you can undercut them hard with a **one-time price**. That is a clear marketing hook: *"Pay once. Own it. Your keys, your data, your computer."*

The trade-off buyers accept: they set up their own platform developer apps, and the app posts only while their computer is on. The price should reflect that friction.

## Editions

| Edition | Who | Seats / devices | Price | Updates |
|---|---|---|---|---|
| **Founder** (first 2,000 only) | Early adopters | 1 user · 1 device | **$49 one-time** | Lifetime |
| **Personal** | Solo creator | 1 user · 1 device | **$79 one-time** | 12 months, then $39/yr (optional) |
| **Pro** | Creator with laptop + desktop | 1 user · up to 3 devices | **$149 one-time** | 12 months, then $69/yr (optional) |
| **Team** | Small agency / creator team | 5 seats (1 device each) | **$399/year** (≈$6.65/seat/mo) or $899 perpetual | Included while subscribed |
| **Business** | Agencies, brands | 25 seats | **$1,499/year** (≈$5/seat/mo) | Included |
| **Enterprise** | 100+ seats, site license | 100+ seats, custom | **From $4,999/year**, quoted | Included, priority support, offline activation, invoice billing |

### Rules that make the tiers work

- **Seat = one device activation.** A Team license with 5 seats activates on 5 computers. Users free a seat with **Settings → License → Deactivate this device**, or you release it through the vendor tools.
- **Perpetual licenses never stop working.** When the update window ends, the customer keeps the version they have. The "updates until" date is encoded in the key, so your future builds can refuse to install on keys whose update window has passed. That check is not wired in yet; add it when you ship v2.
- **Subscriptions** (Team, Business, Enterprise) use keys with an **expiry date**. Issue a fresh key at each renewal (`--expires 2027-10-01`).
- **Volume:** add seats at the tier's per-seat rate. Re-issue the key with the new `--devices` count on the same account.
- **Education and nonprofit:** 40% off Personal and Team. This is optional but good for word of mouth.
- **Refunds:** 14 days, only after the customer deactivates. Revoke the serial when you refund.

### The first 2,000 keys

The keys delivered with the app are **Founder Edition**: 1 device each, lifetime updates, perpetual. Sell them as a limited launch batch ("2,000 Founder licenses, then the price goes up"). Scarcity plus lifetime updates is the strongest launch offer you can make for a desktop tool.

Suggested launch path:
1. **Beta (first 100):** free or $19 to creators who give feedback and testimonials.
2. **Founder launch:** $49 until the 2,000 are gone.
3. **General availability:** Personal $79 and Pro $149.

## Issuing keys for any edition

```bash
npm run vendor:issue -- --tier personal --count 500
npm run vendor:issue -- --tier pro --count 200 --devices 3
npm run vendor:issue -- --tier team --count 1 --devices 5 --expires 2027-10-01 --licensee "Acme Media LLC"
npm run vendor:issue -- --tier business --count 1 --devices 25 --expires 2027-10-01 --licensee "BigCo"
npm run vendor:issue -- --tier enterprise --count 1 --devices 150 --expires 2027-10-01 --licensee "MegaCorp"
```

Each run writes a CSV to `vendor/issued/`. Load the CSV into your store, such as a Shopify digital product or Lemon Squeezy / Paddle license-key delivery, so each order receives one key automatically.

## Selling and delivering

- Payment processors that handle **sales tax / VAT for you** (merchant of record): Paddle, Lemon Squeezy, FastSpring. Recommended for global sales of downloadable software.
- Shopify also works, using a digital-downloads app that hands out one unused key per order.
- Every sale should record: order ID, email, serial, and edition. Put the serial in your support system so you can release seats and handle refunds.

## Protecting revenue: what the crypto does and doesn't do

**What it does:**

- **Keys can't be forged.** Each key is signed with Ed25519 using your private license key, and the app only holds the public key. Changing a single character invalidates the key.
- **Activations can't be copied.** Each activation is signed separately (a second keypair) and bound to a hash of the computer's hardware ID. Copying the app folder or license file to another machine fails.
- **Seat limits are enforced server-side**, with an atomic database check, so racing activations can't exceed the seat count.
- **Leaked keys can be revoked** on the server immediately, and in the app's built-in revocation list on the next update.

**What it doesn't do:** stop someone from patching the app's code to skip the check. No desktop software can fully prevent that; large vendors get cracked too. Mitigations, from cheap to strong:

- Keep releasing updates that crackers must re-patch.
- Code-sign your builds. Signing is required anyway for smooth macOS and Windows installs.
- Enable Electron fuses (`onlyLoadAppFromAsar`, `enableEmbeddedAsarIntegrityValidation`) at packaging time.
- Tie genuinely valuable features to your server later, such as cloud backup or AI caption suggestions.
