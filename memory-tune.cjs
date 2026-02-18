'use strict';

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toFloat(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : fallback;
}

const mode = String(process.env.PERIODIC_GC_MODE || 'adaptive').toLowerCase();
const intervalMs = toInt(process.env.PERIODIC_GC_INTERVAL_MS, 60000);
const rssThresholdMb = toInt(process.env.PERIODIC_GC_MAX_RSS_MB, 0);
const minRssGrowthMb = toInt(process.env.PERIODIC_GC_MIN_RSS_GROWTH_MB, 24);
const minHeapDeltaMb = toInt(process.env.PERIODIC_GC_MIN_HEAP_DELTA_MB, 4);
const heapPressureHigh = toFloat(process.env.PERIODIC_GC_HEAP_PRESSURE_HIGH, 0.82);
const cooldownMs = toInt(process.env.PERIODIC_GC_COOLDOWN_MS, 45000);
const shouldLog = String(process.env.PERIODIC_GC_LOG || 'false') === 'true';

if (intervalMs < 10000) {
  if (shouldLog) console.log('[memory-tune] disabled: interval too low');
  return;
}

if (typeof global.gc !== 'function') {
  if (shouldLog) console.log('[memory-tune] disabled: global.gc unavailable');
  return;
}

let last = process.memoryUsage();
let lastForcedGcAt = 0;

setInterval(() => {
  const now = Date.now();
  if (now - lastForcedGcAt < cooldownMs) return;

  const current = process.memoryUsage();
  const rssMb = Math.round(current.rss / 1024 / 1024);
  const heapUsedMb = Math.round(current.heapUsed / 1024 / 1024);
  const heapTotalMb = Math.max(1, Math.round(current.heapTotal / 1024 / 1024));
  const heapPressure = current.heapUsed / Math.max(1, current.heapTotal);

  if (rssThresholdMb > 0 && rssMb < rssThresholdMb) {
    last = current;
    return;
  }

  let shouldForceGc = false;
  let reason = '';

  if (mode === 'always') {
    shouldForceGc = true;
    reason = 'always';
  } else {
    const rssGrowthMb = Math.round((current.rss - last.rss) / 1024 / 1024);
    const heapGrowthMb = Math.round((current.heapUsed - last.heapUsed) / 1024 / 1024);

    if (heapPressure >= heapPressureHigh) {
      shouldForceGc = true;
      reason = `heap-pressure ${heapPressure.toFixed(2)}`;
    } else if (rssGrowthMb >= minRssGrowthMb && heapGrowthMb <= minHeapDeltaMb) {
      shouldForceGc = true;
      reason = `rss-growth ${rssGrowthMb}MB heap-delta ${heapGrowthMb}MB`;
    }
  }

  if (!shouldForceGc) {
    last = current;
    return;
  }

  global.gc();
  lastForcedGcAt = now;

  if (shouldLog) {
    const after = process.memoryUsage();
    const afterRssMb = Math.round(after.rss / 1024 / 1024);
    const afterHeapUsedMb = Math.round(after.heapUsed / 1024 / 1024);
    console.log(
      `[memory-tune] forced gc (${reason}) rss=${rssMb}MB->${afterRssMb}MB heap=${heapUsedMb}/${heapTotalMb}MB->${afterHeapUsedMb}MB`
    );
  }
  last = process.memoryUsage();
}, intervalMs).unref();
