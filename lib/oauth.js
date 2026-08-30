'use strict';

const crypto = require('crypto');

/* ---------------------------------------------------------------
   Discord OAuth — ported from the store repo (vzjRR/enclave-rp-store).

   Unchanged apart from the "not configured" warning below, which described
   the storefront's checkout. It requires only `crypto`, so the sign-in
   flow, state handling, bot-verified membership and session store carry
   over as they are. Keep the two copies in step.

   Discord sign-in.

   Replaces the six-digit code exchange. That proved someone could
   read a DM sent to an account; this proves they can authenticate as
   it, which is strictly stronger and also tells us who they are —
   their username, their avatar, and which roles they hold in the
   Enclave server. Those roles are what role-based discounts price
   against, so the identity has to be trustworthy end to end.

   The flow, and why each part is there:

     1. /auth/discord/start mints a random state, stores it against a
        short-lived cookie, and redirects to Discord.
     2. Discord sends the visitor back with a code and the state.
        The state must match the cookie, or the callback is somebody
        else's login being replayed into this browser.
     3. The code is exchanged for an access token server-side, using
        the client secret. The token never reaches the browser.
     4. The access token buys exactly one thing: /users/@me, so we
        learn the user's id, name and avatar.
     5. Membership and roles come from the BOT token, not the user's:
        GET /guilds/{guild}/members/{user}. A 404 means "not in the
        server" and the sign-in is refused.

   Step 5 is deliberate. Asking the user for the guilds.members.read
   scope would let the client's own token report its own roles, and a
   discount that keys off a role should not be priced from a claim
   the beneficiary controls. Reading it with the bot token makes the
   server the only source.
--------------------------------------------------------------- */

const DISCORD_API = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TIMEOUT_MS = 8000;

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// state token -> { expiresAt, returnTo }
const pendingStates = new Map();
// session token -> { user, expiresAt, csrfToken }
const sessions = new Map();

async function discordFetch(url, init, token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            ...init,
            signal: controller.signal,
            headers: { ...(init?.headers || {}), ...(token ? { Authorization: token } : {}) }
        });
        const text = await response.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* some errors are not JSON */ }
        return { ok: response.ok, status: response.status, json, text };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @param {object} config
 * @param {string} config.clientId
 * @param {string} config.clientSecret
 * @param {string} config.botToken     used for the membership/role lookup
 * @param {string} config.guildId      the server a customer must belong to
 * @param {string} config.publicBaseUrl
 * @param {string} config.ownerId
 * @param {string[]} config.adminIds
 */
