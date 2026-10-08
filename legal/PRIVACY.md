# Spektly Privacy Policy

**Effective:** [EFFECTIVE DATE] · **Publisher:** [COMPANY LEGAL NAME] ("we", "us") · **Contact:** info@spektly.com

Spektly is a desktop app for Mac and Windows that helps creators schedule, approve and publish posts and see their analytics in one place. It is **local-first**: your content, your platform sign-ins and your analytics stay on your computer. We do not run servers that receive them.

## 1. What Spektly accesses and why

When you connect an account, you sign in on that platform's own website and approve specific permissions. Spektly then uses those permissions **only to provide features you see in the app**:

| You connect | Permissions requested | Used for |
|---|---|---|
| Google / YouTube | Upload YouTube videos; view your YouTube account | Publishing the videos you schedule; showing your channel name and post stats |
| Google / YouTube Analytics | View YouTube Analytics reports (read-only) | The Insights dashboard (views, watch time, subscribers, traffic sources) |
| Google Analytics | View Google Analytics data (read-only) | The Insights "Website" tab (visitors, top pages, channels) |
| Google Search Console | View Search Console data (read-only) | The Insights "Google Search" tab (clicks, impressions, top queries) |
| Google Business Profile | Manage your business listings (used read-only) | The Insights "Business Profile" tab (profile views, calls, website clicks, directions) |
| Your email address (OpenID) | Basic profile email | Showing which Google account is connected |
| TikTok, Instagram, Threads, Facebook, X | Publishing and basic insights permissions shown at sign-in | Publishing your scheduled posts and showing their stats |

Spektly **never** changes your Analytics, Search Console or Business Profile data, never posts anything you have not created or approved in the app, and never reads your private messages.

## 2. Where your data is stored

- **On your computer only.** Sign-in tokens are encrypted with your operating system's secure storage (macOS Keychain / Windows DPAPI) or, if that is unavailable, AES-256-GCM encryption tied to your device. Posts, schedules and analytics are stored in the app's local data folder.
- Data travels **directly between your computer and each platform** (for example from your computer to YouTube) over encrypted HTTPS connections. It does not pass through our servers.
- **We do not receive, store, sell, rent or share** your content, your platform data, or your sign-in tokens.

## 3. Data we do receive: license activation

To enforce licensing, activation sends us your **license serial number**, a **one-way hash** of your device's hardware identifier, your device name and your operating-system type. We use this only to administer licenses and provide support. It contains no platform data.

## 4. Google API Services User Data Policy (Limited Use)

Spektly's use and transfer of information received from Google APIs to any other app will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements. Specifically:

- Google user data is used only to provide or improve the user-facing features described above.
- It is not transferred to anyone except as necessary to provide those features, to comply with law, or as part of a merger or acquisition with notice to you.
- It is never used for advertising, never sold, and never used to build user profiles for third parties.
- No human reads Google user data, unless you give us explicit permission for a specific support request, it is needed for security purposes or to comply with law.
- Google user data is not used to develop, improve, or train generalized AI or machine-learning models.

## 5. Your choices

- **Disconnect** any account in Spektly → Accounts, which deletes its stored tokens from your computer.
- **Revoke access** at any time from the platform itself (Google: [myaccount.google.com/permissions](https://myaccount.google.com/permissions)).
- **Delete everything** by uninstalling Spektly and deleting its data folder (Mac: `~/Library/Application Support/Spektly`; Windows: `%APPDATA%\Spektly`).

## 6. Children

Spektly is not directed to children under 13 (or the minimum age in your country) and we do not knowingly collect their information.

## 7. Changes

If we change this policy we will update the effective date above and, for material changes, notify you in the app.

## 8. Contact

Questions or requests: **info@spektly.com**
