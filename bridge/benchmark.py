"""Run inference only through Windows; keep weights/context/cache types fixed."""
import hashlib
import json
from pathlib import Path
import statistics
import time
import httpx
import runtime_profiles

ROOT = Path(__file__).resolve().parent
MODEL = 'unsloth/Qwen3.8-27B-UD-Q4_K_M'
RESULT = ROOT / 'tps-benchmark-result.json'
CLIENT = httpx.Client(base_url='http://127.0.0.1:8081', timeout=180, trust_env=False)
PROMPTS = {
    'prose': 'Explain how a computer executes a program, from loading it from an SSD through CPU instructions, RAM and caches. Give a clear detailed explanation in ordinary prose.',
    'code': 'Write a complete Python function that uses binary search to find an integer in a sorted list, followed by several assert-based examples and an explanation of edge cases.',
}
results = []

def record(item):
    results.append(item)
    RESULT.write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(item), flush=True)

def load(profile):
    profile = runtime_profiles.validate(profile)
    response = CLIENT.post('/models/load', json={'model': MODEL, 'profile': profile})
    response.raise_for_status()
    deadline = time.monotonic() + 100
    while time.monotonic() < deadline:
        state = CLIENT.get('/bridge/status').json()
        if state['status'] == 'loaded':
            assert state['model'] == MODEL and state['runtime_profile'] == profile, state
            props = CLIENT.get('/props').json()
            assert props['default_generation_settings']['n_ctx'] == 32768, props
            return profile, state['cold_load_seconds']
        if state['status'] == 'error':
            raise RuntimeError(state['error'])
        time.sleep(0.5)
    raise RuntimeError('Benchmark model load timed out')

def measure(name, profile, rounds=1):
    try:
        profile, load_seconds = load(profile)
        runs = []
        for round_id in range(rounds):
            for task, prompt in PROMPTS.items():
                payload = {'model': MODEL, 'runtime_profile': profile, 'messages': [{'role': 'user', 'content': prompt}],
                           'temperature': 0, 'top_k': 1, 'top_p': 1, 'min_p': 0, 'seed': 42,
                           'max_tokens': 128, 'ignore_eos': True, 'stream': False, 'cache_prompt': False,
                           'chat_template_kwargs': {'enable_thinking': False}}
                started = time.monotonic()
                response = CLIENT.post('/v1/chat/completions', json=payload)
                response.raise_for_status()
                data = response.json()
                timing = data['timings']
                tokens = data['usage']['completion_tokens']
                assert tokens == 128, data
                content = data['choices'][0]['message'].get('content', '')
                runs.append({'task': task, 'round': round_id + 1, 'tokens': tokens,
                             'tps': timing['predicted_per_second'], 'prompt_tps': timing['prompt_per_second'],
                             'wall_seconds': round(time.monotonic() - started, 3),
                             'cache_tokens': timing['cache_n'], 'sha256': hashlib.sha256(content.encode()).hexdigest(),
                             'text': content})
                print(json.dumps({'variant': name, 'task': task, 'tps': round(timing['predicted_per_second'], 3)}), flush=True)
        item = {'name': name, 'profile': profile, 'load_seconds': load_seconds,
                'median_tps': statistics.median(r['tps'] for r in runs), 'runs': runs}
        record(item)
        return item
    except Exception as e:
        record({'name': name, 'profile': profile, 'error': str(e)})
        CLIENT.post('/models/unload', json={'model': MODEL}).raise_for_status()
        return None

if __name__ == '__main__':
    try:
        baseline = measure('baseline-12', {})
        if baseline is None:
            raise RuntimeError('Baseline failed')
        candidates = [baseline]
        for threads in (6, 8):
            item = measure(f'threads-{threads}', {'threads': threads})
            if item:
                candidates.append(item)
        best = max(candidates, key=lambda item: item['median_tps'])
        placement = measure('reserve-256', {**best['profile'], 'fitMargin': 256})
        if placement:
            candidates.append(placement)
        best = max(candidates, key=lambda item: item['median_tps'])
        speculation = measure('ngram-map-k', {**best['profile'], 'specType': 'ngram-map-k'})
        if speculation:
            candidates.append(speculation)
        best = max(candidates, key=lambda item: item['median_tps'])
        record({'stage': 'sweep_complete', 'best': best['name'], 'profile': best['profile'],
                'baseline_tps': baseline['median_tps'], 'best_tps': best['median_tps']})
        measure('confirm-baseline', {}, rounds=2)
        if best['name'] != baseline['name']:
            measure('confirm-best', best['profile'], rounds=2)
    finally:
        CLIENT.post('/models/unload', json={'model': MODEL}).raise_for_status()
