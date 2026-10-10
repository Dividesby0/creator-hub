<?php
// Copy to spektly-license-config.php ONE FOLDER ABOVE public_html. Nothing here is secret.
// The Creem API key goes in spektly-signin-secrets.php as 'CREEM_API_KEY'.
return [
  'LICENSE_PUBLIC_KEY' => 'iV16nS7U++0H/wxXOPP31C+6m2uekUEWJZ8BQdURWmU=',
  'CREEM_TEST_MODE' => '0',
  // Creem product id => Spektly plan (fill in after creating the 5 products in Creem)
  'CREEM_PRODUCTS' => [],
  // Checkout link per plan; the spektly.com plan buttons go to https://signin.spektly.com/buy/<plan>
  'BUY_URLS' => ['solo' => '', 'creator' => '', 'pro' => '', 'studio' => '', 'agency' => ''],
];
