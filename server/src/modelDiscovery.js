import {
  fitTier, groupVariants, hubHardware, isCompanionVariant, modelFileTree,
  quantLabel, draftKind, searchModels,
} from './hfHub.js';

const GiB = 1024 ** 3;
const CATALOG_TTL = 10 * 60 * 1000;
const MAX_STALE = 24 * 60 * 60 * 1000;
const SOURCES = ['unsloth', 'bartowski', 'lmstudio-community', 'ggml-org'];
let catalog = null;
let pendingCatalog = null;

function releaseTime(model) { return Date.parse(model.createdAt ?? '') || 0; }
function popularity(model) { return Math.log10(1 + (model.downloads || 0)) * 2 + Math.log10(1 + (model.likes || 0)); }
function trending(model) { return Number.isFinite(model.trendingScore) ? model.trendingScore : popularity(model); }

export function modelIdentity(model) {
  return String(model.baseModel ?? model.id).split('/').pop()
    .toLowerCase().replace(/[-_]gguf(?:[-_].*)?$/, '').replace(/[^a-z0-9.]/g, '');
}

function familyIdentity(model) {
  return modelIdentity(model).replace(/\d+(?:\.\d+)?b(?:a\d+(?:\.\d+)?b)?/g, '')
    .replace(/(?:instruct|chat|thinking|reasoning|base|it)$/g, '');
}

export function diverseModels(models, limit = 12, perFamily = 2) {
  const families = new Map();
  return uniqueModels(models).filter((model) => {
    const family = familyIdentity(model);
    const count = families.get(family) || 0;
    if (count >= perFamily) return false;
    families.set(family, count + 1);
    return true;
  }).slice(0, limit);
}

function uniqueModels(models) {
  const seen = new Set();
  return models.filter((m) => {
    const key = modelIdentity(m);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function describeDiscoveryModel(model, hw) {
  const name = model.id.toLowerCase();
  const skills = [];
  if (/coder|code|devstral|codestral/.test(name)) skills.push('Coding');
  if (/reason|think|qwq|gpt-oss|magistral/.test(name)) skills.push('Reasoning');
  if (/vision|[-_.]vl[-_.]|omni/.test(name) || ['image-text-to-text', 'any-to-any'].includes(model.pipelineTag)) skills.push('Vision');
  if (!skills.length) skills.push('Chat');
  // This is a Q4 screening estimate, not the size of a downloadable file.
  // Recommendations below replace it with real grouped GGUF sizes.
  const estimatedBytes = model.paramsB > 0 ? model.paramsB * 1e9 * 0.6 : null;
  const fit = estimatedBytes ? fitTier(estimatedBytes, hw) : 'unknown';
  const summary = skills.includes('Coding') ? 'A model to explore for code, debugging, and development.'
    : skills.includes('Reasoning') ? 'Explore reasoning and detailed answers with a local model.'
    : skills.includes('Vision') ? 'Chat with a multimodal model. Image input needs runtime support.'
    : model.paramsB && model.paramsB <= 4 ? 'A lightweight option for quick, everyday conversations.'
    : 'A local model for writing, questions, and everyday conversations.';
  return { ...model, skills, summary, memory: { bytes: estimatedBytes, fit, estimated: true } };
}

async function loadCatalog() {
  if (catalog && Date.now() - catalog.at < CATALOG_TTL) return { ...catalog, stale: false };
  if (pendingCatalog) return pendingCatalog;
  pendingCatalog = (async () => {
    const responses = await Promise.allSettled(SOURCES.flatMap((author) =>
      ['createdAt', 'trendingScore'].map((sort) => searchModels('', { author, sort, filter: 'gguf', limit: 40 }))));
    const models = new Map();
    let failures = 0;
    for (const response of responses) {
      if (response.status !== 'fulfilled') { failures += 1; continue; }
      for (const model of response.value.models) {
        if (model.kind !== 'chat' || model.private || model.gated || /(?:^|[-_.])(?:mtp|eagle3|dflash|mmproj)(?:[-_.]|$)/i.test(model.id)) continue;
        models.set(model.id, model);
      }
    }
    if (!models.size) {
      if (catalog && Date.now() - catalog.at < MAX_STALE) return { ...catalog, stale: true };
      throw new Error('Model sources are unavailable. Try again in a moment.');
    }
    catalog = { models: [...models.values()], at: Date.now(), partialSources: failures };
    return { ...catalog, stale: false };
  })().finally(() => { pendingCatalog = null; });
  return pendingCatalog;
}

export function chooseDiscoveryVariant(variants, hw) {
  // Total installed RAM must not substitute for free RAM in recommendations.
  const liveHw = { ...hw, ramTotalGB: null };
  const real = variants.map((v) => ({ ...v, quant: quantLabel(v.name), draft: draftKind(v.name), fit: fitTier(v.size, liveHw) }));
  const rank = { fits: 0, marginal: 1, partial: 2, ram: 3 };
  const candidates = real.filter((v) => v.include && v.complete !== false && v.size >= 32 * 1024 ** 2 && rank[v.fit] != null && !isCompanionVariant(v, real));
  // A balanced 4/5-bit file is preferable to an ultra-low-bit quant just
  // because the latter squeezes under the card's limit.
  const quality = (v) => {
    const bits = Number(v.quant?.match(/I?Q(\d)/i)?.[1]);
    return bits === 4 ? 0 : bits === 5 ? 1 : bits === 6 ? 2 : bits === 8 ? 3 : bits === 3 ? 9 : bits <= 2 && bits > 0 ? 14 : 6;
  };
  candidates.sort((a, b) => (rank[a.fit] * 3 + quality(a)) - (rank[b.fit] * 3 + quality(b)) || a.size - b.size);
  return candidates[0] ?? null;
}

async function recommendations(models, hw) {
  if (hw.available === false || (!hw.gpuTotalGB && !hw.ramAvailableGB)) return [];
  // Freshness and usage determine candidates. Parameter screening avoids
  // fetching hundreds of enormous repos. A real GGUF file is required.
  const budgetGB = Math.max(0, hw.gpuTotalGB || 0) + Math.max(0, hw.ramAvailableGB || 0) * 0.9;
  const shortlist = diverseModels(models.filter((m) => !m.gated && !m.private
    && (!m.paramsB || m.paramsB * 1e9 * 0.5 <= budgetGB * GiB))
    .sort((a, b) => recommendationScore(b) - recommendationScore(a)), 20);
  const verified = [];
  let index = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (index < shortlist.length) {
      const model = shortlist[index++];
      try {
        const grouped = groupVariants(await modelFileTree(model.id));
        const variant = chooseDiscoveryVariant(grouped.variants, hw);
        if (!variant) continue;
        const fullGpu = variant.fit === 'fits' || variant.fit === 'marginal';
        verified.push({ ...describeDiscoveryModel(model, hw),
          suggestedVariant: { name: variant.name, include: variant.include, quant: variant.quant, bytes: variant.size },
          memory: { bytes: variant.size, fit: variant.fit, estimated: false },
          recommendation: { label: fullGpu ? 'GPU pick' : variant.fit === 'ram' ? 'CPU + RAM' : 'Uses GPU + RAM',
            reason: `${variant.quant ?? 'GGUF'} · ${fullGpu ? 'Estimated to fit in your graphics memory.' : variant.fit === 'ram' ? 'Estimated to fit in available system memory; runs on your CPU.' : 'Needs some available system memory; expect slower replies.'}` },
        });
      } catch { /* A missing or incomplete repo must not become a recommendation. */ }
    }
  }));
  verified.sort((a, b) => Number(!['fits', 'marginal'].includes(a.memory.fit)) - Number(!['fits', 'marginal'].includes(b.memory.fit))
    || recommendationScore(b) - recommendationScore(a));
  return diverseModels(verified, 12);
}

