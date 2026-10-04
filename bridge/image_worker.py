"""Photo-only API adapter for Duck Pond. Model execution is always on Windows."""
import base64
import http.server
import json
from pathlib import Path
import re
import subprocess
import socket
import threading
import time
import uuid
from urllib.parse import urlsplit
import library

FILES = {
    'diffusion': library.MODEL_ROOT / 'qwen-image-2.1/qwen_image_2.1-Q4_K.gguf',
    'encoder': library.MODEL_ROOT / 'qwen-image-2.1/Qwen3VL-8B-Instruct-Q4_K_M.gguf',
    'vae': library.MODEL_ROOT / 'qwen-image-2.1/vae/qwen_image_2.1_vae_bf16.safetensors',
}
state_lock = threading.RLock()
state = {'active': False, 'tag': None, 'progress': {}, 'started': 0, 'cancelled': False, 'result': None, 'error': None}
assets = {}
SSH = []
controller = None
compute_lock = None

def configure(ssh, unload, lock):
    global SSH, controller, compute_lock
    SSH, controller, compute_lock = ssh, unload, lock

def stop_remote():
    subprocess.run(SSH + ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', r'C:\Users\toryf\duckpond-worker\windows-image.ps1', '-Action', 'stop'], capture_output=True, timeout=30)

def snapshot():
    with state_lock:
        return {**state, 'elapsed': round(time.monotonic() - state['started'], 1) if state['started'] else 0}

def runtime_tuning(override=None):
    defaults = dict(paramsBackend='cpu', flashAll=False, mmap=False, vaeTile=256, vaeOverlap=0.5)
    if override is None:
        try:
            override = json.loads((library.ROOT / 'photo-runtime.json').read_text())
        except FileNotFoundError:
            override = {}
    if not isinstance(override, dict) or set(override)-set(defaults):
        raise ValueError('Unsupported photo runtime option')
    value = {**defaults, **override}
    if value['paramsBackend'] not in ('cpu', 'auto') or value['vaeTile'] not in (256, 512):
        raise ValueError('Unsupported photo memory placement')
    if type(value['flashAll']) is not bool or type(value['mmap']) is not bool or value['vaeOverlap'] not in (0.25, 0.5):
        raise ValueError('Unsupported photo runtime value')
    return value

def native_progress(prog, line, requested_steps):
    """Tensor transfers and VAE tiles also have counters; only sample steps count."""
    if 'decoding ' in line:
        prog['phase'] = 'decoding'
    elif 'sampling completed' in line:
        prog.update(step=requested_steps, steps=requested_steps)
    elif match := re.search(r'generating image:\s*(\d+)\s*/\s*(\d+)', line):
        prog.update(image=int(match[1]), n=int(match[2]), phase='loading_windows_memory')
    elif match := re.search(r'\|\s*(\d+)\s*/\s*(\d+)\s*-\s*[\d.]+(?:it/s|s/it)', line):
        if int(match[2]) == requested_steps and prog.get('phase') != 'decoding':
            prog.update(phase='sampling', step=int(match[1]), steps=requested_steps)

def generate(body):
    if body.get('model', 'auto') not in ('auto', 'qwen-image-2.1'):
        raise ValueError('Only Qwen Image 2.1 photos are configured')
    if body.get('images_b64'):
        raise ValueError('Reference image editing is not configured yet')
    prompt = str(body.get('prompt', '')).strip()
    if not prompt:
        raise ValueError('Prompt required')
    dimensions = re.fullmatch(r'(\d+)x(\d+)', str(body.get('size', '1024x1024')))
    if not dimensions:
        raise ValueError('Invalid image size')
    width, height = map(int, dimensions.groups())
    if not all(256 <= x <= 2048 and x % 32 == 0 for x in (width, height)):
        raise ValueError('Image dimensions must be 256–2048 and multiples of 32')
    steps = max(1, min(80, int(body.get('steps') or 28)))
    n = max(1, min(4, int(body.get('n') or 1)))
    tag = str(body.get('tag') or uuid.uuid4().hex)
    native_tag = uuid.uuid4().hex
    tuning = runtime_tuning(body.get('runtime_tuning'))
    with compute_lock:
        controller()  # Stop the chat process to make its VRAM available to photos.
        with state_lock:
            state.update(active=True, tag=tag, started=time.monotonic(), cancelled=False, error=None, result=None, progress={'phase': 'preparing', 'steps': steps, 'n': n, 'image': 1, 'seq': 1})
        process = None
        result = None
        try:
            entries = [dict(library.manifest(path), role=role) for role, path in FILES.items()]
            with state_lock:
                assets.clear()
                assets.update({a['sha256']: a for a in entries})
                state['progress'].update(phase='transferring_to_windows', totalBytes=sum(a['bytes'] for a in entries))
            payload = dict(tag=native_tag, tuning=tuning, assets=[dict(a, url='http://127.0.0.1:18083/image-assets/' + a['sha256']) for a in entries], prompt=prompt, negative=str(body.get('negative_prompt') or ''), width=width, height=height, steps=steps, n=n, seed=int(body.get('seed') if body.get('seed') is not None else 42), cfg=float(body.get('true_cfg_scale') or 5.0))
            encoded = base64.b64encode(json.dumps(payload).encode()).decode()
            process = subprocess.Popen(SSH + ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', r'C:\Users\toryf\duckpond-worker\windows-image.ps1', '-Payload', encoded], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            with (library.ROOT / 'windows-image.log').open('a', buffering=1) as log:
                for line in process.stdout:
                    if line.startswith('__DUCKPOND_RESULT__'):
                        result = json.loads(line[len('__DUCKPOND_RESULT__'):])
                        continue
                    log.write(line)
                    with state_lock:
                        prog = state['progress']
                        prog['seq'] = prog.get('seq', 0) + 1
                        if line.startswith('transfer_bytes='):
                            prog.update(phase='transferring_to_windows', bytes=int(line.split('=', 1)[1]))
                        elif line.startswith('image_phase='):
                            prog['phase'] = line.strip().split('=', 1)[1]
                        else:
                            native_progress(prog, line, steps)
            process.wait(timeout=20)
            if snapshot()['cancelled']:
                raise RuntimeError('Image request cancelled')
            if process.returncode or result is None:
                raise RuntimeError('Windows image worker failed; see bridge/windows-image.log')
            with state_lock:
                state.update(result=result, progress={'phase': 'image_done', 'step': steps, 'steps': steps, 'n': n, 'image': n, 'seq': state['progress']['seq'] + 1})
            return result
        except Exception as e:
            with state_lock:
                state['error'] = str(e)
            raise
        finally:
            with state_lock:
                state['active'] = False
            if process and process.poll() is None:
                try:
                    stop_remote()
                    process.wait(timeout=20)
                except Exception:
                    process.terminate()
            assets.clear()

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    def log_message(self, fmt, *args):
        if not self.path.startswith('/v1/progress'):
            print(fmt % args, flush=True)
    def reply(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if urlsplit(self.path).path == '/health':
            ready = all(p.is_file() for p in FILES.values())
            return self.reply({'ok': True, 'default_model': 'qwen-image-2.1', 'models': {'qwen-image-2.1': {'task': 'image', 'kind': 'sdcpp', 'family': 'qwen-image-2.1', 'ready': ready, 'reason': None if ready else 'Image files are still downloading', 'loaded': snapshot()['active'], 'device': 'vulkan', 'default_steps': 28, 'supports_image': False, 'supports_preview': False, 'output_formats': ['png']}}})
        if urlsplit(self.path).path == '/v1/progress':
            s = snapshot()
            s.pop('result', None)
            return self.reply(s)
        return self.reply({'error': 'Not found'}, 404)
    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        if length > 1024 * 1024:
            return self.reply({'error': 'Request too large'}, 413)
        try:
            body = json.loads(self.rfile.read(length) or b'{}')
            path = urlsplit(self.path).path
            if path == '/v1/images/generations':
                return self.reply(generate(body))
            if path in ('/v1/images/generations/cancel', '/v1/models/unload'):
                with state_lock:
                    if path == '/v1/models/unload' or body.get('tag') == state['tag']:
                        state['cancelled'] = True
                stop_remote()
                return self.reply({'ok': True})
            return self.reply({'error': 'Only photo generation is enabled'}, 400)
        except Exception as e:
            return self.reply({'error': str(e)}, 503)
