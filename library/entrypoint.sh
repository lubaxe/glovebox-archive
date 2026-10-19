#!/bin/sh
# Started as root: give the writable folders to PUID:PGID (Docker creates a
# missing bind-mount folder as root), then run the app as that user. Started
# with `user:` already set, it just runs the app.
set -e
if [ "$(id -u)" = 0 ]; then
  uid=${PUID:-1000} gid=${PGID:-1000}
  for dir in /data /retained; do
    mkdir -p "$dir"
    # Only the top folder; what's inside is the app's own.
    chown "$uid:$gid" "$dir"
  done
  exec setpriv --reuid="$uid" --regid="$gid" --clear-groups "$@"
fi
exec "$@"