function createOauth(config) {
    const {
        clientId = '', clientSecret = '', botToken = '',
        guildId = '', publicBaseUrl = '', ownerId = '', adminIds = []
    } = config;

    const configured = Boolean(clientId && clientSecret && guildId && publicBaseUrl);
    const redirectUri = publicBaseUrl ? `${publicBaseUrl.replace(/\/+$/, '')}/auth/discord/callback` : '';

    if (!configured) {
        console.warn(
            'Discord sign-in is not configured (needs DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, ' +
            'DISCORD_GUILD_ID and PUBLIC_BASE_URL). Staff must use the owner TOTP fallback to ' +
            'reach the news console.'
        );
    }

    const staffRole = id => {
        if (ownerId && id === ownerId) return 'owner';
        if (adminIds.includes(id)) return 'admin';
        return null;
    };

    return {
        configured,
        redirectUri,
        guildId,

        /** Begin sign-in. Returns { url, state } — the caller sets the cookie. */
        begin({ returnTo = '/' } = {}) {
            const state = crypto.randomBytes(32).toString('base64url');
            pendingStates.set(state, {
                expiresAt: Date.now() + STATE_TTL_MS,
                // Only same-site paths, never an absolute URL: otherwise the
                // login endpoint becomes an open redirect that launders a
                // hostile link through our own domain.
                returnTo: /^\/[^/\\]/.test(returnTo) ? returnTo : '/'
            });

            const params = new URLSearchParams({
                client_id: clientId,
                redirect_uri: redirectUri,
                response_type: 'code',
                // `identify` only. Membership and roles are read with the bot
                // token instead, so the user cannot influence what we believe
                // about their roles — see the header comment.
                scope: 'identify',
                state
                // No `prompt` parameter. `prompt=none` would skip the
                // consent screen for people who have authorised before,
                // but its behaviour for a first-time authoriser is not
                // worth gambling the whole sign-in path on: omitting it
                // costs one extra click, getting it wrong costs every
                // sale.
            });
            return { url: `${AUTHORIZE_URL}?${params}`, state };
        },

        consumeState(state) {
            const record = pendingStates.get(state);
            if (!record) return null;
            pendingStates.delete(state);
            if (Date.now() > record.expiresAt) return null;
            return record;
        },

        /**
         * Finish sign-in. Resolves to { ok, reason, user } and never throws.
         *
         * `user` carries the Discord identity, the roles the BOT sees for
         * them in the guild, and the staff level derived from the configured
         * owner/admin IDs.
         */
        async complete(code) {
            if (!configured) return { ok: false, reason: 'not-configured' };

            const tokenResponse = await discordFetch(`${DISCORD_API}/oauth2/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: clientId,
                    client_secret: clientSecret,
                    grant_type: 'authorization_code',
                    code,
                    redirect_uri: redirectUri
                }).toString()
            });
            if (!tokenResponse.ok || !tokenResponse.json?.access_token) {
                return { ok: false, reason: 'token-exchange-failed' };
            }

            const me = await discordFetch(`${DISCORD_API}/users/@me`, {},
                `Bearer ${tokenResponse.json.access_token}`);
            if (!me.ok || !me.json?.id) {
                return { ok: false, reason: 'identity-failed' };
            }

            const identity = me.json;

            // Membership and roles, read with the bot's own credentials.
            let roles = [];
            let nickname = '';
            if (botToken) {
                const member = await discordFetch(
                    `${DISCORD_API}/guilds/${guildId}/members/${identity.id}`, {}, `Bot ${botToken}`);
                if (member.status === 404) {
                    return { ok: false, reason: 'not-a-member' };
                }
                if (!member.ok) {
                    // Fail closed. Letting someone through when we could not
                    // confirm membership would quietly turn the requirement
                    // into a suggestion, and would price role discounts off
                    // an empty role list.
                    return { ok: false, reason: 'membership-check-failed' };
                }
                roles = Array.isArray(member.json?.roles) ? member.json.roles : [];
                nickname = member.json?.nick || '';
            } else {
                return { ok: false, reason: 'membership-check-failed' };
            }

            const displayName = nickname
                || identity.global_name
                || identity.username;

            return {
                ok: true,
                user: {
                    id: identity.id,
                    username: identity.username,
                    displayName,
                    avatarUrl: identity.avatar
                        ? `https://cdn.discordapp.com/avatars/${identity.id}/${identity.avatar}.png?size=128`
                        : '',
                    roles,
                    staffRole: staffRole(identity.id)
                }
            };
        },

        /* ---------------------------- sessions ---------------------------- */

        createSession(user) {
            const token = crypto.randomBytes(32).toString('base64url');
            const csrfToken = crypto.randomBytes(32).toString('base64url');
            sessions.set(token, { user, csrfToken, expiresAt: Date.now() + SESSION_TTL_MS });
            return { token, csrfToken };
        },

        getSession(token) {
            if (!token) return null;
            const record = sessions.get(token);
            if (!record) return null;
            if (Date.now() > record.expiresAt) {
                sessions.delete(token);
                return null;
            }
            return record;
        },

        destroySession(token) {
            if (token) sessions.delete(token);
        },

        /**
         * Re-read roles and membership for a live session.
         *
         * Roles change, and people leave servers. A twelve-hour session that
         * never rechecks would keep honouring a role discount for someone who
         * lost the role that morning, so this runs before anything is priced.
         */
        async refresh(token) {
            const record = sessions.get(token);
            if (!record || !botToken) return record ? record.user : null;

            const member = await discordFetch(
                `${DISCORD_API}/guilds/${guildId}/members/${record.user.id}`, {}, `Bot ${botToken}`);

            if (member.status === 404) {
                sessions.delete(token);
                return null;
            }
            if (member.ok) {
                record.user.roles = Array.isArray(member.json?.roles) ? member.json.roles : [];
                if (member.json?.nick) record.user.displayName = member.json.nick;
            }
            // A transient API failure leaves the cached roles in place rather
            // than emptying them, which would silently drop a customer's
            // discount mid-checkout.
            return record.user;
        },

        sweep() {
            const now = Date.now();
            for (const [key, record] of pendingStates) {
                if (now > record.expiresAt) pendingStates.delete(key);
            }
            for (const [key, record] of sessions) {
                if (now > record.expiresAt) sessions.delete(key);
            }
        },

        /** Test seam. */
        reset() {
            pendingStates.clear();
            sessions.clear();
        }
    };
}

module.exports = { createOauth };
