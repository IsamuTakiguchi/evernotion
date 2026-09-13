#!/bin/sh
set -e

# Railway (and most orchestrators) mount volumes as root, and NOT as an overlay:
#
#   "Volumes are mounted as the root user."
#   "Volumes are not mounted as overlays."
#   — https://docs.railway.com/volumes
#
# So the `chown` this image does at build time is simply hidden underneath the
# mount, and a non-root app process gets EACCES on its very first write. The
# failure surfaces as a 500 from /api/health, which fails the platform health
# check and takes the whole deploy down — with nothing in the logs that points
# at permissions.
#
# Railway's documented remedy is RAILWAY_RUN_UID=0, i.e. run the app as root.
# Instead this container starts as root, fixes ownership once the volume is
# actually there, and then drops to an unprivileged user for the app itself.
# Nothing has to be configured on the platform, and the server still does not
# run as root.

APP_UID=1001
APP_GID=1001
DATA_DIR="${EVERNOTION_DATA_DIR:-/data}"

mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  # Only touch ownership when it is actually wrong: on a large volume that has
  # already been adopted, a recursive chown every boot is pure latency.
  owner="$(stat -c '%u' "$DATA_DIR" 2>/dev/null || echo unknown)"
  if [ "$owner" != "$APP_UID" ]; then
    echo "[entrypoint] adopting $DATA_DIR (owner uid=$owner -> $APP_UID)"
    chown -R "$APP_UID:$APP_GID" "$DATA_DIR" || {
      echo "[entrypoint] WARNING: could not chown $DATA_DIR; the app may be unable to write" >&2
    }
  fi

  if command -v setpriv >/dev/null 2>&1; then
    echo "[entrypoint] dropping privileges to uid=$APP_UID"
    exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups "$@"
  fi

  # setpriv lives in util-linux, which is an essential package on Debian, so
  # this should be unreachable. Running as root beats refusing to boot, but say
  # so loudly rather than quietly downgrading the container's security.
  echo "[entrypoint] WARNING: setpriv not found; continuing as root" >&2
  exec "$@"
fi

# Already unprivileged: either the platform pinned the uid, or this is a local
# `docker run --user`. If the data directory is not writable we cannot fix it
# from here, so make the reason explicit instead of letting SQLite report a
# missing directory.
if [ ! -w "$DATA_DIR" ]; then
  echo "[entrypoint] ERROR: $DATA_DIR is not writable by uid $(id -u)." >&2
  echo "[entrypoint] The volume is probably root-owned. Start this container as" >&2
  echo "[entrypoint] root so it can adopt the volume, or set RAILWAY_RUN_UID=0." >&2
fi

exec "$@"
