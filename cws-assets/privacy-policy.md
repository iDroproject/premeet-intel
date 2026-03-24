# Privacy Policy — PreMeet

**Effective date: March 24, 2026**

PreMeet ("we", "us", or "our") is a Chrome extension that turns Google Calendar invites into professional briefs. This policy explains what data PreMeet accesses, how it is handled, and the control you have over it.

> **The short version:** PreMeet reads attendee names from your Google Calendar events, looks up publicly available professional information, and stores everything locally in your browser. We do not sell, share, or transfer your data to third parties.

## 1. What Data We Collect

| Data | Source | Purpose |
|------|--------|---------|
| Attendee names and email addresses | Google Calendar event pages | To identify meeting participants and perform professional lookups |
| Professional profile data (title, company, work history, education, skills) | Publicly available sources (e.g., public LinkedIn profiles) | To generate attendee briefs displayed in the side panel |
| Profile photos | Gravatar (via email hash) | To display attendee avatars |
| Lookup activity log | Generated locally by the extension | To let you revisit past lookups before follow-up meetings |

## 2. What We Do NOT Collect

- We do **not** read your emails or email content.
- We do **not** access tabs or pages outside of `calendar.google.com`.
- We do **not** track your browsing history or activity on other websites.
- We do **not** collect keystrokes, form inputs, or passwords.
- We do **not** run on any page other than Google Calendar.

## 3. How Data Is Stored

All profile data and lookup history are stored **locally in your browser** using `chrome.storage.local`. Data never leaves your device except for the outbound API calls described in Section 4.

- **Cache TTL:** Cached profile data expires automatically after 7 days.
- **Cache limit:** A maximum of 500 entries are stored. When the limit is reached, the least-recently-used entries are evicted first (LRU).
- **Activity log:** Up to 500 lookup history entries are kept, with oldest entries removed first (FIFO).

## 4. External API Calls

When you request a lookup, PreMeet makes outbound calls to retrieve publicly available professional information:

- **Professional data APIs** — to retrieve public LinkedIn profiles, company details, and related professional information.
- **Gravatar** — to fetch profile photos using a hashed version of the attendee's email address.

These calls transmit only the minimum data required (name, email, or email hash). No other personal data is sent.

## 5. Data Sharing and Sales

**We do not sell, rent, or share your data with any third party.**

- Data is **not** sold to third parties, outside of the approved use cases.
- Data is **not** used or transferred for purposes unrelated to the extension's core functionality.
- Data is **not** used or transferred to determine creditworthiness or for lending purposes.

## 6. Permissions Explained

| Permission | Why It's Needed |
|------------|----------------|
| `storage` | To cache profile data and lookup history locally in your browser |
| `identity` | To authenticate your PreMeet account via Google OAuth |
| `sidePanel` | To display attendee briefs in the Chrome side panel |
| Host access: `calendar.google.com` | To read attendee names from calendar event pages — the only site PreMeet runs on |

## 7. Your Control

You are in full control of your data at all times:

- **Clear cache:** You can clear all cached profiles at any time from the extension popup.
- **Uninstall:** Removing the extension deletes all locally stored data immediately.
- **No account required:** Core lookup functionality works without creating an account.

## 8. Data Security

PreMeet stores all data within Chrome's built-in sandboxed storage, which is isolated per-extension and inaccessible to other extensions or websites. All external API calls are made over HTTPS.

## 9. Children's Privacy

PreMeet is not intended for use by individuals under the age of 13. We do not knowingly collect personal information from children.

## 10. Changes to This Policy

We may update this privacy policy from time to time. Changes will be posted on this page with an updated effective date. Continued use of the extension after changes constitutes acceptance of the updated policy.

## 11. Contact Us

If you have questions or concerns about this privacy policy or PreMeet's data practices, please contact us:

- Email: [privacy@premeet.co](mailto:privacy@premeet.co)
- Website: [https://premeet.co](https://premeet.co)
