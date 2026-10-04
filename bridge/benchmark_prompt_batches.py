"""Explicitly invoked prompt-batch comparison; never writes saved profiles.

Run only when the inference PC is available. Keeps the selected model's saved
thread/placement/speculation profile, weights, KV precision and 32K slot.
"""
import argparse
import time
import benchmark as bench
import runtime_profiles


def long_recall(profile):
    # Grow using exact tokenizer counts, rather than treating characters as tokens.
    # Markers at three positions catch obvious context/recall regressions.
    def messages(repeats):
        half = ('The pond team records depth, temperature and clarity each morning. ' * repeats)
        return [{'role': 'user', 'content':
                 'First marker: POND-4827.\n' + half + '\nMiddle marker: REED-7319.\n' + half
                 + '\nLast marker: DUCK-9061.\nReturn all three markers, in order, and nothing else.'}]

    low, high = 1, 8192
    chosen, token_count = None, 0
    while low <= high:
        mid = (low + high) // 2
        current = messages(mid)
        response = bench.CLIENT.post('/v1/chat/completions/input_tokens', json={'model': bench.MODEL, 'messages': current})
        response.raise_for_status()
        count = response.json()['input_tokens']
        if count <= 31_000:
            chosen, token_count, low = current, count, mid + 1
        else:
            high = mid - 1
    if chosen is None or token_count < 28_000:
        raise RuntimeError('Could not create a near-32K recall input for this model')

    started = time.monotonic()
    response = bench.CLIENT.post('/v1/chat/completions', json={
        'model': bench.MODEL, 'runtime_profile': profile, 'messages': chosen,
        'temperature': 0, 'top_k': 1, 'top_p': 1, 'min_p': 0, 'seed': 42,
        'max_tokens': 64, 'stream': False, 'cache_prompt': False,
        'chat_template_kwargs': {'enable_thinking': False},
    }, timeout=1800)
    response.raise_for_status()
    data = response.json()
    text = data['choices'][0]['message'].get('content', '')
    markers = ['POND-4827', 'REED-7319', 'DUCK-9061']
    positions = [text.find(marker) for marker in markers]
    return {'input_tokens': token_count, 'reply': text, 'passed': all(p >= 0 for p in positions)
            and positions == sorted(positions), 'usage': data.get('usage'), 'timings': data.get('timings'),
            'wall_seconds': round(time.monotonic() - started, 3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', default=bench.MODEL)
    parser.add_argument('--rounds', type=int, default=3, choices=range(1, 11))
    args = parser.parse_args()
    bench.MODEL = args.model
    bench.RESULT = bench.ROOT / 'prompt-batch-benchmark-result.json'
    baseline = runtime_profiles.for_model(args.model)
    try:
        variants = [('saved-baseline', baseline)]
        for batch, ubatch in ((2048, 256), (2048, 512), (2048, 1024), (4096, 512), (4096, 1024)):
            candidate = {**baseline, 'batchSize': batch, 'ubatchSize': ubatch}
            if candidate != baseline:
                variants.append((f'batch-{batch}-ubatch-{ubatch}', candidate))
        for name, profile in variants:
            result = bench.measure(name, profile, rounds=args.rounds)
            if result is None:
                continue
            try:
                recall = long_recall(result['profile'])
                bench.record({'name': name + '-long-recall', 'profile': result['profile'], **recall})
            except Exception as error:
                bench.record({'name': name + '-long-recall', 'profile': result['profile'], 'passed': False, 'error': str(error)})
        bench.record({'stage': 'comparison_complete', 'saved_profiles_changed': False,
                      'note': 'Compare prompt throughput, generation throughput, memory and recall. Review response text before choosing a profile; recall is not a complete quality evaluation.'})
    finally:
        bench.CLIENT.post('/models/unload', json={'model': bench.MODEL}).raise_for_status()


if __name__ == '__main__':
    main()
