# node-caged-ptero

A Pterodactyl-oriented Node.js runtime image based on Platformatic's Caged Node distribution. The image keeps the panel's startup contract, adds optional allocator selection, derives a conservative V8 old-space budget from the container memory limit, and exposes memory diagnostics without assuming that every increase in RSS is a garbage-collection problem.

The default configuration favors predictable runtime behavior over speculative memory tuning. The allocator defaults to the platform allocator, automatic heap sizing is opt-in, and forced garbage collection is disabled.

## Runtime baseline

The image currently uses `platformatic/node-caged:26-slim`. Node 26 is the selected runtime line; the upstream base image supplies the Node binary. Caged Node uses an altered V8 memory layout and has compatibility boundaries, especially for native addons that depend on V8 internals. Test native modules, Worker usage, snapshots, and application startup before deploying this image broadly.

Do not interpret Caged Node's benchmark results as a guaranteed reduction in total container RSS. Results depend on object shape, isolate count, external buffers, native allocations, and workload.

## Memory behavior

The image separates three different responsibilities:

- **Container memory discovery** reads cgroup v2 or v1 limits and usage, including finite ancestor limits. The Pterodactyl `SERVER_MEMORY` value is used as an additional upper bound when present.
- **Heap budget calculation** reserves memory for non-old-space allocations before deriving `--max-old-space-size`. If no safe finite budget can be determined, the helper leaves Node's default heap sizing untouched.
- **GC assistance** is an optional diagnostic/operational experiment. Adaptive mode only considers sustained V8 heap pressure. RSS growth, external memory growth, and ArrayBuffer growth are recorded as context but do not independently trigger GC.

A forced full GC can introduce latency and does not fix retained references, native leaks, live ArrayBuffers, or allocator fragmentation. Keep `ENABLE_PERIODIC_GC=false` unless the application has been measured with the helper enabled.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_ALLOCATOR` | `auto` | `auto`, `glibc`, `jemalloc`, or `mimalloc` |

The image also installs `pnpm@12.23.0` globally, so NodeLink startup commands can call `pnpm` without relying on Corepack downloading it at runtime.
| `ENABLE_JEMALLOC` | `false` | Legacy compatibility switch used only when allocator is `auto` |
| `AUTO_TUNE_NODE_MEMORY` | `false` | Derive an old-space limit from effective container memory |
| `NODE_HEAP_RATIO` | `60` | Maximum percentage of the effective limit eligible for old-space |
| `NODE_HEAP_RESERVE_MB` | `128` | Memory reserved outside old-space |
| `NODE_HEAP_MIN_MB` | `64` | Minimum acceptable calculated old-space; smaller results are not applied |
| `MEMORY_DIAGNOSTICS` | `false` | Print cgroup limit, usage, source and computed heap budget |
| `ENABLE_PERIODIC_GC` | `false` | Opt in to the GC helper |
| `PERIODIC_GC_MODE` | `adaptive` | `adaptive` or experimental `always` |
| `PERIODIC_GC_INTERVAL_MS` | `60000` | Sampling interval |
| `PERIODIC_GC_CONSECUTIVE_SAMPLES` | `3` | Consecutive high-pressure samples required in adaptive mode |
| `PERIODIC_GC_HEAP_PRESSURE_HIGH` | `0.9` | Heap-used / V8 heap-size-limit threshold |
| `PERIODIC_GC_COOLDOWN_MS` | `180000` | Minimum time between forced collections |
| `PERIODIC_GC_INCLUDE_WORKERS` | `false` | Also initialize the helper in Worker threads |
| `PERIODIC_GC_LOG` | `false` | Log pre/post memory metrics and GC duration |

When `MEMORY_ALLOCATOR=auto`, the default is glibc. Existing deployments that set `ENABLE_JEMALLOC=true` retain their previous behavior. Explicit allocator requests fail startup if the requested library is unavailable or is not mapped in the Node process; they do not silently fall back to another allocator.

The jemalloc decay settings are deliberately less aggressive than the original 1-second values. They are starting points, not a claim that jemalloc is faster or more memory-efficient for every workload.

## Pterodactyl compatibility

The entrypoint preserves the `STARTUP` variable and the common `{{VARIABLE}}` to Bash expansion used by Pterodactyl eggs. It runs the rendered command through Bash and uses Tini as PID 1 to forward signals and reap child processes.

The image keeps a non-root `container` user with UID 1000 and the conventional `/home/container` working directory. The installed utilities are intended for general Node application compatibility; remove packages from a derived image when the workload does not need them.

## Validation

Run the unit tests with Node 26:

```sh
node --test
bash -n entrypoint.sh
```

The test suite covers cgroup parsing, mount path resolution, ancestor traversal, SERVER_MEMORY parsing, heap budget safety, and the GC policy's sustained-pressure requirement.

A successful unit-test run does not replace building the Docker image or testing real Pterodactyl deployments. Validate native dependencies, Worker threads, stop/restart behavior, and application-specific latency under representative traffic.

## Benchmark methodology

Compare identical workloads and container limits across at least these variants:

1. Caged Node with glibc.
2. Caged Node with jemalloc.
3. Caged Node with mimalloc.
4. Each allocator with and without application-specific GC assistance.

Record container-level memory current/peak, OOM events, process RSS, heapUsed, heapTotal, external, arrayBuffers, event-loop delay, CPU usage, and p95/p99 latency. Include long-running tests and allocation churn. Do not declare an allocator winner from a short startup benchmark.

## References

- Platformatic Node Caged: https://github.com/platformatic/node-caged
- Platformatic Docker images: https://hub.docker.com/r/platformatic/node-caged
- Node.js process memory usage: https://nodejs.org/api/process.html#processmemoryusage
- Node.js V8 API: https://nodejs.org/api/v8.html
- Node.js CLI options: https://nodejs.org/api/cli.html
- Linux cgroup v2: https://docs.kernel.org/admin-guide/cgroup-v2.html
- Linux cgroup v1 memory controller: https://docs.kernel.org/admin-guide/cgroup-v1/memory.html
- Pterodactyl documentation: https://pterodactyl.io/

## Scope

This image does not fix application memory leaks, manage host swap, configure zram/zswap, or change Wings resource limits. Those responsibilities belong to the application or host. No allocator or GC policy is universally optimal; defaults should be changed only after measurements on the target workload.
