// Google service-account authentication: a self-signed JWT exchanged for an access token.
//
// This is the whole of OAuth for a server that owns its own credential. There is no browser, no
// consent screen and no refresh token. The server builds a short-lived assertion, signs it with the
// service account's private key, and Google returns an access token for the mailbox it asked to
// impersonate.
//
// Written against node:crypto rather than googleapis. The flow is one signature and one POST; the
// library that wraps it is 50 MB of transitive dependencies, and this is a credential path where
// being able to read every line matters more than usual.
//
// WHAT DOMAIN-WIDE DELEGATION ACTUALLY IS, since the name obscures it: the `sub` claim below names
// a user to act as. Google checks that a super admin has authorised this service account's client
// ID for the requested scopes in the Admin Console, and if so issues a token for that user. The
// authority lives in the Workspace admin settings, not in the key — which is why revoking there is
// instant and complete.
import { createSign, createHash } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** base64url, which JWT uses and Buffer does not produce by default in older Node. */
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Validate a service-account JSON key and explain what is wrong in terms of what the person did.
 *
 * Pasting the wrong file is the single most common setup mistake: an OAuth *client* JSON looks
 * superficially similar and is the thing you get if you click the wrong button in the same screen.
 * "Missing private_key" would leave someone re-pasting the same wrong file; naming the confusion
 * does not.
 */
export function parseServiceAccount(json) {
  let key;
  if (typeof json === 'string') {
    try { key = JSON.parse(json); }
    catch { return { ok: false, error: 'That is not valid JSON. Paste the entire contents of the downloaded key file, including the outermost { }.' }; }
  } else key = json;

  if (!key || typeof key !== 'object') return { ok: false, error: 'Expected a JSON object.' };

  if (key.type === 'authorized_user' || key.installed || key.web) {
    return { ok: false, error: 'This is an OAuth client file, not a service account key. In Google Cloud go to Credentials, open the service account itself, then Keys → Add key → JSON.' };
  }
  if (key.type && key.type !== 'service_account') {
    return { ok: false, error: `This key says it is a "${key.type}". A service account key is needed.` };
  }
  for (const field of ['client_email', 'private_key']) {
    if (!key[field]) return { ok: false, error: `The key is missing "${field}". Re-download it from Google Cloud → the service account → Keys → Add key → JSON.` };
  }
  if (!/BEGIN (RSA )?PRIVATE KEY/.test(key.private_key)) {
    return { ok: false, error: 'The private_key field does not contain a PEM key. If the JSON was pasted through something that stripped newlines, re-copy it from the original file.' };
  }
  return {
    ok: true,
    key: {
      client_email: key.client_email,
      private_key: key.private_key,
      client_id: key.client_id || null,
      project_id: key.project_id || null,
      token_uri: key.token_uri || TOKEN_URL
    }
  };
}

/**
 * Build and sign the assertion.
 *
 * `iat` is backdated by a few seconds deliberately. Google rejects an assertion issued in the
 * future, and a server clock a second or two fast against Google's produces an intermittent
 * "Invalid JWT" that looks like a credential problem and is not.
 */
export function buildAssertion({ key, subject, scopes, now = Date.now(), lifetimeSeconds = 3600 }) {
  if (!subject) throw new Error('A mailbox to impersonate is required (the `sub` claim)');
  const iat = Math.floor(now / 1000) - 5;
  const claims = {
    iss: key.client_email,
    sub: subject,
    scope: Array.isArray(scopes) ? scopes.join(' ') : String(scopes),
    aud: key.token_uri || TOKEN_URL,
    iat,
    exp: iat + Math.min(3600, lifetimeSeconds)      // Google caps this at one hour
  };
  const signingInput = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(key.private_key);
  return { assertion: `${signingInput}.${b64u(signature)}`, claims };
}

/**
 * Turn Google's OAuth errors into something actionable.
 *
 * Every one of these is a real setup mistake with a specific fix, and Google's own wording points
 * at none of them. Guessing from `unauthorized_client` costs an afternoon.
 */
