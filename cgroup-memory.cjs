'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIB = 1024n * 1024n;
const V1_UNLIMITED = 1n << 60n;

function unescapeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8))
  );
}

function parseMountInfo(content) {
  const mounts = [];

  for (const line of String(content).split('\n')) {
    if (!line) continue;

    const fields = line.split(' ');
    const separator = fields.indexOf('-');
    if (separator < 0 || fields.length <= separator + 3) continue;

    const type = fields[separator + 1];
    const root = unescapeMountPath(fields[3] || '/');
    const mountPoint = unescapeMountPath(fields[4] || '');
    const superOptions = fields[separator + 3] || '';

    if (type === 'cgroup2') {
      mounts.push({ version: 2, root, mountPoint });
    } else if (type === 'cgroup' && /(^|,)memory(,|$)/.test(superOptions)) {
      mounts.push({ version: 1, root, mountPoint });
    }
  }

  return mounts;
}

function parseCgroupMembership(content) {
  let v2 = null;
  let v1Memory = null;

  for (const line of String(content).split('\n')) {
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    if (first < 0 || second < 0) continue;

    const hierarchy = line.slice(0, first);
    const controllers = line.slice(first + 1, second).split(',');
    const groupPath = line.slice(second + 1);

    if (hierarchy === '0' && controllers.length === 1 && controllers[0] === '') {
      v2 = groupPath;
    } else if (controllers.includes('memory')) {
      v1Memory = groupPath;
    }
  }

  return { v2, v1Memory };
}

function resolveCgroupDirectory(mount, groupPath) {
  if (!mount || !groupPath || !mount.mountPoint) return null;

  const root = path.posix.normalize(mount.root || '/');
  const group = path.posix.normalize(groupPath);
  let relative;

  if (root === '/') {
    relative = group.replace(/^\/+/, '');
  } else if (group === root) {
    relative = '';
  } else if (group.startsWith(root.endsWith('/') ? root : `${root}/`)) {
    relative = group.slice(root.length).replace(/^\/+/, '');
  } else {
    return null;
  }

  return path.posix.resolve(mount.mountPoint, relative);
}

function readText(fileSystem, filePath) {
  try {
    return fileSystem.readFileSync(filePath, 'utf8').trim();
  } catch {
    return null;
  }
}

function parseLimit(value, version) {
  if (value == null || value === '' || value === 'max') return null;

  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) return null;
    if (version === 1 && parsed >= V1_UNLIMITED) return null;
    return parsed;
  } catch {
    return null;
  }
}

