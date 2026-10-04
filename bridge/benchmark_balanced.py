"""Check MTP without restricting prompt work to one CCD or CPU operations."""
import json
import time
import benchmark as bench

if __name__ == '__main__':
    bench.RESULT = bench.ROOT / 'tps-balanced-result.json'
    previous = json.loads((bench.ROOT / 'tps-mtp-result.json').read_text())
    chosen = next(r for r in previous if r.get('stage') == 'mtp_sweep_complete')['profile']
    profile = {**chosen, 'threadsBatch': 12, 'cpuMask': '', 'opOffload': True}
    try:
        result = bench.measure('balanced-confirm', profile, rounds=2)
        if result is None:
            raise RuntimeError('Balanced profile failed')
        text = ('The pond monitoring system records water temperature, depth, and clarity each morning. '
                'Its readings are stored in a local database and reviewed every Friday. ') * 160
        prompt = 'Remember this exact access code: DUCK-4827.\n' + text + '\nReply with only the access code given at the start.'
        payload = {'model': bench.MODEL, 'runtime_profile': result['profile'],
                   'messages': [{'role': 'user', 'content': prompt}], 'temperature': 0,
                   'max_tokens': 32, 'stream': False, 'cache_prompt': False,
                   'chat_template_kwargs': {'enable_thinking': False}}
        started = time.monotonic()
        response = bench.CLIENT.post('/v1/chat/completions', json=payload)
        response.raise_for_status()
        data = response.json()
        content = data['choices'][0]['message']['content']
        assert 'DUCK-4827' in content, content
        bench.record({'name': 'balanced-long-input', 'profile': result['profile'], 'usage': data['usage'],
                      'timings': data['timings'], 'reply': content,
                      'wall_seconds': round(time.monotonic() - started, 3)})
    finally:
        bench.CLIENT.post('/models/unload', json={'model': bench.MODEL}).raise_for_status()
