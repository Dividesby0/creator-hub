# Moving the Spektly website to your own domain

The site in this folder is plain HTML with relative links, so it works on any host.

1. Done: the domain is spektly.com and the official email is info@spektly.com.
2. Easiest: keep GitHub Pages and add the domain under repo Settings > Pages > Custom domain. GitHub writes `docs/CNAME`. At your domain registrar, add the DNS records GitHub shows.
   Or copy the `docs/` folder (index.html, privacy/, terms/, assets/) to any host.
3. Done: `src/brand.json`, the site pages and the legal docs now use spektly.com and info@spektly.com.
4. Google Cloud > Google Auth Platform > Branding: update home page, privacy and terms links, support email, and replace the authorized domain with the new one. Verify the new domain in Google Search Console with the same Google account.
5. Rebuild and release the app.
