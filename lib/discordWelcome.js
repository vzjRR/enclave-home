'use strict';

/* ---------------------------------------------------------------
   Welcome images from the Discord join channel.

   A bot posts a welcome card per new member. The site shows the newest ten
   of those images and nothing else -- no names, no text. That is what was
   asked for, and it is also the version that publishes least: a welcome
   card is a picture the community already made public in its own server,
   whereas the surrounding message text tends to carry the member's handle.

   On the cache TTL
   ----------------
   Discord attachment URLs are signed and expire (they carry ?ex=&is=&hm=).
   A URL held for hours renders as a broken image, so the window here is
   deliberately short and the URLs are never written to disk. Re-fetching is
   what re-signs them.
--------------------------------------------------------------- */

const TIMEOUT_MS = 8000;
const TTL_MS = 5 * 60 * 1000;
const FETCH_LIMIT = 25;
const MAX_IMAGES = 10;

const API = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';
const IMAGE = /\.(png|jpe?g|gif|webp)(\?|$)/i;

let cache = { payload: null, expiresAt: 0 };
let inFlight = null;

function empty(reason) {
    return { available: false, reason, images: [], checkedAt: new Date().toISOString() };
}

async function refresh({ token, channelId }) {
    if (!token) return empty('no-bot-token');
    if (!channelId) return empty('not-configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let body;
    try {
        const response = await fetch(
            `${API}/channels/${encodeURIComponent(channelId)}/messages?limit=${FETCH_LIMIT}`,
            {
                signal: controller.signal,
                headers: {
                    Authorization: `Bot ${token}`,
                    'User-Agent': 'EnclaveRP-Home/1.0'
                }
            }
        );
        if (response.status === 403) return empty('no-access');
        if (response.status === 404) return empty('not-found');
        if (!response.ok) return empty('unreachable');
        body = await response.json();
    } catch {
        return empty('unreachable');
    } finally {
        clearTimeout(timer);
    }

    const messages = Array.isArray(body) ? body : [];
    const images = [];

    for (const message of messages) {
        const attachment = (message.attachments || []).find(item => {
            const type = String(item.content_type || '');
            return type.startsWith('image/') || IMAGE.test(String(item.url || ''));
        });
        const url = attachment?.url
            || (message.embeds || [])
                .map(embed => embed?.image?.url || embed?.thumbnail?.url)
                .find(Boolean);
        if (!url) continue;

        // Nothing but the picture: no author, no content, no timestamp. The
        // id is here only so the client has a stable key to render against.
        images.push({ id: String(message.id), url: String(url) });
        if (images.length >= MAX_IMAGES) break;
    }

    return {
        available: true,
        reason: null,
        images,
        checkedAt: new Date().toISOString()
    };
}

async function getImages(config) {
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

module.exports = { getImages, resetCache, TTL_MS, MAX_IMAGES };
