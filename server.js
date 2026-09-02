'use strict';

/* ---------------------------------------------------------------
   Enclave RP — enclaverp.cc

   The public homepage, the news archive, and the admin console that writes
   the news. Node stdlib only, no runtime dependencies, matching the store
   repo it shares an identity and a box with.

   This runs as its own service on its own port. The store is a separate
   process: neither can take the other down, which is the property
   deploy/setup.sh was already protecting when it served this domain as a
   static file. What replaces that guarantee here is the shape of the
   pages — index.html is complete HTML that renders with no JavaScript and
   no API, and every live section degrades to a designed fallback. A dead
   upstream costs one panel, never the page.
--------------------------------------------------------------- */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const path = require('path');

const auth = require('./lib/auth');
const discordStats = require('./lib/discordStats');
const fivem = require('./lib/fivem');
const restartSchedule = require('./lib/restartSchedule');
const storeFeed = require('./lib/storeFeed');
const { News } = require('./lib/news');
const { Settings, DETAIL_FIELDS } = require('./lib/settings');
const discordNews = require('./lib/discordNews');
const discordWelcome = require('./lib/discordWelcome');
const { createOauth } = require('./lib/oauth');
const {
    SECURITY_HEADERS, readJsonBody, sendJson, sendError, parseCookies, buildCookie
} = require('./lib/http');

/* ------------------------------ config ------------------------------ */

const PORT = Number(process.env.PORT) || 3001;

/**
 * Loopback by default.
 *
 * Caddy reverse-proxies to 127.0.0.1:3001, so binding wider than that gains
 * nothing and costs a bypass: the Caddyfile refuses any peer that is not
 * Cloudflare, and that refusal is the only reason CF-Connecting-IP can be
 * believed. A process listening on the public interface can be reached
 * around Caddy entirely, at which point the header is whatever the caller
 * says it is -- the exact attack the store's Caddyfile documents.
 *
 * Overridable for a platform that routes to a container by address rather
 * than through a local proxy, where 0.0.0.0 is required.
 */
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = __dirname;

const DATA_DIR = process.env.DATA_DIR
    || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));

// Where the catalogue is fetched from. Infrastructure, not a link, so it
// stays in the environment — see lib/settings.js for the full split.
const STORE_API_BASE = process.env.STORE_API_BASE || 'https://store.enclaverp.cc';

const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || '';

/**
 * The four operational values below live in settings.json once the first
 * run has seeded them from the environment, so they can be changed from
 * /admin without shell access. Everything reads them through here rather
 * than caching a copy, or a change would need a restart to take.
 */
const settings = new Settings(DATA_DIR, {
    fivemJoinCode: process.env.FIVEM_JOIN_CODE || '',
    discordInviteCode: process.env.DISCORD_INVITE_CODE || '',
    storeUrl: process.env.STORE_URL || process.env.STORE_API_BASE || 'https://store.enclaverp.cc',
    publishPlayerList: process.env.FIVEM_PUBLISH_PLAYER_LIST === 'true',
    publishPlayerMap: process.env.FIVEM_PUBLISH_PLAYER_MAP === 'true',
    newsChannelIds: (process.env.DISCORD_NEWS_CHANNEL_IDS || '')
        .split(/[\s,]+/).filter(Boolean),
    welcomeChannelId: process.env.DISCORD_WELCOME_CHANNEL_ID || ''
});

const joinCode = () => settings.current().fivemJoinCode;
const inviteCode = () => settings.current().discordInviteCode;
const storeUrl = () => settings.current().storeUrl;
const inviteUrl = () => (inviteCode() ? `https://discord.gg/${inviteCode()}` : '');

const OWNER_DISCORD_ID = process.env.OWNER_DISCORD_ID || '';
const ADMIN_DISCORD_IDS = (process.env.ADMIN_DISCORD_IDS || '')
    .split(',').map(id => id.trim()).filter(Boolean);
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || '';

const USER_COOKIE = 'enclave_home_user';
const OAUTH_STATE_COOKIE = 'enclave_home_oauth_state';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Set at boot from the bytes of everything in js/ and css/, so it changes
 * exactly when a deploy changes an asset and not otherwise.
 */