function ancestorDirectories(leaf, mountPoint) {
  const directories = [];
  let current = path.posix.resolve(leaf);
  const boundary = path.posix.resolve(mountPoint);

  while (current === boundary || current.startsWith(`${boundary}/`)) {
    directories.push(current);
    if (current === boundary) break;

    const parent = path.posix.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return directories;
}

function inspectMount(fileSystem, mount, groupPath) {
  const leaf = resolveCgroupDirectory(mount, groupPath);
  if (!leaf) return null;

  const limitFile = mount.version === 2 ? 'memory.max' : 'memory.limit_in_bytes';
  const currentFile = mount.version === 2 ? 'memory.current' : 'memory.usage_in_bytes';
  const limits = [];

  for (const directory of ancestorDirectories(leaf, mount.mountPoint)) {
    const value = readText(fileSystem, path.posix.join(directory, limitFile));
    const parsed = parseLimit(value, mount.version);
    if (parsed != null) limits.push({ path: directory, bytes: parsed });
  }

  const currentText = readText(fileSystem, path.posix.join(leaf, currentFile));
  let currentBytes = null;
  try {
    if (currentText != null && BigInt(currentText) >= 0n) currentBytes = BigInt(currentText);
  } catch {
    currentBytes = null;
  }

  return {
    version: mount.version,
    leaf,
    limits,
    currentBytes
  };
}

function serverMemoryLimit(env) {
  const raw = String(env.SERVER_MEMORY || '').trim();
  if (!/^[1-9][0-9]*$/.test(raw)) return null;

  const mib = BigInt(raw);
  if (mib > (1n << 40n)) return null;
  return mib * MIB;
}

function getMemoryInfo(options = {}) {
  const fileSystem = options.fs || fs;
  const env = options.env || process.env;
  const procRoot = options.procRoot || '/proc';
  const mountsContent = readText(fileSystem, path.join(procRoot, 'self/mountinfo')) || '';
  const membershipContent = readText(fileSystem, path.join(procRoot, 'self/cgroup')) || '';
  const mounts = parseMountInfo(mountsContent);
  const membership = parseCgroupMembership(membershipContent);

  const candidates = [];
  for (const mount of mounts) {
    const groupPath = mount.version === 2 ? membership.v2 : membership.v1Memory;
    if (!groupPath) continue;

    const inspected = inspectMount(fileSystem, mount, groupPath);
    if (!inspected) continue;

    for (const limit of inspected.limits) {
      candidates.push({
        source: `cgroup-v${mount.version}`,
        path: limit.path,
        limitBytes: limit.bytes
      });
    }

    if (inspected.currentBytes != null) {
      candidates.push({
        source: `cgroup-v${mount.version}-current`,
        currentBytes: inspected.currentBytes
      });
    }
  }

  const hardLimits = candidates.filter((item) => item.limitBytes != null);
  const serverLimit = serverMemoryLimit(env);
  if (serverLimit != null) {
    hardLimits.push({
      source: 'SERVER_MEMORY',
      path: null,
      limitBytes: serverLimit
    });
  }

  hardLimits.sort((a, b) => a.limitBytes < b.limitBytes ? -1 : a.limitBytes > b.limitBytes ? 1 : 0);
  const current = candidates.find((item) => item.currentBytes != null);

  return {
    limitBytes: hardLimits[0]?.limitBytes ?? null,
    limitSource: hardLimits[0]?.source ?? null,
    limitPath: hardLimits[0]?.path ?? null,
    currentBytes: current?.currentBytes ?? null,
    sources: hardLimits.map((item) => ({
      source: item.source,
      path: item.path,
      limitBytes: item.limitBytes.toString()
    }))
  };
}

function positiveInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) return fallback;
  return number;
}

function calculateOldSpaceLimit(info, env = process.env) {
  if (!info || typeof info.limitBytes !== 'bigint' || info.limitBytes <= 0n) return null;

  const ratio = positiveInteger(env.NODE_HEAP_RATIO, 60, 90);
  const reserveMiB = positiveInteger(env.NODE_HEAP_RESERVE_MB, 128, 1_048_576);
  const minimumMiB = positiveInteger(env.NODE_HEAP_MIN_MB, 64, 1_048_576);

  const ratioBudget = (info.limitBytes * BigInt(ratio)) / 100n;
  const reserveBytes = BigInt(reserveMiB) * MIB;
  const reserveBudget = info.limitBytes - reserveBytes;
  if (reserveBudget <= 0n) return null;

  const budget = ratioBudget < reserveBudget ? ratioBudget : reserveBudget;
  const mib = budget / MIB;
  if (mib < BigInt(minimumMiB)) return null;

  return Number(mib);
}

function toSerializable(info) {
  return {
    limitMiB: info.limitBytes == null ? null : Number(info.limitBytes / MIB),
    limitSource: info.limitSource,
    limitPath: info.limitPath,
    currentMiB: info.currentBytes == null ? null : Number(info.currentBytes / MIB),
    sources: info.sources
  };
}

if (require.main === module) {
  const info = getMemoryInfo();
  const heapLimit = calculateOldSpaceLimit(info);

  if (process.argv.includes('--heap')) {
    if (heapLimit != null) process.stdout.write(`${heapLimit}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({
      ...toSerializable(info),
      oldSpaceMiB: heapLimit
    }, null, 2)}\n`);
  }
}

module.exports = {
  MIB,
  parseMountInfo,
  parseCgroupMembership,
  resolveCgroupDirectory,
  ancestorDirectories,
  getMemoryInfo,
  calculateOldSpaceLimit,
  serverMemoryLimit,
  toSerializable
};
