# syntax=docker/dockerfile:1

# Source of the execd daemon and its native helpers (bubblewrap, launcher,
# session gate). Pinned to a release tag so builds are reproducible.
ARG EXECD_IMAGE=opensandbox/execd:v1.1.0
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.12.18

FROM ${EXECD_IMAGE} AS execd
FROM ${UV_IMAGE} AS uv

FROM debian:trixie

ARG TARGETARCH
ARG NODE_VERSION=26.10.0
ARG PYTHON_VERSION=3.14

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Runtime tooling that agents commonly need from the sandbox shell.
# libnss3-tools ships certutil, which execd's bootstrap uses for CA trust.
RUN apt-get update && apt-get install -y --no-install-recommends \
        bash ca-certificates curl git jq procps unzip zip xz-utils \
        build-essential pkg-config libnss3-tools \
    && rm -rf /var/lib/apt/lists/*

# Python from python-build-standalone via uv; Debian trixie only packages 3.13.
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python \
    PATH=/opt/python/current/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN set -eux; \
    uv python install "${PYTHON_VERSION}"; \
    py="$(uv python find "${PYTHON_VERSION}")"; \
    ln -s "$(dirname "$(dirname "$py")")" /opt/python/current; \
    # This is the sandbox's only Python; plain pip installs are intended.
    rm -f /opt/python/current/lib/python*/EXTERNALLY-MANAGED; \
    ln -sf python3 /opt/python/current/bin/python; \
    python3 -m ensurepip --upgrade; \
    ln -sf pip3 /opt/python/current/bin/pip; \
    python --version && pip --version

# Node.js from the official tarball.
RUN set -eux; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
        amd64) node_arch=x64 ;; \
        arm64) node_arch=arm64 ;; \
        *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
        | tar -xJ -C /usr/local --strip-components=1 --no-same-owner; \
    node --version && npm --version

# Jupyter server plus kernels for the /code endpoints. execd resolves a kernel
# by its spec "language" field and skips the stock "python3" spec on purpose,
# so the Python kernel is registered under a different name.
RUN set -eux; \
    pip install jupyter-server ipykernel bash_kernel; \
    python3 -m ipykernel install --name python --display-name "Python 3"; \
    python3 -m bash_kernel.install --sys-prefix; \
    npm install -g tslab; \
    tslab install --sys-prefix; \
    npm cache clean --force; \
    jupyter kernelspec list

# execd daemon and its native helpers, at the paths execd expects.
COPY --from=execd --chown=0:0 /execd /opt/opensandbox/execd
COPY --from=execd --chown=0:0 /usr/local/bin/bwrap /usr/local/bin/bwrap
COPY --from=execd --chown=0:0 /opt/opensandbox/opensandbox-session-gate /opt/opensandbox/opensandbox-session-gate
COPY --from=execd --chown=0:0 /opt/opensandbox/opensandbox-launcher /opt/opensandbox/opensandbox-launcher
COPY --from=execd --chown=0:0 /usr/local/libexec/opensandbox-session-gate /usr/local/libexec/opensandbox-session-gate
COPY --from=execd --chown=0:0 /usr/local/libexec/opensandbox-launcher /usr/local/libexec/opensandbox-launcher

# Unprivileged user for the sandbox workload. Everything the agent touches
# lives under /workspace; /opt/opensandbox stays root owned and read only.
RUN groupadd --gid 1000 sandbox \
    && useradd --uid 1000 --gid sandbox --create-home --shell /bin/bash sandbox \
    && mkdir -p /workspace \
    && chown sandbox:sandbox /workspace

COPY --chown=0:0 --chmod=0755 entrypoint.sh /opt/opensandbox/entrypoint.sh
COPY --chown=0:0 --chmod=0644 supervisor.mjs /opt/opensandbox/supervisor.mjs

ENV EXECD_ENVS=/home/sandbox/.execd.env \
    JUPYTER_PORT=44771 \
    JUPYTER_RUNTIME_DIR=/tmp/jupyter-runtime \
    HOME=/home/sandbox

USER sandbox
WORKDIR /workspace

# Default execd port; on Apify the entrypoint listens on ACTOR_WEB_SERVER_PORT.
EXPOSE 44772

ENTRYPOINT ["/opt/opensandbox/entrypoint.sh"]