let ASSET_VERSION = 'dev';

/**
 * Outcome of the most recent Discord news sync, surfaced in the admin
 * console. Without it a channel the bot cannot read fails silently on a
 * timer, and the only symptom is news that never arrives.
 */
let lastSync = null;
let syncInFlight = null;

const NEWS_SYNC_INTERVAL_MS = 5 * 60 * 1000;

async function runNewsSync() {
    const config = settings.current();
    if (!config.newsSyncEnabled) {
        lastSync = { ok: false, reason: 'disabled', channels: [], syncedAt: new Date().toISOString() };
        return lastSync;
    }
    // One at a time. The timer and a settings save can both ask for a sync,
    // and two concurrent runs would race to create the same drafts.
    if (syncInFlight) return syncInFlight;

    syncInFlight = discordNews.sync({
        token: DISCORD_BOT_TOKEN,
        channelIds: config.newsChannelIds,
        news
    }).then(result => {
        lastSync = result;
        return result;
    }).catch(error => {
        lastSync = {
            ok: false, reason: 'error', channels: [],
            syncedAt: new Date().toISOString()
        };
        console.error('[enclave-home] news sync failed', error);
        return lastSync;
    }).finally(() => { syncInFlight = null; });

    return syncInFlight;
}

const news = new News(DATA_DIR);

const oauth = createOauth({
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    botToken: DISCORD_BOT_TOKEN,
    guildId: DISCORD_GUILD_ID,
    publicBaseUrl: PUBLIC_BASE_URL,
    ownerId: OWNER_DISCORD_ID,
    adminIds: ADMIN_DISCORD_IDS
});

/* --------------------------- static files --------------------------- */

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8'
};

// Only these are web-reachable. Exposing the whole project directory would
// make /server.js and /data/news.json downloadable.
const SERVABLE_DIRS = ['css', 'js', 'assets'];

const PAGES = {
    '/': 'index.html',
    '/index.html': 'index.html',
    '/news': 'news.html',
    '/news.html': 'news.html',
    '/admin': 'admin.html',
    '/admin.html': 'admin.html'
};

function resolveStatic(urlPath) {
    let pathname;
    try {
        pathname = decodeURIComponent(urlPath.split('?')[0]);
    } catch {
        return null;
    }

    const trimmed = pathname.replace(/\/+$/, '') || '/';
    const page = PAGES[trimmed];
    if (page) return path.join(PUBLIC_DIR, page);

    // /news/<slug> is a client-side route on the news shell. The server
    // still answers /api/news/<slug> for the content itself.
    if (/^\/news\/[^/]+$/.test(trimmed)) return path.join(PUBLIC_DIR, 'news.html');

    const relative = pathname.replace(/^\/+/, '');
    const top = relative.split('/')[0];
    if (!SERVABLE_DIRS.includes(top)) return null;

    // path.resolve collapses any ../ before this check, so a traversal
    // attempt lands outside the prefix and is rejected here.
    const resolved = path.resolve(PUBLIC_DIR, relative);
    if (!resolved.startsWith(path.join(PUBLIC_DIR, top) + path.sep)) return null;
    return resolved;
}

/**
 * Fingerprint every served script and stylesheet with the build's version.
 *
 * Without this a deploy ships new HTML against a stale script, because
 * Cloudflare rewrites the origin's Cache-Control to its own Browser Cache
 * TTL -- the page said max-age=0, must-revalidate and the browser was told
 * four hours. The HTML is no-cache so it updates immediately; the script
 * does not, and the mismatch shows up as a control that renders but does
 * nothing when clicked.
 *
 * Versioned URLs fix that at the source rather than in a dashboard
 * setting: a new build is a new URL, which no cache anywhere can serve a
 * stale copy of. It also means the assets can safely be cached hard.
 */
function versionAssets(html) {
    return html.replace(
        /(src|href)="(\/(?:js|css|assets)\/[^"?]+)"/g,
        (match, attr, url) => `${attr}="${url}?v=${ASSET_VERSION}"`
    );
}

