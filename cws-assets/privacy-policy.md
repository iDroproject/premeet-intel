# Privacy Policy — PreMeet

**Effective date: March 25, 2026**

PreMeet ("we", "us", or "our") is a Chrome extension that turns Google Calendar invites into professional briefs. This policy explains what data PreMeet accesses, how it is handled, and the control you have over it.

> **The short version:** PreMeet reads attendee names from your Google Calendar events and looks up publicly available professional information. Profile data is cached locally in your browser and on our server to speed up repeat lookups. We use third-party services (BrightData, Stripe, Gravatar) solely to power core features. We do not sell, share, or transfer your data for unrelated purposes.

## 1. What Data We Collect

| Data | Source | Purpose |
|------|--------|---------|
| Attendee names and email addresses | Google Calendar event pages | To identify meeting participants and perform professional lookups |
| Professional profile data (title, company, work history, education, skills) | Publicly available sources (e.g., public LinkedIn profiles) | To generate attendee briefs displayed in the side panel |
| Profile photos | Gravatar (via email hash) | To display attendee avatars |
| Lookup activity log | Generated locally by the extension | To let you revisit past lookups before follow-up meetings |
| Google account info (email, name, Google user ID) | Google OAuth (at sign-in) | To create and manage your PreMeet account |
| Stripe customer and subscription IDs | Stripe (at checkout) | To manage Pro subscription billing |

## 2. What We Do NOT Collect

- We do **not** read your emails or email content.
- We do **not** access tabs or pages outside of `calendar.google.com`.
- We do **not** track your browsing history or activity on other websites.
- We do **not** collect keystrokes, form inputs, or passwords.
- We do **not** run on any page other than Google Calendar.

## 3. How Data Is Stored

PreMeet stores data in two places:

### Local (your browser)

Profile data and lookup history are stored locally using `chrome.storage.local`.

- **Cache TTL:** Cached profile data expires automatically after 7 days.
- **Cache limit:** A maximum of 500 entries are stored. When the limit is reached, the least-recently-used entries are evicted first (LRU).
- **Activity log:** Up to 500 lookup history entries are kept, with oldest entries removed first (FIFO).

### Server-side (Neon Postgres)

When you create a PreMeet account, certain data is also stored on our server hosted on **Neon Serverless Postgres**:

- **User accounts** — email, name, and Google OAuth identifier. Retained until you request account deletion.
- **Enrichment cache** — a shared cache of professional profile data retrieved from public sources, keyed by name/email. Entries expire automatically after **7 days**. This cache is shared across users to reduce redundant lookups.
- **Enrichment request log** — an audit record of each lookup you perform, including entity looked up, credit usage, and timestamp. Retained for **90 days** for billing reconciliation, then automatically purged.
- **Sessions** — hashed authentication tokens. Automatically expire after ~30 days.
- **Subscriptions and billing events** — Stripe reference IDs and webhook event records for payment traceability. Retained until account deletion (subscriptions) or for the duration of our record-keeping obligations (billing events).
- **Cache statistics** — aggregated, non-personally-identifiable hit/miss counters for monitoring. Contain no user data.

## 4. External API Calls and Third-Party Processors

When you request a lookup, PreMeet makes outbound calls to retrieve publicly available professional information. All calls are made over HTTPS and transmit only the minimum data required.

| Service | Data Sent | Purpose | Data Handling |
|---------|-----------|---------|---------------|
| **BrightData** | Attendee name, email, company name | Professional profile lookups from public sources (e.g., public LinkedIn profiles, company websites) | BrightData processes the query and returns results. Subject to BrightData's data processing terms. |
| **Gravatar** (Automattic) | SHA-256 hash of attendee email | Profile photo retrieval | Gravatar matches the hash to registered avatars. The hash cannot be reversed to recover the email. |
| **Google** | Google OAuth access token (at sign-in only) | Verify user identity for account creation | Google verifies the token and returns your email and name. Subject to Google OAuth Terms of Service. |
| **Stripe** | User account reference (never your card number) | Payment processing for Pro subscriptions | Stripe handles all payment instrument data. PreMeet stores only Stripe reference IDs, never credit card numbers or bank details. Subject to the Stripe Services Agreement. |

## 5. Data Sharing and Sales

**We do not sell, rent, or share your data with any third party outside of the services described in Section 4.**

- Data is **not** sold to third parties, data brokers, or advertisers.
- Data is **not** used or transferred for purposes unrelated to the extension's core functionality.
- Data is **not** used or transferred to determine creditworthiness or for lending purposes.
- The third-party services listed in Section 4 (BrightData, Gravatar, Google, Stripe) receive only the minimum data needed to perform their function.

## 6. Permissions Explained

| Permission | Why It's Needed |
|------------|----------------|
| `storage` | To cache profile data and lookup history locally in your browser |
| `identity` | To authenticate your PreMeet account via Google OAuth |
| `sidePanel` | To display attendee briefs in the Chrome side panel |
| Host access: `calendar.google.com` | To read attendee names from calendar event pages — the only site PreMeet runs on |

## 7. Your Control

You are in full control of your data at all times:

- **Clear local cache:** You can clear all cached profiles at any time from the extension popup.
- **Uninstall:** Removing the extension deletes all locally stored data immediately.
- **No account required:** Core lookup functionality works without creating an account.
- **Account deletion:** To delete your server-side account and all associated data (user record, sessions, enrichment request history, and subscription records), contact [privacy@premeet.co](mailto:privacy@premeet.co). Shared enrichment cache entries are not tied to individual users and expire automatically after 7 days.

## 8. Data Security

- **Local storage:** PreMeet stores browser-side data within Chrome's built-in sandboxed storage, which is isolated per-extension and inaccessible to other extensions or websites.
- **Server-side storage:** Server data is stored in Neon Serverless Postgres with encrypted connections. Authentication tokens are stored as cryptographic hashes; raw tokens are never persisted.
- **In transit:** All external API calls are made over HTTPS.

## 9. Children's Privacy

PreMeet is not intended for use by individuals under the age of 13. We do not knowingly collect personal information from children.

## 10. Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted on this page with an updated effective date. Continued use of the extension after changes constitutes acceptance of the updated policy.

## 11. Contact Us

If you have questions or concerns about this privacy policy or PreMeet's data practices, please contact us:

- Email: [privacy@premeet.co](mailto:privacy@premeet.co)
- Website: [https://premeet.co](https://premeet.co)
