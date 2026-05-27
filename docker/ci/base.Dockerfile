FROM node:20-bookworm-slim AS node-runtime

FROM python:3.12-slim-bookworm

ARG UV_VERSION=0.8.22
ARG UIQ_UID=10001
ARG UIQ_GID=10001

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
COPY --from=node-runtime /usr/local/include/node /usr/local/include/node

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/uiq \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    RUNNER_TEMP=/tmp/uiq-runner \
    COREPACK_HOME=/tmp/uiq-runner/uiq-corepack \
    PNPM_HOME=/home/uiq/.local/share/pnpm \
    PNPM_STORE_PATH=/tmp/uiq-runner/uiq-pnpm-store \
    UV_CACHE_DIR=/tmp/uiq-runner/uiq-python-cache/uv \
    UV_HTTP_TIMEOUT=120 \
    PIP_CACHE_DIR=/tmp/uiq-runner/uiq-python-cache/pip \
    PLAYWRIGHT_BROWSERS_PATH=/tmp/uiq-runner/uiq-ms-playwright/root \
    UIQ_RUNTIME_CACHE_ROOT=/workspace/.runtime-cache

ENV PATH="${PNPM_HOME}:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
    && ln -sf /usr/local/lib/node_modules/corepack/dist/pnpm.js /usr/local/bin/pnpm \
    && ln -sf /usr/local/lib/node_modules/corepack/dist/pnpx.js /usr/local/bin/pnpx

RUN corepack enable \
    && corepack prepare pnpm@10.22.0 --activate

RUN python -m pip install --no-cache-dir "uv==${UV_VERSION}"

RUN groupadd --gid "${UIQ_GID}" uiq \
    && useradd --uid "${UIQ_UID}" --gid "${UIQ_GID}" --create-home --shell /bin/bash uiq

RUN mkdir -p \
    /home/uiq/.local/share/pnpm \
    /workspace/.runtime-cache \
    /tmp/uiq-runner/uiq-corepack \
    /tmp/uiq-runner/uiq-ms-playwright/root \
    "${RUNNER_TEMP}" \
    "${PNPM_STORE_PATH}" \
    "${UV_CACHE_DIR}" \
    "${PIP_CACHE_DIR}" \
    && chown -R uiq:uiq /home/uiq /workspace /tmp/uiq-runner

WORKDIR /workspace

USER uiq

CMD ["bash"]
