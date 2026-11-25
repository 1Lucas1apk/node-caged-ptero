'use strict';

function createMemoryPolicy(options = {}) {
  const mode = String(options.mode || 'adaptive').toLowerCase();
  const threshold = Number.isFinite(options.heapPressureHigh) ? options.heapPressureHigh : 0.9;
  const requiredSamples = Number.isInteger(options.consecutiveSamples)
    ? Math.max(1, options.consecutiveSamples)
    : 3;

  let consecutiveHighSamples = 0;

  return {
    evaluate(sample) {
      if (mode === 'always') {
        return { shouldCollect: true, reason: 'always' };
      }

      if (mode !== 'adaptive') {
        return { shouldCollect: false, reason: 'disabled' };
      }

      const used = Number(sample?.heapUsed);
      const limit = Number(sample?.heapLimit);
      if (!Number.isFinite(used) || !Number.isFinite(limit) || used < 0 || limit <= 0) {
        consecutiveHighSamples = 0;
        return { shouldCollect: false, reason: 'invalid-sample' };
      }

      const pressure = used / limit;
      if (pressure >= threshold) {
        consecutiveHighSamples += 1;
      } else {
        consecutiveHighSamples = 0;
      }

      if (consecutiveHighSamples >= requiredSamples) {
        consecutiveHighSamples = 0;
        return {
          shouldCollect: true,
          reason: 'sustained-heap-pressure',
          pressure
        };
      }

      return {
        shouldCollect: false,
        reason: pressure >= threshold ? 'awaiting-confirmation' : 'below-threshold',
        pressure
      };
    },

    reset() {
      consecutiveHighSamples = 0;
    }
  };
}

module.exports = { createMemoryPolicy };
