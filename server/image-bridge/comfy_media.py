"""Duckpond's dedicated ComfyUI adapter for MiniMax H3 audio/video."""
import base64
import json
import os
import time
import uuid
import urllib.request
import urllib.parse
from pathlib import Path

URL = os.environ.get('COMFY_URL', 'http://127.0.0.1:8188')
ROOT = Path(os.environ.get('COMFY_MODELS_DIR', '/var/mnt/modelnvme/ai/duckpond-comfy/models'))
OUTPUT = Path(os.environ.get('COMFY_OUTPUT_DIR', '/var/mnt/modelnvme/ai/duckpond-comfy/output'))
MODEL = 'MiniMaxAI/MiniMax-H3'
FILES = {
    'model': 'diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors',
    'encoder': 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    'video': 'vae/minimax_h3_video_vae_fp16.safetensors',
    'audio': 'vae/minimax_h3_audio_vae_fp32.safetensors',
}

FPS = 24


def align_frame_count(n):
    """H3 requires frame counts of the form 17k+5, clamped to 5..362."""
    n = max(5, min(362, int(n)))
    k = round((n - 5) / 17)
    k = max(0, min(k, (362 - 5) // 17))
    return 17 * k + 5


def frames_for_duration(seconds, fps=24):
    target = max(5, int(round(float(seconds) * fps)))
    return align_frame_count(target)


def request(path, body=None, timeout=15):
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f'MiniMax runtime returned invalid JSON from {path}') from exc


def catalog():
    missing = [name for name, file in FILES.items() if not (ROOT / file).is_file()]
    reason = 'Missing components: ' + ', '.join(missing) if missing else None
    if not reason:
        try:
            request('/system_stats', timeout=2)
        except Exception:
            reason = 'MiniMax runtime is offline'
    return {MODEL: dict(kind='comfy', task='video', ready=not reason, reason=reason, fps=24,
                        supports_image=True, max_references=2, default_steps=20)}


def upload_image(data, filename):
    boundary = '----duckpond' + uuid.uuid4().hex
    def field(name, value, filename=None, mime=None):
        disp = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disp += f'; filename="{filename}"'
        header = f'--{boundary}\r\n{disp}\r\n'
        if mime:
            header += f'Content-Type: {mime}\r\n'
        header += '\r\n'
        chunk = header.encode() + (value if isinstance(value, bytes) else str(value).encode()) + b'\r\n'
        return chunk
    mime = 'image/png'
    if data.startswith(b'\xff\xd8'):
        mime = 'image/jpeg'
    elif data.startswith(b'RIFF') and data[8:12] == b'WEBP':
        mime = 'image/webp'
    body = field('image', data, filename, mime) + field('overwrite', 'true') + f'--{boundary}--\r\n'.encode()
    req = urllib.request.Request(URL + '/upload/image', data=body, method='POST',
                                 headers={'Content-Type': f'multipart/form-data; boundary={boundary}'})
    with urllib.request.urlopen(req, timeout=30) as response:
        info = json.load(response)
    name = info.get('name')
    if not name:
        raise RuntimeError('MiniMax runtime did not accept the reference photo')
    return name


def pil_png_bytes(image):
    import io
    buf = io.BytesIO()
    image.convert('RGB').save(buf, format='PNG')
    return buf.getvalue()


def workflow(prompt, width, height, frames, steps, seed, prefix, first_name=None, last_name=None):
    def node(name, **inputs): return {'class_type': name, 'inputs': inputs}
    graph = {
        '1': node('UNETLoader', unet_name=Path(FILES['model']).name, weight_dtype='default'),
        '2': node('CLIPLoader', clip_name=Path(FILES['encoder']).name, type='minimax'),
        '3': node('VAELoader', vae_name=Path(FILES['video']).name),
        '4': node('VAELoader', vae_name=Path(FILES['audio']).name),
        '5': node('MiniMaxH3ImageToVideo', clip=['2', 0], vae=['3', 0], prompt=prompt, width=width, height=height, length=frames),
        '6': node('RandomNoise', noise_seed=seed),
        '7': node('BasicGuider', model=['1', 0], conditioning=['5', 0]),
        '8': node('KSamplerSelect', sampler_name='res_multistep'),
        '9': node('BasicScheduler', model=['1', 0], scheduler='simple', steps=steps, denoise=1.0),
        '10': node('SamplerCustomAdvanced', noise=['6', 0], guider=['7', 0], sampler=['8', 0], sigmas=['9', 0], latent_image=['5', 1]),
        '11': node('VAEDecodeTiled', samples=['10', 0], vae=['3', 0], tile_size=256, overlap=64, temporal_size=16, temporal_overlap=4),
        '12': node('VAEDecodeAudio', samples=['10', 0], vae=['4', 0]),
        '13': node('CreateVideo', images=['11', 0], audio=['12', 0], fps=float(FPS)),
        # format as a plain container name so DynamicCombo does not see codec='auto' as a string
        '14': node('SaveVideo', video=['13', 0], filename_prefix=prefix, format='mp4'),
    }
    if first_name:
        graph['15'] = node('LoadImage', image=first_name)
        graph['5']['inputs']['first_frame'] = ['15', 0]
    if last_name:
        graph['16'] = node('LoadImage', image=last_name)
        graph['5']['inputs']['last_frame'] = ['16', 0]
    return graph


def history_files(history):
    for node_out in (history.get('outputs') or {}).values():
        if not isinstance(node_out, dict):
            continue
        for key in ('videos', 'gifs', 'images', 'video'):
            items = node_out.get(key)
            if isinstance(items, dict) and items.get('filename'):
                items = [items]
            if isinstance(items, list) and items:
                return items
    return []


def read_output(file_info, prefix):
    if file_info:
        file = file_info[0]
        query = urllib.parse.urlencode({k: file[k] for k in ('filename', 'subfolder', 'type') if k in file})
        with urllib.request.urlopen(URL + '/view?' + query, timeout=120) as response:
            return response.read()
    matches = sorted(OUTPUT.joinpath(*Path(prefix).parts[:-1] or ['.']).glob(Path(prefix).name + '*'),
                     key=lambda p: p.stat().st_mtime)
    if not matches:
        # prefix is duckpond/tag-index — files land in output/duckpond/
        folder = OUTPUT / Path(prefix).parent
        stem = Path(prefix).name
        matches = sorted(folder.glob(stem + '*'), key=lambda p: p.stat().st_mtime) if folder.is_dir() else []
    if not matches:
        raise RuntimeError('Video job completed without an output file')
    return matches[-1].read_bytes()


def job_sampler_progress(job, steps):
    """Best-effort sampler step from Comfy's jobs API. Missing data is not an error."""
    try:
        info = request('/api/jobs/' + job, timeout=2)
    except Exception:
        return None, steps
    if not isinstance(info, dict):
        return None, steps
    for blob in (info, info.get('progress'), info.get('execution'), info.get('status')):
        if not isinstance(blob, dict):
            continue
        value = blob.get('value', blob.get('current', blob.get('step')))
        total = blob.get('max', blob.get('total', blob.get('steps')))
        if value is None:
            continue
        try:
            step = int(value)
            total = int(total) if total is not None else steps
        except (TypeError, ValueError):
            continue
        if step >= 0 and total > 0:
            return step, total
    return None, steps


def generate(body, tag, cancelled, progress, images=None):
    if body.get('negative_prompt'): raise ValueError('MiniMax H3 does not use a negative prompt')
    if int(body.get('fps') or FPS) != FPS: raise ValueError('MiniMax H3 generates at 24 fps')
    width, height = map(int, body.get('size', '608x352').split('x'))
    if width % 32 or height % 32 or width * height > 768 * 1344:
        raise ValueError('H3 dimensions must be multiples of 32, at most 768 × 1344 pixels in area')
    if body.get('duration') is not None:
        frames = frames_for_duration(body['duration'])
    else:
        frames = int(body.get('num_frames') or 124)
        if frames < 5 or frames > 362 or (frames - 5) % 17:
            raise ValueError('H3 frame counts must follow 17k + 5, e.g. 22, 39, 107, 124, 243 or 362')
    steps = int(body.get('steps') or 20)
    first_name = last_name = None
    if images:
        first_name = upload_image(pil_png_bytes(images[0]), f'{tag}-first.png')
        if len(images) > 1:
            last_name = upload_image(pil_png_bytes(images[1]), f'{tag}-last.png')
    outputs = []
    for index in range(int(body.get('n') or 1)):
        if cancelled(): raise InterruptedError('cancelled')
        seed = int(body.get('seed') or 0) + index
        prefix = f'duckpond/{tag}-{index}'
        graph = workflow(body['prompt'], width, height, frames, steps, seed, prefix,
                         first_name, last_name)
        submitted = request('/prompt', {'prompt': graph, 'client_id': tag})
        if submitted.get('node_errors'): raise RuntimeError(json.dumps(submitted['node_errors']))
        job = submitted['prompt_id']
        deadline = time.monotonic() + 3600
        progress('loading', None, steps)
        try:
            while time.monotonic() < deadline:
                if cancelled():
                    request('/queue', {'delete': [job]})
                    request('/interrupt', {})
                    raise InterruptedError('cancelled')
                history = request('/history/' + job).get(job)
                if history:
                    status = history.get('status', {})
                    for kind, details in status.get('messages', []):
                        if kind in ('execution_error', 'execution_interrupted'):
                            raise RuntimeError(details.get('exception_message', kind) if isinstance(details, dict) else kind)
                    outputs.append({'b64_json': base64.b64encode(read_output(history_files(history), prefix)).decode()})
                    progress('image_done', steps, steps)
                    break
                step, total = job_sampler_progress(job, steps)
                progress('generating', step, total)
                time.sleep(1)
            else:
                request('/interrupt', {})
                raise TimeoutError('MiniMax video generation timed out')
        finally:
            try:
                request('/free', {'unload_models': True, 'free_memory': True})
            finally:
                time.sleep(0.5)  # compositor needs a beat to reclaim VRAM
    return {'data': outputs, 'model_used': MODEL, 'task': 'video', 'steps_used': steps, 'fps': FPS}
