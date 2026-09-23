// A single bounded host sample for the floating monitor. All byte counts are
// bytes on the wire; the UI labels binary memory units GiB. Missing sensors
// stay null. Samples are cached briefly so several open tabs do not multiply
// sysfs reads or process launches.
import { readFile, readdir, realpath, statfs } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const STORAGE_PATH = dirname(process.env.DUCKPOND_DB ?? new URL('../../data/duckpond.db', import.meta.url).pathname);
const finite = (v) => Number.isFinite(v) && v >= 0 ? v : null;
const textFile = async (path) => readFile(path, 'utf8').catch(() => null);
const numberFile = async (path) => {
  const raw = await textFile(path);
  return raw == null ? null : finite(Number(raw.trim()));
};
let lastCpu = null;
let lastDisk = null;
let cached = null;
let pending = null;

function cpuSample() {
  const cores = cpus();
  const times = cores.reduce((sum, core) => {
    for (const [key, value] of Object.entries(core.times)) sum[key] = (sum[key] ?? 0) + value;
    return sum;
  }, {});
  const total = Object.values(times).reduce((a, b) => a + b, 0);
  const idle = times.idle ?? 0;
  const elapsed = lastCpu ? total - lastCpu.total : 0;
  const busyPercent = elapsed > 0 ? Math.max(0, Math.min(100, 100 * (1 - (idle - lastCpu.idle) / elapsed))) : null;
  lastCpu = { total, idle };
  return { usagePercent: busyPercent, load1: finite(loadavg()[0]), cores: cores.length, temperatureC: null };
}

async function memorySample() {
  const raw = await textFile('/proc/meminfo');
  const values = Object.fromEntries([...raw?.matchAll(/^(\w+):\s+(\d+) kB/gm) ?? []]
    .map(([, key, value]) => [key, Number(value) * 1024]));
  const totalBytes = values.MemTotal ?? null;
  const availableBytes = values.MemAvailable ?? null;
  const swapTotalBytes = values.SwapTotal ?? null;
  const swapFreeBytes = values.SwapFree ?? null;
  return {
    totalBytes, availableBytes,
    usedBytes: totalBytes != null && availableBytes != null ? Math.max(0, totalBytes - availableBytes) : null,
    swap: { totalBytes: swapTotalBytes, usedBytes: swapTotalBytes != null && swapFreeBytes != null ? Math.max(0, swapTotalBytes - swapFreeBytes) : null },
  };
}

async function hwmonValues(path) {
  if (!path) return { temperatureC: null, fanRpm: null, powerW: null };
  const [temp, fan, power] = await Promise.all([
    numberFile(`${path}/temp1_input`), numberFile(`${path}/fan1_input`),
    numberFile(`${path}/power1_average`),
  ]);
  return { temperatureC: temp == null ? null : temp / 1000, fanRpm: fan, powerW: power == null ? null : power / 1_000_000 };
}

async function firstHwmon(path) {
  const names = await readdir(path).catch(() => []);
  const name = names.find((n) => /^hwmon\d+$/.test(n));
  return name ? `${path}/${name}` : null;
}

async function cpuTemperature() {
  const names = await readdir('/sys/class/hwmon').catch(() => []);
  for (const item of names) {
    if (!/^hwmon\d+$/.test(item)) continue;
    const path = `/sys/class/hwmon/${item}`;
    const name = (await textFile(`${path}/name`))?.trim();
    if (!['k10temp', 'coretemp', 'zenpower'].includes(name)) continue;
    const value = await numberFile(`${path}/temp1_input`);
    if (value != null) return value / 1000;
  }
  return null;
}

const GPU_NAMES = { '1002:7550': 'AMD Radeon RX 9070 XT' };

async function linuxGpu() {
  const cards = (await readdir('/sys/class/drm').catch(() => [])).filter((name) => /^card\d+$/.test(name));
  const found = [];
  for (const card of cards) {
    const path = `/sys/class/drm/${card}/device`;
    const vendor = (await textFile(`${path}/vendor`))?.trim();
    if (!vendor) continue;
    const [device, totalBytes, usedBytes, sharedTotalBytes, sharedUsedBytes, usagePercent, sensors] = await Promise.all([
      textFile(`${path}/device`), numberFile(`${path}/mem_info_vram_total`),
      numberFile(`${path}/mem_info_vram_used`), numberFile(`${path}/mem_info_gtt_total`),
      numberFile(`${path}/mem_info_gtt_used`), numberFile(`${path}/gpu_busy_percent`),
      firstHwmon(`${path}/hwmon`).then(hwmonValues),
    ]);
    const vendorName = vendor === '0x1002' ? 'AMD' : vendor === '0x10de' ? 'NVIDIA' : vendor === '0x8086' ? 'Intel' : 'GPU';
    const pci = `${vendor.replace(/^0x/, '')}:${(device ?? '').trim().replace(/^0x/, '')}`;
    found.push({
      name: GPU_NAMES[pci] ?? `${vendorName} GPU (${card})`, vendor: vendorName,
      utilizationPercent: usagePercent, dedicated: { usedBytes, totalBytes },
      // GTT is system RAM mapped by the GPU. It is displayed separately and
      // NEVER added to dedicated VRAM or system RAM totals.
      shared: { usedBytes: sharedUsedBytes, totalBytes: sharedTotalBytes }, ...sensors,
    });
  }
  return found.sort((a, b) => (b.dedicated.totalBytes ?? 0) - (a.dedicated.totalBytes ?? 0))[0] ?? null;
}

