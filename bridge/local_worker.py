"""The sole Fedora inference exception: the verified LFM2-700M photo helper."""
import hashlib
from contextlib import contextmanager
import os
from pathlib import Path
import subprocess
import threading
import time
import httpx

ROOT = Path(__file__).resolve().parent
MODEL_ID = 'lfm2-700m-q4-0'
MODEL = ROOT.parent / 'models/lfm2-700m/LFM2-700M-Q4_0.gguf'
SHA256 = '15d46638661333ed9b520b5947333c3ebf9022ac370d5e33ac2726b2d114c183'
MODEL_BYTES = 446321376
EXE = ROOT / 'linux-runtime/llama-server'
URL = 'http://127.0.0.1:18084'
IDLE_SECONDS = int(os.environ.get('DUCKPOND_WINDOWS_IDLE_SECONDS', '120'))
lock = threading.RLock()
state_lock = threading.RLock()
state = {'status': 'unloaded', 'model': MODEL_ID, 'active': 0, 'last_used': 0, 'error': None}
process = None
log = None
verified_stat = None

def is_model(model):
    return model == MODEL_ID

def snapshot():
    with state_lock:
        return dict(state, execution_host='Fedora', device='cpu', context_tokens=32768)

def verify_model():
    global verified_stat
    stat = MODEL.stat()
    signature = (stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
    if stat.st_size != MODEL_BYTES:
        raise RuntimeError('Fedora permits only the installed LFM2-700M helper')
    if verified_stat != signature:
        with MODEL.open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != SHA256:
                raise RuntimeError('Fedora helper checksum does not match LFM2-700M')
        verified_stat = signature

def health():
    if process is None or process.poll() is not None:
        return False
    try:
        return httpx.get(URL + '/health', timeout=1, trust_env=False).status_code == 200
    except httpx.HTTPError:
        return False

def _stop():
    global process, log
    if process is not None:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        process = None
    if log is not None:
        log.close()
        log = None

def load():
    global process, log
    with lock:
        if health():
            with state_lock:
                state.update(status='loaded', last_used=time.monotonic())
            return
        _stop()
        with state_lock:
            state.update(status='loading', error=None, last_used=time.monotonic())
        try:
            verify_model()
            log = (ROOT / 'fedora-helper.log').open('a', buffering=1)
            args = [str(EXE), '-m', str(MODEL), '--alias', MODEL_ID, '--host', '127.0.0.1',
                    '--port', '18084', '--device', 'none', '--n-gpu-layers', '0',
                    '--no-op-offload', '--fit', 'off', '--ctx-size', '32768', '--parallel', '1',
                    '--threads', '6', '--threads-batch', '6', '--cache-type-k', 'q8_0',
                    '--cache-type-v', 'q8_0', '--flash-attn', 'on', '--cache-ram', '128', '--jinja']
            started = time.monotonic()
            process = subprocess.Popen(args, cwd=EXE.parent, stdout=log, stderr=subprocess.STDOUT)
            while time.monotonic() - started < 30:
                if process.poll() is not None:
                    raise RuntimeError('Fedora helper exited; see bridge/fedora-helper.log')
                if health():
                    with state_lock:
                        state.update(status='loaded', cold_load_seconds=round(time.monotonic()-started, 3),
                                     last_used=time.monotonic())
                    return
                time.sleep(0.1)
            raise RuntimeError('Fedora helper load timed out')
        except Exception as e:
            _stop()
            with state_lock:
                state.update(status='error', error=str(e))
            raise

def begin_load():
    with state_lock:
        if state['status'] in ('loaded', 'loading'):
            state['last_used'] = time.monotonic()
            return
        state.update(status='loading', error=None, last_used=time.monotonic())
    def run():
        try:
            load()
        except Exception as e:
            print('Fedora helper:', e, flush=True)
    threading.Thread(target=run, daemon=True).start()

@contextmanager
def request():
    # This lock is independent of Windows/photo locks, so CPU chat keeps working.
    with lock:
        with state_lock:
            state['active'] += 1
        try:
            load()
            yield
        finally:
            with state_lock:
                state['active'] -= 1
                state['last_used'] = time.monotonic()

def unload():
    with state_lock:
        if state['active']:
            raise RuntimeError('The Fedora helper has an active request')
    with lock, state_lock:
        if state['active']:
            raise RuntimeError('The Fedora helper has an active request')
        _stop()
        state.update(status='unloaded', error=None)
        return snapshot()

def start_reaper():
    def reap():
        while True:
            time.sleep(5)
            s = snapshot()
            if s['status'] == 'loaded' and not s['active'] and time.monotonic()-s['last_used'] >= IDLE_SECONDS:
                try:
                    unload()
                except RuntimeError:
                    pass
    threading.Thread(target=reap, daemon=True).start()
