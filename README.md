# node-caged-ptero

node-caged-ptero is a practical runtime image for long living Node.js services on Pterodactyl where memory behavior is just as important as feature parity. The purpose of this project is not to chase synthetic benchmark numbers in isolation, but to keep real workloads stable under continuous traffic, especially workloads that combine worker processes, network sockets, stream buffering, and native memory pressure. The image is built on top of `platformatic/node-caged:25-slim` and extends it with allocator control, adaptive garbage collection assistance, and operational defaults that reduce memory drift over time without forcing hard limits in every deployment.

In modern Node.js systems, operators often discover that JavaScript heap usage is only one piece of the memory story. A process can report moderate heap usage while resident set size keeps growing because native allocations, external buffers, and allocator fragmentation are accumulating faster than memory can be returned to the operating system. This repository exists for that exact scenario. It does not assume that one allocator or one flag is universally optimal. Instead, it gives you a controlled environment where allocator selection and runtime behavior can be tuned with environment variables, then validated under your own workload profile.

## Historical and technical context

The base image, `platformatic/node-caged:25-slim`, is part of a broader effort around modern V8 isolation and memory layout improvements. Pointer compression has existed in V8 for years, but its operational behavior in Node contexts with worker models has depended on how isolation boundaries and memory cages are managed. The caged Node runtime is relevant because it brings those low level runtime capabilities to a practical Docker distribution that can be consumed by infrastructure teams without rewriting application code. In other words, this project starts from a runtime that already moves the memory baseline in the right direction and then focuses on the operational layer that decides whether memory remains stable after hours of traffic.

The important point is that heap reductions do not automatically remove RSS instability in stream heavy systems. Audio pipelines, protocol handling, TLS, native modules, and large transient buffers can dominate memory behavior even when JavaScript heap remains moderate. That is why this repository intentionally addresses allocator policy and GC trigger policy in addition to the runtime base image.

## Design philosophy

This image follows a conservative operational philosophy. First, it keeps compatibility with common Pterodactyl startup patterns and expected utilities, since operational breakage is more expensive than a small package delta. Second, it treats allocator choice as an experimentable parameter rather than a religious decision. Third, it avoids hidden hard caps by default, preferring adaptive cleanup behavior so applications can breathe under load while still reacting to clear signs of memory drift. Fourth, it keeps everything configurable through environment variables so panel level changes do not require image rebuilds.

The result is an image intended for operators who care about stability across many hours, not just the first ten minutes after boot.

## What the image actually adds

This repository adds three core layers on top of the caged Node base. The first layer is allocator control through `LD_PRELOAD`, with support for jemalloc, mimalloc, or the default glibc allocator. The second layer is an adaptive GC helper loaded through `--require`, designed to react to suspicious memory movement patterns rather than blindly forcing collection every interval. The third layer is an entrypoint that normalizes runtime environment details relevant to Pterodactyl deployments and keeps startup behavior predictable.

Allocator selection is exposed through the `MEMORY_ALLOCATOR` variable. The current default is jemalloc because it showed better practical behavior in this workload class after A/B testing. Mimalloc remains available for future testing because allocator performance is workload dependent and can change as Node versions, kernel versions, and traffic shape evolve.

The adaptive GC helper is implemented in `memory-tune.cjs`. Its goal is to intervene when there is evidence that memory pressure is not being resolved naturally, especially when RSS rises faster than heap usage, which often indicates native memory retention or fragmentation side effects. This helper is intentionally bounded by cooldown logic so it does not create a self inflicted latency problem by forcing collection too frequently.

## Runtime behavior and memory model

At startup, the container initializes user and npm cache paths, resolves internal network IP exposure for process visibility, selects and preloads the configured allocator, and then builds startup command execution from the panel supplied template variables. If GC helper mode is enabled, Node is started with `--expose-gc` and a preload requirement for `memory-tune.cjs`. The helper then tracks memory snapshots over time.

