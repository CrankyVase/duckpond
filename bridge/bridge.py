"""Windows inference router, with one isolated Fedora CPU prompt helper."""
import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import threading
import time
from urllib.parse import urlsplit
import httpx
import library
import image_worker
import runtime_profiles
import local_worker

ROOT = Path(__file__).resolve().parent
MODEL = ROOT.parent / 'models/qwen3.8-27b/Qwen3.8-27B-UD-Q4_K_M.gguf'
MODEL_ID = 'unsloth/Qwen3.8-27B-UD-Q4_K_M'
SSH = ['ssh', '-i', str(Path.home() / '.ssh/fedora_to_windows'), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', 'toryf@100.77.133.97']
WORKER = r'C:\Users\toryf\duckpond-worker\windows-worker.ps1'
WINDOWS_URL = 'http://127.0.0.1:18082'
IDLE_SECONDS = int(os.environ.get('DUCKPOND_WINDOWS_IDLE_SECONDS', '120'))
CLIENT = httpx.Client(timeout=httpx.Timeout(1800, connect=10), trust_env=False)
state_lock = threading.RLock()
operation_lock = threading.Lock()
state = {'status': 'unloaded', 'model': MODEL_ID, 'active': 0, 'last_used': 0, 'error': None, 'cold_load_seconds': None, 'phase': None, 'transfer_bytes': 0, 'transfer_total_bytes': 0}
compute_lock = threading.RLock()
transfer_assets = {}
worker = None
running_model = None
running_tuning = None
load_generation = 0
worker_log = None
hardware_cache = None
hardware_at = 0
hardware_lock = threading.Lock()

class LoadCancelled(RuntimeError):
    pass

def check_reservation(reservation):
    with state_lock:
        if reservation is not None and reservation != load_generation:
            raise LoadCancelled('Model load cancelled')

def hardware():
    global hardware_cache, hardware_at
    with hardware_lock:
        if hardware_cache and time.monotonic() - hardware_at < 5:
            return hardware_cache
        hardware_cache = remote('hardware', timeout=12)
        hardware_at = time.monotonic()
        return hardware_cache

def remote(action, timeout=45, payload=None):
    args = SSH + ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WORKER, '-Action', action]
    if payload is not None:
        args += ['-Payload', base64.b64encode(json.dumps(payload).encode()).decode()]
    r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if r.returncode:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip() or 'Windows control failed')
    return json.loads(r.stdout.strip()) if r.stdout.strip().startswith('{') else {'output': r.stdout.strip()}

def health():
    try:
        return CLIENT.get(WINDOWS_URL + '/health', timeout=2).status_code == 200
    except httpx.HTTPError:
        return False

def snapshot():
    with state_lock:
        return dict(state, execution_host='Windows MR_PC', storage_host='Fedora with Windows SSD cache', idle_unload_seconds=IDLE_SECONDS, model_downloaded=MODEL.is_file())

def unload():
    global worker, worker_log, running_model, running_tuning, load_generation
    # Withdraw the lease before waiting for the lifecycle lock. This cancels
    # a first-load transfer instead of making Unload wait for the whole copy.
    with state_lock:
        if state['active']:
            raise RuntimeError('A request is active; try unloading when it completes')
        if state['status'] == 'loading':
            load_generation += 1
            state['status'] = 'unloading'
    with compute_lock, operation_lock:
        with state_lock:
            if state['active']:
                raise RuntimeError('A request is active; try unloading when it completes')
            state['status'] = 'unloading'
        try:
            result = remote('stop')
            if worker:
                try:
                    worker.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    worker.terminate()
                    worker.wait(timeout=10)
                worker = None
            # Verify cleanup even if the wrapper died before its finally block.
            result = remote('stop')
            if not result.get('stopped') or result.get('temporaryModelPresent'):
                raise RuntimeError('Windows cleanup has not completed')
            with state_lock:
                state.update(status='unloaded', error=None, phase=None)
                running_model = None
                running_tuning = None
            return result
        except Exception as e:
            with state_lock:
                state.update(status='error', error=str(e))
            raise