async function serveStatic(req, res, filePath) {
    let data;
    try {
        data = await fsp.readFile(filePath);
    } catch {
        return null;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') {
        data = Buffer.from(versionAssets(data.toString('utf8')), 'utf8');
    }

    const etag = `"${crypto.createHash('sha1').update(data).digest('base64url')}"`;

    if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag });
        return res.end();
    }

    res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': data.length,
        // A fingerprinted asset is immutable by construction, so it can be
        // cached for a year. The HTML carrying those fingerprints is the
        // one thing that must always be revalidated.
        'Cache-Control': ext === '.html'
            ? 'no-cache'
            : 'public, max-age=31536000, immutable',
        ETag: etag
    });
    if (req.method === 'HEAD') return res.end();
    res.end(data);
    return true;
}

/* ------------------------------ identity ------------------------------ */

function currentUser(req) {
    const cookies = parseCookies(req);

    const discordSession = oauth.getSession(cookies[USER_COOKIE]);
    if (discordSession) return discordSession.user;

    // TOTP break-glass. Deliberately reports as the owner: the code is only
    // ever held by them, and without this route a broken Discord app would
    // lock the only person who can publish out of their own site.
    if (auth.isValidSession(cookies[auth.SESSION_COOKIE])) {
        return {
            id: OWNER_DISCORD_ID || 'owner',
            username: 'owner',
            displayName: 'المالك (دخول برمز التحقق)',
            avatarUrl: '',
            staffRole: 'owner',
            viaTotp: true
        };
    }
    return null;
}

function isStaff(user) {
    return Boolean(user && (user.staffRole === 'owner' || user.staffRole === 'admin'));
}

function sessionCsrf(req) {
    const cookies = parseCookies(req);
    const discordSession = oauth.getSession(cookies[USER_COOKIE]);
    if (discordSession) return discordSession.csrfToken;
    const totpSession = auth.getSession(cookies[auth.SESSION_COOKIE]);
    return totpSession ? totpSession.csrfToken : null;
}

function constantTimeEquals(a, b) {
    const left = Buffer.from(String(a), 'utf8');
    const right = Buffer.from(String(b), 'utf8');
    if (left.length !== right.length) return false;
    return crypto.timingSafeEqual(left, right);
}

/**
 * Origin, when the browser sends one, compared against the host the request
 * actually arrived on. Absence is not evidence of an attack — non-browser
 * clients omit it — so the token check below is the part that must pass.
 */
function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
        return new URL(origin).host === req.headers.host;
    } catch {
        return false;
    }
}

/**
 * Two independent checks, either sufficient alone: a session-bound token
 * echoed in a header (a cross-origin page can cause a request but cannot
 * read the body that carried the token), and the Origin comparison above.
 * SameSite=Lax on the cookie is a third layer, not the only one.
 */
function requireCsrf(req, res) {
    if (SAFE_METHODS.has(req.method)) return true;

    if (!sameOrigin(req)) {
        sendError(res, 403, 'طلب من مصدر غير موثوق');
        return false;
    }

    const expected = sessionCsrf(req);
    const supplied = String(req.headers['x-csrf-token'] || '');
    if (!expected || !constantTimeEquals(expected, supplied)) {
        sendError(res, 403, 'رمز الحماية مفقود أو منتهي. حدّث الصفحة وسجّل الدخول مجدداً.');
        return false;
    }
    return true;
}

function requireStaff(req, res) {
    const user = currentUser(req);
    if (isStaff(user)) return user;
    if (!user) {
        sendError(res, 401, 'لم يتم تسجيل الدخول');
        return null;
    }
    sendError(res, 403, 'هذه الصفحة للإدارة فقط');
    return null;
}

/* ------------------------------- routes ------------------------------- */

