'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMountInfo,
  parseCgroupMembership,
  resolveCgroupDirectory,
  ancestorDirectories,
  getMemoryInfo,
  calculateOldSpaceLimit,
  serverMemoryLimit,
  MIB
} = require('../cgroup-memory.cjs');
const { createMemoryPolicy } = require('../memory-policy.cjs');

test('parses cgroup v2 mount and escaped mountpoint', () => {
  const mounts = parseMountInfo(
    '29 23 0:26 / /sys/fs/cgroup/my\\040group rw,nosuid,nodev - cgroup2 cgroup rw'
  );
  assert.deepEqual(mounts, [{
    version: 2,
    root: '/',
    mountPoint: '/sys/fs/cgroup/my group'
  }]);
});

test('parses cgroup v1 memory controller', () => {
  const mounts = parseMountInfo(
    '30 23 0:27 /docker /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory'
  );
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].version, 1);
  assert.equal(mounts[0].root, '/docker');
});

test('parses cgroup memberships for both versions', () => {
  assert.deepEqual(
    parseCgroupMembership('0::/system.slice/container.scope\n7:cpu,memory:/docker/abc'),
    { v2: '/system.slice/container.scope', v1Memory: '/docker/abc' }
  );
});

test('resolves a membership relative to a mounted subtree', () => {
  assert.equal(
    resolveCgroupDirectory(
      { root: '/docker', mountPoint: '/sys/fs/cgroup/memory' },
      '/docker/abc'
    ),
    '/sys/fs/cgroup/memory/abc'
  );
  assert.equal(
    resolveCgroupDirectory(
      { root: '/docker', mountPoint: '/sys/fs/cgroup/memory' },
      '/other/abc'
    ),
    null
  );
});

test('walks the leaf and all ancestors up to the mount boundary', () => {
  assert.deepEqual(
    ancestorDirectories('/cg/a/b', '/cg'),
    ['/cg/a/b', '/cg/a', '/cg']
  );
});

test('uses the tightest ancestor or SERVER_MEMORY limit', () => {
  const files = new Map([
    ['/proc/self/mountinfo', '29 23 0:26 / /sys/fs/cgroup rw - cgroup2 cgroup rw'],
    ['/proc/self/cgroup', '0::/tenant/server-a'],
    ['/sys/fs/cgroup/tenant/server-a/memory.max', 'max'],
    ['/sys/fs/cgroup/tenant/server-a/memory.current', '123456'],
    ['/sys/fs/cgroup/tenant/memory.max', '536870912'],
    ['/sys/fs/cgroup/memory.max', '1073741824']
  ]);
  const fakeFs = {
    readFileSync(file) {
      if (!files.has(file)) throw new Error(`not found: ${file}`);
      return files.get(file);
    }
  };

  const info = getMemoryInfo({
    fs: fakeFs,
    procRoot: '/proc',
    env: { SERVER_MEMORY: '256' }
  });

  assert.equal(info.limitBytes, 256n * MIB);
  assert.equal(info.limitSource, 'SERVER_MEMORY');
  assert.equal(info.currentBytes, 123456n);
  assert.equal(info.sources.some((item) => item.source === 'cgroup-v2'), true);
});

test('SERVER_MEMORY is interpreted as MiB and invalid values are ignored', () => {
  assert.equal(serverMemoryLimit({ SERVER_MEMORY: '512' }), 512n * MIB);
  assert.equal(serverMemoryLimit({ SERVER_MEMORY: '0' }), null);
  assert.equal(serverMemoryLimit({ SERVER_MEMORY: '512MB' }), null);
});

test('heap budget is capped by the ratio and calculated from the limit', () => {
  const info = { limitBytes: 512n * MIB };
  assert.equal(
    calculateOldSpaceLimit(info, {
      NODE_HEAP_RATIO: '60',
      NODE_HEAP_RESERVE_MB: '128',
      NODE_HEAP_MIN_MB: '64'
    }),
    307
  );
});

test('reserve is subtracted when it is more restrictive than the ratio', () => {
  const info = { limitBytes: 256n * MIB };
  assert.equal(
    calculateOldSpaceLimit(info, {
      NODE_HEAP_RATIO: '90',
      NODE_HEAP_RESERVE_MB: '128',
      NODE_HEAP_MIN_MB: '64'
    }),
    128
  );
});

test('does not force a minimum heap larger than the safe budget', () => {
  const info = { limitBytes: 128n * MIB };
  assert.equal(
    calculateOldSpaceLimit(info, {
      NODE_HEAP_RATIO: '90',
      NODE_HEAP_RESERVE_MB: '128',
      NODE_HEAP_MIN_MB: '64'
    }),
    null
  );
});

test('refuses to guess a heap budget without a finite limit', () => {
  assert.equal(calculateOldSpaceLimit({ limitBytes: null }), null);
});

test('adaptive GC policy requires consecutive heap-pressure samples', () => {
  const policy = createMemoryPolicy({
    mode: 'adaptive',
    heapPressureHigh: 0.9,
    consecutiveSamples: 3
  });

  const sample = { heapUsed: 91, heapLimit: 100 };
  assert.equal(policy.evaluate(sample).shouldCollect, false);
  assert.equal(policy.evaluate(sample).shouldCollect, false);
  assert.equal(policy.evaluate(sample).shouldCollect, true);
});

test('a healthy sample resets consecutive high-pressure samples', () => {
  const policy = createMemoryPolicy({
    mode: 'adaptive',
    heapPressureHigh: 0.9,
    consecutiveSamples: 2
  });

  assert.equal(policy.evaluate({ heapUsed: 95, heapLimit: 100 }).shouldCollect, false);
  assert.equal(policy.evaluate({ heapUsed: 50, heapLimit: 100 }).shouldCollect, false);
  assert.equal(policy.evaluate({ heapUsed: 95, heapLimit: 100 }).shouldCollect, false);
  assert.equal(policy.evaluate({ heapUsed: 95, heapLimit: 100 }).shouldCollect, true);
});

test('RSS alone cannot trigger adaptive GC', () => {
  const policy = createMemoryPolicy({
    mode: 'adaptive',
    heapPressureHigh: 0.9,
    consecutiveSamples: 2
  });

  assert.equal(
    policy.evaluate({ heapUsed: 20, heapLimit: 100, rssGrowth: 500 }).shouldCollect,
    false
  );
});

test('always mode is explicit and disabled mode never collects', () => {
  assert.equal(createMemoryPolicy({ mode: 'always' }).evaluate({}).shouldCollect, true);
  assert.equal(createMemoryPolicy({ mode: 'off' }).evaluate({}).shouldCollect, false);
});
