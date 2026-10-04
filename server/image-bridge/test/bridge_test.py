"""Contract tests with fake ML modules. Never imports torch or loads weights."""
import base64
import contextlib
import io
import json
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
fake_torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda:False), inference_mode=contextlib.nullcontext)
with patch.dict(sys.modules, {'torch':fake_torch, 'numpy':SimpleNamespace(), 'studio':None}):
    import bridge

class BridgeTests(unittest.TestCase):
    def tearDown(self):
        bridge.CANCEL_TAGS.clear()
        bridge._loaded.update(id=None,pipe=None,kind=None)
        bridge._tts['backend'] = None
        with bridge.STATE_LOCK:
            bridge.STATE.update(tag=None, active=False, phase=None, step=None, steps=None,
                                image=None, n=None, enhanced_prompt=None,
                                started_at=None, eta_seconds=None, elapsed=None)
    def test_unload_releases_only_requested_model(self):
        bridge._loaded.update(id='image', pipe=object(), kind='image')
        handler = object.__new__(bridge.Handler)
        handler.path = '/v1/models/unload'
        payload = json.dumps({'model': 'other'}).encode()
        handler.headers = {'content-length': str(len(payload))}
        handler.rfile = io.BytesIO(payload)
        handler._json = MagicMock()
        handler.do_POST()
        self.assertEqual(bridge._loaded['id'], 'image')
        payload = json.dumps({'model': 'image'}).encode()
        handler.headers = {'content-length': str(len(payload))}
        handler.rfile = io.BytesIO(payload)
        handler.do_POST()
        self.assertIsNone(bridge._loaded['pipe'])
        self.assertEqual(handler._json.call_args.args[0], 200)

    def test_unload_during_generation_is_conflict(self):
        handler = object.__new__(bridge.Handler)
        handler.path = '/v1/models/unload'
        payload = json.dumps({'model': 'image'}).encode()
        handler.headers = {'content-length': str(len(payload))}
        handler.rfile = io.BytesIO(payload)
        handler._json = MagicMock()
        with bridge.GEN_LOCK:
            handler.do_POST()
        self.assertEqual(handler._json.call_args.args[0], 409)

    def test_qwen_cpu_override_uses_bfloat16_without_gpu_offload(self):
        pipe = MagicMock()
        cls = SimpleNamespace(from_pretrained=MagicMock(return_value=pipe))
        with patch.dict(sys.modules, {'diffusers': SimpleNamespace(QwenImage21Pipeline=cls)}), patch.object(bridge, 'DEVICE', 'cuda'), patch.object(bridge, 'CPU_MODELS', {'qwen'}), patch.dict(bridge.os.environ, {'IMAGE_CPU_DTYPE':'bfloat16'}), patch.object(bridge.torch, 'float32', 'fp32', create=True), patch.object(bridge.torch, 'bfloat16', 'bf16', create=True):
            bridge.load_pipeline('qwen', {'path':'/fake', 'class':'QwenImage21Pipeline', 'kind':'diffusers', 'task':'image'})
        self.assertEqual(cls.from_pretrained.call_args.kwargs['torch_dtype'], 'bf16')
        pipe.to.assert_called_once_with('cpu')
        pipe.enable_sequential_cpu_offload.assert_not_called()
        pipe.enable_model_cpu_offload.assert_not_called()

    def test_seed_zero_image_and_no_negative_argument(self):
        calls = []
        class Picture:
            def save(self, buf, format): buf.write(b'PNG')
        class Pipe:
            def __call__(self, prompt, num_inference_steps, width, height, generator=None):
                calls.append((prompt,width,height,generator))
                return SimpleNamespace(images=[Picture()])
        generator = MagicMock()
        with patch.object(bridge,'resolve_model',return_value=('image',{'kind':'diffusers','task':'image'})), patch.object(bridge,'load_pipeline',return_value=Pipe()), patch.object(bridge.torch,'Generator',return_value=generator,create=True):
            result = bridge.run_job({'prompt':'test','seed':0,'size':'512x512'},'test')
        generator.manual_seed.assert_called_once_with(0)
        self.assertEqual(calls[0][:3], ('test',512,512))
        self.assertEqual(base64.b64decode(result['data'][0]['b64_json']),b'PNG')
    def test_qwen_true_cfg_and_steps_default(self):
        seen = {}
        class Picture:
            def save(self, buf, format): buf.write(b'PNG')
        class QwenPipe:
            def __call__(self, prompt, num_inference_steps, width, height, true_cfg_scale=None, negative_prompt=None, generator=None):
                seen.update(prompt=prompt, steps=num_inference_steps, width=width, height=height,
                            true_cfg_scale=true_cfg_scale, negative_prompt=negative_prompt)
                return SimpleNamespace(images=[Picture()])
        captured = {}
        orig_call = bridge.call_pipeline
        def spy(pipe, kwargs):
            captured.update(kwargs)
            return orig_call(pipe, kwargs)
        with patch.object(bridge,'resolve_model',return_value=('qwen',{'kind':'diffusers','task':'image','default_steps':40})), patch.object(bridge,'load_pipeline',return_value=QwenPipe()), patch.object(bridge,'call_pipeline',side_effect=spy):
            result = bridge.run_job({'prompt':'a cat','task':'image','size':'512x512','steps':None,'true_cfg_scale':2.5,'negative_prompt':'blurry'},'test')
        self.assertEqual(seen['true_cfg_scale'],2.5)
        self.assertEqual(seen['negative_prompt'],'blurry')
        self.assertEqual(seen['steps'],40)
        self.assertEqual(captured.get('true_cfg_scale'),2.5)
        self.assertEqual(captured.get('negative_prompt'),'blurry')
        self.assertEqual(result['steps_used'],40)

    def test_no_cfg_means_no_negative_or_true_cfg(self):
        captured = {}
        class Picture:
            def save(self, buf, format): buf.write(b'PNG')
        class PlainPipe:
            def __call__(self, prompt, num_inference_steps, width, height, generator=None):
                return SimpleNamespace(images=[Picture()])
        orig_call = bridge.call_pipeline
        def spy(pipe, kwargs):
            captured.update(kwargs)
            return orig_call(pipe, kwargs)
        with patch.object(bridge,'resolve_model',return_value=('qwen',{'kind':'diffusers','task':'image','default_steps':40})), patch.object(bridge,'load_pipeline',return_value=PlainPipe()), patch.object(bridge,'call_pipeline',side_effect=spy):
            result = bridge.run_job({'prompt':'a cat','task':'image','size':'512x512','negative_prompt':'blurry'},'test')
        self.assertNotIn('negative_prompt', captured)
        self.assertNotIn('true_cfg_scale', captured)
        self.assertEqual(result['steps_used'],40)

    def test_qwen_true_cfg_out_of_range_rejected(self):
        with patch.object(bridge,'resolve_model',return_value=('qwen',{'kind':'diffusers','task':'image','default_steps':40})), patch.object(bridge,'load_pipeline') as load:
            with self.assertRaises(ValueError):
                bridge.run_job({'prompt':'a cat','task':'image','size':'512x512','true_cfg_scale':7},'test')
            load.assert_not_called()

    def test_stable_audio_duration_and_actual_sample_rate(self):
        calls = []
        class Pipe:
            vae = SimpleNamespace(config=SimpleNamespace(sampling_rate=48000))
            def __call__(self,prompt,num_inference_steps,audio_end_in_s,generator=None):
                calls.append(audio_end_in_s)
                return SimpleNamespace(audios=['audio'])
        with patch.object(bridge,'resolve_model',return_value=('sound',{'kind':'diffusers','task':'audio'})), patch.object(bridge,'load_pipeline',return_value=Pipe()), patch.object(bridge,'encode_audio',return_value='wav') as encode:
            bridge.run_job({'prompt':'test','task':'audio','audio_duration':4},'test')
        self.assertEqual(calls,[4])
        encode.assert_called_once_with('audio',48000)
    def test_missing_sample_rate_rejected(self):
        with self.assertRaisesRegex(RuntimeError,'sample rate'): bridge.audio_sample_rate(object())
    def test_all_tasks_accept_cancel(self):
        for path in ('images/generations','videos/generations','audio/generations','audio/speech'):
            handler = object.__new__(bridge.Handler)
            handler.path = '/v1/' + path + '/cancel'
            payload = json.dumps({'tag':path}).encode()
            handler.headers = {'content-length':str(len(payload))}
            handler.rfile = io.BytesIO(payload)
            handler._json = MagicMock()
            handler.do_POST()
            handler._json.assert_called_once_with(200,{'ok':True})
            self.assertIn(path,bridge.CANCEL_TAGS)
    def test_native_reference_not_silently_ignored(self):
        with patch.object(bridge,'resolve_model',return_value=('voice',{'kind':'native_audio','task':'tts'})), patch.object(bridge,'run_tts_job') as run:
            with self.assertRaisesRegex(ValueError,'cloning'): bridge.run_job({'prompt':'test','task':'tts','ref_audio_b64':'abc'},'test')
            run.assert_not_called()
    def test_resident_pipeline_reused_without_reloading(self):
        obj = object()
        bridge._loaded.update(id='image',pipe=obj,kind='image')
        self.assertIs(bridge.load_pipeline('image',{'kind':'diffusers'}),obj)
    def test_native_backend_reused_and_no_unknown_clone_kwargs(self):
        backend = SimpleNamespace(active_model_name='voice',generate_audio_response=MagicMock(return_value=(b'wav',24000)),load_model=MagicMock())
        bridge._tts['backend'] = backend
        with patch.object(bridge,'_tts_backend',return_value=backend), patch.object(bridge,'_tts_config',return_value=SimpleNamespace()):
            result = bridge.run_tts_job({'prompt':'test','seed':0},'test','voice',{})
        backend.load_model.assert_not_called()
        self.assertEqual(backend.generate_audio_response.call_args.kwargs['seed'],0)
        self.assertNotIn('ref_audio_b64',backend.generate_audio_response.call_args.kwargs)
        self.assertEqual(result['sample_rate'],24000)
    def test_photo_to_photo_passes_image(self):
        from PIL import Image
        seen = []
        class Picture:
            def save(self, buf, format): buf.write(b'PNG')
        class Pipe:
            def __call__(self, prompt, num_inference_steps, width, height, image=None, generator=None):
                seen.append(image)
                return SimpleNamespace(images=[Picture()])
        buf = io.BytesIO()
        Image.new('RGB', (32, 32), 'red').save(buf, format='PNG')
        b64 = base64.b64encode(buf.getvalue()).decode()
        with patch.object(bridge, 'resolve_model', return_value=('image', {'kind': 'diffusers', 'task': 'image'})), patch.object(bridge, 'load_pipeline', return_value=Pipe()):
            bridge.run_job({'prompt': 'make it night', 'size': '512x512', 'images_b64': [b64]}, 'test')
        self.assertIsNotNone(seen[0])
        self.assertEqual(getattr(seen[0], 'size', None), (32, 32))

    def test_edit_only_model_requires_a_photo(self):
        with patch.object(bridge, 'resolve_model', return_value=('edit', {'kind': 'diffusers', 'task': 'image', 'needs_image': True})), patch.object(bridge, 'load_pipeline') as load:
            with self.assertRaisesRegex(ValueError, 'reference photo'):
                bridge.run_job({'prompt': 'make it night', 'size': '512x512'}, 'test')
            load.assert_not_called()

    def test_omnivoice_reference_reaches_documented_adapter(self):
        model = SimpleNamespace(generate=MagicMock(return_value=['audio']))
        factory = SimpleNamespace(from_pretrained=MagicMock(return_value=model))
        sf = SimpleNamespace(read=lambda _:([0]*24000,24000),write=MagicMock())
        random = SimpleNamespace(fork_rng=lambda **_:contextlib.nullcontext())
        with patch.dict(sys.modules,{'omnivoice':SimpleNamespace(OmniVoice=factory),'soundfile':sf}), patch.object(bridge.torch,'random',random,create=True), patch.object(bridge.torch,'float32','float32',create=True), patch.object(bridge.torch,'manual_seed',create=True), patch.object(bridge,'encode_audio',return_value='wav'):
            bridge.run_omnivoice_job({'prompt':'New words','ref_audio_b64':base64.b64encode(b'wav').decode(),'ref_text':'Reference words','seed':0},'test','omni',{'path':'/fake/model'})
        self.assertTrue(factory.from_pretrained.call_args.kwargs['local_files_only'])
        args = model.generate.call_args.kwargs
        self.assertEqual(args['text'],'New words')
        self.assertEqual(args['ref_text'],'Reference words')
        self.assertTrue(args['ref_audio'].endswith('reference.wav'))

    def test_eta_excludes_load_and_first_step(self):
        with patch.object(bridge.time, 'monotonic', return_value=0):
            bridge.touch_progress(active=True, started_at=time.time() - 200, phase='generating', step=0, steps=10)
        with patch.object(bridge.time, 'monotonic', return_value=180):
            bridge.touch_progress(phase='denoising', step=1)
        self.assertIsNone(bridge.STATE['eta_seconds'])
        with patch.object(bridge.time, 'monotonic', return_value=182):
            bridge.touch_progress(phase='denoising', step=2)
        self.assertIsNone(bridge.STATE['eta_seconds'])
        with patch.object(bridge.time, 'monotonic', return_value=184):
            bridge.touch_progress(phase='denoising', step=3)
        self.assertEqual(bridge.STATE['eta_seconds'], 14)
        self.assertGreater(bridge.STATE['elapsed'], 190)
        with patch.object(bridge.time, 'monotonic', return_value=185):
            bridge.touch_progress()
        self.assertEqual(bridge.STATE['eta_seconds'], 13)
        self.assertEqual(bridge.STATE['_step_durations'], [2, 2])
        bridge.touch_progress(phase='generating', image=2, step=0)
        self.assertIsNone(bridge.STATE['eta_seconds'])
        self.assertEqual(bridge.STATE['_step_durations'], [])

    def test_progress_payload_does_not_invent_eta(self):
        bridge.touch_progress(tag='t', active=True, phase='generating', step=0, steps=4,
                              image=1, n=1, started_at=time.time() - 8)
        handler = object.__new__(bridge.Handler)
        handler.path = '/v1/progress'
        handler._json = MagicMock()
        handler.do_GET()
        code, payload = handler._json.call_args[0]
        self.assertEqual(code, 200)
        self.assertIsNone(payload['eta_seconds'])
        self.assertGreater(payload['elapsed'], 0)
        self.assertIsNone(payload['progress']['eta_seconds'])
        self.assertIn('elapsed', payload['progress'])

if __name__ == '__main__': unittest.main()
