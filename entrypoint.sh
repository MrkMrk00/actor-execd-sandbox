#!/bin/sh
# Starts execd as the container init with a local Jupyter server as its
# supervised entrypoint. execd reaps children, forwards signals and exits
# with Jupyter's status, so a dead kernel host takes the run down with it
# instead of leaving a half-working sandbox behind.
set -eu

# Apify Standby proxies requests to ACTOR_WEB_SERVER_PORT. Outside Apify
# (local docker run) fall back to execd's default port.
PORT="${ACTOR_STANDBY_PORT:-${ACTOR_WEB_SERVER_PORT:-44772}}"

JUPYTER_PORT="${JUPYTER_PORT:-44771}"
JUPYTER_HOST="http://127.0.0.1:${JUPYTER_PORT}"

# Jupyter only listens on loopback, but it still needs a token so nothing
# else inside the container can drive the kernels. Random per run. Passed
# through the environment, not argv, so it does not show up in ps or logs.
if [ -z "${JUPYTER_TOKEN:-}" ]; then
    JUPYTER_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi

export JUPYTER_HOST JUPYTER_TOKEN
export JUPYTER_RUNTIME_DIR="${JUPYTER_RUNTIME_DIR:-/tmp/jupyter-runtime}"

mkdir -p "$JUPYTER_RUNTIME_DIR"

if [ -n "${EXECD_ENVS:-}" ]; then
    mkdir -p "$(dirname "$EXECD_ENVS")"
    touch "$EXECD_ENVS"
fi

echo "execd: listening on :${PORT}, jupyter on ${JUPYTER_HOST}"

exec /opt/opensandbox/execd --init --port "$PORT" -- \
    jupyter server \
        --ip=127.0.0.1 \
        --port="$JUPYTER_PORT" \
        --no-browser \
        --ServerApp.root_dir=/workspace \
        --ServerApp.open_browser=False
