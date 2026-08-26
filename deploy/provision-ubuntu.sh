#!/usr/bin/env bash
#
# Provision a fresh Ubuntu 24.04 box (DigitalOcean droplet or anything like it)
# to run this app behind nginx and TLS.
#
#   scp deploy/provision-ubuntu.sh root@YOUR_DROPLET:/root/
#   ssh root@YOUR_DROPLET
#   DOMAIN=badges.example.com bash provision-ubuntu.sh
#
# Re-running is safe: every step checks before it acts.
#
# ---------------------------------------------------------------------------
# WHAT THIS SCRIPT WILL NOT DO, and why
#
#   It never writes a secret you have to keep. The issuer seed, the Xaman
#   credentials and the admin password hash are left BLANK in .env and you fill
#   them in over SSH. A provisioning script that takes an issuer seed puts it in
#   your shell history, in `ps` output, and in whatever log captured this run.
#
#   It does not start the app. The first boot needs those secrets, and a service
#   that crash-loops for ten minutes because it was started too early is a worse
#   first impression than one you start yourself when it is ready.
#
#   It does not run certbot for you. That needs DNS to already point here, which
#   is not something this script can know. It prints the one command.
#
# ---------------------------------------------------------------------------
# THE ONE SETTING THAT CANNOT BE CHANGED LATER
#
#   BADGE_BASE_URL goes inside every badge's NFTokenMint URI, and that field is
#   IMMUTABLE. Every badge minted while it points somewhere depends on that
#   hostname resolving for as long as the badge is meant to mean anything.
#
#   This script sets it to https://$DOMAIN. Use a domain you own and intend to
#   keep. Never a tunnel, never an IP address, never a hostname that belongs to
#   somebody else's free tier. (Ask me how I know.)
# ---------------------------------------------------------------------------

set -euo pipefail

# ---------------------------------------------------------------------------
# Settings. Override any of them on the command line:
#   DOMAIN=badges.example.com APP_USER=poap bash provision-ubuntu.sh
# ---------------------------------------------------------------------------

# The CANONICAL hostname. Every badge ever minted points at this one, in a
# field that cannot be edited, so it is the domain you must still be paying for
# in ten years' time.
DOMAIN="${DOMAIN:-}"
# Extra hostnames that should also serve the site, space or comma separated:
#   DOMAIN=poap.live ALT_DOMAINS=poap.feooh.ca bash provision-ubuntu.sh
# They serve the same app and share the certificate. They are NOT badge origins:
# a badge fetched through one of these still carries the canonical URL, because
# there can only be one and it is already on the ledger.
ALT_DOMAINS="${ALT_DOMAINS:-}"
REPO="${REPO:-git@github.com:team607/xrp-poap.git}"
BRANCH="${BRANCH:-main}"
APP_USER="${APP_USER:-poap}"
APP_DIR="${APP_DIR:-/srv/poap}"
# Deliberately NOT the checkout. The deploy key and the database password live
# in here, and a home directory that is also a git working tree is one
# `git clean -xdf` away from losing both.
HOME_DIR="${HOME_DIR:-/var/lib/$APP_USER}"
DB_NAME="${DB_NAME:-xrpl_poap}"
DB_USER="${DB_USER:-poap}"
NODE_MAJOR="${NODE_MAJOR:-22}"
SERVICE="${SERVICE:-poap}"
APP_PORT="${APP_PORT:-3000}"

# ---------------------------------------------------------------------------

say()  { printf '\n\033[1;33m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\n\033[1;31m!!\033[0m  %s\n' "$*"; }
die()  { warn "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this as root: sudo bash provision-ubuntu.sh"
[ -n "$DOMAIN" ] || die "Set DOMAIN. e.g.  DOMAIN=badges.example.com bash provision-ubuntu.sh"

ALL_DOMAINS="$DOMAIN ${ALT_DOMAINS//,/ }"
for d in $ALL_DOMAINS; do
  case "$d" in
    *[!a-zA-Z0-9.-]*|-*|*.|.*) die "'$d' does not look like a hostname." ;;
  esac
done

# -d for each name, so one certificate covers the lot.
CERT_ARGS=""
for d in $ALL_DOMAINS; do CERT_ARGS="$CERT_ARGS -d $d"; done

if [ -r /etc/os-release ]; then
  . /etc/os-release
  [ "${VERSION_ID:-}" = "24.04" ] || warn "Built for Ubuntu 24.04; this is ${PRETTY_NAME:-unknown}. Continuing."
fi

