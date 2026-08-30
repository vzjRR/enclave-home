'use strict';

const crypto = require('crypto');
const net = require('net');

/* ---------------------------------------------------------------
   Admin authentication.

   Ported verbatim from the store repo (vzjRR/enclave-rp-store) apart from
   the cookie name below. It had no coupling to the store's catalogue --
   only `crypto` and `net` -- so the sessions, CSRF tokens, per-IP lockout,
   global rate pressure, TOTP break-glass and trusted-proxy handling all
   carry over unchanged. Keep the two copies in step.

   The credential never leaves the server: the client posts a candidate (a
   Discord session, or the owner's TOTP code as a break-glass route), gets
   an opaque session cookie back, and every write is gated on that cookie.

   Sessions live in memory. This app writes to a single local volume,
   so it is single-instance by construction and an in-memory store is
   consistent with that. Restarting logs admins out, which is fine.
--------------------------------------------------------------- */

// Distinct from the store's 'enclave_session'. Both are host-only cookies on
// different subdomains so they could not collide anyway, but a shared name
// across two services invites someone to assume the sessions interoperate.
const SESSION_COOKIE = 'enclave_home_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;      // 8 hours
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;              // 15 minutes

// token -> { expiresAt, csrfToken }
const sessions = new Map();
const failedAttempts = new Map();                // ip -> { count, until }

/**
 * Failures across ALL client addresses, in a rolling window.
 *
 * The per-IP lockout above is only as good as the identity it counts
 * against, and a client address is an attacker-influenced value in almost
 * every proxied deployment. This second counter is not: whatever address a
 * request claims, it still lands here. It cannot be evaded by rotating
 * anything, because it does not look at the client at all.
 */
const GLOBAL_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_HARD_LIMIT = 200;                   // unambiguously an attack
const GLOBAL_HARD_PAUSE_MS = 5 * 60 * 1000;
const GLOBAL_DELAY_STEP_MS = 40;
const GLOBAL_DELAY_CAP_MS = 2000;

let globalFailures = [];                         // timestamps
let globalPausedUntil = 0;

let adminTotpSecret = null;    // raw key bytes, kept in memory only
let lastUsedTotpCounter = -1;  // guards against replaying an accepted code

/* ------------------------------ TOTP ------------------------------ */
//
// RFC 6238 (TOTP) over RFC 4226 (HOTP), hand-rolled rather than pulling in
// a dependency — this app ships with none, deliberately. It's ~60 lines on
// top of Node's own HMAC and needs nothing else: a 6-digit code from any
// authenticator app (Google Authenticator, Aegis, 1Password, ...), refused
// for everyone but the owner, so a broken Discord application does not
// lock them out of their own store with no way back short of SSH.

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // tolerate ±1 step (±30s) of clock drift
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buffer) {
    let bits = 0, value = 0, output = '';
    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    return output;
}