function recommendationScore(model) {
  const ageDays = Math.max(0, (Date.now() - releaseTime(model)) / 86400000);
  return popularity(model) + 8 * Math.exp(-ageDays / 90) + (model.paramsB >= 4 ? 1 : 0);
}

export async function discoverModels({ feed = 'recommended', query = '', sort = '', cursor } = {}) {
  if (!['recommended', 'new', 'trending', 'all'].includes(feed)) throw Object.assign(new Error('Unknown discovery feed'), { status: 400 });
  const hw = await hubHardware();
  if (String(query).trim()) {
    const result = await searchModels(String(query).trim(), { filter: 'gguf', sort: sort || 'trendingScore', cursor, limit: 40 });
    return { ...result, models: result.models.filter((m) => m.kind === 'chat').map((m) => describeDiscoveryModel(m, hw)),
      fetchedAt: new Date().toISOString(), stale: false, hardwareAvailable: hw.available !== false };
  }
  const source = await loadCatalog();
  let models;
  if (feed === 'recommended') models = await recommendations(source.models, hw);
  else {
    const order = feed === 'new' || sort === 'createdAt' ? (a, b) => releaseTime(b) - releaseTime(a)
      : sort === 'likes' ? (a, b) => b.likes - a.likes
      : sort === 'downloads' ? (a, b) => b.downloads - a.downloads
      : (a, b) => trending(b) - trending(a);
    models = uniqueModels([...source.models].sort(order)).map((m) => describeDiscoveryModel(m, hw));
  }
  return { models, nextCursor: null, fetchedAt: new Date(source.at).toISOString(), stale: source.stale,
    partialSources: source.partialSources, hardwareAvailable: hw.available !== false,
    sources: SOURCES, refreshMinutes: CATALOG_TTL / 60000 };
}
