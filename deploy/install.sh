#!/usr/bin/env bash
#
# Install the Enclave RP homepage alongside the store.
#
#   sudo bash deploy/install.sh
#
# Mirrors the store's deploy/setup.sh conventions: the same service user,
# the same /opt layout, an env file in /etc, a version-controlled unit.
#
# What this does NOT do, on purpose: touch /etc/caddy/Caddyfile. That file
# is serving the live store, and a script that rewrites it is one bad regex
# away from taking payments offline. The Caddy block is printed at the end
# for you to paste, and the change it replaces is a block setup.sh wrote.

set -euo pipefail

APP_DIR=/opt/enclave-home/app
DATA_DIR=/opt/enclave-home/data
ENV_FILE=/etc/enclave-home.env
SERVICE_USER=enclave
REPO=https://github.com/vzjRR/enclave-home
BRANCH="${BRANCH:-main}"

log()  { printf '\033[1;35m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m  ! \033[0m%s\n' "$1"; }
ok()   { printf '\033[1;32m  ✓ \033[0m%s\n' "$1"; }

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

# ------------------------------------------------------------------ node

if ! command -v node >/dev/null; then
    echo "node is not installed — the store needs it too, so something is off" >&2
    exit 1
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 18 )); then
    echo "node $node_major is too old; this needs 18 or newer" >&2
    exit 1
fi
ok "node $(node -v)"

# ------------------------------------------------------------------ user

# The store's setup.sh creates this user. Reuse it rather than adding a
# second one: both services are the same operator with the same blast
# radius, and two users means two sets of permissions to keep straight.
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    log "Creating service user $SERVICE_USER"
    useradd --system --home /opt/enclave-home --shell /usr/sbin/nologin "$SERVICE_USER"
else
    ok "service user $SERVICE_USER already exists (shared with the store)"
fi

# ------------------------------------------------------------- checkout

log "Installing to $APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
    git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
    git -C "$APP_DIR" fetch --quiet --all
    git -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
    ok "updated existing checkout to origin/$BRANCH"
else
    git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
    ok "cloned $BRANCH"
fi

chown -R "$SERVICE_USER:$SERVICE_USER" /opt/enclave-home
# news.json can contain unpublished drafts; keep it off other users' eyes.
chmod 750 "$DATA_DIR"

# ----------------------------------------------------------------- port

# Do not assume 3001 is free. This box already runs the store on 3000 and,
# in at least one deployment, a third service on 3001 -- an assumption that
# cost an operator a crash loop and a puzzling 404 from someone else's app
# answering on the port we expected to own.
#
# `ss` is not guaranteed present, so the real test is the one that matters:
# ask the kernel for the port the same way the service will, using the Node
# that is already a hard dependency.
port_free() {
    node -e '
        const net = require("net");
        const server = net.createServer();
        server.once("error", () => process.exit(1));
        server.listen(Number(process.argv[1]), "127.0.0.1", () => {
            server.close(() => process.exit(0));
        });
    ' "$1" 2>/dev/null
}

pick_port() {
    local candidate=$1
    local limit=$((candidate + 40))
    while (( candidate < limit )); do
        if port_free "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
        candidate=$((candidate + 1))
    done
    return 1
}

# ------------------------------------------------------------------ env

if [[ -f "$ENV_FILE" ]]; then
    ok "$ENV_FILE already exists — left untouched"

    # It is left untouched, but a stale port in it is worth naming now
    # rather than leaving someone to find it in `journalctl` later.
    existing_port="$(grep -m1 '^PORT=' "$ENV_FILE" | cut -d= -f2- | tr -d '[:space:]')"
    if [[ -n "$existing_port" ]] && ! port_free "$existing_port"; then
        warn "PORT=$existing_port in $ENV_FILE is already in use by another process."
        warn "The service will fail to start with EADDRINUSE. Pick a free port:"
        suggestion="$(pick_port "$existing_port" || echo '')"
        if [[ -n "$suggestion" ]]; then
            warn "  sed -i 's/^PORT=.*/PORT=$suggestion/' $ENV_FILE"
            warn "  and match it in the reverse_proxy line of your Caddy block."
        fi
    fi
    PORT_CHOSEN="${existing_port:-3001}"
else
    PORT_CHOSEN="$(pick_port 3001)" || {
        echo "no free port found in 3001-3040" >&2
        exit 1
    }
    if [[ "$PORT_CHOSEN" != "3001" ]]; then
        warn "3001 is taken on this host; using $PORT_CHOSEN instead."
    fi

    log "Writing $ENV_FILE (port $PORT_CHOSEN)"
    cat > "$ENV_FILE" <<EOF
# Enclave RP homepage. Fill in the blanks, then:
#   sudo systemctl restart enclave-home

NODE_ENV=production
PORT=$PORT_CHOSEN
DATA_DIR=$DATA_DIR
PUBLIC_BASE_URL=https://enclaverp.cc
TRUST_PROXY=true

# Live server board
FIVEM_JOIN_CODE=dggpkvq
FIVEM_PUBLISH_PLAYER_LIST=false

# Discord stats (the invite alone is enough — no token required)
DISCORD_GUILD_ID=1535571261395312680
DISCORD_INVITE_CODE=7KuYSBX4A

# Admin sign-in. Same Discord app as the store; its redirect list must
# include https://enclaverp.cc/auth/discord/callback exactly.
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
OWNER_DISCORD_ID=
ADMIN_DISCORD_IDS=

