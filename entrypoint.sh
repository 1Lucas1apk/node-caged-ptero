#!/bin/bash
set -euo pipefail

cd /home/container

export HOME="${HOME:-/home/container}"
export USER="${USER:-container}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-${HOME}/.npm}"
export npm_config_cache="${npm_config_cache:-${NPM_CONFIG_CACHE}}"

mkdir -p "${NPM_CONFIG_CACHE}" "${NPM_CONFIG_CACHE}/_logs" 2>/dev/null || true
chmod -R u+rwX "${NPM_CONFIG_CACHE}" 2>/dev/null || true

INTERNAL_IP="$(ip route get 1 2>/dev/null | awk '{print $(NF-2);exit}' || true)"
export INTERNAL_IP

add_preload_lib() {
  local lib="$1"
  export LD_PRELOAD="${lib}${LD_PRELOAD:+:${LD_PRELOAD}}"
}

find_allocator_library() {
  local soname_prefix="$1"
  ldconfig -p 2>/dev/null | awk -v prefix="${soname_prefix}" \
    '$1 ~ ("^" prefix "\\.so\\.[0-9]+$") { print $NF; exit }'
}

verify_allocator_preload() {
  node -e '
    const fs = require("node:fs")
    const markers = { jemalloc: "libjemalloc.so.", mimalloc: "libmimalloc.so." }
    const marker = markers[process.env.MEMORY_ALLOCATOR_SELECTED]
    if (!marker || !fs.readFileSync("/proc/self/maps", "utf8").includes(marker)) process.exit(1)
  ' || {
    echo "ERROR: ${MEMORY_ALLOCATOR_SELECTED} was selected but is not mapped in the Node.js process." >&2
    return 1
  }
}

select_allocator() {
  local requested allocator library
  requested="${MEMORY_ALLOCATOR:-auto}"
  allocator="${requested,,}"

  # ENABLE_JEMALLOC is retained for compatibility with existing panel variables.
  if [ "${allocator}" = "auto" ]; then
    if [ "${ENABLE_JEMALLOC:-false}" = "true" ]; then
      allocator="jemalloc"
    else
      allocator="glibc"
    fi
  fi

  case "${allocator}" in
    glibc|none)
      export MEMORY_ALLOCATOR_SELECTED="glibc"
      echo "Memory allocator: glibc"
      ;;
    jemalloc)
      library="$(find_allocator_library 'libjemalloc')"
      if [ -z "${library}" ] || [ ! -r "${library}" ]; then
        echo "ERROR: jemalloc was requested but libjemalloc was not found." >&2
        return 1
      fi
      add_preload_lib "${library}"
      export MEMORY_ALLOCATOR_SELECTED="jemalloc"
      export MEMORY_ALLOCATOR_LIBRARY="${library}"
      verify_allocator_preload || return 1
      echo "Memory allocator: jemalloc (${library}) loaded"
      ;;
    mimalloc)
      library="$(find_allocator_library 'libmimalloc')"
      if [ -z "${library}" ] || [ ! -r "${library}" ]; then
        echo "ERROR: mimalloc was requested but libmimalloc was not found." >&2
        return 1
      fi
      add_preload_lib "${library}"
      export MEMORY_ALLOCATOR_SELECTED="mimalloc"
      export MEMORY_ALLOCATOR_LIBRARY="${library}"
      verify_allocator_preload || return 1
      echo "Memory allocator: mimalloc (${library}) loaded"
      ;;
    *)
      echo "ERROR: unsupported MEMORY_ALLOCATOR='${requested}'. Use auto, glibc, jemalloc or mimalloc." >&2
      return 1
      ;;
  esac
}

select_allocator

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

has_node_option() {
  local option="$1"
  [[ " ${NODE_OPTIONS:-} " =~ [[:space:]]${option}([=]|[[:space:]]|$) ]]
}

if [ "${AUTO_TUNE_NODE_MEMORY:-false}" = "true" ]; then
  if [[ ! " ${NODE_OPTIONS:-} " =~ [[:space:]]--max-old-space-size(=|[[:space:]]) ]] && \
     [[ ! " ${NODE_OPTIONS:-} " =~ [[:space:]]--max-old-space-size-percentage(=|[[:space:]]) ]]; then
    HEAP_MB="$(node /cgroup-memory.cjs --heap)"

    if [[ "${HEAP_MB}" =~ ^[1-9][0-9]*$ ]]; then
      export NODE_OPTIONS="--max-old-space-size=${HEAP_MB}${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
      echo "Auto heap tuning: old-space=${HEAP_MB} MiB (per V8 isolate)"
    else
      echo "Auto heap tuning: no safe finite budget found; leaving Node.js defaults"
    fi
  else
    echo "Auto heap tuning: explicit NODE_OPTIONS heap limit preserved"
  fi
fi

if [ "${MEMORY_DIAGNOSTICS:-false}" = "true" ]; then
  echo "Container memory diagnostics:"
  node /cgroup-memory.cjs
fi

if [ "${ENABLE_PERIODIC_GC:-false}" = "true" ]; then
  if ! has_node_option '--expose-gc'; then
    export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--expose-gc"
  fi

  if [[ " ${NODE_OPTIONS:-} " != *"/memory-tune.cjs"* ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }--require=/memory-tune.cjs"
  fi

  echo "GC helper enabled: mode=${PERIODIC_GC_MODE:-adaptive} interval=${PERIODIC_GC_INTERVAL_MS:-60000}ms"
  echo "WARNING: forced GC is opt-in and may increase latency; NODE_OPTIONS also affects child Node.js processes."
fi

if [ -z "${STARTUP:-}" ]; then
  echo "ERROR: STARTUP variable is empty."
  exit 1
fi

MODIFIED_STARTUP="$(printf '%s' "${STARTUP}" | sed -e 's/{{/${/g' -e 's/}}/}/g')"
echo ":/home/container$ ${MODIFIED_STARTUP}"

exec bash -c "${MODIFIED_STARTUP}"