function base32Decode(str) {
    const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0, value = 0;
    const bytes = [];
    for (const char of clean) {
        const idx = BASE32_ALPHABET.indexOf(char);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

/** HOTP (RFC 4226): an HMAC-SHA1 over a counter, dynamically truncated to digits. */
function hotp(secret, counter) {
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigUInt64BE(BigInt(counter));
    const hmac = crypto.createHmac('sha1', secret).update(counterBuffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return String(code % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

function totpCounter(stepOffset = 0) {
    return Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS) + stepOffset;
}

/**
 * Resolve the admin TOTP secret at boot. If ADMIN_TOTP_SECRET is unset we
 * mint a random one and print it (base32, ready to type into an
 * authenticator app), so a fresh deploy is never protected by a secret
 * that is public knowledge.
 */
function initAdminTotp(rawFromEnv) {
    let raw = (rawFromEnv || '').trim();
    let generated = false;
    let secret = raw ? base32Decode(raw) : Buffer.alloc(0);

    if (!raw || secret.length < 10) {
        secret = crypto.randomBytes(20); // 160 bits — the usual TOTP secret size
        raw = base32Encode(secret);
        generated = true;
    }

    adminTotpSecret = secret;
    lastUsedTotpCounter = -1;

    if (generated) {
        console.warn(
            '\n  ADMIN_TOTP_SECRET is not set.\n' +
            `  Temporary TOTP secret for this boot: ${raw}\n` +
            '  Add it to an authenticator app as a manual/setup-key entry.\n' +
            '  Set ADMIN_TOTP_SECRET in the service environment to make it stick.\n'
        );
    }
    // The plaintext secret is returned only when this process generated it,
    // so the caller can deliver it once. A secret supplied through the
    // environment is never echoed back: whoever set it already has it, and
    // re-transmitting it on every restart is exposure with no benefit.
    return { generated, secret: generated ? raw : null };
}

/**
 * Constant-time TOTP check, tolerant of ±1 step of clock drift.
 *
 * A code that verifies is retired: `lastUsedTotpCounter` blocks it (and
 * anything at or before its step) from being accepted again, so a code
 * observed in transit is a single-use credential rather than a 30-second
 * window of replay.
 */
function verifyTotp(candidate) {
    if (!adminTotpSecret) return false;
    const code = String(candidate ?? '').trim();
    if (!/^\d{6}$/.test(code)) return false;

    const given = Buffer.from(code);
    const counter = totpCounter();
    let matchedCounter = null;

    for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
        const stepCounter = counter + offset;
        const expected = Buffer.from(hotp(adminTotpSecret, stepCounter));
        if (expected.length === given.length &&
            crypto.timingSafeEqual(expected, given) &&
            stepCounter > lastUsedTotpCounter) {
            matchedCounter = stepCounter;
        }
    }

    if (matchedCounter === null) return false;
    lastUsedTotpCounter = matchedCounter;
    return true;
}

/* --------------------------- rate limiting --------------------------- */

function isLockedOut(ip) {
    const record = failedAttempts.get(ip);
    if (!record) return false;
    if (Date.now() > record.until) {
        failedAttempts.delete(ip);
        return false;
    }
    return record.count >= MAX_FAILED_ATTEMPTS;
}

function pruneGlobal(now) {
    const cutoff = now - GLOBAL_WINDOW_MS;
    if (globalFailures.length && globalFailures[0] <= cutoff) {
        globalFailures = globalFailures.filter(t => t > cutoff);
    }
}

/**
 * Whether login is paused for everyone, and how long to stall a request
 * that is allowed through.
 *
 * The graduated delay is deliberate. A hard global lockout would hand any
 * passer-by the ability to lock the owner out of their own console by
 * failing a few hundred logins; a delay that grows with recent failures
 * caps an attacker's guess rate without ever fully denying service. The
 * hard pause only engages far past the point where the traffic could still
 * be somebody mistyping.
 */
function globalPressure() {
    const now = Date.now();
    if (now < globalPausedUntil) {
        return { paused: true, delayMs: 0 };
    }
    pruneGlobal(now);
    return {
        paused: false,
        delayMs: Math.min(GLOBAL_DELAY_CAP_MS, globalFailures.length * GLOBAL_DELAY_STEP_MS)
    };
}

function recordFailure(ip) {
    const record = failedAttempts.get(ip) || { count: 0, until: 0 };
    record.count += 1;
    record.until = Date.now() + LOCKOUT_MS;
    failedAttempts.set(ip, record);

    const now = Date.now();
    globalFailures.push(now);
    pruneGlobal(now);
    if (globalFailures.length >= GLOBAL_HARD_LIMIT) {
        globalPausedUntil = now + GLOBAL_HARD_PAUSE_MS;
        globalFailures = [];
        console.error(
            `Admin login paused for ${GLOBAL_HARD_PAUSE_MS / 60000} minutes: ` +
            `${GLOBAL_HARD_LIMIT} failed attempts across all addresses within ` +
            `${GLOBAL_WINDOW_MS / 60000} minutes. This is a distributed guessing attempt.`
        );
    }
}

function clearFailures(ip) {
    failedAttempts.delete(ip);
}

/* ----------------------------- sessions ----------------------------- */

function createSession() {
    const token = crypto.randomBytes(32).toString('base64url');
    // Bound to this session and handed to the client in the response body,
    // never in a cookie — that is the whole point: a cross-site request can
    // ride the cookie but cannot read the body that carried this.
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS, csrfToken });
    return { token, csrfToken };
}

function destroySession(token) {
    if (token) sessions.delete(token);
}

function getSession(token) {
    if (!token) return null;
    const record = sessions.get(token);
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
        sessions.delete(token);
        return null;
    }
    return record;
}

function isValidSession(token) {
    return getSession(token) !== null;
}

