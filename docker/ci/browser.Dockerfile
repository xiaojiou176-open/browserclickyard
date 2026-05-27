FROM mcr.microsoft.com/playwright:v1.58.2-noble

ARG UV_VERSION=0.8.22

ENV DEBIAN_FRONTEND=noninteractive \
    HOME=/home/pwuser \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    RUNNER_TEMP=/tmp/uiq-runner \
    COREPACK_HOME=/tmp/uiq-runner/uiq-corepack \
    PNPM_HOME=/home/pwuser/.local/share/pnpm \
    PNPM_STORE_PATH=/tmp/uiq-runner/uiq-pnpm-store \
    UV_CACHE_DIR=/tmp/uiq-runner/uiq-python-cache/uv \
    UV_HTTP_TIMEOUT=120 \
    PIP_CACHE_DIR=/tmp/uiq-runner/uiq-python-cache/pip \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    UIQ_RUNTIME_CACHE_ROOT=/workspace/.runtime-cache

ENV PATH="${PNPM_HOME}:${PATH}"

RUN corepack enable \
    && corepack prepare pnpm@10.22.0 --activate

RUN curl -LsSf https://astral.sh/uv/${UV_VERSION}/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

RUN mkdir -p \
    /home/pwuser/.local/share/pnpm \
    /workspace/.runtime-cache \
    /tmp/uiq-runner/uiq-corepack \
    "${RUNNER_TEMP}" \
    "${PNPM_STORE_PATH}" \
    "${UV_CACHE_DIR}" \
    "${PIP_CACHE_DIR}" \
    && chown -R pwuser:pwuser /home/pwuser /workspace /tmp/uiq-runner

WORKDIR /workspace

USER pwuser

CMD ["bash"]