def load(model=MODEL_ID, reservation=None, tuning_override=None):
    global worker, worker_log, running_model, running_tuning
    with compute_lock, operation_lock:
        check_reservation(reservation)
        tuning = runtime_profiles.validate(tuning_override) if tuning_override is not None else runtime_profiles.for_model(model)
        if health() and running_model == model and running_tuning == tuning:
            with state_lock:
                state.update(status='loaded', last_used=time.monotonic())
            return
        path = library.records().get(model)
        if path is None:
            raise RuntimeError('Model is missing from the Fedora library; download and register it first')
        with state_lock:
            state.update(status='loading', model=model, last_used=time.monotonic(), error=None, phase='preparing', transfer_bytes=0)
        started = time.monotonic()
        try:
            remote('stop')
            assets = library.chat_assets(path)
            check_reservation(reservation)
            with state_lock:
                state['transfer_total_bytes'] = sum(a['bytes'] for a in assets)
                transfer_assets.clear()
                transfer_assets.update({a['sha256']: a for a in assets})
            payload = dict(model=model, tuning=tuning, assets=[dict(a, url='http://127.0.0.1:18083/assets/' + a['sha256']) for a in assets])
            encoded = base64.b64encode(json.dumps(payload).encode()).decode()
            worker = subprocess.Popen(SSH + ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WORKER, '-Action', 'run', '-Payload', encoded], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            threading.Thread(target=monitor_worker, args=(worker,), daemon=True).start()
            deadline = time.monotonic() + 1800
            while time.monotonic() < deadline:
                check_reservation(reservation)
                if worker.poll() is not None:
                    raise RuntimeError('Windows worker exited; see bridge/windows-session.log and Windows llama.stderr.log')
                if health():
                    with state_lock:
                        state.update(status='loaded', phase='ready', last_used=time.monotonic(), cold_load_seconds=round(time.monotonic() - started, 3))
                        running_model = model
                        running_tuning = tuning
                        state['runtime_profile'] = tuning
                    return
                time.sleep(1)
            raise RuntimeError('Windows model load timed out')
        except Exception as e:
            with state_lock:
                cancelled = reservation is not None and reservation != load_generation
            with state_lock:
                state.update(status='unloading' if cancelled else 'error', error=None if cancelled else str(e))
            try:
                remote('stop')
            except Exception:
                pass
            if cancelled:
                raise LoadCancelled('Model load cancelled') from e
            raise

def monitor_worker(process):
    with open(ROOT / 'windows-session.log', 'a', buffering=1) as log:
        for line in process.stdout:
            log.write(line)
            if process is not worker:
                continue
            with state_lock:
                if line.startswith('transfer_bytes='):
                    state.update(phase='transferring_to_windows', transfer_bytes=int(line.split('=', 1)[1]))
                elif line.startswith(('cache_ready_seconds=', 'cache_hit=')):
                    state.update(phase='loading_windows_memory', transfer_bytes=state['transfer_total_bytes'])

def begin_load(model, tuning_override=None):
    global load_generation
    tuning = runtime_profiles.validate(tuning_override) if tuning_override is not None else runtime_profiles.for_model(model)
    with state_lock:
        if state['status'] == 'loading':
            if state['model'] != model:
                raise RuntimeError('Another model is loading; wait for it to finish')
            return
        if state['status'] == 'loaded' and state['model'] == model and running_tuning == tuning:
            state['last_used'] = time.monotonic()
            return
        state.update(status='loading', model=model, phase='preparing', error=None,
                     transfer_bytes=0, transfer_total_bytes=0, cold_load_seconds=None)
        load_generation += 1
        reservation = load_generation
    def run():
        try:
            load(model, reservation, tuning)
        except LoadCancelled:
            print('background load cancelled', flush=True)
        except Exception as e:
            print('background load:', e, flush=True)
            with state_lock:
                state.update(status='error', error=str(e))
    threading.Thread(target=run, daemon=True).start()

