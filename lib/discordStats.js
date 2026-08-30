'use strict';

/* ---------------------------------------------------------------
   Discord community stats.

   Two ways to ask, in order of preference:

   1. A bot token — GET /guilds/{id}?with_counts=true. Needs the bot to be
      in the guild, which the Enclave bot already is (the store uses the
      same token to check membership on every sign-in).
   2. The invite code — GET /invites/{code}?with_counts=true. No auth at
      all, so it works before a token is configured, but it is tied to one
      invite: if that invite is revoked or expires, the numbers stop.

   The guild's widget would be a third option and would carry richer data
   (voice channels, an online roster) with no token, but it is currently
   disabled on this guild.

   Never throws. Discord being unreachable is a state to report.
--------------------------------------------------------------- */

const TIMEOUT_MS = 6000;
const TTL_MS = 60 * 1000;

const API = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';

let cache = { payload: null, expiresAt: 0 };
let inFlight = null;

async function getJson(url, headers) {
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

function empty(reason) {
    return {
        available: false,
        reason,
        members: 0,
        online: 0,
        name: '',
        checkedAt: new Date().toISOString()
    };
}

function shape(source, raw) {
    return {
        available: true,
        reason: null,
        members: Number(raw.approximate_member_count) || 0,
        online: Number(raw.approximate_presence_count) || 0,
        name: String(raw.name ?? raw.guild?.name ?? ''),
        source,
        checkedAt: new Date().toISOString()
    };
}

async function refresh({ guildId, inviteCode, botToken }) {
    if (botToken && guildId) {
        const guild = await getJson(
            `${API}/guilds/${encodeURIComponent(guildId)}?with_counts=true`,
            { Authorization: `Bot ${botToken}` }
        );
        if (guild) return shape('bot', guild);
        // Fall through rather than return: a revoked token or a bot removed
        // from the guild should degrade to the invite, not to nothing.
    }

    if (inviteCode) {
        const invite = await getJson(
            `${API}/invites/${encodeURIComponent(inviteCode)}?with_counts=true`
        );
        // The invite response nests the guild, and carries the counts at the
        // top level alongside it.
        if (invite) {
            return shape('invite', { ...invite, name: invite.guild?.name });
        }
    }

    return empty(botToken || inviteCode ? 'unreachable' : 'not-configured');
}

async function getStats(config) {
    if (cache.payload && Date.now() < cache.expiresAt) return cache.payload;
    if (inFlight) return inFlight;

    inFlight = refresh(config)
        .then(payload => {
            cache = { payload, expiresAt: Date.now() + TTL_MS };
            return payload;
        })
        .catch(() => {
            const payload = empty('error');
            cache = { payload, expiresAt: Date.now() + TTL_MS };
            return payload;
        })
        .finally(() => { inFlight = null; });

    return inFlight;
}

function resetCache() {
    cache = { payload: null, expiresAt: 0 };
    inFlight = null;
}

module.exports = { getStats, resetCache, TTL_MS };
