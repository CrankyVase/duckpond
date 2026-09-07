"""Contract tests with fake ML modules. Never imports torch or loads weights."""
import base64
import contextlib
import io
import json
import sys
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

if __name__ == '__main__': unittest.main()
