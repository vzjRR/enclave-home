'use strict';

/* ---------------------------------------------------------------
   Smoke tests — run with: npm test

   Boots the real server on a scratch data directory, with every upstream
   (Cfx.re, Discord, the store) pointed at a local stub, and exercises the
   things that would actually hurt if they broke: player identifiers
   leaking to the browser, the project directory being downloadable,
   unauthenticated or cross-site writes landing, drafts being publicly
   readable, a dead upstream taking a section or the page down, and one
   visitor's page view turning into many upstream calls.

   These are integration tests against a live process. Everything asserted
   here is enforced server-side; nothing depends on what the browser does.
--------------------------------------------------------------- */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;

function ok(condition, label) {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  ✗ ${label}`);
    }
}

function eq(actual, expected, label) {
    ok(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/* --------------------------- upstream stub --------------------------- */

/**
 * Stands in for Cfx.re, Discord and the store.
 *
 * Deliberately an arm's-length HTTP server rather than a monkey-patched
 * fetch: the modules under test are exercised through the same code path
 * production uses, including timeouts, non-2xx handling and JSON parsing.
 */
const stubState = {
    serverUp: true,
    storeOpen: true,
    newsMessages: [],
    welcomeMessages: [],
    playersCalls: 0,
    dynamicCalls: 0,
    discordCalls: 0
};

function createStub() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://stub');
        const json = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };

        // Cfx.re join-code resolution: the address comes back in a header.
        if (url.pathname.startsWith('/join/')) {
            res.writeHead(200, {
                'x-citizenfx-url': `http://127.0.0.1:${server.address().port}/`,
                'cache-control': 'max-age=300',
                'Content-Type': 'text/html'
            });
            return res.end('<html></html>');
        }

        if (url.pathname === '/dynamic.json') {
            stubState.dynamicCalls++;
            if (!stubState.serverUp) return json(500, {});
            return json(200, {
                clients: 42, sv_maxclients: 64,
                hostname: '^2ENCLAVE RP^7 | QBCore',
                gametype: 'Roleplay', mapname: 'Los Santos'
            });
        }

        if (url.pathname === '/info.json') {
            if (!stubState.serverUp) return json(500, {});
            return json(200, {
                server: 'FXServer-master v1.0.0',
                resources: ['a', 'b', 'c'],
                vars: {
                    sv_projectName: 'ENCLAVE RP',
                    sv_projectDesc: 'مدينة رول بلاي',
                    tags: 'roleplay, arabic',
                    locale: 'ar-SA',
                    onesync_enabled: 'true'
                }
            });
        }

        if (url.pathname === '/players.json') {
            stubState.playersCalls++;
            if (!stubState.serverUp) return json(500, {});
            // Exactly the shape FiveM returns, identifiers and all.
            return json(200, [{
                id: 3,
                name: 'Ahmed',
                ping: 38,
                endpoint: '203.0.113.9:30120',
                identifiers: [
                    'steam:11000010000abcd',
                    'license:7f3c1e2b9a8d',
                    'discord:1303195553068482591',
                    'ip:203.0.113.9'
                ]
            }]);
        }

        // Cfx.re listing API — unlisted server.
        if (url.pathname.startsWith('/servers/single/')) return json(404, {});

        if (url.pathname.startsWith('/invites/')) {
            stubState.discordCalls++;
            return json(200, {
                approximate_member_count: 150,
                approximate_presence_count: 41,
                guild: { name: 'ENCLAVE RP' }
            });
        }

        // Discord channel reads, for the news sync and welcome images.
        const channel = /^\/channels\/(\d+)\/messages$/.exec(url.pathname);
        if (channel) {
            const id = channel[1];
            if (id === '900000000000000001') return json(403, {});
            if (id === '900000000000000009') {
                return json(200, stubState.welcomeMessages);
            }
            return json(200, stubState.newsMessages);
        }

        if (url.pathname === '/api/store') {
            if (!stubState.storeOpen) {
                return json(200, { storeOpen: false, categories: [], products: [] });
            }
            return json(200, {
                storeOpen: true,
                baseCurrency: 'OMR',
                categories: [{ id: 'c1', name: 'سيارات' }],
                products: [
                    { id: 'p_old', name: 'Old', categoryId: 'c1', price: 10, mainImage: 'https://x.test/a.png', createdAt: '2026-01-01T00:00:00Z' },
                    { id: 'p_new', name: 'New', categoryId: 'c1', price: 20, mainImage: 'https://x.test/b.png', createdAt: '2026-08-01T00:00:00Z' },
                    { id: 'p_mid', name: 'Mid', categoryId: 'c1', price: 15, mainImage: 'https://x.test/c.png', createdAt: '2026-05-01T00:00:00Z' }
                ]
            });
        }

        return json(404, { error: 'not found' });
    });

    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------- client ------------------------------- */

