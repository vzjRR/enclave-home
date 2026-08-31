'use strict';

/* ---------------------------------------------------------------
   Live FiveM server stats.

   Two independent sources, queried together on every refresh:

   1. The server itself — /dynamic.json, /info.json, /players.json on the
      address the join code resolves to. Authoritative and real-time, but
      only reachable if the game port is open to this host.
   2. The Cfx.re listing API — servers-frontend.fivem.net. Plain HTTPS, so
      it survives firewalls that block the game port, but it only answers
      for a server currently listed in the public browser and its numbers
      lag the server's own.

   The direct answer wins when both arrive. The listing is what keeps the
   board populated when it does not.

   The address is resolved from the join code rather than hardcoded, so the
   site follows the server if its IP changes. Cfx.re answers the join URL
   with an `x-citizenfx-url` header and `cache-control: max-age=300`, and
   that max-age is honoured below.

   Nothing here throws. A dead game server is an ordinary state for this
   module to report, not an error for the caller to handle.
--------------------------------------------------------------- */

const TIMEOUT_MS = 6000;
const ADDRESS_TTL_FALLBACK_MS = 5 * 60 * 1000;

// Matches the max-age on /api/server, so a visitor refreshing the page
// cannot pull more often than a shared cache would anyway. Overridable so
// the test suite can watch the cache actually expire instead of sleeping
// half a minute to do it.
const STATS_TTL_MS = Number(process.env.FIVEM_STATS_TTL_MS) || 30 * 1000;

// Overridable so the test suite can point every upstream at a local stub.
// Unset in every real deployment.
const JOIN_BASE = process.env.FIVEM_JOIN_BASE || 'https://cfx.re/join';
const LIST_BASE = process.env.FIVEM_LIST_BASE
    || 'https://servers-frontend.fivem.net/api/servers/single';

/**
 * Publishing the player list is the community's call, not a default. Names
 * are pseudonymous but they are still a live "who is in the city right now"
 * feed, so it stays off unless someone turns it on deliberately.
 *
 * Passed in per call rather than read from the environment at load, because
 * it is now editable from the admin console and a module constant would
 * mean the toggle needed a service restart to take effect.
 */
const PUBLISH_DEFAULT = process.env.FIVEM_PUBLISH_PLAYER_LIST === 'true';

let addressCache = { url: null, expiresAt: 0 };
let statsCache = { payload: null, expiresAt: 0 };
let inFlight = null;

async function getJson(url, { headers } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': 'EnclaveRP-Home/1.0', ...(headers || {}) }
        });
        if (!response.ok) return null;
        return await response.json();
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Resolve a join code to the server's current base URL.
 *
 * Cfx.re returns the address in a response header, not the body, so this
 * reads `x-citizenfx-url` rather than parsing the HTML landing page.
 */