async function handleApi(req, res, pathname, url) {
    const method = req.method;

    /* ---- health ---- */

    if (method === 'GET' && pathname === '/api/health') {
        return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
    }

    /* ---- site configuration the pages need before they can render links ---- */

    if (method === 'GET' && pathname === '/api/site') {
        return sendJson(res, 200, {
            storeUrl: storeUrl(),
            discordInviteUrl: inviteUrl(),
            joinCode: joinCode(),
            // fivem://connect is what the FiveM client registers as a
            // protocol handler; the cfx.re link is the browser fallback for
            // anyone without the client installed.
            connectUrl: joinCode() ? `fivem://connect/${joinCode()}` : '',
            joinUrl: joinCode() ? `https://cfx.re/join/${joinCode()}` : ''
        // Short, because this is now editable from the console: a stale
        // join code in a shared cache is a dead button for players.
        }, { cacheSeconds: 30 });
    }

    /* ---- live FiveM stats ---- */

    if (method === 'GET' && pathname === '/api/server') {
        const config = settings.current();
        const stats = await fivem.getStats(joinCode(), {
            publishPlayers: config.publishPlayerList,
            publishMap: config.publishPlayerMap
        });

        // Only the rows an admin chose to show leave the server. Filtering
        // here rather than in the browser means an unselected field is
        // genuinely absent, not merely hidden by CSS.
        const chosen = new Set(config.serverDetailFields);
        const details = {};
        for (const [key, value] of Object.entries(stats.details || {})) {
            if (chosen.has(key)) details[key] = value;
        }

        // The player list rides on its own setting, not on the detail
        // picker -- see the note in lib/settings.js.
        return sendJson(res, 200, {
            ...stats,
            details,
            detailFields: config.serverDetailFields,
            // Independent of the live poll above -- a known schedule
            // (RESTART_SCHEDULE_TIMES), not something FiveM reports.
            nextRestartSeconds: restartSchedule.getNext()
        }, { cacheSeconds: 30 });
    }

    /* ---- Discord welcome images ---- */

    if (method === 'GET' && pathname === '/api/discord/welcome') {
        const config = settings.current();
        if (!config.showWelcomeImages) {
            return sendJson(res, 200, { available: false, reason: 'disabled', images: [] },
                { cacheSeconds: 60 });
        }
        const payload = await discordWelcome.getImages({
            token: DISCORD_BOT_TOKEN,
            channelId: config.welcomeChannelId
        });
        // Matches the module's own TTL: the attachment URLs in here are
        // signed and expire, so a longer shared cache would hand visitors
        // links that have already gone stale.
        return sendJson(res, 200, payload, { cacheSeconds: 300 });
    }

    /* ---- Discord community stats ---- */

    if (method === 'GET' && pathname === '/api/discord') {
        const stats = await discordStats.getStats({
            guildId: DISCORD_GUILD_ID,
            inviteCode: inviteCode(),
            botToken: DISCORD_BOT_TOKEN
        });
        return sendJson(res, 200, { ...stats, inviteUrl: inviteUrl() },
            { cacheSeconds: 60 });
    }

    /* ---- newest products from the store ---- */

    if (method === 'GET' && pathname === '/api/store/latest') {
        const feed = await storeFeed.getLatest(STORE_API_BASE);
        return sendJson(res, 200, { ...feed, storeUrl: storeUrl() }, { cacheSeconds: 120 });
    }

    /* ---- news, public ---- */

    if (method === 'GET' && pathname === '/api/news') {
        const limit = Math.min(Number(url.searchParams.get('limit')) || 0, 50);
        const tag = String(url.searchParams.get('tag') || '').slice(0, 32);
        const posts = news.published({ limit, tag }).map(post => news.summary(post));
        return sendJson(res, 200, { posts }, { cacheSeconds: 60 });
    }

    const slugMatch = /^\/api\/news\/([^/]+)$/.exec(pathname);
    if (method === 'GET' && slugMatch) {
        let slug;
        try {
            slug = decodeURIComponent(slugMatch[1]);
        } catch {
            return sendError(res, 400, 'رابط غير صالح');
        }
        const post = news.findBySlug(slug);
        // A draft is not "forbidden" to a visitor, it does not exist yet.
        if (!post || post.published !== true) {
            return sendError(res, 404, 'الخبر غير موجود');
        }
        return sendJson(res, 200, news.full(post), { cacheSeconds: 60 });
    }

    /* ---- admin session ---- */

    if (method === 'GET' && pathname === '/api/admin/session') {
        const user = currentUser(req);
        if (!isStaff(user)) {
            return sendJson(res, 200, {
                signedIn: false,
                loginAvailable: oauth.configured,
                totpAvailable: true
            });
        }
        return sendJson(res, 200, {
            signedIn: true,
            user: {
                displayName: user.displayName,
                avatarUrl: user.avatarUrl || '',
                staffRole: user.staffRole
            },
            csrfToken: sessionCsrf(req)
        });
    }

    if (method === 'POST' && pathname === '/api/admin/login') {
        if (!sameOrigin(req)) return sendError(res, 403, 'طلب من مصدر غير موثوق');

        const ip = auth.clientIp(req);
        if (auth.isLockedOut(ip)) {
            return sendError(res, 429, 'محاولات كثيرة. انتظر قليلاً ثم أعد المحاولة.');
        }
        // Slows a distributed guessing attempt that spreads itself across
        // many source addresses to stay under the per-IP lockout.
        await auth.globalPressure();

        const body = await readJsonBody(req);
        if (!auth.verifyTotp(String(body.code || ''))) {
            auth.recordFailure(ip);
            return sendError(res, 401, 'رمز التحقق غير صحيح');
        }
        auth.clearFailures(ip);

        const { token, csrfToken } = auth.createSession();
        res.setHeader('Set-Cookie', buildCookie(auth.SESSION_COOKIE, token, {
            maxAge: Math.floor(auth.SESSION_TTL_MS / 1000),
            secure: IS_PRODUCTION
        }));
        return sendJson(res, 200, { ok: true, csrfToken });
    }

    if (method === 'POST' && pathname === '/api/admin/logout') {
        const cookies = parseCookies(req);
        oauth.destroySession(cookies[USER_COOKIE]);
        auth.destroySession(cookies[auth.SESSION_COOKIE]);
        res.setHeader('Set-Cookie', [
            buildCookie(USER_COOKIE, '', { maxAge: 0, secure: IS_PRODUCTION }),
            buildCookie(auth.SESSION_COOKIE, '', { maxAge: 0, secure: IS_PRODUCTION })
        ]);
        return sendJson(res, 200, { ok: true });
    }

    /* ---- settings, admin ---- */

    if (pathname === '/api/admin/settings') {
        const user = requireStaff(req, res);
        if (!user) return undefined;
        if (!requireCsrf(req, res)) return undefined;

        if (method === 'GET') {
            return sendJson(res, 200, {
                settings: settings.current(),
                detailFields: DETAIL_FIELDS,
                lastSync
            });
        }

        if (method === 'PUT') {
            const body = await readJsonBody(req);
            const { settings: saved, changed } = await settings.save(body, user.displayName);

            // Drop only the caches whose inputs moved. A store-URL edit must
            // not throw away a warm FiveM poll, and clearing everything on
            // every save would turn a typo-and-fix into four needless
            // upstream round trips.
            if (changed.includes('fivemJoinCode') || changed.includes('publishPlayerList')
                || changed.includes('publishPlayerMap') || changed.includes('serverDetailFields')) {
                fivem.resetCache();
            }
            if (changed.includes('discordInviteCode')) discordStats.resetCache();
            if (changed.includes('storeUrl')) storeFeed.resetCache();
            if (changed.includes('welcomeChannelId') || changed.includes('showWelcomeImages')) {
                discordWelcome.resetCache();
            }

            // Picking channels should show a result now, not in five
            // minutes -- otherwise there is no way to tell a permission
            // problem from a slow timer.
            if (changed.includes('newsChannelIds') || changed.includes('newsSyncEnabled')) {
                runNewsSync().catch(() => {});
            }

            return sendJson(res, 200, { settings: saved, changed });
        }
    }

    if (method === 'POST' && pathname === '/api/admin/news/sync') {
        const user = requireStaff(req, res);
        if (!user) return undefined;
        if (!requireCsrf(req, res)) return undefined;
        return sendJson(res, 200, await runNewsSync());
    }

    /* ---- news, admin ---- */

    if (pathname === '/api/admin/news' || pathname.startsWith('/api/admin/news/')) {
        const user = requireStaff(req, res);
        if (!user) return undefined;
        if (!requireCsrf(req, res)) return undefined;

        if (method === 'GET' && pathname === '/api/admin/news') {
            return sendJson(res, 200, {
                posts: news.all().map(post => ({
                    ...news.summary(post),
                    published: post.published === true,
                    body: post.body,
                    author: post.author || '',
                    createdAt: post.createdAt
                }))
            });
        }

        if (method === 'POST' && pathname === '/api/admin/news') {
            const body = await readJsonBody(req);
            const post = await news.create(body, user.displayName);
            return sendJson(res, 201, post);
        }

        const idMatch = /^\/api\/admin\/news\/([^/]+)$/.exec(pathname);
        if (idMatch && method === 'PUT') {
            const body = await readJsonBody(req);
            const post = await news.update(idMatch[1], body);
            return sendJson(res, 200, post);
        }
        if (idMatch && method === 'DELETE') {
            return sendJson(res, 200, await news.remove(idMatch[1]));
        }
    }

    return sendError(res, 404, 'المسار غير موجود');
}

