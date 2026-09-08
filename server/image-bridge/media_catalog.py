"""Metadata-only media discovery and request contracts; no GPU imports."""
import importlib.util
import inspect
import json
import math
import re
from pathlib import Path


def read_json(path):
    try:
        data = json.loads(path.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def weights_ready(root):
    for index in root.glob('*.index.json'):
        files = set(read_json(index).get('weight_map', {}).values())
        if files:
            return all((root / f).is_file() and (root / f).stat().st_size > 0 for f in files)
    return any(p.is_file() and p.stat().st_size > 0
               for pattern in ('*.safetensors', 'pytorch_model*.bin', 'diffusion_pytorch_model*.bin', '*.gguf')
               for p in root.glob(pattern))


def _compact(text):
    return re.sub(r'[^a-z0-9]+', '', str(text).lower())


def snapshot_hint(snap, repo_id=''):
    bits = [repo_id]
    try:
        bits.append(snap.parents[1].name.replace('models--', '').replace('--', '/'))
    except IndexError:
        pass
    return ' '.join(bits)


def infer_task(text):
    """Map a pipeline class, repo id, or cache folder onto image/video/audio/tts.

    Unknown text returns None — callers must not treat that as an image. Speech
    is checked before generic audio so OmniVoice/Bark/Piper never land in Images
    just because the class name omitted the word "audio".
    """
    raw = str(text or '')
    s = re.sub(r'([a-z])([A-Z])', r'\1 \2', raw).lower()
    parts = re.findall(r'[a-z0-9]+', s)
    compact = ''.join(parts)
    partset = set(parts)
    if not compact:
        return None
    if partset & {'tokenizer', 'codec', 'encodec'} or 'tokenizer' in compact or 'encodec' in compact:
        return None
    if partset & {'tts', 'speecht5', 'bark', 'vits', 'piper', 'kokoro', 'xtts', 'chatterbox', 'speech'} or any(
        x in compact for x in (
            'omnivoice', 'openvoice', 'cosyvoice', 'styletts', 'fishspeech',
            'higgstts', 'higgsaudio', 'mosstts', 'qwen3tts', 'qwentts',
            'f5tts', 'indextts', 'melotts', 'voiceclone', 'voicecraft',
            'texttospeech', 'parlertts', 'speecht5',
        )
    ):
        return 'tts'
    if 'music' in partset or any(x in compact for x in (
        'musicgen', 'stableaudio', 'audioldm', 'minimaxmusic', 'texttoaudio',
        'riffusion', 'musicldm',
    )):
        return 'audio'
    if 'audio' in partset or 'audio' in compact:
        return 'audio'
    if 'video' in partset or 'video' in compact or any(x in compact for x in (
        'ltxvideo', 'ltx2', 'ltxcondition', 'ltxv', 'cogvideox', 'hunyuanvideo',
        'texttovideo', 'imagetovideo', 'pyramidflow', 'opensora', 'wanvideo',
        'wan22', 'wan21',
    )):
        return 'video'
    if partset & {'ltx', 'wan', 'mochi', 'allegro'}:
        return 'video'
    if partset & {'flux', 'sdxl', 'sd3', 'krea', 'ideogram', 'chroma'} or any(x in compact for x in (
        'stablediffusion', 'pixart', 'playgroundv', 'auraflow', 'lumina', 'kolors',
        'cogview', 'hunyuandit', 'hunyuanimage', 'dreamshaper', 'dreambooth',
        'hidream', 'zimage', 'qwenimage', 'texttoimage',
    )):
        return 'image'
    return None


def pipeline_task(name, hint=''):
    return infer_task(f'{name} {hint}') or 'image'


def inspect_snapshot(snap, native_available=False, repo_id=''):
    hint = snapshot_hint(snap, repo_id)
    idx = read_json(snap / 'model_index.json')
    cls = idx.get('_class_name', '')
    if isinstance(cls, str) and cls.endswith('Pipeline'):
        info = dict(kind='diffusers', task=pipeline_task(cls, hint), path=str(snap), **{'class': cls})
        missing = []
        for name, component in idx.items():
            if name.startswith('_') or not isinstance(component, list) or len(component) != 2 or not component[0]:
                continue
            folder = snap / name
            if not folder.is_dir():
                missing.append(name)
            elif any(x in str(component[1]).lower() for x in ('model', 'encoder', 'autoencoder', 'unet', 'vocoder')) and not weights_ready(folder):
                missing.append(name + ' weights')
        # A pipeline index by itself is never sufficient.
        if not any(weights_ready(p) for p in snap.iterdir() if p.is_dir()):
            missing.append('model weights')
        if missing:
            return dict(info, ready=False, reason='Download incomplete: ' + ', '.join(missing))
        # Conditioning-only pipelines cannot accept just a text prompt.
        if any(x in cls.lower() for x in ('img2img', 'image2video', 'imagetovideo', 'inpaint', 'controlnet', 'upscale')):
            return dict(info, ready=False, reason='This pipeline needs an input image; text-only generation is not supported yet')
        return dict(info, ready=True)

    cfg = read_json(snap / 'config.json')
    if cfg:
        architecture = str(cfg.get('model_type', '')).lower()
        names = ' '.join(cfg.get('architectures', [])).lower()
        descriptor = architecture + ' ' + names
        named_task = infer_task(f'{descriptor} {hint}')
        if any(x in descriptor for x in ('tokenizer', 'codec', 'encodec')):
            return None  # Companion audio encoders cannot synthesize speech.
        if 'musicgen_melody' in descriptor or 'musicgenmelody' in descriptor:
            return dict(kind='unsupported', task='audio', path=str(snap), ready=False,
                        reason='MusicGen Melody requires a conditioning adapter; use a standard MusicGen model')
        if 'musicgen' in descriptor:
            info = dict(kind='musicgen', task='audio', path=str(snap), max_duration=30)
        elif 'omnivoice' in descriptor or (named_task == 'tts' and 'omnivoice' in _compact(hint)):
            info = dict(kind='omnivoice', task='tts', path=str(snap), cloning=True)
            if not importlib.util.find_spec('omnivoice'):
                return dict(info, ready=False, reason='OmniVoice weights found. Install omnivoice in the media bridge environment and restart it')
        elif any(x in descriptor for x in ('moss_tts', 'moss-tts', 'higgs_audio', 'higgs-tts', 'higgs_tts', 'minimax_music')):
            info = dict(kind='native_audio', task='audio' if 'music' in descriptor else 'tts', path=str(snap), cloning=False)
            if not native_available:
                return dict(info, ready=False, reason='Install the Unsloth native audio runtime')
        elif named_task == 'tts' or any(x in descriptor for x in ('qwen3_tts', 'bark', 'vits', 'speecht5', 'parler', 'tts')):
            return dict(kind='unsupported', task='tts', path=str(snap), ready=False, cloning=False,
                        reason=f'The {architecture or names} speech architecture needs a dedicated runtime adapter')
        elif named_task == 'audio':
            return dict(kind='unsupported', task='audio', path=str(snap), ready=False,
                        reason='This audio architecture needs a dedicated runtime adapter')
        else:
            return None  # Text/embedding weights must never become single-file images.
        return dict(info, ready=weights_ready(snap), **({} if weights_ready(snap) else {'reason': 'Download incomplete: model weights'}))

    task = infer_task(hint)
    if any(snap.rglob('*.gguf')) and task in ('image', 'video', 'audio', 'tts'):
        return dict(kind='gguf', task=task, path=str(snap), ready=False,
                    reason='GGUF media needs a dedicated loader and companion encoders; choose a complete Diffusers repository')
    if any(snap.glob('*.safetensors')) and task in ('image', 'video', 'audio', 'tts'):
        return dict(kind='single_file', task=task, path=str(snap), ready=False,
                    reason='Standalone checkpoint architecture is unknown; choose a complete Diffusers repository')
    return None


def scan_models(hub_dir, native_available=False):
    models = {}
    if not hub_dir.is_dir():
        return models
    for repo in sorted(hub_dir.glob('models--*')):
        try:
            snapshots = [p for p in (repo / 'snapshots').iterdir() if p.is_dir()]
            snapshots.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            # Follow the requested main revision when present, not an arbitrary
            # partially-created snapshot from a concurrent download.
            ref = repo / 'refs' / 'main'
            main = ref.read_text().strip() if ref.is_file() else ''
            snapshots.sort(key=lambda p: p.name != main)
            if snapshots:
                repo_id = repo.name[8:].replace('--', '/', 1)
                info = inspect_snapshot(snapshots[0], native_available, repo_id=repo_id)
                if info:
                    models[repo_id] = info
        except OSError:
            continue  # A concurrent deletion must not hide every other model.
    return models


def select_model(models, requested, task, default=''):
    if requested and requested != 'auto':
        info = models.get(requested)
        if not info:
            raise ValueError(f'Model {requested} is not downloaded or recognized')
        if info.get('task') != task:
            raise ValueError(f'Model {requested} is for {info.get("task")}, not {task}')
        if not info.get('ready'):
            raise ValueError(info.get('reason', 'Model is not ready'))
        return requested, info
    candidates = {k: v for k, v in models.items() if v.get('ready') and v.get('task') == task}
    if not candidates:
        raise ValueError(f'No ready {task} model. Download a compatible model in Model Hub')
    chosen = default if default in candidates else next(iter(candidates))
    return chosen, candidates[chosen]


def pipeline_kwargs(pipe, kwargs):
    params = inspect.signature(pipe.__call__).parameters
    # Optional negative prompts vary by architecture. Required task controls
    # must never be silently discarded (e.g. requested duration or dimensions).
    result = {}
    for key, value in kwargs.items():
        if value is None:
            continue
        if key in params:
            result[key] = value
        elif key == 'negative_prompt':
            raise ValueError('This model does not support a negative prompt; clear it and retry')
        else:
            raise ValueError(f'This pipeline does not support the {key} control')
    return result


def validate_request(body):
    if not isinstance(body.get('prompt'), str) or not body['prompt'].strip():
        raise ValueError('Prompt is required')
    if body.get('task', 'image') not in ('image', 'video', 'audio', 'tts'):
        raise ValueError('Unknown media task')
    for key, low, high in (('n', 1, 4), ('steps', 1, 80), ('fps', 1, 60),
                           ('num_frames', 1, 500), ('audio_duration', .5, 600), ('seed', 0, 2**32 - 1)):
        value = body.get(key)
        if value is not None:
            try:
                n = float(value)
            except (TypeError, ValueError):
                raise ValueError(f'Invalid {key}')
            if not math.isfinite(n) or not low <= n <= high or (key != 'audio_duration' and not n.is_integer()):
                raise ValueError(f'{key} must be between {low} and {high}')
    size = re.fullmatch(r'(\d+)x(\d+)', str(body.get('size', '1024x1024')))
    if not size or any(not 64 <= int(n) <= 2048 or int(n) % 8 for n in size.groups()):
        raise ValueError('Size must use multiples of 8 between 64 and 2048')