function request(base, urlPath, { method = 'GET', body, headers = {}, cookie = '' } = {}) {
    return new Promise((resolve, reject) => {
        const target = new URL(urlPath, base);
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname + target.search,
            method,
            headers: {
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
                ...headers
            }
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let json = null;
                try { json = JSON.parse(text); } catch { /* not JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

/** Independent RFC 6238 implementation, so the suite never reaches into lib/auth.js. */
function totp(secretBase32) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const ch of secretBase32.replace(/=+$/, '').toUpperCase()) {
        const value = alphabet.indexOf(ch);
        if (value >= 0) bits += value.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));

    const counter = Math.floor(Date.now() / 1000 / 30);
    const buffer = Buffer.alloc(8);
    buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
    buffer.writeUInt32BE(counter >>> 0, 4);

    const digest = crypto.createHmac('sha1', Buffer.from(bytes)).update(buffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const code = ((digest[offset] & 0x7f) << 24
        | digest[offset + 1] << 16
        | digest[offset + 2] << 8
        | digest[offset + 3]) % 1000000;
    return String(code).padStart(6, '0');
}

async function waitForServer(base, attempts = 60) {
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await request(base, '/api/health');
            if (res.status === 200) return;
        } catch { /* not up yet */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('server did not start');
}

/* -------------------------------- run -------------------------------- */

const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const BOT_TOKEN = 'MTQxMS.stub.tokenvalue';

async function main() {
    const stub = await createStub();
    const stubBase = `http://127.0.0.1:${stub.address().port}`;
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'enclave-home-test-'));
    const port = 3200 + Math.floor(Math.random() * 400);
    const base = `http://127.0.0.1:${port}`;

    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
        env: {
            ...process.env,
            PORT: String(port),
            DATA_DIR: dataDir,
            NODE_ENV: 'test',
            ADMIN_TOTP_SECRET: TOTP_SECRET,
            FIVEM_JOIN_CODE: 'testcode',
            FIVEM_JOIN_BASE: `${stubBase}/join`,
            FIVEM_LIST_BASE: `${stubBase}/servers/single`,
            FIVEM_PUBLISH_PLAYER_LIST: 'true',
            // Short enough that the suite can observe the cache expire and
            // re-poll a downed upstream, rather than asserting against a
            // still-warm entry and proving nothing.
            FIVEM_STATS_TTL_MS: '300',
            DISCORD_API_BASE: stubBase,
            DISCORD_INVITE_CODE: 'testinvite',
            DISCORD_GUILD_ID: '123',
            DISCORD_BOT_TOKEN: BOT_TOKEN,
            STORE_API_BASE: stubBase,
            STORE_URL: 'https://store.example.test'
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.resume();
    child.stderr.resume();

    try {
        await waitForServer(base);

        /* ---------------------- pages and static ---------------------- */

        const home = await request(base, '/');
        eq(home.status, 200, 'homepage serves');
        ok(/ENCLAVE/.test(home.text), 'homepage carries its content');
        ok(home.headers['content-security-policy'].includes("script-src 'self'"),
            'CSP forbids inline and third-party script');

        // Static-first: the reveal attribute must not be in the served HTML,
        // or a visitor without JS would get an invisible page.
        ok(!/\sdata-reveal(=|\s|>)/.test(home.text),
            'served HTML carries no data-reveal (content visible without JS)');
        ok(!/<script(?![^>]*\ssrc=)/i.test(home.text),
            'no inline <script> in the page the CSP would block');

        /* ------------------ asset cache-busting ------------------ */

        // A deploy that ships new HTML against a cached old script produces
        // a control that renders but does nothing. Cloudflare rewrites the
        // origin's Cache-Control to its own Browser Cache TTL, so the fix
        // has to be in the URL rather than in a header.
        const versioned = /(?:src|href)="\/js\/admin\.js\?v=([A-Za-z0-9_-]+)"/.exec(
            (await request(base, '/admin')).text);
        ok(versioned, 'scripts are referenced with a version fingerprint');

        if (versioned) {
            const asset = await request(base, `/js/admin.js?v=${versioned[1]}`);
            eq(asset.status, 200, 'the fingerprinted URL serves the script');
            ok(asset.headers['cache-control'].includes('immutable'),
                'a fingerprinted asset is cached hard');
        }

        eq((await request(base, '/admin')).headers['cache-control'], 'no-cache',
            'the HTML carrying the fingerprints is never cached');

        // Every page must be fingerprinted, not just the one checked above.
        for (const page of ['/', '/news']) {
            const body = (await request(base, page)).text;
            const bare = /(?:src|href)="\/(?:js|css)\/[^"?]+"/.exec(body);
            ok(!bare, `no unversioned asset on ${page}${bare ? ` (${bare[0]})` : ''}`);
        }

        // The rewrite must not touch third-party URLs.
        ok(!/fonts\.googleapis\.com[^"]*\?v=/.test((await request(base, '/')).text),
            'external URLs are left alone by the rewrite');

        for (const attempt of [
            '/server.js', '/lib/auth.js', '/data/news.json',
            '/../server.js', '/css/../../server.js', '/css/%2e%2e/%2e%2e/server.js'
        ]) {
            const res = await request(base, attempt);
            eq(res.status, 404, `blocked: ${attempt}`);
        }

        eq((await request(base, '/css/tokens.css')).status, 200, 'stylesheet serves');

        /* -------------------------- redirects -------------------------- */

        const join = await request(base, '/join');
        eq(join.status, 302, '/join redirects');
        eq(join.headers.location, 'https://cfx.re/join/testcode', '/join uses the configured code');
        eq((await request(base, '/connect')).headers.location, 'fivem://connect/testcode',
            '/connect uses the FiveM protocol handler');
        eq((await request(base, '/store')).headers.location, 'https://store.example.test',
            '/store uses the configured store URL');

        /* ------------------------ live server API ------------------------ */

        const live = await request(base, '/api/server');
        eq(live.status, 200, 'server stats respond');
        eq(live.json.online, true, 'server reported online');
        eq(live.json.players, 42, 'player count read from dynamic.json');
        eq(live.json.maxPlayers, 64, 'max slots read from dynamic.json');
        eq(live.json.source, 'direct', 'direct poll preferred over the listing');

        // The whole point of publicPlayer(). A regression here publishes
        // every player's Steam ID, Discord ID and home IP address.
        const serialised = JSON.stringify(live.json);
        ok(!serialised.includes('steam:'), 'no steam identifier reaches the client');
        ok(!serialised.includes('license:'), 'no license identifier reaches the client');
        ok(!serialised.includes('discord:'), 'no discord identifier reaches the client');
        ok(!serialised.includes('203.0.113.9'), 'no player endpoint/IP reaches the client');
        ok(!serialised.includes('identifiers'), 'identifiers key is dropped entirely');
        eq(live.json.playerList[0].name, 'Ahmed', 'player name survives');
        eq(live.json.playerList[0].ping, 38, 'player ping survives');

        eq(live.headers['cache-control'], 'public, max-age=30', 'server stats are cacheable');

        // Cached: a second call must not re-poll upstream.
        const dynamicBefore = stubState.dynamicCalls;
        await request(base, '/api/server');
        eq(stubState.dynamicCalls, dynamicBefore, 'second call served from cache');

        /* --------------------------- discord --------------------------- */

        const discord = await request(base, '/api/discord');
        eq(discord.json.members, 150, 'member count');
        eq(discord.json.online, 41, 'presence count');
        eq(discord.json.available, true, 'discord reported available');
        eq(discord.headers['cache-control'], 'public, max-age=60', 'discord stats are cacheable');

        /* ---------------------------- store ---------------------------- */

        const store = await request(base, '/api/store/latest');
        eq(store.json.products.length, 3, 'products returned');
        eq(store.json.products[0].id, 'p_new', 'newest product sorts first');
        eq(store.json.products[2].id, 'p_old', 'oldest product sorts last');
        eq(store.json.products[0].category, 'سيارات', 'category name resolved');
        eq(store.json.baseCurrency, 'OMR', 'base currency passed through, not guessed');
        ok(!('gallery' in store.json.products[0]), 'gallery not forwarded to the homepage');

        /* ------------------------- news, public ------------------------- */

        eq((await request(base, '/api/news')).json.posts.length, 0, 'no posts to begin with');

        const noAuth = await request(base, '/api/admin/news', {
            method: 'POST', body: { title: 'x', body: 'y' }
        });
        eq(noAuth.status, 401, 'unauthenticated create rejected');
        eq((await request(base, '/api/admin/news')).status, 401, 'unauthenticated list rejected');

        /* --------------------------- sign in --------------------------- */

        const badLogin = await request(base, '/api/admin/login', {
            method: 'POST', body: { code: '000000' }
        });
        eq(badLogin.status, 401, 'wrong TOTP rejected');

        const login = await request(base, '/api/admin/login', {
            method: 'POST', body: { code: totp(TOTP_SECRET) }
        });
        eq(login.status, 200, 'TOTP sign-in succeeds');
        const cookie = String(login.headers['set-cookie'][0]).split(';')[0];
        const csrf = login.json.csrfToken;
        ok(Boolean(csrf), 'sign-in returns a CSRF token');

        const noCsrf = await request(base, '/api/admin/news', {
            method: 'POST', body: { title: 'x', body: 'y' }, cookie
        });
        eq(noCsrf.status, 403, 'authenticated write without CSRF token rejected');

        const badOrigin = await request(base, '/api/admin/news', {
            method: 'POST',
            body: { title: 'x', body: 'y' },
            cookie,
            headers: { 'X-CSRF-Token': csrf, Origin: 'https://evil.example' }
        });
        eq(badOrigin.status, 403, 'cross-origin write rejected even with a valid token');

        const write = (body, method = 'POST', urlPath = '/api/admin/news') =>
            request(base, urlPath, { method, body, cookie, headers: { 'X-CSRF-Token': csrf } });

        /* ------------------------- news, writes ------------------------- */

        const created = await write({
            title: 'افتتاح السيرفر',
            body: 'أهلاً **بكم** <script>alert(1)</script>\n\n- أول\n- ثاني',
            tag: 'إعلان',
            published: true
        });
        eq(created.status, 201, 'post created');
        eq(created.json.slug, 'افتتاح-السيرفر', 'Arabic slug derived from the title');
        ok(created.json.html.includes('<strong>بكم</strong>'), 'markdown bold rendered');
        ok(created.json.html.includes('&lt;script&gt;'), 'author HTML is escaped, not executed');
        ok(!created.json.html.includes('<script>'), 'no raw script tag survives rendering');

        const draft = await write({ title: 'مسودة', body: 'سر', published: false });
        eq(draft.status, 201, 'draft created');

        const publicList = await request(base, '/api/news');
        eq(publicList.json.posts.length, 1, 'draft hidden from the public list');
        eq((await request(base, `/api/news/${encodeURIComponent('مسودة')}`)).status, 404,
            'draft not readable by slug');
        eq((await request(base, `/api/news/${encodeURIComponent('افتتاح-السيرفر')}`)).status, 200,
            'published post readable by slug');

        eq((await request(base, '/api/admin/news', { cookie, headers: { 'X-CSRF-Token': csrf } }))
            .json.posts.length, 2, 'admin list includes drafts');

        // Editing a live post must not reshuffle it to the top of the page.
        const firstPublishedAt = created.json.publishedAt;
        await new Promise(resolve => setTimeout(resolve, 10));
        const edited = await write(
            { title: 'افتتاح السيرفر', body: 'معدّل', published: true },
            'PUT', `/api/admin/news/${created.json.id}`
        );
        eq(edited.status, 200, 'post updated');
        eq(edited.json.publishedAt, firstPublishedAt, 'publishedAt stable across an edit');
        ok(edited.json.html.includes('معدّل'), 'body re-rendered after edit');

        const badCover = await write({ title: 't', body: 'b', coverImage: 'javascript:alert(1)' });
        eq(badCover.status, 400, 'unsafe cover image URL rejected');

        const removed = await write(null, 'DELETE', `/api/admin/news/${draft.json.id}`);
        eq(removed.status, 200, 'post deleted');
        eq((await request(base, '/api/admin/news', { cookie, headers: { 'X-CSRF-Token': csrf } }))
            .json.posts.length, 1, 'deleted post gone from the admin list');

        /* ------------------------- settings ------------------------- */

        eq((await request(base, '/api/admin/settings')).status, 401,
            'unauthenticated settings read rejected');
        eq((await request(base, '/api/admin/settings', {
            method: 'PUT', body: { fivemJoinCode: 'hacked' }
        })).status, 401, 'unauthenticated settings write rejected');

        const readSettings = () => request(base, '/api/admin/settings',
            { cookie, headers: { 'X-CSRF-Token': csrf } });

        const seeded = await readSettings();
        eq(seeded.status, 200, 'settings readable by staff');
        eq(seeded.json.settings.fivemJoinCode, 'testcode', 'seeded from the environment');
        eq(seeded.json.settings.publishPlayerList, true, 'player-list seed carried through');

        // Whatever the settings endpoint returns, it must never carry the
        // credentials the service holds. The read-only panel that used to
        // list them is gone, and this is what keeps it gone.
        const settingsText = JSON.stringify(seeded.json);
        for (const secret of [BOT_TOKEN, TOTP_SECRET, 'CLIENT_SECRET']) {
            ok(!settingsText.includes(secret),
                `settings response carries no ${secret === BOT_TOKEN ? 'bot token' : 'secret'}`);
        }
        ok(Array.isArray(seeded.json.detailFields) && seeded.json.detailFields.length,
            'the endpoint offers the selectable detail fields');
        ok(!seeded.json.detailFields.includes('playerList'),
            'the player list is not a detail field — it has its own setting');

        const putSettings = body => request(base, '/api/admin/settings',
            { method: 'PUT', body, cookie, headers: { 'X-CSRF-Token': csrf } });

        // A pasted URL must be stored as a bare code, or it resolves to
        // nothing later and reads as an outage.
        const normalised = await putSettings({
            fivemJoinCode: 'https://cfx.re/join/newcode1',
            discordInviteCode: 'https://discord.gg/abc-123',
            storeUrl: 'https://shop.example.test/',
            publishPlayerList: false
        });
        eq(normalised.status, 200, 'settings saved');
        eq(normalised.json.settings.fivemJoinCode, 'newcode1', 'join URL normalised to a code');
        eq(normalised.json.settings.discordInviteCode, 'abc-123', 'invite URL normalised to a code');
        eq(normalised.json.settings.storeUrl, 'https://shop.example.test', 'trailing slash trimmed');

        // Saving must take effect immediately — the whole point of moving
        // these out of the env file is not needing a restart.
        const site = await request(base, '/api/site');
        eq(site.json.joinCode, 'newcode1', 'live config reflects the save without a restart');
        eq(site.json.storeUrl, 'https://shop.example.test', 'store URL applied live');
        eq((await request(base, '/store')).headers.location, 'https://shop.example.test',
            'redirect follows the saved setting');

        eq((await putSettings({
            fivemJoinCode: 'newcode1', discordInviteCode: 'abc-123',
            storeUrl: 'https://shop.example.test', publishPlayerList: false
        })).json.changed.length, 0, 'a no-op save reports nothing changed');

        for (const [label, body] of [
            ['join code with a space', { fivemJoinCode: 'bad code' }],
            ['non-https store url', { storeUrl: 'http://insecure.test' }],
            ['javascript: store url', { storeUrl: 'javascript:alert(1)' }]
        ]) {
            eq((await putSettings(body)).status, 400, `rejected: ${label}`);
        }

        // Restore, so the outage assertions below still describe a
        // configured server rather than one this block broke.
        await putSettings({
            fivemJoinCode: 'testcode', discordInviteCode: 'testinvite',
            storeUrl: 'https://store.example.test', publishPlayerList: true,
            serverDetailFields: ['gametype', 'mapname', 'resourceCount']
        });

        /* --------------------- server details --------------------- */

        await putSettings({
            fivemJoinCode: 'testcode', discordInviteCode: 'testinvite',
            storeUrl: 'https://store.example.test', publishPlayerList: true,
            serverDetailFields: ['projectName', 'resourceCount']
        });
        await new Promise(resolve => setTimeout(resolve, 400));

        const detailed = await request(base, '/api/server');
        eq(detailed.json.details.projectName, 'ENCLAVE RP', 'a chosen detail is returned');
        eq(detailed.json.details.resourceCount, 3, 'resource count is counted from info.json');
        ok(!('tags' in detailed.json.details),
            'an unselected field is absent, not empty');
        ok(!('locale' in detailed.json.details), 'only chosen fields are sent');

        // The player list must not be gated behind the detail picker: it has
        // its own setting, and two controls for one outcome is how an
        // operator ends up ticking the obvious box and seeing nothing.
        eq(detailed.json.playerList.length, 1,
            'player list follows publishPlayerList, not the detail picker');

        /* ------------------ discord welcome images ------------------ */

        stubState.welcomeMessages = [
            { id: '5', attachments: [{ url: 'https://cdn.test/a.png', content_type: 'image/png' }], embeds: [] },
            { id: '4', content: 'no image here', attachments: [], embeds: [] },
            { id: '3', attachments: [], embeds: [{ image: { url: 'https://cdn.test/b.png' } }] }
        ];
        await putSettings({
            fivemJoinCode: 'testcode', discordInviteCode: 'testinvite',
            storeUrl: 'https://store.example.test', publishPlayerList: true,
            serverDetailFields: ['projectName', 'resourceCount'],
            welcomeChannelId: '900000000000000009', showWelcomeImages: true
        });

        const welcome = await request(base, '/api/discord/welcome');
        eq(welcome.status, 200, 'welcome images respond');
        eq(welcome.json.images.length, 2, 'messages without an image are skipped');
        eq(welcome.json.images[0].url, 'https://cdn.test/a.png', 'attachment image used');
        eq(welcome.json.images[1].url, 'https://cdn.test/b.png', 'embed image used as a fallback');

        // Images only. A name or handle leaking in here is the whole thing
        // the user asked to avoid.
        const welcomeKeys = Object.keys(welcome.json.images[0]).sort().join(',');
        eq(welcomeKeys, 'id,url', 'a welcome image carries only an id and a url');

        /* ---------------------- discord news sync ---------------------- */

        const message = (id, content) => ({
            id, content, timestamp: '2026-08-01T00:00:00Z', attachments: [], embeds: []
        });
        stubState.newsMessages = [
            message('300000000000000000', 'إعلان ثالث\nتفاصيل'),
            message('200000000000000000', 'إعلان ثاني\nتفاصيل'),
            message('100000000000000000', 'إعلان أول\nتفاصيل')
        ];

        const publicBefore = (await request(base, '/api/news')).json.posts.length;

        const syncNow = () => request(base, '/api/admin/news/sync',
            { method: 'POST', cookie, headers: { 'X-CSRF-Token': csrf } });

        eq((await request(base, '/api/admin/news/sync', { method: 'POST' })).status, 401,
            'unauthenticated sync rejected');

        await putSettings({
            fivemJoinCode: 'testcode', discordInviteCode: 'testinvite',
            storeUrl: 'https://store.example.test', publishPlayerList: true,
            serverDetailFields: ['projectName'],
            newsSyncEnabled: true,
            newsChannelIds: ['900000000000000002']
        });

        const first = await syncNow();
        eq(first.json.added, 3, 'three messages synced');

        // Drafts, never published. This is the promise the whole feature
        // rests on: nothing reaches the public site without a human.
        eq((await request(base, '/api/news')).json.posts.length, publicBefore,
            'synced posts are drafts and do not appear publicly');

        eq((await syncNow()).json.added, 0, 're-syncing adds nothing');

        // A message deleted in Discord removes its post.
        stubState.newsMessages = [
            message('300000000000000000', 'إعلان ثالث\nتفاصيل'),
            message('100000000000000000', 'إعلان أول\nتفاصيل')
        ];
        eq((await syncNow()).json.removed, 1, 'a deleted message removes its post');

        // The dangerous case: the window slides past old messages entirely.
        // They are out of view, NOT deleted — without this check the first
        // sync of a busy channel would wipe the archive.
        stubState.newsMessages = [
            message('900000000000000000', 'جديد\nتفاصيل')
        ];
        eq((await syncNow()).json.removed, 0,
            'messages older than the fetch window are not treated as deleted');

        const adminPosts = (await request(base, '/api/admin/news',
            { cookie, headers: { 'X-CSRF-Token': csrf } })).json.posts;
        ok(adminPosts.some(post => post.source === 'discord'), 'synced posts are marked');
        ok(adminPosts.some(post => !post.source), 'hand-written posts survive the sync');

        // A channel the bot cannot read reports itself instead of failing quietly.
        await putSettings({
            fivemJoinCode: 'testcode', discordInviteCode: 'testinvite',
            storeUrl: 'https://store.example.test', publishPlayerList: true,
            serverDetailFields: ['projectName'],
            newsSyncEnabled: true, newsChannelIds: ['900000000000000001']
        });
        const denied = await syncNow();
        eq(denied.json.channels[0].ok, false, 'a forbidden channel is reported');
        eq(denied.json.channels[0].reason, 'no-access', 'and names the reason');

        /* ----------------------- upstream failures ----------------------- */

        // A dead game server must degrade to an offline board, not an error,
        // and must not affect any other section or the page itself.
        stubState.serverUp = false;
        await new Promise(resolve => setTimeout(resolve, 400));   // let the cache lapse

        const offline = await request(base, '/api/server');
        eq(offline.status, 200, 'server stats still answer 200 while the game server is down');
        eq(offline.json.online, false, 'board reports the server as offline');
        eq(offline.json.reason, 'unreachable', 'offline board carries an actionable reason');
        eq(offline.json.players, 0, 'no stale player count survives the outage');
        eq(offline.json.playerList.length, 0, 'no stale player list survives the outage');

        // And it recovers on its own once the server answers again.
        stubState.serverUp = true;
        await new Promise(resolve => setTimeout(resolve, 400));
        const recovered = await request(base, '/api/server');
        eq(recovered.json.online, true, 'board recovers when the server returns');
        eq(recovered.json.players, 42, 'player count is live again after recovery');

        stubState.storeOpen = false;
        const closed = await request(base, '/api/store/latest');
        eq(closed.status, 200, 'store feed answers while the shop is closed');

        eq((await request(base, '/')).status, 200, 'homepage unaffected by upstream failures');
        eq((await request(base, '/api/health')).status, 200, 'health unaffected');
    } finally {
        child.kill();
        stub.close();
        await fsp.rm(dataDir, { recursive: true, force: true });
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