/* ------------------------------ redirects ------------------------------ */

/**
 * Short links for the three destinations the pages point at.
 *
 * These exist so index.html can carry working buttons without templating:
 * the join code, the invite and the store URL all live in the environment,
 * and a static page cannot interpolate them. Linking to /join instead means
 * the markup stays constant, the configuration stays in one place, and the
 * buttons work with JavaScript disabled.
 */
const REDIRECTS = {
    '/join': () => (joinCode() ? `https://cfx.re/join/${joinCode()}` : ''),
    '/connect': () => (joinCode() ? `fivem://connect/${joinCode()}` : ''),
    '/discord': () => inviteUrl(),
    '/store': () => storeUrl()
};

function handleRedirect(res, target) {
    if (!target) {
        res.writeHead(503, {
            ...SECURITY_HEADERS,
            'Content-Type': 'text/plain; charset=utf-8'
        });
        return res.end('هذا الرابط غير مهيأ بعد');
    }
    res.writeHead(302, {
        ...SECURITY_HEADERS,
        Location: target,
        // Short, so flipping a join code or invite takes effect quickly
        // rather than living in browser caches for a day.
        'Cache-Control': 'public, max-age=300'
    });
    return res.end();
}

/* ---------------------------- Discord OAuth ---------------------------- */