def prune_cache():
    with compute_lock:
        s = snapshot()
        if s['status'] == 'loaded' and any(not Path(a['path']).is_file() for a in transfer_assets.values()):
            unload()
            s = snapshot()
        protected = [a['cacheKey'] for a in transfer_assets.values()] if s['status'] in ('loaded', 'loading') else []
        return library.prune(lambda keys: remote('delete', payload={'keys': keys}), protected)

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def setup(self):
        super().setup()
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    def log_message(self, fmt, *args):
        if urlsplit(self.path).path != '/lease':
            print(fmt % args, flush=True)
    def reply(self, body, code=200):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        path = urlsplit(self.path).path
        if path == '/lease':
            return self.reply({'allowed': snapshot()['status'] in ('loading', 'loaded')})
        if path == '/image-lease':
            s = image_worker.snapshot()
            return self.reply({'allowed': s['active'] and not s['cancelled'] and s['elapsed'] < 2700})
        if path.startswith('/image-assets/'):
            asset = image_worker.assets.get(path.rsplit('/', 1)[-1])
            if asset is None or not image_worker.snapshot()['active']:
                return self.reply({'error': 'Transfer not authorized'}, 404)
            return self.serve_file(Path(asset['path']))
        if path == '/model.gguf':
            if not MODEL.is_file() or snapshot()['status'] != 'loading':
                return self.reply({'error': 'No model transfer authorized'}, 404)
            self.send_response(200)
            self.send_header('Content-Length', str(MODEL.stat().st_size))
            self.end_headers()
            try:
                with MODEL.open('rb') as f:
                    while chunk := f.read(1024 * 1024):
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        if path.startswith('/assets/'):
            asset = transfer_assets.get(path.rsplit('/', 1)[-1])
            if asset is None or snapshot()['status'] != 'loading':
                return self.reply({'error': 'Transfer not authorized'}, 404)
            return self.serve_file(Path(asset['path']))
        if path in ('/health', '/bridge/status'):
            return self.reply(dict(snapshot(), fedora_helper=local_worker.snapshot()))
        if path in ('/v1/models', '/models'):
            if urlsplit(self.path).query == 'reload=1':
                try:
                    prune_cache()
                except Exception as e:
                    print('queued Windows cache deletion:', e, flush=True)
            s = snapshot()
            data = []
            for alias, p in library.records().items():
                cpu = local_worker.is_model(alias)
                current = local_worker.snapshot() if cpu else s
                selected = current['model'] == alias
                data.append({'id': alias, 'object': 'model', 'execution_host': 'Fedora' if cpu else 'Windows MR_PC',
                             'device': 'cpu' if cpu else 'vulkan',
                             'status': {'value': current['status'] if selected else 'unloaded',
                                        'args': ['--model', str(p), '--ctx-size', '32768']},
                             'load_error': current.get('error') if selected else None,
                             'loading_progress': dict(phase=s['phase'], bytes=s['transfer_bytes'], totalBytes=s['transfer_total_bytes']) if selected and not cpu else None})
            return self.reply({'object': 'list', 'data': data})
        if path == '/bridge/windows-status':
            try:
                return self.reply(remote('status'))
            except Exception as e:
                return self.reply({'error': str(e)}, 503)
        if path == '/bridge/hardware':
            try:
                return self.reply(hardware())
            except Exception as e:
                return self.reply({'error': str(e)}, 503)
        if path in ('/props', '/slots'):
            if snapshot()['status'] == 'loaded':
                return self.proxy('GET', b'')
            if local_worker.snapshot()['status'] == 'loaded':
                return self.proxy('GET', b'', local_worker.URL)
        return self.reply({'error': 'Not found'}, 404)
    def serve_file(self, path):
        self.send_response(200)
        self.send_header('Content-Length', str(path.stat().st_size))
        self.end_headers()
        try:
            with path.open('rb') as f:
                while chunk := f.read(1024 * 1024):
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass
    def do_DELETE(self):
        try:
            return self.reply({'success': True, 'deletedWindowsCache': prune_cache()})
        except Exception as e:
            return self.reply({'error': str(e)}, 503)
    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0'))
        if length > 32 * 1024 * 1024:
            return self.reply({'error': 'Request too large'}, 413)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw or b'{}')
            path = urlsplit(self.path).path
            if path == '/models/load':
                model = body.get('model', MODEL_ID)
                if model not in library.records():
                    return self.reply({'error': 'Model not in Fedora library'}, 404)
                if local_worker.is_model(model):
                    local_worker.begin_load()
                    return self.reply({'success': True, **local_worker.snapshot()})
                begin_load(model, body.get('profile'))
                return self.reply({'success': True, **snapshot()})
            if path == '/models/unload':
                if local_worker.is_model(body.get('model')):
                    return self.reply({'success': True, **local_worker.unload()})
                if body.get('model') and body['model'] != snapshot()['model']:
                    return self.reply({'success': True, 'already': True})
                return self.reply({'success': True, **unload()})
            if path in ('/v1/chat/completions', '/v1/chat/completions/input_tokens', '/tokenize', '/completion'):
                if local_worker.is_model(body.get('model')):
                    with local_worker.request():
                        return self.proxy('POST', raw, local_worker.URL)
                # Reserve the worker before loading so the idle reaper cannot race a request.
                with compute_lock:
                    with state_lock:
                        state['active'] += 1
                        state['last_used'] = time.monotonic()
                    try:
                        load(body.get('model', MODEL_ID), tuning_override=body.get('runtime_profile'))
                        return self.proxy('POST', raw)
                    finally:
                        with state_lock:
                            state['active'] -= 1
                            state['last_used'] = time.monotonic()
            return self.reply({'error': 'Not found'}, 404)
        except Exception as e:
            return self.reply({'error': str(e)}, 503)
    def proxy(self, method, raw, target=WINDOWS_URL):
        headers_sent = False
        try:
            with CLIENT.stream(method, target + self.path, content=raw, headers={'Content-Type': 'application/json'}) as response:
                self.send_response(response.status_code)
                self.send_header('Content-Type', response.headers.get('content-type', 'application/json'))
                self.send_header('Connection', 'close')
                self.end_headers()
                headers_sent = True
                self.close_connection = True
                for chunk in response.iter_raw():
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            if not headers_sent:
                self.reply({'error': str(e)}, 503)
            else:
                self.close_connection = True

