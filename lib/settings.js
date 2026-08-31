'use strict';

/* ---------------------------------------------------------------
   Operational settings, editable from the admin console.

   The split here is deliberate, and it is a security boundary rather than
   a matter of taste.

   EDITABLE — things that change in the ordinary life of the community, and
   whose worst case is a broken link:

     fivemJoinCode      the server moved, or was recreated with a new code
     discordInviteCode  the invite expired or was rotated
     storeUrl           where the "visit the store" buttons point
     publishPlayerList  whether the live player names are shown

   NOT EDITABLE, and deliberately absent from this file — anything whose
   worst case is losing control of the site:

     DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, ADMIN_TOTP_SECRET
        Secrets. A settings page that can write them is a settings page
        that can read them back, which turns one hijacked admin session
        into the store's credentials as well -- the same bot and app run
        both sites.
     OWNER_DISCORD_ID, ADMIN_DISCORD_IDS
        These decide who may administer. Editing them from inside the
        admin console is a privilege-escalation ladder: reach the console
        once, add yourself, keep it.
     DISCORD_GUILD_ID
        Sign-in checks membership of this guild. Change it in the browser
        and the next sign-in fails, including yours.
     PORT, BIND_HOST, DATA_DIR, PUBLIC_BASE_URL, STORE_API_BASE
        Infrastructure. These have to agree with systemd and Caddy, which
        a web form cannot update.

   Those stay in /etc/enclave-home.env, where changing them requires shell
   access to the box.

   Environment variables seed this document on first run and are ignored
   afterwards -- the same "one-time seed" idiom the store repo uses for its
   payment details. So an operator can bootstrap from the env file, then
   manage day to day from the console, and the two never fight over which
   is authoritative.
--------------------------------------------------------------- */

const path = require('path');

const { JsonStore } = require('./jsonStore');

// Cfx.re join codes are short and alphanumeric. Validating the shape stops
// a paste of the whole URL ("cfx.re/join/abc123") from being stored as a
// code and failing later as a confusing "unresolved".
const JOIN_CODE = /^[A-Za-z0-9]{4,16}$/;
const INVITE_CODE = /^[A-Za-z0-9-]{2,32}$/;

function fail(message, statusCode = 400) {
    return Object.assign(new Error(message), { statusCode });
}

/** Accepts a bare code or a full join URL, and stores the code either way. */
function normaliseJoinCode(value) {
    const text = String(value ?? '').trim();
    const fromUrl = /(?:cfx\.re\/join\/|fivem:\/\/connect\/)([A-Za-z0-9]+)/i.exec(text);
    return fromUrl ? fromUrl[1] : text;
}

/** Same courtesy for a pasted discord.gg link. */
function normaliseInviteCode(value) {
    const text = String(value ?? '').trim();
    const fromUrl = /(?:discord\.gg\/|discord\.com\/invite\/)([A-Za-z0-9-]+)/i.exec(text);
    return fromUrl ? fromUrl[1] : text;
}

class Settings extends JsonStore {
    constructor(dataDir, seed = {}) {
        super(path.join(dataDir, 'settings.json'), {
            fivemJoinCode: String(seed.fivemJoinCode ?? ''),
            discordInviteCode: String(seed.discordInviteCode ?? ''),
            storeUrl: String(seed.storeUrl ?? ''),
            publishPlayerList: seed.publishPlayerList === true,
            updatedAt: null,
            updatedBy: ''
        });
    }

    /** The values the rest of the app reads. */
    current() {
        return {
            fivemJoinCode: this.state.fivemJoinCode || '',
            discordInviteCode: this.state.discordInviteCode || '',
            storeUrl: this.state.storeUrl || '',
            publishPlayerList: this.state.publishPlayerList === true,
            updatedAt: this.state.updatedAt || null,
            updatedBy: this.state.updatedBy || ''
        };
    }

    #validate(input) {
        const joinCode = normaliseJoinCode(input?.fivemJoinCode);
        if (joinCode && !JOIN_CODE.test(joinCode)) {
            throw fail('رمز الانضمام غير صالح — أحرف وأرقام فقط (مثال: dggpkvq)');
        }

        const inviteCode = normaliseInviteCode(input?.discordInviteCode);
        if (inviteCode && !INVITE_CODE.test(inviteCode)) {
            throw fail('رمز دعوة ديسكورد غير صالح');
        }

        const storeUrl = String(input?.storeUrl ?? '').trim().replace(/\/+$/, '');
        // https only. A settings field that accepts any scheme is a stored
        // redirect waiting to happen, since this value lands in an href on
        // the homepage.
        if (storeUrl && !/^https:\/\/[^\s"'<>]+$/i.test(storeUrl)) {
            throw fail('رابط المتجر يجب أن يبدأ بـ https://');
        }

        return {
            fivemJoinCode: joinCode,
            discordInviteCode: inviteCode,
            storeUrl,
            publishPlayerList: input?.publishPlayerList === true
        };
    }

    /**
     * Save and report which keys actually changed.
     *
     * The caller uses that list to drop only the caches it has to: a store
     * URL edit should not throw away a warm FiveM poll, and re-fetching
     * everything on every save would turn a typo-and-fix into four
     * needless upstream round trips.
     */
    save(input, actor) {
        const fields = this.#validate(input);

        return this.mutate(state => {
            const changed = Object.keys(fields).filter(key => state[key] !== fields[key]);
            Object.assign(state, fields, {
                updatedAt: new Date().toISOString(),
                updatedBy: actor || ''
            });
            return { settings: this.current(), changed };
        });
    }
}

module.exports = { Settings, normaliseJoinCode, normaliseInviteCode };