function oauthFailure(res, reason) {
    // Reasons are a fixed internal vocabulary, never echoed into the page —
    // the redirect carries a code the admin shell maps to its own copy.
    const target = `/admin?error=${encodeURIComponent(reason)}`;
    res.writeHead(302, {
        ...SECURITY_HEADERS,
        Location: target,
        'Set-Cookie': buildCookie(OAUTH_STATE_COOKIE, '', { maxAge: 0, secure: IS_PRODUCTION })
    });
    res.end();
}

async function handleOauth(req, res, pathname, url) {
    if (pathname === '/auth/discord/start') {
        if (!oauth.configured) return oauthFailure(res, 'not-configured');
        const { url: authorizeUrl, state } = oauth.begin({ returnTo: '/admin' });
        res.writeHead(302, {
            ...SECURITY_HEADERS,
            Location: authorizeUrl,
            'Set-Cookie': buildCookie(OAUTH_STATE_COOKIE, state, {
                maxAge: 600, secure: IS_PRODUCTION
            })
        });
        return res.end();
    }

    if (pathname === '/auth/discord/callback') {
        const state = url.searchParams.get('state') || '';
        const cookieState = parseCookies(req)[OAUTH_STATE_COOKIE] || '';

        // The state must match the cookie AND still be live server-side.
        // Either half alone leaves a hole: without the cookie an attacker
        // can replay their own state, and without the server record a
        // state can be reused indefinitely.
        if (!state || !cookieState || state !== cookieState || !oauth.consumeState(state)) {
            return oauthFailure(res, 'bad-state');
        }

        const code = url.searchParams.get('code') || '';
        if (!code) return oauthFailure(res, 'no-code');

        const result = await oauth.complete(code);
        if (!result.ok) return oauthFailure(res, result.reason);

        // Signing in is not the same as being let in. This console has no
        // customer side, so a member who is not staff has nothing to see.
        if (!isStaff(result.user)) return oauthFailure(res, 'not-staff');

        const { token } = oauth.createSession(result.user);
        res.writeHead(302, {
            ...SECURITY_HEADERS,
            Location: '/admin',
            'Set-Cookie': [
                buildCookie(USER_COOKIE, token, {
                    maxAge: 8 * 60 * 60, secure: IS_PRODUCTION
                }),
                buildCookie(OAUTH_STATE_COOKIE, '', { maxAge: 0, secure: IS_PRODUCTION })
            ]
        });
        return res.end();
    }

    return sendError(res, 404, 'المسار غير موجود');
}