async function nvidiaGpu() {
  try {
    const { stdout } = await run('nvidia-smi', [
      '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw',
      '--format=csv,noheader,nounits',
    ], { timeout: 1700, maxBuffer: 8192 });
    const row = stdout.split('\n')[0]?.split(',').map((s) => s.trim());
    if (!row || row.length < 7) return null;
    const parsed = (s) => /^\d+(?:\.\d+)?$/.test(s) ? Number(s) : null;
    const mib = (s) => parsed(s) == null ? null : parsed(s) * 1024 * 1024;
    return {
      name: row[0], vendor: 'NVIDIA', utilizationPercent: parsed(row[1]),
      dedicated: { usedBytes: mib(row[2]), totalBytes: mib(row[3]) },
      shared: { usedBytes: null, totalBytes: null }, temperatureC: parsed(row[4]),
      fanRpm: null, fanPercent: parsed(row[5]), powerW: parsed(row[6]),
    };
  } catch { return null; }
}

async function gpuSample() {
  const sysfs = await linuxGpu();
  if (sysfs?.dedicated.totalBytes) return sysfs;
  return await nvidiaGpu() ?? sysfs ?? {
    name: null, vendor: null, utilizationPercent: null,
    dedicated: { usedBytes: null, totalBytes: null }, shared: { usedBytes: null, totalBytes: null },
    temperatureC: null, fanRpm: null, powerW: null,
  };
}

function mountRecord(line) {
  const bits = line.split(' ');
  const sep = bits.indexOf('-');
  return {
    id: bits[2],
    point: bits[4]?.replace(/\\([0-7]{3})/g, (_, code) => String.fromCharCode(parseInt(code, 8))),
    // btrfs reports a virtual major:minor. The source after "-" is the real disk.
    source: sep >= 0 ? bits[sep + 2] : null,
  };
}

async function diskDevice(path) {
  const raw = await textFile('/proc/self/mountinfo');
  const mount = raw?.split('\n').map(mountRecord)
    .filter((row) => row.point && (path === row.point || path.startsWith(`${row.point.replace(/\/$/, '')}/`)))
    .sort((a, b) => b.point.length - a.point.length)[0];
  if (!mount) return null;
  const diskstats = await textFile('/proc/diskstats');
  const rows = diskstats?.split('\n').map((line) => line.trim().split(/\s+/)).filter((bits) => bits.length >= 10) ?? [];
  const [major, minor] = String(mount.id ?? '').split(':').map(Number);
  const sourceName = mount.source?.startsWith('/dev/') ? mount.source.slice(5) : null;
  const row = rows.find((bits) => Number(bits[0]) === major && Number(bits[1]) === minor)
    ?? rows.find((bits) => bits[2] === sourceName);
  if (!row) return null;
  const name = row[2];
  const readBytes = Number(row[5]) * 512;
  const writeBytes = Number(row[9]) * 512;
  const now = Date.now();
  const prev = lastDisk?.name === name ? lastDisk : null;
  lastDisk = { name, readBytes, writeBytes, now };
  const seconds = prev ? (now - prev.now) / 1000 : 0;
  return {
    name,
    readBytesPerSec: seconds > 0 ? Math.max(0, (readBytes - prev.readBytes) / seconds) : null,
    writeBytesPerSec: seconds > 0 ? Math.max(0, (writeBytes - prev.writeBytes) / seconds) : null,
  };
}

async function diskTemperature(deviceName) {
  if (!deviceName?.startsWith('nvme')) return null;
  const controller = deviceName.match(/^nvme\d+/)?.[0];
  const names = await readdir('/sys/class/hwmon').catch(() => []);
  for (const item of names) {
    if (!/^hwmon\d+$/.test(item)) continue;
    const path = `/sys/class/hwmon/${item}`;
    if ((await textFile(`${path}/name`))?.trim() !== 'nvme') continue;
    const target = await realpath(`${path}/device`).catch(() => '');
    if (!target.includes(controller)) continue;
    const temp = await numberFile(`${path}/temp1_input`);
    return temp == null ? null : temp / 1000;
  }
  return null;
}

async function storageSample() {
  const [fs, device] = await Promise.all([statfs(STORAGE_PATH).catch(() => null), diskDevice(STORAGE_PATH)]);
  const totalBytes = fs ? fs.blocks * fs.bsize : null;
  const freeBytes = fs ? fs.bavail * fs.bsize : null;
  return {
    label: 'App storage', totalBytes, freeBytes,
    usedBytes: totalBytes != null && freeBytes != null ? Math.max(0, totalBytes - freeBytes) : null,
    readBytesPerSec: device?.readBytesPerSec ?? null,
    writeBytesPerSec: device?.writeBytesPerSec ?? null,
    temperatureC: await diskTemperature(device?.name),
  };
}

async function collect() {
  const cpu = cpuSample();
  const [memory, gpu, storage, temperatureC] = await Promise.all([
    memorySample(), gpuSample(), storageSample(), cpuTemperature(),
  ]);
  cpu.temperatureC = temperatureC;
  return { sampledAt: new Date().toISOString(), cpu, memory, gpu, storage };
}

export function systemMetrics() {
  if (cached && Date.now() - cached.at < 2000) return Promise.resolve(cached.sample);
  if (pending) return pending;
  pending = collect().then((sample) => {
    cached = { at: Date.now(), sample };
    return sample;
  }).finally(() => { pending = null; });
  return pending;
}
