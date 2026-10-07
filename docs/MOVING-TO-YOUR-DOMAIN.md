# Moving the Creator Hub website to your own domain

The site in this folder is plain HTML with relative links, so it works on any host.

1. Buy the domain (for example creatorhub.app) and set up the official email (for example support@creatorhub.app).
2. Easiest: keep GitHub Pages and add the domain under repo Settings > Pages > Custom domain. GitHub writes `docs/CNAME`. At your domain registrar, add the DNS records GitHub shows.
   Or copy the `docs/` folder (index.html, privacy/, terms/, assets/) to any host.
3. Edit `src/brand.json` with the new site, privacy, terms URLs and support email, and replace `decrypt443@gmail.com` in `docs/*.html`, `legal/PRIVACY.md`, `legal/EULA.md`.
4. Google Cloud > Google Auth Platform > Branding: update home page, privacy and terms links, support email, and replace the authorized domain with the new one. Verify the new domain in Google Search Console with the same Google account.
5. Rebuild and release the app.
