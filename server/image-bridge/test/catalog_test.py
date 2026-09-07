import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from media_catalog import inspect_snapshot, scan_models, select_model, validate_request, pipeline_kwargs

class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.snap = self.root / 'models--test--model' / 'snapshots' / 'revision'
        self.snap.mkdir(parents=True)
    def tearDown(self):
        self.tmp.cleanup()
    def file(self, path, contents='weights'):
        p = self.snap / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(contents) if isinstance(contents, dict) else contents)
    def test_chat_safetensors_are_not_images(self):
        self.file('config.json', {'model_type':'qwen3'})
        self.file('model.safetensors')
        self.assertIsNone(inspect_snapshot(self.snap))
    def test_audio_tokenizer_is_not_a_voice(self):
        self.file('config.json', {'model_type':'moss-audio-tokenizer'})
        self.file('model.safetensors')
        self.assertIsNone(inspect_snapshot(self.snap, True))
    def test_native_voice_requires_weights(self):
        self.file('config.json', {'model_type':'moss_tts_nano'})
        self.assertFalse(inspect_snapshot(self.snap, True)['ready'])
        self.file('model.safetensors')
        self.assertTrue(inspect_snapshot(self.snap, True)['ready'])
        self.assertFalse(inspect_snapshot(self.snap, False)['ready'])
    def test_omnivoice_is_speech_with_runtime_reason(self):
        self.file('config.json', {'model_type':'omnivoice'})
        self.file('model.safetensors')
        with patch('importlib.util.find_spec', return_value=None):
            info = inspect_snapshot(self.snap)
        self.assertEqual(info['task'], 'tts')
        self.assertFalse(info['ready'])
        self.assertTrue(info['cloning'])
    def test_missing_diffusion_components(self):
        self.file('model_index.json', {'_class_name':'StableDiffusionXLPipeline', 'unet':['diffusers','UNet2DConditionModel'], 'vae':['diffusers','AutoencoderKL']})
        self.file('unet/config.json', {})
        self.file('unet/model.onnx')
        self.assertFalse(inspect_snapshot(self.snap)['ready'])
        self.file('unet/diffusion_pytorch_model.safetensors')
        self.file('vae/diffusion_pytorch_model.safetensors')
        self.assertTrue(inspect_snapshot(self.snap)['ready'])
    def test_melody_requires_its_own_adapter(self):
        self.file('config.json', {'model_type':'musicgen_melody'})
        self.file('model.safetensors')
        self.assertFalse(inspect_snapshot(self.snap)['ready'])
    def test_broken_shard_symlink(self):
        self.file('config.json', {'model_type':'musicgen'})
        self.file('model.safetensors.index.json', {'weight_map':{'a':'part1.safetensors','b':'part2.safetensors'}})
        self.file('part1.safetensors')
        (self.snap/'part2.safetensors').symlink_to(self.root/'missing')
        self.assertFalse(inspect_snapshot(self.snap)['ready'])
        self.assertEqual(len(scan_models(self.root)), 1)
    def test_explicit_model_is_never_substituted(self):
        models = {'image':{'ready':True,'task':'image'}, 'voice':{'ready':True,'task':'tts'}, 'music':{'ready':True,'task':'audio'}}
        self.assertEqual(select_model(models,'auto','tts','image')[0], 'voice')
        with self.assertRaisesRegex(ValueError,'not downloaded'): select_model(models,'missing','tts')
        with self.assertRaisesRegex(ValueError,'not tts'): select_model(models,'music','tts')
        with self.assertRaisesRegex(ValueError,'No ready'): select_model({'image':models['image']},'auto','video')
    def test_unready_auto_model_is_skipped(self):
        models = {'bad':{'ready':False,'task':'image','reason':'Incomplete'},'good':{'ready':True,'task':'image'}}
        self.assertEqual(select_model(models,'auto','image','bad')[0], 'good')
        with self.assertRaisesRegex(ValueError,'Incomplete'): select_model(models,'bad','image')
    def test_request_validation_and_seed_zero(self):
        validate_request({'prompt':'test','seed':0,'task':'tts'})
        for extra in ({'seed':-1},{'steps':float('nan')},{'size':'9999x9999'},{'size':'513x512'},{'task':'bogus'},{'prompt':[]},{'n':1.5}):
            with self.subTest(extra=extra), self.assertRaises(ValueError): validate_request({'prompt':'test',**extra})
    def test_pipeline_specific_controls(self):
        class Flux:
            def __call__(self, prompt, width=512): pass
        self.assertEqual(pipeline_kwargs(Flux(), {'prompt':'test','negative_prompt':None,'width':512}), {'prompt':'test','width':512})
        with self.assertRaisesRegex(ValueError,'negative prompt'): pipeline_kwargs(Flux(), {'prompt':'test','negative_prompt':'bad'})
        with self.assertRaisesRegex(ValueError,'audio_length'): pipeline_kwargs(Flux(), {'audio_length_in_s':10})

if __name__ == '__main__': unittest.main()