def reaper():
    while True:
        time.sleep(10)
        s = snapshot()
        if s['status'] == 'loaded' and not s['active'] and time.monotonic() - s['last_used'] >= IDLE_SECONDS:
            try:
                # Recheck inside the lifecycle lock in unload, which refuses active work.
                unload()
            except Exception as e:
                print('idle unload:', e, flush=True)
        elif s['status'] == 'loaded' and worker and worker.poll() is not None:
            with state_lock:
                state.update(status='error', error='Windows worker exited unexpectedly')
        if s['status'] != 'loading' and not s['active']:
            try:
                prune_cache()
            except Exception as e:
                print('queued Windows cache deletion:', e, flush=True)

def main():
    # On restart, stop and clean this worker before advertising an unloaded model.
    try:
        remote('stop')
    except Exception as e:
        print('startup cleanup:', e, flush=True)
        with state_lock:
            state.update(status='error', error=str(e))
    threading.Thread(target=reaper, daemon=True).start()
    local_worker.start_reaper()
    image_worker.configure(SSH, unload, compute_lock)
    media = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), image_worker.Handler)
    threading.Thread(target=media.serve_forever, daemon=True).start()
    files = http.server.ThreadingHTTPServer(('127.0.0.1', 18083), Handler)
    threading.Thread(target=files.serve_forever, daemon=True).start()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 8081), Handler)
    def stop(signum, frame):
        with state_lock:
            state['status'] = 'unloading'
        try:
            local_worker.unload()
            image_worker.stop_remote()
            remote('stop')
        except Exception as e:
            print('shutdown cleanup:', e, flush=True)
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    server.serve_forever()

if __name__ == '__main__':
    main()
