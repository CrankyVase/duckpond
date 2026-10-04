"""API smoke test: the website must save a real reply from the selected worker."""
import json
import os
from pathlib import Path
import time
import httpx

cookie = Path('/tmp/duckpond-qa-cookie.txt').read_text().strip()
client = httpx.Client(base_url='http://127.0.0.1:3000', headers={'Cookie': cookie}, timeout=30, trust_env=False)
created = client.post('/api/conversations', json={'model_id': os.environ.get('DUCKPOND_QA_MODEL', 'gemma-4-26b-a4b-it-ud-q3-k-xl')})
created.raise_for_status()
conv = created.json()['id']
try:
    client.patch(f'/api/conversations/{conv}', json={'title': 'Inference worker verification', 'settings': {'ctx_size': 8192, 'thinking': 'none', 'disabledTools': ['web_search', 'fetch_page', 'generate_image', 'start_project']}}).raise_for_status()
    r = client.get(f'/api/conversations/{conv}')
    r.raise_for_status()
    assert r.json()['settings']['ctx_size'] == 32768, r.text
    job = client.post(f'/api/conversations/{conv}/chat', json={'content': 'Reply with exactly: Website chat is working.'})
    job.raise_for_status()
    end = time.monotonic() + 180
    while time.monotonic() < end:
        r = client.get(f'/api/conversations/{conv}')
        r.raise_for_status()
        replies = [m for m in r.json()['messages'] if m['role'] == 'assistant' and m['content'].strip()]
        if replies:
            print(json.dumps({'conversation': conv, 'context': r.json()['settings']['ctx_size'], 'reply': replies[-1]['content']}), flush=True)
            break
        time.sleep(2)
    else:
        raise RuntimeError('Website did not persist a reply within three minutes')
finally:
    client.post(f'/api/conversations/{conv}/stop', json={})
    client.delete(f'/api/conversations/{conv}').raise_for_status()