async function resolveAddress(joinCode) {
    if (addressCache.url && Date.now() < addressCache.expiresAt) {
        return addressCache.url;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(`${JOIN_BASE}/${encodeURIComponent(joinCode)}`, {
            signal: controller.signal,
            headers: { 'User-Agent': 'EnclaveRP-Home/1.0' }
        });
        const url = response.headers.get('x-citizenfx-url');
        if (!url) return null;

        // Honour Cfx.re's own cache directive when it sends one; a bad or
        // missing value must not collapse the TTL to zero and turn every
        // page view into a fresh resolve.
        const maxAge = Number(/max-age=(\d+)/.exec(
            response.headers.get('cache-control') || ''
        )?.[1]);
        const ttl = Number.isFinite(maxAge) && maxAge > 0
            ? maxAge * 1000
            : ADDRESS_TTL_FALLBACK_MS;

        addressCache = { url: url.replace(/\/+$/, ''), expiresAt: Date.now() + ttl };
        return addressCache.url;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Reduce a raw /players.json entry to what a visitor may see.
 *
 * The raw entry carries `identifiers` (steam:, license:, discord:, xbl:,
 * live:) and `endpoint`, which is the player's own IP address. None of that
 * can reach the browser: it would deanonymise every player in the city and,
 * in the case of endpoint, publish their home IP.
 */
function publicPlayer(player) {
    return {
        id: Number(player?.id) || 0,
        name: String(player?.name ?? '').slice(0, 64),
        ping: Number(player?.ping) || 0
    };
}

function emptyStats(reason) {
    return {
        online: false,
        reason,
        players: 0,
        maxPlayers: 0,
        hostname: '',
        gametype: '',
        mapname: '',
        playerList: [],
        details: {},
        source: null,
        checkedAt: new Date().toISOString()
    };
}

/**
 * The optional detail rows, pulled out of /info.json's `vars` bag.
 *
 * Every value is normalised to a string or a number here rather than in the
 * template, because `vars` is a free-form map a server owner can put
 * anything in -- booleans arrive as the strings "true"/"false", and numbers
 * as strings too.
 */
function extractDetails(info, listing) {
    const vars = (info && info.vars) || {};
    const text = value => String(value ?? '').trim();

    const details = {
        projectName: text(vars.sv_projectName),
        projectDesc: text(vars.sv_projectDesc),
        tags: text(vars.tags),
        locale: text(vars.locale),
        enforceGameBuild: text(vars.sv_enforceGameBuild),
        onesync: vars.onesync_enabled === true || vars.onesync_enabled === 'true'
            ? 'مفعّل'
            : (vars.onesync_enabled === undefined ? '' : 'معطّل'),
        resourceCount: Array.isArray(info?.resources) ? info.resources.length : 0,
        serverVersion: text(info?.server),
        upvotes: Number(listing?.upvotePower) || 0
    };

    // An absent value and a zero are different things to a reader, so drop
    // the empties here rather than rendering a panel full of dashes.
    for (const [key, value] of Object.entries(details)) {
        if (value === '' || value === 0) delete details[key];
    }
    return details;
}

/** Poll the server's own endpoints. Returns null unless /dynamic.json answers. */
async function fetchDirect(baseUrl, publishPlayers) {
    if (!baseUrl) return null;

    const [dynamic, info, players] = await Promise.all([
        getJson(`${baseUrl}/dynamic.json`),
        getJson(`${baseUrl}/info.json`),
        // Only fetched when it will actually be published — otherwise it is
        // a request per refresh whose entire result gets thrown away.
        publishPlayers ? getJson(`${baseUrl}/players.json`) : Promise.resolve(null)
    ]);

    // dynamic.json is the one that decides "is it up". info.json only adds
    // detail rows, and players.json is empty on an idle-but-live server, so
    // neither is allowed to make the server look down.
    if (!dynamic) return null;

    return {
        online: true,
        reason: null,
        players: Number(dynamic.clients) || 0,
        maxPlayers: Number(dynamic.sv_maxclients ?? dynamic.svMaxclients) || 0,
        hostname: String(dynamic.hostname ?? ''),
        gametype: String(dynamic.gametype ?? ''),
        mapname: String(dynamic.mapname ?? ''),
        playerList: Array.isArray(players) ? players.map(publicPlayer) : [],
        details: extractDetails(info, null),
        source: 'direct',
        checkedAt: new Date().toISOString()
    };
}

/** Ask the public Cfx.re listing. Returns null when the server is unlisted. */
async function fetchListing(joinCode, publishPlayers) {
    const body = await getJson(`${LIST_BASE}/${encodeURIComponent(joinCode)}`);
    const data = body?.Data;
    if (!data) return null;

    return {
        online: true,
        reason: null,
        players: Number(data.clients) || 0,
        maxPlayers: Number(data.svMaxclients ?? data.sv_maxclients) || 0,
        hostname: String(data.hostname ?? ''),
        gametype: String(data.gametype ?? ''),
        mapname: String(data.mapname ?? ''),
        playerList: publishPlayers && Array.isArray(data.players)
            ? data.players.map(publicPlayer)
            : [],
        details: extractDetails(data, data),
        source: 'listing',
        checkedAt: new Date().toISOString()
    };
}

async function refresh(joinCode, publishPlayers) {
    if (!joinCode) return emptyStats('not-configured');

    const address = await resolveAddress(joinCode);

    // Both sources are asked at once rather than in sequence: the listing
    // costs nothing extra in wall-clock time this way, and it is ready to
    // stand in the moment the direct poll comes back empty.
    const [direct, listing] = await Promise.all([
        fetchDirect(address, publishPlayers),
        fetchListing(joinCode, publishPlayers)
    ]);

    const stats = direct || listing;
    if (!stats) {
        return emptyStats(address ? 'unreachable' : 'unresolved');
    }

    // A listing hit with a direct miss still means the server is up; the
    // hostname is worth keeping either way, since it is the only place the
    // board gets the server's real name.
    return stats;
}

/**
 * Cached stats. Concurrent callers during a refresh share one upstream
 * round-trip rather than each starting their own — without this, a burst of
 * traffic on a cold cache turns into a burst against the game server.
 */
async function getStats(joinCode, { publishPlayers = PUBLISH_DEFAULT } = {}) {
    if (statsCache.payload && Date.now() < statsCache.expiresAt) {
        return statsCache.payload;
    }
    if (inFlight) return inFlight;

    inFlight = refresh(joinCode, publishPlayers)
        .then(payload => {
            statsCache = { payload, expiresAt: Date.now() + STATS_TTL_MS };
            return payload;
        })
        .catch(() => {
            const payload = emptyStats('error');
            // Cache the failure too, briefly. Otherwise every request during
            // an outage retries the upstream immediately.
            statsCache = { payload, expiresAt: Date.now() + STATS_TTL_MS };
            return payload;
        })
        .finally(() => { inFlight = null; });

    return inFlight;
}

/** Test seam: drop every cached value so a case starts from a known state. */
function resetCache() {
    addressCache = { url: null, expiresAt: 0 };
    statsCache = { payload: null, expiresAt: 0 };
    inFlight = null;
}

module.exports = {
    getStats,
    resolveAddress,
    publicPlayer,
    resetCache,
    PUBLISH_DEFAULT,
    STATS_TTL_MS
};
