"""Confirm Qwen's embedded draft head and check longer input on Windows."""
import json
import time
import benchmark as bench

if __name__ == '__main__':
    bench.RESULT = bench.ROOT / 'tps-mtp-result.json'
    previous = json.loads((bench.ROOT / 'tps-extra-result.json').read_text())
    initial = next(r for r in previous if r.get('stage') == 'extra_sweep_complete')['profile']
    try:
        candidates = [next(r for r in previous if r.get('name') == 'confirm-extra-best')]
        for name, changes in [('mtp-gpu-operations', {'opOffload': True}),
                              ('mtp-shorter-draft', {'specDraftMax': 2})]:
            result = bench.measure(name, {**initial, **changes})
            if result:
                candidates.append(result)
        best = max(candidates, key=lambda r: r['median_tps'])
        bench.record({'stage': 'mtp_sweep_complete', 'best': best['name'], 'profile': best['profile']})
        bench.measure('confirm-final', best['profile'], rounds=2)
        text = ('The pond monitoring system records water temperature, depth, and clarity each morning. '
                'Its readings are stored in a local database and reviewed every Friday. ') * 160
        prompt = ('Remember this exact access code: DUCK-4827.\n' + text +
                  '\nReply with only the access code given at the start.')
        for name, tuning in [('original-long-input', {}), ('final-long-input', best['profile'])]:
            profile, load_seconds = bench.load(tuning)
            payload = {'model': bench.MODEL, 'runtime_profile': profile,
                       'messages': [{'role': 'user', 'content': prompt}], 'temperature': 0,
                       'max_tokens': 32, 'stream': False, 'cache_prompt': False,
                       'chat_template_kwargs': {'enable_thinking': False}}
            started = time.monotonic()
            response = bench.CLIENT.post('/v1/chat/completions', json=payload)
            response.raise_for_status()
            data = response.json()
            content = data['choices'][0]['message']['content']
            assert 'DUCK-4827' in content, content
            bench.record({'name': name, 'profile': profile, 'usage': data['usage'],
                          'timings': data['timings'], 'reply': content,
                          'wall_seconds': round(time.monotonic() - started, 3)})
    finally:
        bench.CLIENT.post('/models/unload', json={'model': bench.MODEL}).raise_for_status()