# Break-glass login. Leave blank for the first start: the service prints a
# generated secret to the journal, which you add to an authenticator app
# and then paste back in here.
ADMIN_TOTP_SECRET=

# Store
STORE_API_BASE=https://store.enclaverp.cc
STORE_URL=https://store.enclaverp.cc
EOF
    ok "created — it still needs the Discord values filling in"
fi

# ------------------------------------------------- inherited credentials

# The homepage and the store are the same Discord app, the same bot and the
# same staff list, so five of the values below already exist on this box in
# the store's env file. Copy them rather than asking someone to paste a bot
# token twice -- a token retyped by hand is a token typo'd by hand, and the
# failure looks exactly like a Discord outage.
#
# Nothing is echoed: the script reports which keys it copied, never what
# they contain.
STORE_ENV=/etc/enclave.env

if [[ -f "$STORE_ENV" ]]; then
    log "Inheriting shared Discord configuration from $STORE_ENV"
    # Python rather than sed: a bot token and a client secret contain
    # characters that are awkward as sed delimiters, and a silently mangled
    # credential is worse than an obviously missing one.
    SRC="$STORE_ENV" DST="$ENV_FILE" python3 - <<'PYEOF'
import os

SRC, DST = os.environ['SRC'], os.environ['DST']
KEYS = [
    'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN',
    'OWNER_DISCORD_ID', 'ADMIN_DISCORD_IDS',
]

def read_env(path):
    values = {}
    with open(path, encoding='utf-8') as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, value = line.split('=', 1)
            values[key.strip()] = value.strip()
    return values

source = read_env(SRC)
lines = open(DST, encoding='utf-8').read().splitlines()

copied, missing, written = [], [], set()
for index, line in enumerate(lines):
    if '=' not in line or line.lstrip().startswith('#'):
        continue
    key = line.split('=', 1)[0].strip()
    if key in KEYS and source.get(key):
        lines[index] = f'{key}={source[key]}'
        copied.append(key)
        written.add(key)

for key in KEYS:
    if key in written:
        continue
    if source.get(key):
        lines.append(f'{key}={source[key]}')
        copied.append(key)
    else:
        missing.append(key)

open(DST, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')

for key in copied:
    print(f'  \033[1;32m  \u2713 \033[0mcopied {key}')
for key in missing:
    print(f'  \033[1;33m  ! \033[0m{key} is empty in {SRC} too -- fill it by hand')
PYEOF
else
    warn "No $STORE_ENV on this host, so nothing to inherit."
    warn "Fill DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN and"
    warn "OWNER_DISCORD_ID in $ENV_FILE by hand."
fi

# The file holds a bot token and a client secret.
chown root:"$SERVICE_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# --------------------------------------------------------------- service

log "Installing the systemd unit"
install -m 644 "$APP_DIR/deploy/enclave-home.service" /etc/systemd/system/enclave-home.service
systemctl daemon-reload
systemctl enable --quiet enclave-home
ok "enclave-home enabled"

# ----------------------------------------------------------------- done

# Build the Caddy block the operator has to paste, with both variables that
# can differ per host already substituted: the TLS line (copied from the
# store's own block, so certificates are handled identically) and the port
# chosen above. Generating it here is what stops the port in the env file
# and the port in the reverse_proxy line from drifting apart -- the failure
# that produces is a 502 with nothing obviously wrong in either file.
BLOCK_OUT=/tmp/enclaverp-caddy-block.conf
TLS_LINE="$(grep -m1 -E '^[[:space:]]*tls[[:space:]]' /etc/caddy/Caddyfile 2>/dev/null || true)"
if [[ -z "$TLS_LINE" ]]; then
    TLS_LINE=$'\t# TLS handled automatically by Caddy (Let\'s Encrypt)'
fi

sed -e "s|##TLS_DIRECTIVE##|${TLS_LINE}|" \
    -e "s|127\.0\.0\.1:3001|127.0.0.1:${PORT_CHOSEN}|" \
    "$APP_DIR/deploy/Caddyfile.home" > "$BLOCK_OUT"
chmod 644 "$BLOCK_OUT"
ok "Caddy block written to $BLOCK_OUT (upstream 127.0.0.1:$PORT_CHOSEN)"

cat <<EOF

$(log "Next, by hand")

1. Fill in anything still blank in $ENV_FILE, then:

     sudo systemctl restart enclave-home
     sudo journalctl -u enclave-home -n 30 --no-pager
     curl -s http://127.0.0.1:$PORT_CHOSEN/api/health

   With ADMIN_TOTP_SECRET blank, the startup log prints a generated secret.
   Add it to your authenticator app, paste it into $ENV_FILE, and restart
   once more so it survives the next restart.

   Do not go to step 2 until that curl returns {"ok":true,...}. While the
   service is down the old static page keeps serving visitors, which is the
   safe state to debug from.

2. Replace the enclaverp.cc block in /etc/caddy/Caddyfile.

   setup.sh wrote a static block for this domain ("root * \\$APP_DIR" and
   "rewrite / /home/index.html"). See it with:

     sudo awk '/^enclaverp\.cc/,/^}/' /etc/caddy/Caddyfile

   Back up, delete that whole block, and paste the contents of:

     $BLOCK_OUT

   Then, before reloading — a syntax error here takes the store down too:

     sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak
     sudo caddy validate --config /etc/caddy/Caddyfile
     sudo systemctl reload caddy

3. Check it:

     curl -s https://enclaverp.cc/api/health
     curl -s https://enclaverp.cc/api/server

EOF
