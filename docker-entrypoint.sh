#!/bin/sh
#
# Container entrypoint.
#
# The image starts as root so it can prepare the mounted data volume, then hands
# the application over to an unprivileged user with gosu. Both of those steps
# need Linux capabilities that a hardened deployment may have dropped:
# CAP_CHOWN for the ownership fix, CAP_SETUID/CAP_SETGID for the privilege drop.
#
# Neither step is treated as fatal any more. What actually matters is that the
# process that ends up running the application can write to the data directory,
# so that is checked explicitly - as the final user - right before exec.
#
# The script runs itself a second time after the privilege drop; the second pass
# is marked with ZR_PRIVILEGES_DROPPED so the root section is not repeated.

set -eu

DATA_DIR='/app/data'
LOGS_DIR="${DATA_DIR}/logs"

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

warn() {
  echo "entrypoint: WARNING: $*" >&2
}

err() {
  echo "entrypoint: ERROR: $*" >&2
}

is_numeric_id() {
  case "$1" in
  '' | *[!0-9]*) return 1 ;;
  *) return 0 ;;
  esac
}

# Real write test. "test -w" is useless here: for root it reports success even
# when the write itself is refused, which is exactly the situation this guards.
can_write() {
  _probe="$1/.zr-write-probe.$$"
  if (: >"${_probe}") 2>/dev/null; then
    rm -f "${_probe}"
    return 0
  fi
  return 1
}

describe_dir() {
  stat -c '%U:%G (%u:%g), mode %a' "$1" 2>/dev/null || echo 'owner unknown'
}

if [ "${ZR_PRIVILEGES_DROPPED:-}" != '1' ] && [ "$(id -u)" -eq 0 ]; then
  if ! is_numeric_id "${PUID}" || ! is_numeric_id "${PGID}"; then
    err "PUID and PGID must be numeric ids, got PUID='${PUID}' PGID='${PGID}'."
    exit 1
  fi

  mkdir -p "${DATA_DIR}" "${LOGS_DIR}" 2>/dev/null || true

  # Best effort. Without CAP_CHOWN this fails, and that is fine as long as the
  # directory turns out to be writable anyway (named volume seeded from the
  # image, bind mount already owned by PUID, or the container staying root).
  if ! chown -R "${PUID}:${PGID}" "${DATA_DIR}" 2>/dev/null; then
    warn "could not change the ownership of ${DATA_DIR} to ${PUID}:${PGID} - the container has no CAP_CHOWN. Continuing; this only matters if the directory is not writable, which is checked below."
  fi

  if gosu "${PUID}:${PGID}" true 2>/dev/null; then
    export ZR_PRIVILEGES_DROPPED=1
    exec gosu "${PUID}:${PGID}" "$0" "$@"
  fi

  warn "could not drop privileges to ${PUID}:${PGID} - the container has no CAP_SETUID/CAP_SETGID. The application stays root inside the container. To run it unprivileged, add 'cap_add: [SETUID, SETGID]' to the service, or start it with 'user: \"${PUID}:${PGID}\"'."
fi

# From here on this is the user the application will actually run as.
mkdir -p "${DATA_DIR}" "${LOGS_DIR}" 2>/dev/null || true

for dir in "${DATA_DIR}" "${LOGS_DIR}"; do
  if [ -d "${dir}" ] && can_write "${dir}"; then
    continue
  fi

  err "${dir} is not writable, refusing to start."
  err "  process user: uid=$(id -u) gid=$(id -g)"
  if [ -d "${dir}" ]; then
    err "  directory:    ${dir} - $(describe_dir "${dir}")"
  else
    err "  directory:    ${dir} - does not exist and could not be created"
  fi
  err '  Fix one of these and start the container again:'
  err "    * let the container repair the ownership itself: keep 'cap_drop: [ALL]' but add 'cap_add: [CHOWN, DAC_OVERRIDE, SETGID, SETUID]'"
  err "    * or fix the mount on the host: chown -R $(id -u):$(id -g) <host directory mounted at ${DATA_DIR}>"
  err '    * or set PUID/PGID to the uid/gid that already owns that directory'
  exit 1
done

# gosu resolves HOME from /etc/passwd; a PUID with no account there gets "/",
# which pm2 cannot write its runtime state into.
if [ -z "${HOME:-}" ] || ! can_write "${HOME}"; then
  HOME="${DATA_DIR}"
  export HOME
fi

exec "$@"