In adaptive mode, GC is requested when one of two patterns appears. The first pattern is high heap pressure, where used heap relative to available heap crosses the configured threshold. The second pattern is asymmetric growth, where RSS rises significantly while heap growth remains small. This asymmetry is frequently observed in stream intensive systems where external buffers and native structures dominate short term memory movement. Because this signal is noisy under bursty traffic, the helper uses a cooldown window to avoid overreacting.

If an operator prefers fixed behavior for controlled experiments, the helper can run in always mode. If an operator prefers full runtime autonomy with no helper intervention, it can be disabled entirely.

## Pterodactyl operational note

A common startup expression bug in panel templates is quoting wildcard conditions in Bash. When `*.js` is quoted, wildcard matching is disabled and the condition no longer behaves as intended. This can force the process into a TypeScript branch even when the main file is JavaScript. The recommended startup condition keeps the wildcard unquoted so shell pattern matching works correctly.

This is not a cosmetic detail. Misrouting startup execution can change runtime footprint, startup time, and module loading behavior in ways that look like allocator problems while actually being startup logic problems.

## Why this repository keeps both jemalloc and mimalloc

Operational memory tuning should be evidence driven. Different allocators make different tradeoffs in thread caching behavior, fragmentation control, and release cadence. In one workload, mimalloc may win RSS and latency together. In another workload, jemalloc may give smoother tail latency and fewer regressions under stream churn. Keeping both libraries available allows you to run real A/B windows against your own traffic and decide with telemetry rather than assumptions.

In this project history, jemalloc ended up as the default because test results under the active NodeLink style workload were better overall. That choice is not permanent dogma. It is the current measured default.

## Build and deployment narrative

Building this image is straightforward and does not require special tooling beyond Docker. The output image is intended to be pushed to your own registry namespace and then referenced by Pterodactyl as the server image. Once deployed, runtime behavior is controlled by environment variables rather than by rebuilding for every experiment.

A typical production rollout should compare at least two windows with equivalent traffic shape and duration. During each window, collect average RSS, RSS peak, p95 latency, p99 latency, and event frequency for memory growth anomalies in worker and source worker processes. Short snapshots are useful for sanity checks but not sufficient for allocator decisions. Fragmentation behavior usually appears over longer windows.

## Files in this repository

`Dockerfile` defines the runtime base, package set, allocator libraries, environment defaults, and process entry configuration. `entrypoint.sh` performs runtime bootstrap, allocator selection, optional heap auto tune behavior, and optional GC helper injection. `memory-tune.cjs` implements the adaptive policy that inspects process memory movement and decides when forcing GC is justified.

Together these files form a small but complete operational layer around Node 25 caged runtime for Pterodactyl deployments.

## Known boundaries

This project does not claim to solve application level leaks. If your service keeps strong references to objects indefinitely, no allocator policy will fully hide that. This project also does not replace host level memory management features such as zram or zswap, because those belong to the host kernel and node configuration, not the container image. Finally, no single default here should be treated as universally optimal across all workloads. The design intentionally exposes controls so operators can test and select behavior empirically.

## Technical references

The runtime baseline and the low level memory context are rooted in official project material from Platformatic and V8. The references below are the canonical sources used when maintaining this image behavior and documentation.

Platformatic node-caged Docker distribution can be found at https://hub.docker.com/r/platformatic/node-caged

Platformatic node-caged source repository is available at https://github.com/platformatic/node-caged

V8 pointer compression background is documented at https://v8.dev/blog/pointer-compression

V8 sandbox context is documented at https://v8.dev/blog/sandbox

Cloudflare and Igalia engineering write-up on IsolateGroups and Node related performance context is available at https://blog.cloudflare.com/unlocking-nodejs-performance-through-isolategroups/

## Document status

This document describes the current state of this repository as of February 18, 2026, including allocator default selection, adaptive GC helper behavior, and Pterodactyl oriented runtime assumptions.
