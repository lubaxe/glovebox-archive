#!/bin/sh
# Started as root: give the writable folders to PUID:PGID, then import as
# that user. Started with `user:` already set, it just runs.
set -e
if [ "$(id -u)" = 0 ]; then
  uid=${PUID:-1000} gid=${PGID:-1000}
  for dir in /imports /config/rclone; do
    mkdir -p "$dir"
    chown "$uid:$gid" "$dir"
  done
  exec su-exec "$uid:$gid" "$@"
fi
exec "$@"
