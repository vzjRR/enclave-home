'use strict';

/* ---------------------------------------------------------------
   News synced from Discord announcement channels.

   Every message becomes a DRAFT. Nothing reaches the public site until a
   human opens /admin and publishes it. That is the community's choice, and
   it is also the safer default: a channel added to the list by mistake
   costs a few drafts to delete rather than a wrong announcement on the
   homepage.

   On deleting
   -----------
   A post is removed when its message is removed in Discord, which needs
   more care than "it wasn't in the response".

   Each poll asks for the newest 50 messages in a channel. A tracked message
   missing from that response has either been deleted, or has simply aged
   out of the window. Telling those apart is what the `oldestId` comparison
   below does: a missing message NEWER than the oldest one we just saw must
   have been deleted, because it would otherwise have been in the response.
   Anything older is out of view and is left alone.

   Without that check, the first poll of a channel with more than 50
   messages would delete the entire back catalogue.

   Only posts carrying source: 'discord' are ever touched. A post written by
   hand in the console has no source and cannot be removed by anything
   happening in Discord.
--------------------------------------------------------------- */

const TIMEOUT_MS = 8000;
const FETCH_LIMIT = 50;
const MAX_TITLE = 120;

const API = process.env.DISCORD_API_BASE || 'https://discord.com/api/v10';

async function discordGet(token, route) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(`${API}${route}`, {
            signal: controller.signal,
            headers: {
                Authorization: `Bot ${token}`,
                'User-Agent': 'EnclaveRP-Home/1.0'
            }
        });
        if (!response.ok) return { ok: false, status: response.status };
        return { ok: true, status: response.status, body: await response.json() };
    } catch {
        return { ok: false, status: 0 };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Discord's markdown is nearly ours, but its entity syntax is not: a raw
 * `<@1303195553068482591>` renders as a wall of digits on a web page.
 * Custom emoji, channels and roles have the same problem.
 *
 * Spoilers are unwrapped rather than preserved. There is no spoiler
 * affordance on the site, and shipping `||text||` verbatim would publish
 * the hidden text anyway while looking like a typo.
 */
function fromDiscordMarkdown(content) {
    return String(content ?? '')
        .replace(/<a?:(\w+):\d+>/g, ':$1:')
        .replace(/<@!?\d+>/g, '@عضو')
        .replace(/<@&\d+>/g, '@رتبة')
        .replace(/<#\d+>/g, '#قناة')
        .replace(/\|\|([\s\S]+?)\|\|/g, '$1')
        .replace(/^\s*(?:@everyone|@here)\s*$/gm, '')
        .replace(/@everyone|@here/g, '')
        .trim();
}

const IMAGE = /\.(png|jpe?g|gif|webp)(\?|$)/i;

/** First image on a message, from an attachment or an embed. */
function coverImage(message) {
    const attachment = (message.attachments || []).find(item => {
        const type = String(item.content_type || '');
        return type.startsWith('image/') || IMAGE.test(String(item.url || ''));
    });
    if (attachment?.url) return String(attachment.url);

    for (const embed of message.embeds || []) {
        const url = embed?.image?.url || embed?.thumbnail?.url;
        if (url) return String(url);
    }
    return '';
}

/**
 * Split a message into a title and a body.
 *
 * The first line is the title when it is short enough to read as one --
 * announcements are usually written that way. When it is not, the whole
 * message stays as the body and the title is a trimmed version, so nothing
 * is silently lost from the middle of a paragraph.
 */
function splitTitle(text) {
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) return null;

    const first = lines[0].replace(/^#+\s*/, '').replace(/\*\*/g, '');
    if (first.length <= MAX_TITLE && lines.length > 1) {
        return { title: first, body: lines.slice(1).join('\n') };
    }
    return {
        title: first.slice(0, MAX_TITLE).trim() || 'إعلان',
        body: text
    };
}

/** Turn one Discord message into the shape News.create expects, or null. */
function toPost(message, channelId) {
    // Skip anything with no usable text: a bare image drop has no title, and
    // a post whose title we would have to invent is not an announcement.
    const content = fromDiscordMarkdown(message.content);
    const split = content ? splitTitle(content) : null;
    if (!split) return null;

    return {
        input: {
            title: split.title,
            body: split.body,
            tag: 'ديسكورد',
            coverImage: coverImage(message),
            pinned: false,
            // Drafts, always. See the header.
            published: false
        },
        origin: {
            source: 'discord',
            sourceMessageId: String(message.id),
            sourceChannelId: String(channelId),
            createdAt: message.timestamp || new Date().toISOString()
        }
    };
}

/**
 * Sync one channel. Returns a status the admin console can show, so a
 * missing permission is visible in the UI rather than only in the journal.
 */
async function syncChannel({ token, channelId, news }) {
    const result = await discordGet(token,
        `/channels/${encodeURIComponent(channelId)}/messages?limit=${FETCH_LIMIT}`);

    if (!result.ok) {
        const reason = result.status === 403 ? 'no-access'
            : result.status === 404 ? 'not-found'
                : result.status === 429 ? 'rate-limited'
                    : 'unreachable';
        return { channelId, ok: false, reason, added: 0, removed: 0 };
    }

    const messages = Array.isArray(result.body) ? result.body : [];
    let added = 0;
    let removed = 0;

    // Oldest first, so a burst of new announcements keeps its order.
    for (const message of [...messages].reverse()) {
        if (news.findBySourceMessage(String(message.id))) continue;
        const post = toPost(message, channelId);
        if (!post) continue;
        try {
            await news.create(post.input, 'Discord', post.origin);
            added++;
        } catch {
            // One malformed message must not stop the rest of the channel.
        }
    }

    // See the header: only messages newer than the oldest one this response
    // carried can be judged deleted. Discord snowflakes sort chronologically
    // as BigInts, which is what makes the comparison valid.
    if (messages.length) {
        const seen = new Set(messages.map(message => String(message.id)));
        const oldestId = messages
            .map(message => BigInt(message.id))
            .reduce((low, id) => (id < low ? id : low));

        for (const post of news.fromDiscord(channelId)) {
            if (seen.has(post.sourceMessageId)) continue;
            let id;
            try {
                id = BigInt(post.sourceMessageId);
            } catch {
                continue;
            }
            if (id <= oldestId) continue;   // aged out of the window, not deleted
            if (await news.removeBySourceMessage(post.sourceMessageId)) removed++;
        }
    }

    return { channelId, ok: true, reason: null, added, removed };
}

/**
 * Sync every configured channel. Never throws: this runs on a timer, and a
 * Discord outage must not take the service down with it.
 */
async function sync({ token, channelIds, news }) {
    if (!token) return { ok: false, reason: 'no-bot-token', channels: [] };
    if (!Array.isArray(channelIds) || !channelIds.length) {
        return { ok: false, reason: 'no-channels', channels: [] };
    }

    const channels = [];
    // Sequential rather than parallel. Eleven channels is nothing, and a
    // burst of parallel calls is the shape that trips Discord's per-route
    // rate limiter for no gain in wall-clock time that anyone would notice.
    for (const channelId of channelIds) {
        try {
            channels.push(await syncChannel({ token, channelId, news }));
        } catch {
            channels.push({ channelId, ok: false, reason: 'error', added: 0, removed: 0 });
        }
    }

    return {
        ok: true,
        reason: null,
        channels,
        added: channels.reduce((sum, channel) => sum + channel.added, 0),
        removed: channels.reduce((sum, channel) => sum + channel.removed, 0),
        syncedAt: new Date().toISOString()
    };
}

module.exports = { sync, syncChannel, fromDiscordMarkdown, splitTitle, toPost, coverImage };
