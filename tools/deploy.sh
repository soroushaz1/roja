#!/usr/bin/env bash
# Puts this working copy on the server: the site in /var/www/pythonpath, the skin check
# API in /opt/roja-api, its systemd unit and the nginx site. Safe to run again.
#
#   tools/deploy.sh                    # root@204.48.27.227 with ~/.ssh/roja_deploy
#   ROJA_HOST=root@… ROJA_KEY=… tools/deploy.sh
#
# The certificate is set up once, by hand: see README ("Server").
set -euo pipefail
cd "$(dirname "$0")/.."
HOST=${ROJA_HOST:-root@204.48.27.227}
KEY=${ROJA_KEY:-$HOME/.ssh/roja_deploy}
ssh_(){ ssh -i "$KEY" -o BatchMode=yes "$HOST" "$@"; }

node tools/skin-check.mjs >/dev/null
node tools/billing-check.mjs >/dev/null
node tools/build-pages.mjs --check

SITE=(index.html stats.html pages.css sitemap.xml robots.txt makeup faq privacy business roja.css sw.js manifest.webmanifest favicon.svg ./*.js icons fonts vendor)
# The before/after pictures and their page, once there are any (tools/showcase/).
if [ -d showcase ]; then SITE+=(showcase); fi
echo "site → /var/www/pythonpath"
tar -cz "${SITE[@]}" | ssh_ 'set -e
  rm -rf /var/www/pythonpath.new && mkdir -p /var/www/pythonpath.new
  tar -xz -C /var/www/pythonpath.new
  chmod -R a+rX /var/www/pythonpath.new
  if [ -d /var/www/pythonpath ]; then mv /var/www/pythonpath /var/www/pythonpath.old; fi
  mv /var/www/pythonpath.new /var/www/pythonpath
  rm -rf /var/www/pythonpath.old'

# Payment settings for shops' plans (server/billing.mjs), from this script's environment
# (the deploy workflow passes them from the repository's secrets and variables). Each
# one set here replaces its line in the server's /etc/roja-api.env; one not set is left
# as the server has it. Sent on standard input, never on a command line.
ENV_LINES=$(for name in ZARINPAL_MERCHANT ZARINPAL_SANDBOX ROJA_PRICE_MONTH ROJA_PRICE_YEAR; do
  [ -n "${!name:-}" ] && printf '%s=%s\n' "$name" "${!name}"; done; true)
if [ -n "$ENV_LINES" ]; then
  echo "payment settings → /etc/roja-api.env ($(printf '%s\n' "$ENV_LINES" | cut -d= -f1 | tr '\n' ' '))"
  printf '%s\n' "$ENV_LINES" | ssh_ 'set -e
    f=/etc/roja-api.env; umask 077; touch "$f"; new=$(cat)
    names=$(printf "%s\n" "$new" | cut -d= -f1 | paste -sd"|")
    { grep -Ev "^($names)=" "$f" || true; printf "%s\n" "$new"; } > "$f.new"
    chmod 600 "$f.new"; mv "$f.new" "$f"'
fi

echo "api → /opt/roja-api"
tar -cz skin.js catalog.js shops.js server | ssh_ 'set -e
  rm -rf /opt/roja-api.new && mkdir -p /opt/roja-api.new
  tar -xz -C /opt/roja-api.new
  chmod -R a+rX /opt/roja-api.new
  rm -rf /opt/roja-api && mv /opt/roja-api.new /opt/roja-api
  install -m 644 /opt/roja-api/server/roja-api.service /etc/systemd/system/roja-api.service
  install -m 644 /opt/roja-api/server/nginx-pythonpath.conf /etc/nginx/sites-available/pythonpath
  ln -sf /etc/nginx/sites-available/pythonpath /etc/nginx/sites-enabled/pythonpath
  systemctl daemon-reload
  systemctl enable --quiet roja-api
  systemctl restart roja-api
  nginx -t -q && systemctl reload nginx
  sleep 1; systemctl is-active roja-api'
echo "done: https://pythonpath.ir/"
