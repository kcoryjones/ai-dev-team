#!/bin/sh
set -eu

runtime_uid="${ENGINEERING_TEAM_UID:-1000}"
runtime_gid="${ENGINEERING_TEAM_GID:-1000}"

case "$runtime_uid:$runtime_gid" in
  *[!0-9:]*|:*|*:)
    echo "ENGINEERING_TEAM_UID and ENGINEERING_TEAM_GID must be numeric" >&2
    exit 1
    ;;
esac

if [ "$(id -u)" = "0" ]; then
  chown -R "$runtime_uid:$runtime_gid" /data
  chown "$runtime_uid:$runtime_gid" /worktrees
  umask 002
  exec gosu "$runtime_uid:$runtime_gid" "$@"
fi

exec "$@"