export function explainTokenError(status, body) {
  const err = (body && (body.error || body.error_description)) || '';
  const desc = (body && body.error_description) || '';
  const both = `${err} ${desc}`.toLowerCase();

  if (both.includes('unauthorized_client')) {
    return 'Google refused the service account for this mailbox. Either the Client ID in Admin Console → Security → API controls → Manage domain-wide delegation does not match this key, or the scopes there do not cover what was asked for, or delegation has not propagated yet. If you have just set it up, wait five minutes and try again before changing anything.';
  }
  if (both.includes('invalid_grant') && both.includes('account not found')) {
    return 'Google does not recognise that address as a user account. Three things cause this, in rough order of likelihood. (1) It is an ALIAS, not the account\'s primary address — delegation only accepts the primary, so a user who signs in as support@yourdomain.com but also receives at support@otherdomain.com must be impersonated by the sign-in address. (2) It is a Google Group, which has no Gmail mailbox for the API to act as. (3) The address is simply misspelled. Check Admin Console → Directory → Users: the address shown in the "Email" column of the user\'s own row is the one to use.';
  }
  if (both.includes('invalid_grant')) {
    return 'Google rejected the signed assertion. The usual cause is the server clock being out of step — the assertion is time-signed and a skew of more than a few minutes is refused. Check the system time. It can also mean the mailbox address is wrong.';
  }
  if (both.includes('invalid_scope')) {
    return 'One of the requested scopes is not authorised in Admin Console. The scope list there is exact: adding a scope in the platform does nothing until a super admin adds the identical string to the delegation entry.';
  }
  if (both.includes('invalid_client')) {
    return 'The service account itself was not recognised. The key may have been deleted in Google Cloud, or the whole service account removed.';
  }
  if (status === 403) return 'Google returned 403. The Gmail API may not be enabled on the Cloud project — APIs & Services → Library → Gmail API → Enable.';
  return `Google returned ${status}${err ? `: ${err}` : ''}${desc ? ` — ${desc}` : ''}`;
}

/**
 * An access-token source with a cache, one entry per (mailbox, scope set).
 *
 * Caching is not an optimisation here. A sync pass makes many calls, and minting a token per call
 * would mean an RSA signature and a network round trip each time, plus running into Google's token
 * endpoint rate limits. Tokens are valid for an hour and are renewed a minute early so a long
 * request cannot start with 3 seconds of validity left and fail halfway.
 */
export function createTokenSource({ key, fetchImpl = fetch, now = () => Date.now() }) {
  const cache = new Map();
  const cacheKey = (subject, scopes) =>
    `${subject}|${createHash('sha256').update([...scopes].sort().join(' ')).digest('hex').slice(0, 16)}`;

  async function token(subject, scopes) {
    const ck = cacheKey(subject, scopes);
    const hit = cache.get(ck);
    if (hit && hit.expiresAt > now() + 60_000) return hit.accessToken;

    const { assertion } = buildAssertion({ key, subject, scopes, now: now() });
    let res;
    try {
      res = await fetchImpl(key.token_uri || TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: JWT_BEARER, assertion }).toString()
      });
    } catch (cause) {
      // Not reaching Google at all is a different problem from Google refusing, and pointing
      // someone at their Admin Console when the real fault is egress firewalling or DNS wastes an
      // afternoon on the wrong thing. Node's own message here is "fetch failed", which says nothing.
      const e = new Error(`Could not reach Google to get an access token (${cause && cause.message ? cause.message : 'network error'}). This is a connectivity problem, not a credential one: the server needs outbound HTTPS to oauth2.googleapis.com and gmail.googleapis.com. Check egress firewall rules, any proxy, and DNS.`);
      e.status = 0;
      e.networkError = true;
      e.cause = cause;
      throw e;
    }

    let body = null;
    try { body = await res.json(); } catch { /* an HTML error page, handled below */ }
    if (!res.ok || !body || !body.access_token) {
      const e = new Error(explainTokenError(res.status, body));
      e.status = res.status;
      e.googleError = body && body.error;
      throw e;
    }
    cache.set(ck, {
      accessToken: body.access_token,
      expiresAt: now() + (Number(body.expires_in) || 3600) * 1000
    });
    return body.access_token;
  }

  return {
    token,
    /** Drop cached tokens — after a credential change, or when a call returns 401. */
    invalidate(subject = null) {
      if (!subject) return cache.clear();
      for (const k of [...cache.keys()]) if (k.startsWith(subject + '|')) cache.delete(k);
    },
    get size() { return cache.size; }
  };
}

/** The scopes this platform asks for, and why. Kept here so the docs and the code cannot diverge. */
export const SCOPES = {
  read: 'https://www.googleapis.com/auth/gmail.readonly',
  send: 'https://www.googleapis.com/auth/gmail.send',
  // modify, NOT full: `gmail.full` grants permanent deletion, which this platform never needs and
  // therefore should not be able to do even by accident.
  modify: 'https://www.googleapis.com/auth/gmail.modify'
};

export const ALL_SCOPES = [SCOPES.read, SCOPES.send, SCOPES.modify];