say "Provisioning $DOMAIN"
[ -n "$ALT_DOMAINS" ] && info "also serving  ${ALT_DOMAINS//,/ }"
info "app user   $APP_USER"
info "app dir    $APP_DIR"
info "database   $DB_NAME"
info "service    $SERVICE (127.0.0.1:$APP_PORT behind nginx)"

# ---------------------------------------------------------------------------
say "1/9  System packages"
# ---------------------------------------------------------------------------

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl gnupg git ufw ripgrep \
  postgresql postgresql-contrib \
  nginx certbot python3-certbot-nginx
info "installed"

# ---------------------------------------------------------------------------
say "2/9  Node $NODE_MAJOR"
# ---------------------------------------------------------------------------

if ! command -v node >/dev/null 2>&1 || \
   [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt "$NODE_MAJOR" ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
info "node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------------------
say "3/9  Service account"
# ---------------------------------------------------------------------------

if ! id -u "$APP_USER" >/dev/null 2>&1; then
  # No login shell and no password: this account exists to own files and run one
  # process. Nothing should ever ssh in as it.
  adduser --system --group --home "$HOME_DIR" --shell /usr/sbin/nologin "$APP_USER"
  info "created $APP_USER"
else
  info "$APP_USER already exists"
  # An earlier version of this script put the home directory inside the
  # checkout. Converge it rather than skipping: a home that is also a git
  # working tree stops `git clone` dead, and one `git clean -xdf` takes the
  # deploy key with it. "Already exists" is not the same as "already right".
  CURRENT_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
  if [ -n "$CURRENT_HOME" ] && [ "$CURRENT_HOME" != "$HOME_DIR" ]; then
    info "moving the home directory: $CURRENT_HOME -> $HOME_DIR"
    install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$HOME_DIR"
    for keep in .ssh .dbpass; do
      [ -e "$CURRENT_HOME/$keep" ] || continue
      if [ -e "$HOME_DIR/$keep" ]; then
        # Both exist: the one in the new home is live, the other is a leftover.
        rm -rf "${CURRENT_HOME:?}/${keep:?}"
        info "  dropped the superseded $keep"
      else
        mv "$CURRENT_HOME/$keep" "$HOME_DIR/$keep"
        info "  kept $keep"
      fi
    done
    usermod -d "$HOME_DIR" "$APP_USER"
    chown -R "$APP_USER:$APP_USER" "$HOME_DIR"
  fi
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$HOME_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$HOME_DIR/.ssh"

# github.com's host keys, pinned from the published fingerprints rather than
# accepted on faith the first time a clone runs.
if [ ! -s "$HOME_DIR/.ssh/known_hosts" ]; then
  ssh-keyscan -t rsa,ecdsa,ed25519 github.com 2>/dev/null \
    | install -o "$APP_USER" -g "$APP_USER" -m 0600 /dev/stdin "$HOME_DIR/.ssh/known_hosts"
  info "recorded github.com host keys — verify against https://api.github.com/meta"
fi

# ---------------------------------------------------------------------------
say "4/9  PostgreSQL"
# ---------------------------------------------------------------------------

systemctl enable --now postgresql

db_exists() { sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$1'" | grep -q 1; }
role_exists() { sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$1'" | grep -q 1; }

DB_PASS_FILE="$HOME_DIR/.dbpass"
if [ -f "$DB_PASS_FILE" ]; then
  DB_PASS="$(cat "$DB_PASS_FILE")"
  info "reusing the existing database password"
else
  # Generated here and never printed. It goes into .env and into this file, both
  # readable only by the service account.
  DB_PASS="$(openssl rand -hex 24)"
  install -o "$APP_USER" -g "$APP_USER" -m 0600 /dev/null "$DB_PASS_FILE"
  printf '%s' "$DB_PASS" > "$DB_PASS_FILE"
  info "generated a database password (stored 0600, never echoed)"
fi

if role_exists "$DB_USER"; then
  sudo -u postgres psql -qc "ALTER ROLE \"$DB_USER\" WITH LOGIN PASSWORD '$DB_PASS'"
else
  sudo -u postgres psql -qc "CREATE ROLE \"$DB_USER\" WITH LOGIN PASSWORD '$DB_PASS'"
fi
db_exists "$DB_NAME" || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
sudo -u postgres psql -qd "$DB_NAME" -c "GRANT ALL ON SCHEMA public TO \"$DB_USER\""
info "database $DB_NAME owned by $DB_USER"

# ---------------------------------------------------------------------------
say "5/9  Application code"
# ---------------------------------------------------------------------------

if [ -d "$APP_DIR/.git" ]; then
  info "updating the existing checkout"
  sudo -H -u "$APP_USER" git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  sudo -H -u "$APP_USER" git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  # git refuses to clone into a non-empty directory, and that has nothing to do
  # with credentials. Diagnose it here, or the handler below blames the deploy
  # key for it and sends the operator off to re-add a key that was never wrong.
  if [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
    warn "$APP_DIR is not empty, and is not a checkout. git clone cannot write into it."
    printf '\n  It contains:\n'
    ls -A "$APP_DIR" | sed 's/^/    /'
    cat <<STALEEOF

  If that is all leftover from an earlier run and none of it is yours:

    find $APP_DIR -mindepth 1 -delete

  Then run this again. Nothing before this point has to be redone.

STALEEOF
    exit 1
  fi

  KEY="$HOME_DIR/.ssh/id_ed25519"
  if [ ! -f "$KEY" ]; then
    sudo -H -u "$APP_USER" ssh-keygen -q -t ed25519 -N "" -f "$KEY" -C "deploy:$DOMAIN"
    info "generated a deploy key"
  fi

  info "cloning $REPO ($BRANCH)"
  CLONE_LOG="$(mktemp)"
  trap 'rm -f "$CLONE_LOG"' EXIT
  if ! sudo -H -u "$APP_USER" git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR" >"$CLONE_LOG" 2>&1; then
    sed 's/^/    /' "$CLONE_LOG"
    printf '\n'
    # Only an authentication failure is a deploy-key problem. Anything else gets
    # git's own words and no invented explanation on top of them.
    if ! grep -qiE 'permission denied|publickey|could not read from remote|authenticat|access rights' "$CLONE_LOG"; then
      die "Clone failed. git's output is above."
    fi
    warn "Clone failed — the repo has not been given this box's key yet."
    cat <<KEYEOF

  Add this as a DEPLOY KEY on the repository. Read-only: leave
  "Allow write access" unchecked, because nothing here ever pushes.

    GitHub -> the repo -> Settings -> Deploy keys -> Add deploy key

$(cat "$KEY.pub")

  Then run this script again. Everything up to here is already done.

  Or skip GitHub entirely and push the tree up from your laptop:

    rsync -av --exclude node_modules --exclude .env --exclude out \\
      ./ root@HOST:$APP_DIR/
    chown -R $APP_USER:$APP_USER $APP_DIR

KEYEOF
    exit 1
  fi
fi

# Dev dependencies stay installed on purpose: `npm run migrate` runs through tsx,
# and the .sql migrations are read from the source tree at runtime.
sudo -H -u "$APP_USER" npm --prefix "$APP_DIR" ci
sudo -H -u "$APP_USER" npm --prefix "$APP_DIR" run build
info "built"

# ---------------------------------------------------------------------------
say "6/9  Configuration"
# ---------------------------------------------------------------------------

ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  info ".env already exists — left exactly as it is"
else
  install -o "$APP_USER" -g "$APP_USER" -m 0600 /dev/null "$ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# Written by provision-ubuntu.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# See .env.example in this repo for what every one of these means.

# --- the ledger ------------------------------------------------------------
# Clio-enabled MAINNET endpoints. s1/s2 serve Clio; xrplcluster.com does not.
XRPL_ENDPOINT=wss://s1.ripple.com
XRPL_FALLBACK_ENDPOINTS=wss://s2.ripple.com
XRPL_NETWORK=mainnet

# --- FILL THESE IN ---------------------------------------------------------
# Never paste the seed on a command line; edit this file over ssh.
ISSUER_SEED=
ISSUER_ADDRESS=

# https://apps.xaman.dev
XUMM_API_KEY=
XUMM_API_SECRET=

# One operator account.  Generate the hash on this box:  npm run admin:hash
ADMIN_EMAIL=
ADMIN_PASSWORD_HASH=
# ---------------------------------------------------------------------------

# Generated here. Rotating it signs everyone out.
SESSION_SECRET=$(openssl rand -hex 32)
SESSION_TTL_HOURS=12

# Badge hosting. THIS ORIGIN IS BAKED INTO EVERY BADGE, PERMANENTLY.
BADGE_BASE_URL=https://$DOMAIN
BADGE_METADATA_URI_MODE=selfhosted
BADGE_IMAGE_URI_MODE=https

# Attribution on every transaction this app submits.
SOURCE_TAG=2607210007
EVENT_NAME=

# Not set, and not needed while BADGE_METADATA_URI_MODE=selfhosted: badge art
# and metadata are generated per request and served from this box. Add
# PINATA_JWT and PINATA_GATEWAY only if you switch a mode back to ipfs/https.
# PINATA_JWT=
# PINATA_GATEWAY=https://gateway.pinata.cloud
# EVENT_METADATA_URI=

# Sponsorship of unactivated attendee wallets. REAL MONEY on mainnet — the
# daily cap is the only thing between a bug and an empty issuer.
SPONSOR_ENABLED=true
SPONSOR_AMOUNT_XRP=1.5
SPONSOR_DAILY_CAP_XRP=50

# The wallet-generating, attendee-signing demo. Never on mainnet; it refuses
# to boot there anyway.
DEMO_ENABLED=false

DATABASE_URL=postgres://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME

# Bound to loopback: nginx is the only thing that may reach it.
PORT=$APP_PORT
HOST=127.0.0.1
# Behind nginx, so the cookie is Secure and the client IP comes from the proxy.
# Rate limiting is keyed on that IP — without this every attendee shares one
# bucket; trusting it from anywhere but the proxy hands out unlimited buckets.
SECURE_COOKIES=true
TRUST_PROXY=127.0.0.1
EOF
  info "wrote .env (0600, $APP_USER) — four values still blank"
fi

# ---------------------------------------------------------------------------
say "7/9  systemd"
# ---------------------------------------------------------------------------

cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=XRPL attendance badges
Documentation=https://$DOMAIN
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
Environment=NODE_ENV=production
Environment=HOME=$HOME_DIR
ExecStart=/usr/bin/node dist/api/server.js
Restart=on-failure
RestartSec=5s
# Give up rather than crash-loop forever on a bad .env; the journal keeps why.
StartLimitBurst=5
StartLimitIntervalSec=120

# This process reads a seed that can spend real money. It gets nothing it does
# not need.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false
# The only writable path: badge manifests and the issuer note.
ReadWritePaths=$APP_DIR/out $HOME_DIR

[Install]
WantedBy=multi-user.target
EOF

install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$APP_DIR/out"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
info "$SERVICE enabled — NOT started, it needs the blank values first"

# ---------------------------------------------------------------------------
say "8/9  nginx"
# ---------------------------------------------------------------------------

cat > "/etc/nginx/sites-available/$SERVICE" <<EOF
# Written by provision-ubuntu.sh. certbot rewrites this to add TLS.
server {
    listen 80;
    listen [::]:80;
    server_name $ALL_DOMAINS;

    # Badge art is rasterised per request and deterministic forever, so let
    # nginx keep it. Everything else is per-attendee and must not be cached.
    location ~ ^/badge/ {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_valid 200 30d;
    }

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 70s;
    }

    client_max_body_size 1m;
}
EOF

ln -sf "/etc/nginx/sites-available/$SERVICE" "/etc/nginx/sites-enabled/$SERVICE"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
info "proxying $DOMAIN -> 127.0.0.1:$APP_PORT"

# ---------------------------------------------------------------------------
say "9/9  Firewall"
# ---------------------------------------------------------------------------

ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
info "ssh and http/https only — postgres and :$APP_PORT are not reachable from outside"

# ---------------------------------------------------------------------------

cat <<EOF

────────────────────────────────────────────────────────────────────────────
 Provisioned. Four things left, and all four need you.
────────────────────────────────────────────────────────────────────────────

 1. Point DNS at this box, then get a certificate:

      certbot --nginx$CERT_ARGS

    Do this BEFORE minting anything. Every badge points at https://$DOMAIN
    forever, so that name has to work forever.

 2. Set the operator password (it prompts silently, prints two lines):

      cd $APP_DIR && sudo -u $APP_USER npm run admin:hash

    Paste them over ADMIN_EMAIL and ADMIN_PASSWORD_HASH in $APP_DIR/.env

 3. Fill in the rest of $APP_DIR/.env:

      ISSUER_SEED       the mainnet issuer. Paste it here and nowhere else.
      ISSUER_ADDRESS    its classic address — startup checks they agree.
      XUMM_API_KEY      from https://apps.xaman.dev
      XUMM_API_SECRET

      sudo -u $APP_USER nano $APP_DIR/.env

 4. Migrate, then start:

      cd $APP_DIR
      sudo -u $APP_USER npm run migrate
      systemctl start $SERVICE
      systemctl status $SERVICE
      journalctl -u $SERVICE -f

 Then open https://$DOMAIN — you should get the front door, and
 https://$DOMAIN/admin to create your first event.

 Before you mint on mainnet, from your laptop against this box:
      npm run check:cutover

 A word on the issuer: it needs enough XRP for the owner reserve on every
 open claim offer (0.2 XRP each, returned when the offer is accepted or
 cancelled) plus $([ -n "${SPONSOR_AMOUNT_XRP:-}" ] && echo "$SPONSOR_AMOUNT_XRP" || echo "1.5") XRP for each attendee whose wallet is not activated.
 SPONSOR_DAILY_CAP_XRP is the ceiling on that second number.

EOF