/* ------------------------------ dispatch ------------------------------ */

const server = http.createServer(async (req, res) => {
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
        return sendError(res, 400, 'طلب غير صالح');
    }
    const pathname = url.pathname;

    try {
        if (pathname.startsWith('/api/')) {
            return await handleApi(req, res, pathname, url);
        }
        if (pathname.startsWith('/auth/')) {
            return await handleOauth(req, res, pathname, url);
        }

        const redirect = REDIRECTS[pathname.replace(/\/+$/, '') || '/'];
        if (redirect && SAFE_METHODS.has(req.method)) {
            return handleRedirect(res, redirect());
        }

        if (SAFE_METHODS.has(req.method)) {
            const filePath = resolveStatic(pathname);
            if (filePath && await serveStatic(req, res, filePath)) return undefined;
        }

        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('غير موجود');
    } catch (error) {
        const status = error.statusCode || 500;
        if (status >= 500) console.error('[enclave-home]', error);
        // A 500's message could carry a path or a stack fragment, so only
        // deliberate 4xx messages are shown to the client.
        return sendError(res, status, status >= 500 ? 'خطأ في الخادم' : error.message);
    }
});

/* -------------------------------- boot -------------------------------- */

async function computeAssetVersion() {
    const hash = crypto.createHash('sha1');
    for (const dir of ['js', 'css']) {
        let names;
        try {
            names = (await fsp.readdir(path.join(PUBLIC_DIR, dir))).sort();
        } catch {
            continue;
        }
        for (const name of names) {
            hash.update(name);
            hash.update(await fsp.readFile(path.join(PUBLIC_DIR, dir, name)));
        }
    }
    return hash.digest('base64url').slice(0, 10);
}

async function start() {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    ASSET_VERSION = await computeAssetVersion();
    await news.load();
    await settings.load();

    auth.initAdminTotp(process.env.ADMIN_TOTP_SECRET);

    // Expired sessions and OAuth states are dropped on a timer rather than
    // only on access, so an idle process does not hold them indefinitely.
    const sweeper = setInterval(() => {
        auth.sweep();
        oauth.sweep();
    }, 10 * 60 * 1000);
    sweeper.unref();

    // Sync on a timer, and once shortly after boot so a restart picks up
    // anything posted while the service was down.
    if (settings.current().newsSyncEnabled) {
        setTimeout(() => runNewsSync().catch(() => {}), 10 * 1000).unref();
    }
    const syncTimer = setInterval(() => runNewsSync().catch(() => {}), NEWS_SYNC_INTERVAL_MS);
    syncTimer.unref();

    server.listen(PORT, BIND_HOST, () => {
        console.log(`enclave-home listening on http://${BIND_HOST}:${PORT}`);
        if (!joinCode()) {
            console.warn('No FiveM join code set — the live server board will show "not configured".');
            console.warn('Set it at /admin, or seed FIVEM_JOIN_CODE before the first run.');
        }
        if (!inviteCode() && !DISCORD_BOT_TOKEN) {
            console.warn('No Discord invite code and no bot token — Discord stats stay empty.');
        }
    });
}

if (require.main === module) {
    start().catch(error => {
        console.error('failed to start', error);
        process.exit(1);
    });
}

module.exports = { server, start, news };
