'use strict';

/* ---------------------------------------------------------------
   HTTP helpers — request parsing, responses, cookies.
   No dependencies: everything here is Node stdlib only.

   Ported from the store repo (vzjRR/enclave-rp-store) so both services
   answer with the same headers and cookie semantics. The differences are
   noted where they occur; keep the two in step when either changes.
--------------------------------------------------------------- */

// The store allows 8 MB because order bodies carry a base64 receipt photo.
// Nothing here does: the largest body is a news post with an optional cover
// image pasted as a data URI, so the ceiling comes down accordingly.
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Content-Security-Policy.
 *
 * Same policy as the store, and the clause that matters is the same one:
 * `script-src 'self'` with no 'unsafe-inline' and no CDN, so an injected
 * <script> or event-handler attribute does not run.
 *
 * This service has no inline script at all — the current landing page's
 * countdown ran from an inline <script>, which this policy would block, so
 * every page here loads its JavaScript from js/ instead.
 *
 * Where each relaxation comes from:
 *
 *   style-src 'unsafe-inline'   pages carry inline style attributes, and the
 *                               vendored stylesheet is served from 'self'.
 *   img-src data: https:        product images come from the store's own
 *                               catalogue on hosts we do not control, and
 *                               news covers may be pasted as data: URIs.
 *   fonts.googleapis/gstatic    the one third-party origin the pages load.
 *
 * connect-src stays 'self': every upstream (Cfx.re, Discord, the store) is
 * proxied through this service's own API, so the browser never talks to a
 * third party directly.
 */
const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests'
].join('; ');

const SECURITY_HEADERS = {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin'
};

/**
 * Read and JSON-parse a request body, refusing anything oversized.
 * Counts bytes (not UTF-16 string length) so multi-byte input can't slip past.
 */
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;

        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                const err = new Error('حجم الطلب كبير جداً');
                err.statusCode = 413;
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => {
            if (size === 0) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
                const err = new Error('صيغة الطلب غير صحيحة');
                err.statusCode = 400;
                reject(err);
            }
        });

        req.on('error', reject);
    });
}

function sendJson(res, status, payload, { cacheSeconds = 0 } = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        // Public read-only endpoints say how long a shared cache may hold
        // them, so Cloudflare absorbs repeat traffic instead of every
        // visitor reaching this process. Anything authenticated passes 0.
        'Cache-Control': cacheSeconds > 0
            ? `public, max-age=${cacheSeconds}`
            : 'no-store'
    });
    res.end(body);
}

function sendError(res, status, message) {
    sendJson(res, status, { error: message });
}

function parseCookies(req) {
    const header = req.headers.cookie;
    if (!header) return {};
    const out = {};
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        const name = part.slice(0, eq).trim();
        if (!name) continue;
        out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    }
    return out;
}

/**
 * Build a Set-Cookie value. `Secure` is omitted on plain-HTTP localhost so the
 * admin panel still works in local development.
 *
 * `sameSite` defaults to Lax rather than Strict, and that is deliberate.
 *
 * Sign-in returns from discord.com, which is a cross-site top-level
 * navigation — and browsers do not send a Strict cookie on one of those.
 * With Strict the OAuth state cookie is simply absent when the callback
 * arrives, so every sign-in fails the state check.
 *
 * Lax is sent on top-level GET navigations and withheld from every
 * cross-site POST/PUT/PATCH/DELETE, which is the case CSRF cares about.
 * The admin CSRF defence does not rest on the cookie attribute anyway: a
 * session-bound token in `X-CSRF-Token` and an Origin check both have to
 * pass independently.
 */
function buildCookie(name, value, { maxAge, secure, sameSite = 'Lax' }) {
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        `SameSite=${sameSite}`,
        `Max-Age=${maxAge}`
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

module.exports = {
    MAX_BODY_BYTES,
    CSP,
    SECURITY_HEADERS,
    readJsonBody,
    sendJson,
    sendError,
    parseCookies,
    buildCookie
};
