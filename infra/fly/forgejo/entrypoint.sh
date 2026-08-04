#!/bin/sh
# zapp.build — seed /data/gitea/conf/app.ini on first boot, then hand over to
# the upstream entrypoint (GIT-1).
#
# The same three lines the dev stack runs inline in compose, in a file because a
# Fly machine has no `entrypoint:` override to inline them into. The condition is
# the whole point: **first boot only.** Forgejo appends its generated SECRET_KEY
# and INTERNAL_TOKEN to its own copy, and a seed that overwrote that copy on
# every boot would rotate the key that encrypts every stored credential — every
# webhook secret and every mirror password unreadable, on a restart nobody
# thought was a migration.
#
# `environment-to-ini` (upstream, run by the image's own init) merges every
# FORGEJO__section__KEY variable into the copy afterwards, on every boot. That is
# where the per-environment values and the only secrets live — see the header of
# infra/docker/forgejo/app.ini.prod.
set -eu

CONF_DIR=/data/gitea/conf
SEED=/etc/forgejo/app.ini.seed

mkdir -p "$CONF_DIR"
if [ ! -f "$CONF_DIR/app.ini" ]; then
  echo "[zapp] seeding $CONF_DIR/app.ini from $SEED"
  cp "$SEED" "$CONF_DIR/app.ini"
  chmod 0660 "$CONF_DIR/app.ini"
fi
chown -R 1000:1000 "$CONF_DIR"

exec /usr/bin/entrypoint "$@"
