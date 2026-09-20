# Connecting Google Workspace

The platform reads and sends mail through the Gmail API using a **service account with
domain-wide delegation**. One credential, authorised once, can act as any mailbox in the domain.

## Why not just a password

It no longer works. Google switched off basic authentication (username + password) for IMAP, POP
and SMTP on Workspace accounts in **March 2025**. The remaining password-shaped option is an App
Password, which requires 2-Step Verification, is revoked whenever that account's password changes,
can be disabled domain-wide by an admin, and only ever reaches one mailbox.

Domain-wide delegation has none of those properties. There is no password to rotate, nothing
expires, and the Gmail API gives real thread IDs and incremental sync — which is what makes a
usable conversation view possible at all. IMAP polling for unread messages cannot reconstruct a
thread reliably.

## Before you start — one thing that catches people out

**The mailboxes you want to connect must be real user accounts, not Google Groups.**

A Google Group (`support@` set up as a group with members) has no Gmail mailbox, so there is
nothing for the API to act as, and delegation will fail with a confusing error. If `support@` is
currently a group, you need either:

- a Workspace seat for `support@` (a licensed user), with the group's members added as Gmail
  delegates if people also want it in their own Gmail; or
- a different address that *is* a user account, with the group forwarding into it.

Check in Admin Console → Directory → Users. If the address appears there, it is a user. If it only
appears under Groups, it is not.

## Part 1 — Google Cloud (about 10 minutes)

You need a Google Cloud project. It can be a free one; the Gmail API quota for a few mailboxes
costs nothing.

1. Go to <https://console.cloud.google.com> and create a project — call it something like
   `geekitek-platform`.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → Credentials → Create credentials → Service account**.
   - Name: `netinv-mail`
   - Skip the optional "grant this service account access to the project" step. It needs no
     project roles; its power comes from the Workspace side, not from Google Cloud.
4. Open the service account → **Keys** → **Add key → Create new key → JSON**. A `.json` file
   downloads.

   **That file is a credential that can read every mailbox you later authorise.** Treat it like a
   password: do not email it, do not commit it. You will paste its contents into the platform once
   and can then delete the download.

5. Still on the service account, note the **Unique ID** (a long number, sometimes labelled
   "Client ID"). You need it in the next part.

## Part 2 — Workspace Admin Console (about 5 minutes)

This part requires a **super administrator**.

1. Go to <https://admin.google.com> → **Security → Access and data control → API controls**.
2. Click **Manage domain-wide delegation** → **Add new**.
3. **Client ID**: the Unique ID from step 5 above.
4. **OAuth scopes** — paste these, comma-separated:

   ```
   https://www.googleapis.com/auth/gmail.readonly,
   https://www.googleapis.com/auth/gmail.send,
   https://www.googleapis.com/auth/gmail.modify
   ```

   What each is for, so you can judge whether you want to grant it:

   | Scope | Why |
   |---|---|
   | `gmail.readonly` | Reading messages and threads into the platform |
   | `gmail.send` | Sending replies as the shared address |
   | `gmail.modify` | Marking read, applying labels. **Not** `gmail.full` — that includes permanent deletion, which the platform never needs and should not be able to do. |

5. **Authorise**.

Delegation can take a few minutes to propagate. If the platform reports `unauthorized_client`
immediately after setting this up, wait five minutes and retry before changing anything — that
error usually means "not propagated yet" rather than "wrong".

## Part 3 — In the platform

**Settings → Email (Google Workspace)**:

1. Paste the contents of the JSON key file.
2. Add each mailbox you want connected, by address — for example `support@geekitek.com` and
   `carriers@geekitek.com`. Give each a label and say whether it is for customers or vendors.
3. Press **Test connection** on each. It performs a real read of that mailbox's profile and reports
   exactly what came back, rather than a green tick.

## Troubleshooting

| What you see | What it usually means |
|---|---|
| `unauthorized_client` | The Client ID or scopes in Admin Console do not match, or delegation has not propagated. Wait five minutes, then re-check the Unique ID against the service account. |
| `Precondition check failed` / 400 on impersonation | The address is a Google Group, not a user account. See the note above. |
| `Invalid grant` | The server clock is wrong. The JWT is time-signed and Google rejects a skew over a few minutes. Check `timedatectl` on the server. |
| `insufficient authentication scopes` | A scope is missing from the Admin Console entry. The list there is exact — adding a scope in code does nothing until it is authorised there. |
| Works for one mailbox, not another | Delegation is domain-wide but each address still has to exist as a user. Check the failing one in Directory → Users. |

## Revoking access

Admin Console → **Security → API controls → Manage domain-wide delegation** → delete the entry.
That cuts off every mailbox immediately, without touching anyone's password. Deleting the key in
Google Cloud does the same from the other end.
