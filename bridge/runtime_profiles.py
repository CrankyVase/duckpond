"""Performance-only controls; model weights, context and KV precision are fixed."""
import json
from pathlib import Path

PROFILE_FILE = Path(__file__).resolve().parent / 'runtime-profiles.json'
DEFAULT = {'threads': 12, 'threadsBatch': 12, 'fitMargin': 1536, 'specType': 'none', 'cpuMask': '',
           'opOffload': True, 'cpuFfn': 0, 'specDraftMax': 3,
           'batchSize': 2048, 'ubatchSize': 512}

def validate(value):
    value = dict(value or {})
    if set(value) - set(DEFAULT):
        raise ValueError('Unsupported runtime tuning option')
    result = {**DEFAULT, **value}
    for name in ('threads', 'threadsBatch'):
        if type(result[name]) is not int or not 1 <= result[name] <= 24:
            raise ValueError('Thread count must be an integer from 1 to 24')
    for name in ('batchSize', 'ubatchSize'):
        if type(result[name]) is not int or result[name] not in (128, 256, 512, 1024, 2048, 4096, 8192):
            raise ValueError('Batch size must be a supported power of two from 128 to 8192')
    if result['ubatchSize'] > result['batchSize']:
        raise ValueError('Physical batch size cannot exceed logical batch size')
    if type(result['fitMargin']) is not int or result['fitMargin'] not in (256, 512, 768, 1024, 1536, 2048):
        raise ValueError('Keep a supported VRAM reserve')
    if result['specType'] not in ('none', 'ngram-simple', 'ngram-map-k', 'ngram-map-k4v', 'ngram-mod', 'ngram-cache', 'draft-mtp'):
        raise ValueError('Unsupported speculative decoding mode')
    if not isinstance(result['cpuMask'], str):
        raise ValueError('CPU mask must be a string')
    if result['cpuMask']:
        import re
        if not isinstance(result['cpuMask'], str) or not re.fullmatch(r'[0-9a-fA-F]{1,6}', result['cpuMask']):
            raise ValueError('CPU mask must select the Windows CPU cores')
    if type(result['opOffload']) is not bool:
        raise ValueError('Operation offload must be a boolean')
    if type(result['cpuFfn']) is not int or not 0 <= result['cpuFfn'] <= 64:
        raise ValueError('CPU FFN layer count must be from 0 to 64')
    if type(result['specDraftMax']) is not int or result['specDraftMax'] not in (1, 2, 3, 4, 6, 8):
        raise ValueError('Unsupported speculative draft length')
    return result

def for_model(model):
    try:
        profiles = json.loads(PROFILE_FILE.read_text())
    except FileNotFoundError:
        profiles = {}
    return validate(profiles.get(model))
