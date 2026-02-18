FROM platformatic/node-caged:25-slim

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
  libmimalloc2.0 \
  libnss3 \
  python3 \
  sqlite3 \
  tar \
  tini \
  tzdata \
  zip \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund npm@latest typescript ts-node \
  && npm cache clean --force

RUN useradd -m -d /home/container -s /bin/bash -U -u 1000 container && mkdir -p /home/container /home/container/.npm && chown -R container:container /home/container

ENV USER=container \
  HOME=/home/container \
  NPM_CONFIG_CACHE=/home/container/.npm \
  npm_config_cache=/home/container/.npm \
  npm_config_update_notifier=false \
  npm_config_fund=false \
  npm_config_audit=false \
  MALLOC_ARENA_MAX=2 \
  MEMORY_ALLOCATOR=jemalloc \
  ENABLE_JEMALLOC=true \
  MALLOC_CONF=background_thread:true,narenas:2,dirty_decay_ms:1000,muzzy_decay_ms:1000 \
  AUTO_TUNE_NODE_MEMORY=false \
  NODE_HEAP_RATIO=65 \
  NODE_HEAP_MIN_MB=128 \
  ENABLE_PERIODIC_GC=true \
  PERIODIC_GC_MODE=adaptive \
  PERIODIC_GC_INTERVAL_MS=60000 \
  PERIODIC_GC_MAX_RSS_MB=0 \
  PERIODIC_GC_MIN_RSS_GROWTH_MB=24 \
  PERIODIC_GC_MIN_HEAP_DELTA_MB=4 \
  PERIODIC_GC_HEAP_PRESSURE_HIGH=0.82 \
  PERIODIC_GC_COOLDOWN_MS=45000 \
  PERIODIC_GC_LOG=false

WORKDIR /home/container

COPY --chown=container:container entrypoint.sh /entrypoint.sh
COPY --chown=container:container memory-tune.cjs /memory-tune.cjs
RUN chmod 755 /entrypoint.sh && chmod 644 /memory-tune.cjs

USER container

STOPSIGNAL SIGINT

ENTRYPOINT ["/usr/bin/tini","-g","--"]
CMD ["/entrypoint.sh"]
