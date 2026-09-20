// A Gmail API client: read threads, sync incrementally, send replies that actually thread.
//
// Everything here that does not need the network is a pure function, because the parts most likely
// to be wrong — walking a MIME tree, decoding a body, building a reply that threads on the
// recipient's side — are exactly the parts you cannot check by pointing at a live mailbox and
// squinting. Those are tested against captured payload shapes; only the transport needs Google.
import { createHash } from 'node:crypto';

const API = 'https://gmail.googleapis.com/gmail/v1';

const fromB64u = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const toB64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// ---- reading a message ---------------------------------------------------------------------------

/** Case-insensitive header lookup. Gmail returns headers as an array, and casing is not consistent. */
export function header(message, name) {
  const headers = (message && message.payload && message.payload.headers) || [];
  const want = String(name).toLowerCase();
  const found = headers.find(h => String(h.name).toLowerCase() === want);
  return found ? found.value : null;
}

/**
 * Walk the MIME tree and pull out the body and attachments.
 *
 * Real mail is not a flat object. A reply from Outlook with an attachment is typically
 * multipart/mixed wrapping multipart/alternative wrapping text/plain and text/html, and the plain
 * text can be nested three levels down. Taking payload.body.data at the top — which works for the
 * simplest possible message — produces empty bodies for most real mail, and it fails silently.
 *
 * text/plain is preferred over text/html: it is what the sender's client generated as the readable
 * version, and stripping tags out of HTML mail produces a worse result than the plain part that is
 * usually sitting right next to it.
 */
export function extractBody(message) {
  const out = { text: '', html: '', attachments: [] };
  const seen = [];

  const walk = (part, depth = 0) => {
    if (!part || depth > 12) return;          // depth guard: malformed mail can nest absurdly
    const mime = String(part.mimeType || '').toLowerCase();
    const filename = part.filename || '';

    if (filename && part.body && (part.body.attachmentId || part.body.size)) {
      out.attachments.push({
        filename,
        mimeType: mime,
        size: Number(part.body.size) || 0,
        attachmentId: part.body.attachmentId || null
      });
      return;                                  // an attachment's bytes are never body text
    }
    if (part.body && part.body.data) {
      const decoded = fromB64u(part.body.data).toString('utf8');
      if (mime === 'text/plain') out.text += (out.text ? '\n' : '') + decoded;
      else if (mime === 'text/html') out.html += decoded;
      else if (!mime.startsWith('multipart/') && !out.text && !out.html) out.text += decoded;
      seen.push(mime);
    }
    for (const child of part.parts || []) walk(child, depth + 1);
  };
  walk(message && message.payload);

  if (!out.text && out.html) out.text = htmlToText(out.html);
  out.mimeTypes = seen;
  return out;
}

/**
 * HTML to readable text, for mail that carries no plain part.
 *
 * Not a general converter — the job is a readable preview and a searchable body, so block elements
 * become line breaks and everything else is dropped. Script and style content is removed rather
 * than stripped of tags, or their contents end up in the message text.
 */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, ' - ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Every address in a header, lowercased. "A <a@b.com>, c@d.com" → ['a@b.com', 'c@d.com'] */
