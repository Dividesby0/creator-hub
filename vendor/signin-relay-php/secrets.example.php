<?php
// Copy to spektly-signin-secrets.php ONE FOLDER ABOVE public_html (never inside it), then fill in.
// A platform switches on when its secret is filled in. App IDs are public; secrets are not.
return [
  'INSTAGRAM_APP_ID' => '',
  'INSTAGRAM_APP_SECRET' => '',
  'THREADS_APP_ID' => '',
  'THREADS_APP_SECRET' => '',
  'FACEBOOK_APP_ID' => '',
  'FACEBOOK_APP_SECRET' => '',
  // Licensing. LICENSE_PUBLIC_KEY is public (same value as src/license/keys.json "licensePublicKey").
  'LICENSE_PUBLIC_KEY' => '',
  // Stripe (payments). Use a RESTRICTED key (rk_live_... / rk_test_...), not the sk_ secret key.
  // Permissions: Checkout Sessions write, Billing portal write, Subscriptions read, Customers read.
  'STRIPE_SECRET_KEY' => '',
  // Signing secret (whsec_...) of the webhook endpoint https://<this host>/v1/stripe/webhook
  'STRIPE_WEBHOOK_SECRET' => '',
  // Creem (legacy payments). Paste your API key from the Creem dashboard (Developers, API keys).
  'CREEM_API_KEY' => '',
  'CREEM_TEST_MODE' => '0',            // '1' while testing with Creem test mode
  // Creem product id => Spektly plan
  'CREEM_PRODUCTS' => [
    // 'prod_xxxxxxxx' => 'solo',
  ],
  // Checkout link for each plan (spektly.com/#plans buttons go to https://<this host>/buy/<plan>)
  'BUY_URLS' => [
    'solo' => '', 'creator' => '', 'pro' => '', 'studio' => '', 'agency' => '',
  ],
  'ADMIN_TOKEN' => '',                 // optional, long random string for /v1/admin/*
];
