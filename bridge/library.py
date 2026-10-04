"""Fedora is authoritative; Windows caches only files used by inference."""
import configparser
import hashlib
import json
from pathlib import Path
import re
import threading

ROOT = Path(__file__).resolve().parent
MODEL_ROOT = ROOT.parent / 'models'
INI = ROOT / 'models.ini'
LEDGER = ROOT / 'windows-cache.json'
lock = threading.RLock()

def records():
    cfg = configparser.ConfigParser(interpolation=None, strict=False)
    cfg.read(INI)
    result = {}
    for alias in cfg.sections():
        value = cfg[alias].get('model')
        if not value:
            continue
        path = Path(value)
        try:
            path.resolve().relative_to(MODEL_ROOT.resolve())
        except ValueError:
            continue
        if path.is_file():
            result[alias] = path
    # Completed downloads appear in the picker immediately. Companion image,
    # audio and embedding weights are not chat models.
    seen = {p.resolve() for p in result.values()}
    paths = []
    hub = MODEL_ROOT / 'huggingface/hub'
    for snapshots in hub.glob('models--*/snapshots'):
        paths.extend(snapshots.rglob('*.gguf'))
    paths.extend(p for p in MODEL_ROOT.rglob('*.gguf') if hub not in p.parents and 'qwen-image-2.1' not in p.parts)
    for path in sorted(paths):
        if path.resolve() in seen:
            continue
        if re.search(r'(mmproj|clip|vae|embed|whisper|tts|music|qwen[-_]image|flux|wan[.-]?\d|stable.diffusion)', str(path), re.I):
            continue
        shard = re.match(r'^(.*)-(\d{5})-of-(\d{5})\.gguf$', path.name)
        if shard:
            if shard[2] != '00001' or not all(path.with_name(f'{shard[1]}-{i:05d}-of-{int(shard[3]):05d}.gguf').is_file() for i in range(1, int(shard[3]) + 1)):
                continue
        alias = re.sub(r'[^a-z0-9]+', '-', path.stem.lower()).strip('-')[:80] or 'model'
        if alias in result:
            alias = alias[:68] + '-' + hashlib.sha256(str(path).encode()).hexdigest()[:10]
        result[alias] = path
        seen.add(path.resolve())
    return result

def ledger():
    try:
        return json.loads(LEDGER.read_text())
    except (FileNotFoundError, ValueError):
        return {}

def save(value):
    tmp = LEDGER.with_suffix('.tmp')
    tmp.write_text(json.dumps(value, indent=2) + '\n')
    tmp.replace(LEDGER)

def manifest(path):
    path = Path(path)
    stat = path.stat()
    with lock:
        entries = ledger()
        cached = entries.get(str(path))
        if cached and cached['bytes'] == stat.st_size and cached['mtime_ns'] == stat.st_mtime_ns:
            return cached
        with path.open('rb') as source:
            sha = hashlib.file_digest(source, 'sha256').hexdigest()
        value = dict(path=str(path), name=path.name, bytes=stat.st_size, mtime_ns=stat.st_mtime_ns, sha256=sha, cacheKey=sha)
        entries[str(path)] = value
        save(entries)
        return value

def chat_assets(path):
    path = Path(path)
    split = re.match(r'^(.*)-(\d{5})-of-(\d{5})\.gguf$', path.name)
    files = [path] if not split else [path.with_name(f'{split[1]}-{i:05d}-of-{int(split[3]):05d}.gguf') for i in range(1, int(split[3]) + 1)]
    if not all(p.is_file() for p in files):
        raise RuntimeError('All GGUF shards must be downloaded before loading')
    assets = [manifest(p) for p in files]
    key = assets[0]['sha256']
    assets = [dict(a, cacheKey=key) for a in assets]
    with lock:
        entries = ledger()
        entries.update({a['path']: a for a in assets})
        save(entries)
    return assets

def prune(remote_delete, protected=()):
    """Keep failed deletions queued in the ledger until Windows reconnects."""
    with lock:
        entries = ledger()
        missing = {p: a for p, a in entries.items() if not Path(p).is_file() and a['cacheKey'] not in protected}
        keys = sorted({a['cacheKey'] for a in missing.values()} - {a['cacheKey'] for p, a in entries.items() if Path(p).is_file()})
        if keys:
            remote_delete(keys)
        for p in missing:
            entries.pop(p)
        if missing:
            save(entries)
        return keys
