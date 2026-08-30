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

# ------------------------------------------------------------------ env

if [[ -f "$ENV_FILE" ]]; then
    ok "$ENV_FILE already exists — left untouched"
else
    log "Writing $ENV_FILE"
    cat > "$ENV_FILE" <<EOF
# Enclave RP homepage. Fill in the blanks, then:
#   sudo systemctl restart enclave-home

NODE_ENV=production
PORT=3001
DATA_DIR=$DATA_DIR
PUBLIC_BASE_URL=https://enclaverp.cc
TRUST_PROXY=true

# Live server board
FIVEM_JOIN_CODE=pggedl8
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

cat <<EOF

$(log "Next, by hand")

1. Fill in the Discord values in $ENV_FILE, then:

     sudo systemctl restart enclave-home
     sudo journalctl -u enclave-home -n 30 --no-pager

   With ADMIN_TOTP_SECRET blank, the startup log prints a generated secret.
   Add it to your authenticator app, paste it into $ENV_FILE, and restart
   once more so it survives the next restart.

2. Replace the enclaverp.cc block in /etc/caddy/Caddyfile.

   setup.sh wrote a static block for this domain ("root * \$APP_DIR" and
   "rewrite / /home/index.html"). Delete that whole block and paste the
   contents of:

     $APP_DIR/deploy/Caddyfile.home

   Substitute ##TLS_DIRECTIVE## the same way the store's block does — copy
   the tls line from the store's block above it. Then:

     sudo caddy validate --config /etc/caddy/Caddyfile
     sudo systemctl reload caddy

3. Check it:

     curl -s https://enclaverp.cc/api/health
     curl -s https://enclaverp.cc/api/server

EOF
