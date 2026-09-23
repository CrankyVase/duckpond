// One installation state per variant. A file's size is never a successful task.
const STATES = ['missing', 'partial', 'downloading', 'downloaded', 'dependencies_missing', 'ready', 'loaded', 'verified'];

const COPY = {
  missing: {
    label: 'Not downloaded',
    detail: 'No files for this version are on disk.',
    next: 'Download this version',
  },
  partial: {
    label: 'Incomplete',
    detail: 'The download or a required shard is incomplete.',
    next: 'Resume the download',
  },
  downloading: {
    label: 'Downloading',
    detail: 'A transfer for this version is in progress.',
    next: 'Wait for the transfer to finish',
  },
  downloaded: {
    label: 'Downloaded',
    detail: 'Files are on disk, but runtime compatibility is not confirmed.',
    next: 'Confirm runtime compatibility',
  },
  dependencies_missing: {
    label: 'Dependencies missing',
    detail: 'Weights are on disk, but a required companion is absent.',
    next: 'Download the missing companion',
  },
  ready: {
    label: 'Ready to load',
    detail: 'Files are complete and a compatible runtime path exists. No successful task has been recorded.',
    next: 'Load this version',
  },
  loaded: {
    label: 'Loaded',
    detail: 'The runtime reports this version is resident. No successful task has been recorded.',
    next: 'Run a real task to verify it',
  },
  verified: {
    label: 'Verified',
    detail: 'A recorded successful task used this version.',
    next: 'No repair needed',
  },
};

const GROUPS = [
  { name: 'encoder', test: (p) => /(?:^|\/)text_encoders?(?:_\d+)?(?:\/|$)/i.test(p) },
  { name: 'VAE', test: (p) => /(?:^|\/)vaes?(?:\/|$)/i.test(p) },
  { name: 'tokenizer', test: (p) => /(?:^|\/)tokenizers?(?:_\d+)?(?:\/|$)/i.test(p) || /(?:^|\/)tokenizer(?:_config)?\.json$/i.test(p) },
  { name: 'config', test: (p) => /(?:^|\/)(?:model_index\.json|config\.json)$/i.test(p) },
];

function asFiles(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((file) => file && typeof file.path === 'string').map((file) => ({
    path: file.path.split('\\').join('/'),
    size: Number(file.size) || 0,
  }));
}

function isOptionalPath(path) {
  return /(?:^|\/)(?:readme(?:\.\w+)?|license(?:\.\w+)?|\.gitattributes|\.gitignore)$/i.test(path)
    || /\.(?:md|png|jpe?g|gif|webp|svg)$/i.test(path);
}

function isCompanionPath(path) {
  return GROUPS.some((group) => group.test(path))
    || /(?:^|\/)(?:scheduler|feature_extractor)s?(?:\/|$)/i.test(path);
}

function isWeightPath(path) {
  return /\.(?:safetensors|gguf|ckpt|pt|pth|bin)$/i.test(path) && !isCompanionPath(path);
}

function shardNames(path) {
  const shard = String(path).match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
  if (!shard) return null;
  const total = Number(shard[3]);
  if (total < 1 || total > 1000) return [];
  const names = [];
  for (let i = 1; i <= total; i += 1) {
    names.push(`${shard[1]}-${String(i).padStart(5, '0')}-of-${shard[3]}.gguf`.toLowerCase());
  }
  return names;
}

function fileReady(expected, presentByPath) {
  const got = presentByPath.get(expected.path.toLowerCase());
  if (!got || got.size <= 0) return false;
  if (expected.size > 0 && got.size < expected.size * 0.999) return false;
  return true;
}

