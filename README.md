# Enclave RP — enclaverp.cc

The official homepage for the Enclave RP FiveM community: live server
status, news and announcements, the newest items from the store, and
Discord activity. Arabic, right-to-left.

Node.js, **zero runtime dependencies** — the same footing as
[the store](https://github.com/vzjRR/Enclave-RP-Store), which it shares a
design system, a box and a Discord app with, but not a process.

---

## Running locally

```bash
node server.js
# http://localhost:3001
```

```bash
npm test        # 74 assertions: identifier leakage, path traversal,
                # CSRF and cross-origin writes, draft visibility, upstream
                # outage and recovery, cache behaviour — driven against a
                # stubbed Cfx.re/Discord/store, not mocks of our own modules
```

If `ADMIN_TOTP_SECRET` is unset the server mints a random one and prints it
at startup, so a deployment is never protected by a credential that is
public knowledge.

---

## How the page holds up

`index.html` is a complete document. It renders, reads and links correctly
with **JavaScript disabled and every API down** — the join, Discord and
store buttons are server-side redirects (`/connect`, `/discord`, `/store`)
rather than values templated into the markup, so they work without the page
knowing any configuration.

On top of that, `js/home.js` fills in four sections from four independent
requests. Each one either improves its own section or leaves the served
markup alone; none can blank another. A dead game server costs the status
board, not the page.

This matters more than it sounds. Before this service, `enclaverp.cc` was a
static file served straight off disk by Caddy, deliberately, so the landing
page survived the store's Node process going down. Replacing that with a
backend gives that guarantee up unless the pages are built to not need it.

---

## Where the data comes from

| Section | Source | Cached |
|---|---|---|
| Live server | `cfx.re/join/<code>` → `x-citizenfx-url` → the server's `/dynamic.json` and `/players.json`, with the Cfx.re listing API as a fallback | 30 s |
| Player position mini-map | The same server, `/enclave-positions/positions.json` — a companion FXServer resource, not a Cfx.re endpoint (see below) | 30 s |
| Discord | `GET /guilds/{id}?with_counts=true` with a bot token, falling back to `GET /invites/{code}?with_counts=true` with no auth at all | 60 s |
| Store | `GET /api/store` on the store — its existing public catalogue, sorted by `createdAt` | 120 s |
| News | `news.json` in `DATA_DIR`, written by the admin console | in-process |

Every upstream is fetched **server-side**. None of them sends CORS headers,
and more to the point, a browser-side fetch would turn one visitor into one
request against the game server. Concurrent callers on a cold cache share a
single round trip rather than each starting their own.

The join code is resolved to an address on every refresh instead of being
hardcoded, so the site follows the server if its IP changes.

### What is deliberately not published

- **FiveM player identifiers.** `/players.json` returns `steam:`,
  `license:`, `discord:` and `ip:` identifiers plus an `endpoint` field
  holding the player's own IP address. `lib/fivem.js` reduces each entry to
  name and ping before it goes anywhere near a response. The player list is
  off entirely unless `FIVEM_PUBLISH_PLAYER_LIST=true`.
- **The game server's address.** It is resolved and used server-side; it is
  not in any browser-reachable payload.
- **A player identity on the position mini-map.** `fivem-resource/
  enclave-positions/` — a small FXServer resource the operator installs
  separately, documented in its own README — publishes `{x, y}` only, no
  name and no player id. The map and the player-name list
  (`FIVEM_PUBLISH_PLAYER_LIST`) are independent toggles on purpose: a shared
  id between the two would let anyone turn both on and match a dot to a name
  by cross-referencing it, which would defeat the point of publishing
  positions without names in the first place.
- **A closed store's catalogue.** The store withholds its inventory while
  shut, on purpose — a scraper should not be able to read the whole
  catalogue out of a shop showing a maintenance notice. This site reads that
  API anonymously and renders an empty state. It does not authenticate as
  staff to see through the gate, and it should not be changed to.

---

## Admin console

`/admin` — write, edit, pin, publish and delete news. Two ways in:

1. **Discord**, for anyone in `OWNER_DISCORD_ID` or `ADMIN_DISCORD_IDS`.
   Membership and identity are verified with the bot's own credentials, not
   the user's, so nobody can influence what the server believes about them.
2. **A TOTP code**, for the owner only, as a break-glass route. Without it a
   misconfigured Discord app locks the only person who can publish out of
   their own site.

Every write carries a session-bound CSRF token in `X-CSRF-Token` *and* has
its `Origin` checked, independently. `SameSite=Lax` on the cookie is a third
layer, not the only one.

Posts are written in a small Markdown subset that is rendered **on the
server** (`lib/markdown.js`). The input is HTML-escaped in full before a
single tag is introduced, so nothing an author types can become markup —
there is no sanitiser pass afterwards because there is nothing left to
sanitise. Rendering server-side also keeps a Markdown library off the page,
which a `script-src 'self'` policy with no CDN would otherwise make awkward.

State lives in JSON files, written atomically (temp file → fsync → rename)
with mutations serialised through a single chain, so two concurrent saves
cannot interleave into a half-written document. `lib/jsonStore.js` provides
that for both `news.json` and `settings.json`.

### News synced from Discord

With `newsSyncEnabled` on, the service polls the configured announcement
channels every five minutes with the bot token and turns each message into
a **draft**. Nothing reaches the public site until someone publishes it in
the console — a channel added by mistake costs a few drafts to delete
rather than a wrong announcement on the homepage.

A post is deleted when its Discord message is deleted. That needs more care
than "it wasn't in the response": each poll sees only the newest 50
messages, so a tracked message can be missing because it was deleted *or*
because it aged out of the window. Only a message newer than the oldest one
the poll returned can be judged deleted — without that check, the first
sync of a busy channel would wipe the entire archive. Posts written by hand
carry no `source` and are never touched.

Per-channel status (ok / no access / not found) is shown in the console, so
a missing bot permission is visible rather than presenting as news that
never arrives.

### Settings

The console's second tab edits the values that change in the ordinary life
of the community. Environment variables **seed** them on first run and are
ignored afterwards — the same one-time-seed idiom the store repo uses for
its payment details — so there is never a question of which is authoritative.

| Editable at `/admin` | Why it is safe to expose |
|---|---|
| FiveM join code | Worst case is a dead join button |
| Discord invite code | Worst case is a dead invite |
| Store URL | Validated `https://` only, so it cannot become a stored redirect |
| Publish player list | A visibility choice for the community to make |
| Publish player position map | Positions only, no name/id (see above); a no-op until `enclave-positions` is installed |
| Server detail fields | Layout only, and validated against an allow-list |
| News sync + channel ids | Reads public announcement channels; posts land as drafts |
| Welcome images + channel | Shows images the bot already posted publicly |

A save applies immediately and drops only the caches whose inputs moved — a
store-URL edit does not throw away a warm FiveM poll.

**Not editable, deliberately.** `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`
and `ADMIN_TOTP_SECRET` because a settings page that can write a secret can
read it back, and the same bot and app run the store too. `OWNER_DISCORD_ID`
and `ADMIN_DISCORD_IDS` because editing who may administer *from inside the
admin console* is a privilege-escalation ladder. `DISCORD_GUILD_ID` because
sign-in checks membership of it. `PORT`, `BIND_HOST`, `DATA_DIR`,
`PUBLIC_BASE_URL` and `STORE_API_BASE` because they must agree with systemd
and Caddy, which a web form cannot update. Those stay in
`/etc/enclave-home.env`, where changing them needs shell access.

The console lists them read-only, so an operator can see what is configured
and knows to reach for the env file rather than hunt for a missing field.
Credentials appear only as "set" or "not set", never as values.

---

## Environment variables

See `.env.example` for the annotated list. The ones without which something
visibly does not work:

| Variable | Required | Purpose |
|---|---|---|
| `FIVEM_JOIN_CODE` | first run only | Seeds the join code; edit it at `/admin` afterwards. |
| `DISCORD_GUILD_ID` | **yes** | Sign-in checks membership of this guild. Not editable in the console. |
| `DISCORD_INVITE_CODE` | first run only | Seeds the invite; edit it at `/admin` afterwards. |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN` | for Discord admin sign-in | Without these, staff use the TOTP route. |
| `OWNER_DISCORD_ID` | **yes** | Who may publish. |
| `ADMIN_TOTP_SECRET` | **yes, in production** | Break-glass login. |
| `PUBLIC_BASE_URL` | for Discord sign-in | The OAuth redirect is built from it. |
| `NODE_ENV=production` | **yes, in production** | Session cookies get the `Secure` flag. |
| `TRUST_PROXY=true` | behind Caddy | A forwarded header is honoured only from a trusted peer. |
| `STORE_API_BASE` | for store highlights | Where the catalogue is fetched from. Infrastructure, not editable in the console. |
| `STORE_URL` | first run only | Seeds where the buttons point; edit it at `/admin` afterwards. |
| `PORT` | no | Whatever the installer found free, starting at `3001` (the store is on `3000`, and a box may run other services). The Caddy block it generates uses the same port. |
| `BIND_HOST` | no | Defaults to `127.0.0.1`. Only widen it for a platform that routes by address rather than through a local proxy. |
| `DATA_DIR` | no | Defaults to `/data` when it exists, else `./data`. On the box: `/opt/enclave-home/data`. |

---

## Deploying

The store's `deploy/setup.sh` already writes a `HOME_DOMAIN` block for this
domain that serves a static file. Replace it with `deploy/Caddyfile.home`,
which proxies to this service and keeps the `cloudflare_only` guard and
security headers from the original.

```bash
sudo install -m 644 deploy/enclave-home.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now enclave-home
sudo systemctl reload caddy
```

The layout mirrors the store's, so the two look the same on the box:
`/opt/enclave-home/app` (checkout), `/opt/enclave-home/data` (news.json),
`/etc/enclave-home.env` (configuration).

One more step on the Discord side: the app needs a **second redirect URI**,
`https://enclaverp.cc/auth/discord/callback`, alongside the store's.

---

## The design system

`css/tokens.css` and `css/styles.css` are vendored from the store repo,
verbatim. It is the source of truth; this site consumes it. Refresh with:

```bash
./deploy/sync-css.sh ../enclave-rp-store
```

Site-specific styling goes in `css/home.css` — never into the two vendored
files, since the next sync would drop it. CI checks for that.

The palette is anchored on hue 262, sampled from the logo. Everything
structural on these pages — the nav, cards, buttons, empty states,
skeletons, tables, modals — already existed in that stylesheet; `home.css`
adds only the status board, the news meta row and the Discord panel.

---

Designed and built by [vzjRR](https://www.tsh87.com).
