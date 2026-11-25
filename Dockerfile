FROM platformatic/node-caged:26-slim

RUN apt-get update -o Acquire::Retries=3 && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  curl \
  dnsutils \
  ffmpeg \
  git \
  iproute2 \
  iputils-ping \
  libjemalloc2 \
  libmimalloc3 \
  libnss3 \
  python3 \
  sqlite3 \
  tar \
  tini \
  tzdata \
  zip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund typescript ts-node \
  && npm cache clean --force

RUN useradd -m -d /home/container -s /bin/bash -U -u 1000 container \
  && mkdir -p /home/container /home/container/.npm \
  && chown -R container:container /home/container

ENV USER=container \
  HOME=/home/container \
  NPM_CONFIG_CACHE=/home/container/.npm \
  npm_config_cache=/home/container/.npm \
  npm_config_update_notifier=false \
  npm_config_fund=false \
  npm_config_audit=false \
  AUTO_TUNE_NODE_MEMORY=false \
  NODE_HEAP_RATIO=60 \
  NODE_HEAP_RESERVE_MB=128 \
  NODE_HEAP_MIN_MB=64 \
  ENABLE_PERIODIC_GC=false \
  PERIODIC_GC_MODE=adaptive \
  PERIODIC_GC_INTERVAL_MS=60000 \
  PERIODIC_GC_CONSECUTIVE_SAMPLES=3 \
  PERIODIC_GC_HEAP_PRESSURE_HIGH=0.9 \
  PERIODIC_GC_COOLDOWN_MS=180000 \
  PERIODIC_GC_INCLUDE_WORKERS=false \
  PERIODIC_GC_LOG=false \
  MEMORY_DIAGNOSTICS=false

WORKDIR /home/container

COPY --chown=container:container entrypoint.sh /entrypoint.sh
COPY --chown=container:container cgroup-memory.cjs /cgroup-memory.cjs
COPY --chown=container:container memory-policy.cjs /memory-policy.cjs
COPY --chown=container:container memory-tune.cjs /memory-tune.cjs
RUN chmod 755 /entrypoint.sh \
  && chmod 644 /cgroup-memory.cjs /memory-policy.cjs /memory-tune.cjs

USER container

STOPSIGNAL SIGINT

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD["/entrypoint.sh"]