export function addresses(value) {
  const out = [];
  for (const m of String(value || '').matchAll(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g)) {
    const a = m[0].toLowerCase();
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** The display name from "Maria Olsen <maria@example.com>", or null. */
export function displayName(value) {
  const s = String(value || '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  const name = m && m[1] ? m[1].trim() : '';
  return name || null;
}

/**
 * Flatten a Gmail message into the shape the platform stores.
 *
 * `internalDate` is used for the timestamp rather than the Date header, deliberately: Date is
 * written by the sender's machine and is wrong often enough to matter — badly set clocks, and
 * spam with a deliberately future date so it pins to the top of a mailbox sorted by date.
 */
export function normaliseMessage(message) {
  const body = extractBody(message);
  const from = header(message, 'From') || '';
  return {
    id: message.id,
    threadId: message.threadId,
    historyId: message.historyId || null,
    messageId: header(message, 'Message-ID'),
    inReplyTo: header(message, 'In-Reply-To'),
    references: header(message, 'References'),
    subject: header(message, 'Subject') || '(no subject)',
    from: (addresses(from)[0]) || null,
    fromName: displayName(from),
    to: addresses(header(message, 'To')),
    cc: addresses(header(message, 'Cc')),
    replyTo: addresses(header(message, 'Reply-To'))[0] || null,
    date: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    snippet: message.snippet || '',
    labels: message.labelIds || [],
    unread: (message.labelIds || []).includes('UNREAD'),
    // A message we sent appears in the mailbox too. Without this every outbound reply would be
    // ingested as if the customer had written it.
    outbound: (message.labelIds || []).includes('SENT'),
    text: body.text,
    html: body.html,
    attachments: body.attachments
  };
}

// ---- composing ------------------------------------------------------------------------------------

/**
 * RFC 2047 encoded-word, for header values outside ASCII.
 *
 * A subject containing an accented name is not exotic — "Café" in a subject line sent raw produces
 * mojibake in the recipient's client, or a rejected message. Only encoded when needed, because an
 * encoded-word where plain ASCII would do makes headers unreadable in logs.
 */
export function encodeHeader(value) {
  const s = String(value == null ? '' : value);
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\x7F]/.test(s)) return s.replace(/[\r\n]+/g, ' ');
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * Build an RFC 5322 message.
 *
 * THE THING THAT IS EASY TO GET WRONG: threading. Passing `threadId` to the Gmail send API threads
 * the message in OUR mailbox and does nothing at all for the recipient — their client threads on
 * the In-Reply-To and References headers. Send a reply with only threadId and, from the customer's
 * side, every reply arrives as a new unrelated message. Both mechanisms are needed, and they are
 * independent.
 *
 * References accumulates the whole ancestry, trimmed from the middle when long: RFC 5322 says to
 * keep the first and the most recent, because the first identifies the thread root and the recent
 * ones are what clients actually match against.
 */
export function buildRawMessage({ from, fromName, to, cc, subject, text, html, inReplyTo, references, headers = {} }) {
  const toList = Array.isArray(to) ? to : [to];
  if (!toList.filter(Boolean).length) throw new Error('A message needs at least one recipient');
  if (!from) throw new Error('A message needs a From address');

  const lines = [];
  lines.push(`From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`);
  lines.push(`To: ${toList.filter(Boolean).join(', ')}`);
  if (cc && cc.length) lines.push(`Cc: ${(Array.isArray(cc) ? cc : [cc]).filter(Boolean).join(', ')}`);
  lines.push(`Subject: ${encodeHeader(subject || '')}`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  lines.push('MIME-Version: 1.0');

  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    const chain = buildReferences(references, inReplyTo);
    if (chain) lines.push(`References: ${chain}`);
  }
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${encodeHeader(v)}`);

  if (html) {
    const boundary = `b_${createHash('sha256').update(String(Date.now()) + subject).digest('hex').slice(0, 24)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '');
    lines.push(`--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(text || htmlToText(html), 'utf8').toString('base64')));
    lines.push(`--${boundary}`, 'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', wrap76(Buffer.from(html, 'utf8').toString('base64')));
    lines.push(`--${boundary}--`);
  } else {
    // base64, not 8bit: a body line over 998 characters is illegal in SMTP, and a pasted log or a
    // long URL crosses that without anyone noticing until a server rejects the message.
    lines.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '');
    lines.push(wrap76(Buffer.from(text || '', 'utf8').toString('base64')));
  }
  return lines.join('\r\n');
}

const wrap76 = (s) => String(s).replace(/(.{76})/g, '$1\r\n').trim();

/** Append a Message-ID to a References chain, keeping it within sane length. */
export function buildReferences(existing, add) {
  const ids = String(existing || '').split(/\s+/).filter(Boolean);
  if (add && !ids.includes(add)) ids.push(add);
  if (ids.length <= 12) return ids.join(' ');
  return [ids[0], ...ids.slice(-10)].join(' ');       // the root, plus the recent ancestry
}

/** "Re:" exactly once, however many the other client added. */
export function replySubject(subject) {
  const s = String(subject || '').trim();
  return /^re:\s*/i.test(s) ? s.replace(/^(re:\s*)+/i, 'Re: ') : `Re: ${s}`;
}

/**
 * Who a reply should go to.
 *
 * Reply-To wins over From when present — that is what it is for, and a ticketing system on the
 * other end depends on it. Our own addresses are removed from Cc so a reply never loops back into
 * the mailbox it came from, which otherwise produces a conversation talking to itself.
 */
export function replyRecipients(message, ourAddresses = []) {
  const ours = new Set(ourAddresses.map(a => String(a).toLowerCase()));
  const to = message.replyTo ? [message.replyTo] : (message.from ? [message.from] : []);
  const cc = [...(message.cc || []), ...(message.to || [])]
    .filter(a => !ours.has(a) && !to.includes(a));
  return { to, cc: [...new Set(cc)] };
}

// ---- the client -----------------------------------------------------------------------------------

/**
 * `tokenSource` comes from lib/googleauth.js; `mailbox` is the address being impersonated.
 *
 * A 401 mid-sync means the cached token expired against a clock we do not control, so it is retried
 * exactly once with a fresh token. Retrying more would turn a genuine authorisation failure into a
 * loop that looks like a hang.
 */
export function createGmailClient({ tokenSource, mailbox, scopes, fetchImpl = fetch }) {
  const base = `${API}/users/${encodeURIComponent(mailbox)}`;

  async function call(path, { method = 'GET', body = null, query = null, retried = false } = {}) {
    const url = new URL(base + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);

    const token = await tokenSource.token(mailbox, scopes);
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (cause) {
      // Same distinction as in the token source: unreachable is not refused.
      const e = new Error(`Could not reach the Gmail API (${cause && cause.message ? cause.message : 'network error'}). The credential may be fine — the server needs outbound HTTPS to gmail.googleapis.com. Check egress rules, proxy settings and DNS.`);
      e.status = 0; e.networkError = true; e.cause = cause;
      throw e;
    }

    if (res.status === 401 && !retried) {
      tokenSource.invalidate(mailbox);
      return call(path, { method, body, query, retried: true });
    }
    let json = null;
    try { json = await res.json(); } catch {}
    if (!res.ok) {
      const e = new Error(explainApiError(res.status, json, mailbox));
      e.status = res.status; e.body = json;
      throw e;
    }
    return json;
  }

  return {
    mailbox,
    /** Confirms the mailbox is reachable and reports what Google says it is. */
    profile: () => call('/profile'),
    /**
     * The addresses this account is allowed to put in a From header.
     *
     * Worth asking Google rather than assuming. Impersonating support@geekfiwifi.com does not by
     * itself permit sending as support@geekitek.com — that depends on whether the second address is
     * a domain alias, a verified send-as, or neither. Gmail's failure mode when it is not permitted
     * is to silently REWRITE the From to the account's own address, so the mail goes out under the
     * wrong identity and nothing reports an error.
     */
    sendAs: () => call('/settings/sendAs'),
    listMessages: (q, pageToken, maxResults = 50) =>
      call('/messages', { query: { q, pageToken, maxResults } }),
    getMessage: (id, format = 'full') => call(`/messages/${encodeURIComponent(id)}`, { query: { format } }),
    getThread: (id) => call(`/threads/${encodeURIComponent(id)}`, { query: { format: 'full' } }),
    history: (startHistoryId, pageToken) =>
      call('/history', { query: { startHistoryId, pageToken, historyTypes: 'messageAdded' } }),
    send: ({ raw, threadId }) =>
      call('/messages/send', { method: 'POST', body: { raw: toB64u(raw), ...(threadId ? { threadId } : {}) } }),
    modify: (id, { add = [], remove = [] }) =>
      call(`/messages/${encodeURIComponent(id)}/modify`, { method: 'POST', body: { addLabelIds: add, removeLabelIds: remove } }),
    attachment: (messageId, attachmentId) =>
      call(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`),
    call
  };
}

/** Gmail's API errors, in terms of what to do about them. */
export function explainApiError(status, body, mailbox) {
  const reason = body && body.error && (body.error.message || body.error.status) || '';
  const r = String(reason).toLowerCase();

  if (status === 403 && r.includes('insufficient')) {
    return `Missing scope for ${mailbox}. A super admin must add the exact scope string to the delegation entry in Admin Console — adding it in the platform alone does nothing.`;
  }
  if (status === 403 && (r.includes('not been used') || r.includes('disabled'))) {
    return 'The Gmail API is not enabled on the Google Cloud project. APIs & Services → Library → Gmail API → Enable.';
  }
  if (status === 404 && r.includes('not found')) {
    return `Gmail returned "not found" for ${mailbox}. The message may have been deleted, or the mailbox address may be wrong.`;
  }
  if (status === 400 && r.includes('failedprecondition')) {
    return `${mailbox} has no Gmail mailbox. This is what a Google Group looks like to the API — delegation can only reach real user accounts.`;
  }
  if (status === 429 || (status === 403 && r.includes('rate'))) {
    return 'Gmail is rate-limiting this account. The sync will back off and retry; no messages are lost.';
  }
  return `Gmail returned ${status}${reason ? `: ${reason}` : ''}`;
}

/**
 * Incremental sync.
 *
 * Gmail hands out a historyId per mailbox; asking for everything since a stored one returns just
 * the changes. This is the difference between a sync that stays fast on a mailbox with 40,000
 * messages and one that re-lists the inbox every minute.
 *
 * The catch, and the reason for the fallback: Google expires history older than about a week, and
 * returns 404 for a historyId that has aged out. Treating that as an error would leave a mailbox
 * that was offline for a fortnight permanently stuck. It means "resynchronise", and the caller is
 * told so explicitly rather than having to infer it from a status code.
 */
export async function syncSince(client, startHistoryId) {
  if (!startHistoryId) return { full: true, reason: 'no previous sync point', messageIds: [], historyId: null };

  const ids = new Set();
  let pageToken, latest = startHistoryId;
  try {
    do {
      const page = await client.history(startHistoryId, pageToken);
      for (const h of page.history || []) {
        for (const added of h.messagesAdded || []) if (added.message) ids.add(added.message.id);
      }
      if (page.historyId) latest = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);
  } catch (e) {
    if (e.status === 404) {
      return { full: true, reason: 'the last sync point has aged out of Gmail history (it keeps about a week), so a full pass is needed', messageIds: [], historyId: null };
    }
    throw e;
  }
  return { full: false, reason: null, messageIds: [...ids], historyId: latest };
}
