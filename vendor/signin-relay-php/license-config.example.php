<?php
// Copy to spektly-license-config.php ONE FOLDER ABOVE public_html. Nothing here is secret.
// The Creem API key goes in spektly-signin-secrets.php as 'CREEM_API_KEY'.
return [
  'LICENSE_PUBLIC_KEY' => 'iV16nS7U++0H/wxXOPP31C+6m2uekUEWJZ8BQdURWmU=',
  'CREEM_TEST_MODE' => '0',
  // Creem product id => Spektly plan (fill in after creating the 5 products in Creem)
  'CREEM_PRODUCTS' => [],
  // Checkout link per plan; the spektly.com plan buttons go to https://signin.spektly.com/buy/<plan>
  // Stripe Billing (current). Price id => plan. These are the SANDBOX prices; swap in the live
  // price ids when you go live. Secrets STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET go in
  // spektly-signin-secrets.php, never here.
  'STRIPE_PRICES' => [
    'price_1UPyKXD2uPkPLPjpsxNccsKf' => 'solo',
    'price_1UPyKaD2uPkPLPjp4r6XJGry' => 'creator',
    'price_1UPyKdD2uPkPLPjpA2UFFqKx' => 'pro',
    'price_1UPyKgD2uPkPLPjpIoiydqra' => 'studio',
    'price_1UPyKjD2uPkPLPjpzvfEkmkG' => 'agency',
  ],
  // Turn on only after at least one tax registration is active in Stripe (Tax > Registrations).
  'STRIPE_AUTOMATIC_TAX' => false,
  // Legacy Creem links (unused once Stripe is configured)
  'BUY_URLS' => ['solo' => '', 'creator' => '', 'pro' => '', 'studio' => '', 'agency' => ''],
];