function expectedShardGap(expected, ready) {
  const ggufs = expected.filter((file) => /\.gguf$/i.test(file.path));
  if (!ggufs.length) return false;
  let saw = false;
  let missing = false;
  for (const file of ggufs) {
    const names = shardNames(file.path);
    if (!names) {
      if (ready.has(file.path.toLowerCase())) saw = true;
      else missing = true;
      continue;
    }
    if (!names.length) return true;
    for (const name of names) {
      if (ready.has(name)) saw = true;
      else missing = true;
    }
  }
  return saw && missing;
}

function presentShardGap(files) {
  const ggufs = files.filter((file) => /\.gguf$/i.test(file.path));
  if (!ggufs.length) return false;
  if (ggufs.some((file) => file.size <= 0)) return true;
  const names = new Set(files.map((file) => file.path.toLowerCase()));
  return ggufs.some((file) => {
    const parts = shardNames(file.path);
    if (!parts) return false;
    if (!parts.length) return true;
    return parts.some((name) => !names.has(name));
  });
}

function missingCompanionGroups(expected, ready) {
  const weights = expected.filter((file) => isWeightPath(file.path));
  if (!weights.length || !weights.every((file) => ready.has(file.path.toLowerCase()))) return [];
  const missing = [];
  for (const group of GROUPS) {
    const named = expected.filter((file) => group.test(file.path));
    if (!named.length) continue;
    if (!named.every((file) => ready.has(file.path.toLowerCase()))) missing.push(group.name);
  }
  return missing;
}

function missingFromPresent(files) {
  const paths = files.map((file) => file.path);
  const hasWeight = files.some((file) => file.size > 0 && isWeightPath(file.path));
  if (!hasWeight) return [];
  const pipeline = paths.some((path) => /model_index\.json$/i.test(path));
  const split = paths.some((path) => /text_encoder/i.test(path) || /(?:^|\/)vaes?(?:\/|$)/i.test(path));
  if (!pipeline && !split) return [];
  const required = pipeline ? GROUPS : GROUPS.filter((group) => group.name === 'encoder' || group.name === 'VAE');
  return required.filter((group) => !paths.some((path) => group.test(path))).map((group) => group.name);
}

function derive(input) {
  const present = asFiles(input.presentFiles);
  const expected = asFiles(input.expectedFiles).filter((file) => !isOptionalPath(file.path));
  const bundle = asFiles(input.bundleFiles);
  const presentByPath = new Map(present.map((file) => [file.path.toLowerCase(), file]));
  if (expected.length) {
    const ready = new Set(expected.filter((file) => fileReady(file, presentByPath)).map((file) => file.path.toLowerCase()));
    const anyPresent = expected.some((file) => {
      const got = presentByPath.get(file.path.toLowerCase());
      return !!got;
    });
    const shardGap = expectedShardGap(expected, ready);
    const missingDependencies = missingCompanionGroups(expected, ready);
    const allReady = expected.every((file) => ready.has(file.path.toLowerCase()));
    const onlyCompanionsMissing = missingDependencies.length > 0 && expected.every((file) => (
      ready.has(file.path.toLowerCase()) || isCompanionPath(file.path)
    ));
    return {
      filesPresent: [...presentByPath.values()].some((file) => file.size > 0),
      incomplete: !allReady && !onlyCompanionsMissing && (anyPresent || shardGap),
      incompleteShard: shardGap,
      missingDependencies: onlyCompanionsMissing ? missingDependencies : [],
    };
  }
  const filesPresent = present.some((file) => file.size > 0);
  const shardGap = presentShardGap(present);
  const variantWeight = present.some((file) => file.size > 0 && isWeightPath(file.path));
  const missingDependencies = (!shardGap && variantWeight)
    ? missingFromPresent(bundle.length ? bundle : present)
    : [];
  return {
    filesPresent,
    incomplete: shardGap || present.some((file) => file.size <= 0 && !isOptionalPath(file.path)),
    incompleteShard: shardGap,
    missingDependencies,
  };
}

