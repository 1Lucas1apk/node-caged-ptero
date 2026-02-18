#!/bin/bash
set -euo pipefail

cd /home/container

export HOME="${HOME:-/home/container}"
export USER="${USER:-container}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-${HOME}/.npm}"
export npm_config_cache="${npm_config_cache:-${NPM_CONFIG_CACHE}}"

mkdir -p "${NPM_CONFIG_CACHE}" "${NPM_CONFIG_CACHE}/_logs" 2>/dev/null || true
chmod -R u+rwX "${NPM_CONFIG_CACHE}" 2>/dev/null || true

INTERNAL_IP="$(ip route get 1 2>/dev/null | awk '{print $(NF-2);exit}')"
export INTERNAL_IP

add_preload_lib() {
  local lib="$1"
  export LD_PRELOAD="${lib}${LD_PRELOAD:+:${LD_PRELOAD}}"
}

find_first_lib() {
  local path
  for path in "$@"; do
    if [ -r "${path}" ]; then
      echo "${path}"
      return 0
    fi
  done
  return 1
}

select_allocator() {
  local requested allocator mimalloc_lib jemalloc_lib
  requested="${MEMORY_ALLOCATOR:-auto}"
  allocator="${requested,,}"

  mimalloc_lib="$(find_first_lib \
    /usr/lib/x86_64-linux-gnu/libmimalloc.so.2 \
    /usr/lib/x86_64-linux-gnu/libmimalloc.so.2.0 \
    /usr/lib/libmimalloc.so.2 \
    /usr/lib/libmimalloc.so.2.0 \
  )" || true

  jemalloc_lib="$(find_first_lib \
    /usr/lib/x86_64-linux-gnu/libjemalloc.so.2 \
    /usr/lib/libjemalloc.so.2 \
  )" || true

  if [ "${allocator}" = "auto" ]; then
    allocator="jemalloc"
  fi

  if [ "${allocator}" = "mimalloc" ]; then
    if [ -n "${mimalloc_lib}" ]; then
      add_preload_lib "${mimalloc_lib}"
      echo "Memory allocator: mimalloc enabled"
      return 0
    fi
    echo "Memory allocator: mimalloc requested but library not found, trying jemalloc"
    allocator="jemalloc"
  fi

  if [ "${allocator}" = "jemalloc" ]; then
    if [ -n "${jemalloc_lib}" ]; then
      add_preload_lib "${jemalloc_lib}"
      echo "Memory allocator: jemalloc enabled"
      return 0
    fi
    echo "Memory allocator: jemalloc requested but library not found"
    return 1
  fi

  if [ "${allocator}" = "none" ]; then
    echo "Memory allocator: default glibc"
    return 0
  fi

  echo "Memory allocator: unknown MEMORY_ALLOCATOR='${requested}', using default glibc"
  return 0
}

# Backward compatibility for older deployments.
if [ "${MEMORY_ALLOCATOR:-auto}" = "auto" ] && [ "${ENABLE_JEMALLOC:-true}" = "true" ]; then
  MEMORY_ALLOCATOR="jemalloc"
fi

select_allocator || true

echo "Node.js Version: $(node -v)"

if [ "${YOLK_EOL_NAG_WARNING+x}" ]; then
  echo "======================================================================"
  echo "DEPRECATION WARNING:"
  echo "This version of the Node.js yolk has been marked as end-of-life."
  echo "Please migrate to a supported version as soon as possible to ensure"
  echo "continued security updates and support."
  echo "This image will be removed/disabled in the near future."
  echo "======================================================================"
  echo "Execution will continue in ${YOLK_EOL_NAG_DELAY:-10} seconds..."
  sleep "${YOLK_EOL_NAG_DELAY:-10}"
fi

if [ "${AUTO_TUNE_NODE_MEMORY:-true}" = "true" ]; then
  if [[ "${NODE_OPTIONS:-}" != *"--max-old-space-size="* ]]; then
    CGROUP_LIMIT_BYTES=""

    if [ -r /sys/fs/cgroup/memory.max ]; then
      CGROUP_LIMIT_BYTES="$(cat /sys/fs/cgroup/memory.max)"
      if [ "${CGROUP_LIMIT_BYTES}" = "max" ]; then
        CGROUP_LIMIT_BYTES=""
      fi
    elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
      CGROUP_LIMIT_BYTES="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)"
      if [ "${CGROUP_LIMIT_BYTES}" -ge 9223372036850000000 ] 2>/dev/null; then
        CGROUP_LIMIT_BYTES=""
      fi
    fi

    if [ -n "${CGROUP_LIMIT_BYTES}" ] && [ "${CGROUP_LIMIT_BYTES}" -gt 0 ] 2>/dev/null; then
      LIMIT_MB="$((CGROUP_LIMIT_BYTES / 1024 / 1024))"
      HEAP_RATIO="${NODE_HEAP_RATIO:-65}"
      HEAP_MB="$((LIMIT_MB * HEAP_RATIO / 100))"
      MIN_MB="${NODE_HEAP_MIN_MB:-128}"

      if [ "${HEAP_MB}" -lt "${MIN_MB}" ]; then
        HEAP_MB="${MIN_MB}"
      fi

      export NODE_OPTIONS="--max-old-space-size=${HEAP_MB} ${NODE_OPTIONS:-}"
      echo "Auto heap tuning: cgroup=${LIMIT_MB}MB, old-space=${HEAP_MB}MB"
    fi
  fi
fi

if [ "${ENABLE_PERIODIC_GC:-false}" = "true" ]; then
  if [[ "${NODE_OPTIONS:-}" != *"--expose-gc"* ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:-} --expose-gc"
  fi

  if [[ "${NODE_OPTIONS:-}" != *"--require /memory-tune.cjs"* ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:-} --require /memory-tune.cjs"
  fi

  echo "GC helper enabled: mode=${PERIODIC_GC_MODE:-adaptive} interval=${PERIODIC_GC_INTERVAL_MS:-60000}ms"
fi

if [ -z "${STARTUP:-}" ]; then
  echo "ERROR: STARTUP variable is empty."
  exit 1
fi

MODIFIED_STARTUP="$(printf '%s' "${STARTUP}" | sed -e 's/{{/${/g' -e 's/}}/}/g')"
echo ":/home/container$ ${MODIFIED_STARTUP}"

exec bash -c "${MODIFIED_STARTUP}"
