# Google OAuth verification packet: Spektly

This is the step-by-step checklist for moving the **decrypt443** Google Cloud project's sign-in from *Testing* to *In production*. Until then only listed test users can connect, and their sign-in expires every 7 days.

## 0. Status (2026-10-07)
- [x] APIs enabled: YouTube Data v3, YouTube Analytics, Analytics Data, Analytics Admin, Search Console, My Business Account Management, My Business Business Information, Business Profile Performance
- [x] Google Auth Platform configured: app name **Spektly**, External, support/contact `decrypt443@gmail.com`, test user `decrypt443@gmail.com`
- [x] Desktop-app OAuth client **Spektly Desktop** (ID in `PRIVATE - License Vendor Keys/Google OAuth - decrypt443.txt`)
- [ ] Public website with home page, privacy policy and terms (see §1)
- [ ] Domain verified in Google Search Console and added as an authorized domain
- [ ] Branding completed, then **Publish app**
- [ ] Verification submitted (scopes justification + demo video, see §3–4)
- [ ] Business Profile API access request approved (separate form, see §5)

## 1. Public pages Google requires
Host three pages on a domain you own (spektly.com). Free option: GitHub Pages on a custom domain.

| Page | Source in repo |
|---|---|
| Home page: what Spektly is, how it uses Google data, link to the privacy policy | write from the README intro |
| Privacy policy | `legal/PRIVACY.md` (fill in `[COMPANY LEGAL NAME]` and `[EFFECTIVE DATE]`) |
| Terms of service | `legal/EULA.md` |

The home page must **name the app exactly "Spektly"**, explain its purpose, and link to the privacy policy. It must be on the same domain as the authorized domain, and must not be behind a login.

## 2. Branding fields (Google Auth Platform → Branding)
- App name: `Spektly`
- User support email: `decrypt443@gmail.com`
- App logo: 120×120 PNG (`assets/icon.png` resized). Note that a logo triggers brand review.
- App home page: `https://<your-domain>/`
- Privacy policy: `https://<your-domain>/privacy`
- Terms of service: `https://<your-domain>/terms`
- Authorized domains: `<your-domain>`
- Developer contact: `decrypt443@gmail.com`

## 3. Scopes and justifications (Data Access → Add scopes)

| Scope | Sensitivity | Justification to paste |
|---|---|---|
| `youtube.upload` | Sensitive | Spektly is a desktop scheduler. When the user schedules a video for YouTube and approves it, the app uploads that video to the user's own channel at the scheduled time. Nothing is uploaded without the user creating and approving the post. |
| `youtube.readonly` | Sensitive | Shows the connected channel's name and the view/like/comment counts of videos the user published through the app. |
| `yt-analytics.readonly` | Sensitive | Read-only. Powers the Insights dashboard: views, watch time, subscribers gained, top videos and traffic sources for the user's own channel, compared with the previous period. |
| `analytics.readonly` | Sensitive | Read-only. Shows the user's own website traffic (visitors, sessions, top pages, channels) from the Google Analytics 4 property they pick, next to their social stats. |
| `webmasters.readonly` | Sensitive | Read-only. Shows clicks, impressions, average position and top search queries for the user's own Search Console site, plus "SEO opportunity" highlights. |
| `business.manage` | Sensitive | Used read-only to list the user's Business Profile locations and show profile views, calls, website clicks and direction requests. The app never edits listings. (Google offers no read-only Business Profile scope.) |
| `openid`, `email` | Non-sensitive | Displays which Google account is connected. |

**Why not narrower scopes:** each scope maps to one visible tab. Users who don't use a source simply see "not used". If Google asks, offer to request Business Profile as an optional second step.

## 4. Demo video (unlisted YouTube link, 2–4 minutes)
Google wants to see the **consent screen with the OAuth client ID visible** and **each scope in use**. Record this script:

1. Open Spektly and show the app name and version.
2. Accounts → **Connect with Google**. In the browser, zoom into the address bar so the `client_id=` value is readable. Show the consent screen listing every permission, then click **Allow**.
3. Back in the app, show "Connected as <channel>".
4. **youtube.upload:** Compose → pick a short video → select YouTube → schedule → Approve → Publish now. Show the video appearing on the channel (set it to private/unlisted).
5. **youtube.readonly:** Post analytics → show the views/likes for that video.
6. **yt-analytics.readonly:** Insights → YouTube tab (views, watch hours, top videos).
7. **analytics.readonly:** Insights → Website tab.
8. **webmasters.readonly:** Insights → Google Search tab.
9. **business.manage:** Insights → Business Profile tab (or explain that access is pending).
10. Show **Disconnect**, and show revoking the app at myaccount.google.com/permissions.

## 5. Business Profile API access (separate)
Request access with the Business Profile API contact form (Google Business Profile APIs → "Request access"), using project number **563271142019**. Until it's approved, Insights shows a note on the Business Profile tab and every other tab works.

## 6. YouTube API audit (for public uploads)
Videos uploaded through an unaudited project are locked to **private**. Submit the *YouTube API Services: Audit and Quota Extension* form after publishing the app. Reuse the justifications above and the demo video.

## 7. Typical timeline
Branding/brand review takes a few days. Sensitive-scope verification takes roughly 2–6 weeks, with back-and-forth by email to `decrypt443@gmail.com`. Watch that inbox and answer quickly.