function recordedSuccess(input) {
  const flag = input.verified;
  if (flag === true) return true;
  if (typeof flag === 'number' && Number.isFinite(flag) && flag > 0) return true;
  if (typeof flag === 'string' && flag.trim() && flag.trim() !== 'false' && flag.trim() !== '0') return true;
  const at = input.verifiedAt ?? input.successfulTaskAt ?? input.successAt;
  if (typeof at === 'number' && Number.isFinite(at) && at > 0) return true;
  if (typeof at === 'string' && at.trim()) return true;
  return false;
}

function formatList(names) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function dependencyNames(input, derived) {
  if (input.dependenciesMissing === false) return [];
  if (Array.isArray(input.missingDependencies)) {
    return input.missingDependencies.map((name) => String(name).trim()).filter(Boolean);
  }
  if (input.dependenciesMissing === true) return derived?.missingDependencies?.length ? derived.missingDependencies : ['companion'];
  return derived?.missingDependencies ?? [];
}

/**
 * Classify one variant. `verified` is only true when the caller passes a
 * success flag or timestamp — never because bytes are present.
 * @returns {{ state: string, label: string, detail: string, next: string }}
 */
export function installationState(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const derived = (Array.isArray(src.expectedFiles) || Array.isArray(src.presentFiles) || Array.isArray(src.bundleFiles))
    ? derive(src) : null;
  const downloading = src.downloading === true || src.transfer === 'active' || src.transfer === 'running' || src.transfer === 'cancelling';
  const filesPresent = src.filesPresent ?? derived?.filesPresent ?? (Number(src.bytes) > 0 || Number(src.fileCount) > 0);
  const shardFlag = src.incompleteShard === true || src.shardIncomplete === true;
  let incomplete = src.incomplete === true || src.partial === true || shardFlag
    || derived?.incomplete === true || derived?.incompleteShard === true;
  const expectedBytes = Number(src.expectedBytes);
  const bytes = Number(src.bytes);
  if (!incomplete && Number.isFinite(expectedBytes) && expectedBytes > 0 && Number.isFinite(bytes) && bytes > 0 && bytes < expectedBytes * 0.999) {
    incomplete = true;
  }
  const names = dependencyNames(src, derived);
  const depsMissing = filesPresent && names.length > 0 && !incomplete;
  const status = String(src.runtimeStatus ?? '').toLowerCase();
  const loaded = src.loaded === true || src.resident === true || status === 'loaded' || status === 'sleeping' || status === 'loading';
  const runtimeCompatible = src.runtimeCompatible === true || src.runtimeReady === true;
  const verified = recordedSuccess(src);

  let state = 'downloaded';
  if (downloading) state = 'downloading';
  else if (incomplete) state = 'partial';
  else if (!filesPresent) state = 'missing';
  else if (depsMissing) state = 'dependencies_missing';
  else if (verified) state = 'verified';
  else if (loaded) state = 'loaded';
  else if (runtimeCompatible) state = 'ready';

  if (!STATES.includes(state)) state = 'missing';
  const copy = COPY[state];
  let detail = copy.detail;
  let next = copy.next;
  if (state === 'partial' && (shardFlag || derived?.incompleteShard)) {
    detail = 'A required shard is missing or incomplete. File size alone does not mean this version can run.';
  }
  if (state === 'dependencies_missing' && names.length && names[0] !== 'companion') {
    detail = `Weights are on disk, but ${formatList(names)} ${names.length === 1 ? 'is' : 'are'} absent.`;
    next = `Download missing ${formatList(names)}`;
  }
  if (state === 'verified') {
    const at = src.verifiedAt ?? src.successfulTaskAt ?? src.successAt;
    if ((typeof at === 'number' && at > 0) || (typeof at === 'string' && at.trim())) {
      detail = `A successful task was recorded (${at}).`;
    }
  }
  const note = typeof src.note === 'string' ? src.note.trim() : '';
  if (note && !detail.includes(note)) detail = `${detail} ${note}`;
  return { state, label: copy.label, detail, next };
}
