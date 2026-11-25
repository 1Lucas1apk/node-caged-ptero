'use strict';

const { isMainThread } = require('node:worker_threads');
const v8 = require('node:v8');
const { createMemoryPolicy } = require('/memory-policy.cjs');

function integer(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(process.env[name] ?? ''), 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function decimal(name, fallback, minimum, maximum) {
  const parsed = Number.parseFloat(String(process.env[name] ?? ''));
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

const mode = String(process.env.PERIODIC_GC_MODE || 'adaptive').toLowerCase();
const intervalMs = integer('PERIODIC_GC_INTERVAL_MS', 60000, 10000, 3_600_000);
const consecutiveSamples = integer('PERIODIC_GC_CONSECUTIVE_SAMPLES', 3, 2, 100);
const heapPressureHigh = decimal('PERIODIC_GC_HEAP_PRESSURE_HIGH', 0.9, 0.5, 0.99);
const cooldownMs = integer('PERIODIC_GC_COOLDOWN_MS', 180000, 10000, 86_400_000);
const includeWorkers = String(process.env.PERIODIC_GC_INCLUDE_WORKERS || 'false') === 'true';
const shouldLog = String(process.env.PERIODIC_GC_LOG || 'false') === 'true';

if (mode !== 'adaptive' && mode !== 'always') {
  if (shouldLog) console.log(`[memory-tune] disabled: unsupported mode "${mode}"`);
  return;
}

if (!includeWorkers && !isMainThread) {
  if (shouldLog) console.log('[memory-tune] skipped: worker thread');
  return;
}

if (typeof global.gc !== 'function') {
  if (shouldLog) console.log('[memory-tune] disabled: global.gc is unavailable');
  return;
}

const policy = createMemoryPolicy({
  mode,
  heapPressureHigh,
  consecutiveSamples
});

let lastForcedGcAt = 0;

const timer = setInterval(() => {
  const now = Date.now();
  if (now - lastForcedGcAt < cooldownMs) return;

  const memory = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const decision = policy.evaluate({
    heapUsed: memory.heapUsed,
    heapLimit
  });

  if (!decision.shouldCollect) {
    if (shouldLog && decision.reason === 'awaiting-confirmation') {
      console.log(
        `[memory-tune] heap pressure ${(decision.pressure * 100).toFixed(1)}%; waiting for confirmation`
      );
    }
    return;
  }

  const before = process.memoryUsage();
  const startedAt = performance.now();
  global.gc();
  const durationMs = performance.now() - startedAt;
  const after = process.memoryUsage();
  lastForcedGcAt = Date.now();

  if (shouldLog) {
    console.log(
      '[memory-tune] forced GC',
      JSON.stringify({
        reason: decision.reason,
        heapPressure: decision.pressure ?? null,
        durationMs: Number(durationMs.toFixed(2)),
        rssBeforeMiB: Number((before.rss / 1048576).toFixed(1)),
        rssAfterMiB: Number((after.rss / 1048576).toFixed(1)),
        heapUsedBeforeMiB: Number((before.heapUsed / 1048576).toFixed(1)),
        heapUsedAfterMiB: Number((after.heapUsed / 1048576).toFixed(1)),
        externalMiB: Number((after.external / 1048576).toFixed(1)),
        arrayBuffersMiB: Number((after.arrayBuffers / 1048576).toFixed(1))
      })
    );
  }
}, intervalMs);

timer.unref();
