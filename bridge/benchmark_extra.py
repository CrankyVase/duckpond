"""Second-stage placement/affinity/MTP tests, using the same Windows-only harness."""
import json
from pathlib import Path
import benchmark as bench

if __name__ == '__main__':
    bench.RESULT = bench.ROOT / 'tps-extra-result.json'
    previous = json.loads((bench.ROOT / 'tps-benchmark-result.json').read_text())
    initial = next(r for r in previous if r.get('stage') == 'sweep_complete')['profile']
    topology = json.loads((bench.ROOT / 'cpu-topology-result.json').read_text())
    try:
        baseline = bench.measure('current-best', initial)
        candidates = [baseline] if baseline else []
        for i, mask in enumerate(topology['physical_core_masks_per_ccd']):
            item = bench.measure(f'ccd-{i + 1}', {**initial, 'threads': 6, 'threadsBatch': 6, 'cpuMask': mask})
            if item:
                candidates.append(item)
        best = max(candidates, key=lambda r: r['median_tps'])
        no_offload = bench.measure('cpu-operations', {**best['profile'], 'opOffload': False})
        if no_offload:
            candidates.append(no_offload)
        best = max(candidates, key=lambda r: r['median_tps'])
        ffn = bench.measure('cpu-ffn-12', {**best['profile'], 'cpuFfn': 12})
        if ffn:
            candidates.append(ffn)
        best = max(candidates, key=lambda r: r['median_tps'])
        mtp = bench.measure('mtp-3', {**best['profile'], 'specType': 'draft-mtp'})
        if mtp:
            candidates.append(mtp)
        best = max(candidates, key=lambda r: r['median_tps'])
        bench.record({'stage': 'extra_sweep_complete', 'best': best['name'], 'profile': best['profile'], 'best_tps': best['median_tps']})
        bench.measure('confirm-original', {}, rounds=2)
        bench.measure('confirm-extra-best', best['profile'], rounds=2)
    finally:
        bench.CLIENT.post('/models/unload', json={'model': bench.MODEL}).raise_for_status()