/** Compare a submitted CSRF token against the session's, in constant time. */
function csrfMatches(sessionToken, candidate) {
    const record = getSession(sessionToken);
    if (!record) return false;
    const expected = Buffer.from(record.csrfToken, 'utf8');
    const given = Buffer.from(String(candidate ?? ''), 'utf8');
    if (expected.length !== given.length) return false;
    return crypto.timingSafeEqual(given, expected);
}

/** Drop expired sessions and stale lockouts so neither map grows without bound. */
function sweep() {
    const now = Date.now();
    for (const [token, record] of sessions) {
        if (now > record.expiresAt) sessions.delete(token);
    }
    for (const [ip, record] of failedAttempts) {
        if (now > record.until) failedAttempts.delete(ip);
    }
    pruneGlobal(now);
}

/* ------------------------------ client IP ------------------------------ */

/**
 * Which TCP peers are allowed to speak for someone else.
 *
 * A forwarded header is a claim, and a claim is only worth the connection
 * it arrived on. Trusting one from an arbitrary peer is what let a rotating
 * CF-Connecting-IP walk past the login lockout: the app took the header at
 * face value from whoever opened the socket.
 *
 * The default set is the local machine and RFC1918 space, which covers the
 * normal arrangement (Caddy on 127.0.0.1) and a container network, and
 * covers nothing that a stranger on the internet can connect from.
 * TRUSTED_PROXY_CIDRS overrides it for anything more exotic.
 *
 * NOTE: this makes TRUST_PROXY safe to leave on, but it is not by itself a
 * complete answer when the proxy is the thing forwarding the forged value.
 * The edge has to refuse non-Cloudflare traffic as well — see the
 * cloudflare_only block in deploy/Caddyfile, which is enabled by default.
 */
const DEFAULT_TRUSTED_CIDRS = [
    '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
    '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'
];

function buildTrustList(spec) {
    const list = new net.BlockList();
    const entries = String(spec || '').trim()
        ? String(spec).split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULT_TRUSTED_CIDRS;

    for (const entry of entries) {
        const [address, bits] = entry.split('/');
        const type = net.isIPv6(address) ? 'ipv6' : 'ipv4';
        if (!net.isIP(address)) {
            console.warn(`TRUSTED_PROXY_CIDRS: ignoring unparseable entry "${entry}"`);
            continue;
        }
        try {
            if (bits === undefined) list.addAddress(address, type);
            else list.addSubnet(address, Number(bits), type);
        } catch (error) {
            console.warn(`TRUSTED_PROXY_CIDRS: ignoring "${entry}" — ${error.message}`);
        }
    }
    return list;
}

const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
const trustedProxies = buildTrustList(process.env.TRUSTED_PROXY_CIDRS);

/** Node reports IPv4 peers as ::ffff:a.b.c.d when the socket is dual-stack. */
function normalizeAddress(address) {
    if (!address) return '';
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    return mapped ? mapped[1] : address;
}

function isTrustedPeer(address) {
    const normalized = normalizeAddress(address);
    if (!net.isIP(normalized)) return false;
    return trustedProxies.check(normalized, net.isIPv6(normalized) ? 'ipv6' : 'ipv4');
}

function clientIp(req) {
    const direct = normalizeAddress(req.socket.remoteAddress) || 'unknown';
    if (!TRUST_PROXY || !isTrustedPeer(direct)) return direct;

    // Cloudflare sets this itself and strips any client-supplied copy, so it
    // is the most trustworthy value available — provided the origin cannot be
    // reached except through Cloudflare.
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && net.isIP(cf.trim())) return cf.trim();

    // Otherwise take the last hop, not the first. The leftmost entry is the
    // part a client can forge; the rightmost was appended by our own proxy.
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
        const hops = forwarded.split(',').map(h => h.trim()).filter(h => net.isIP(h));
        if (hops.length) return hops[hops.length - 1];
    }

    return direct;
}

module.exports = {
    SESSION_COOKIE,
    SESSION_TTL_MS,
    MAX_FAILED_ATTEMPTS,
    initAdminTotp,
    verifyTotp,
    isLockedOut,
    globalPressure,
    recordFailure,
    clearFailures,
    createSession,
    destroySession,
    getSession,
    isValidSession,
    csrfMatches,
    sweep,
    clientIp,
    isTrustedPeer
};
