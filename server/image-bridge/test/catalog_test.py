import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from media_catalog import inspect_snapshot, scan_models, select_model, validate_request, pipeline_kwargs, pipeline_task, infer_task

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
    def test_speech_pipelines_are_not_images(self):
        for cls in ('BarkPipeline', 'SpeechT5Pipeline', 'PiperPipeline', 'VitsPipeline', 'ParlerTTSPipeline'):
            with self.subTest(cls=cls):
                self.assertEqual(pipeline_task(cls), 'tts', cls)

    def test_music_and_video_pipelines_keep_their_tasks(self):
        self.assertEqual(pipeline_task('AudioLDMPipeline'), 'audio')
        self.assertEqual(pipeline_task('StableAudioPipeline'), 'audio')
        self.assertEqual(pipeline_task('MusicLDMPipeline'), 'audio')
        self.assertEqual(pipeline_task('LTXConditionPipeline'), 'video')
        self.assertEqual(pipeline_task('CogVideoXPipeline'), 'video')
        self.assertEqual(pipeline_task('StableDiffusionXLPipeline'), 'image')
        self.assertEqual(pipeline_task('FluxPipeline'), 'image')

    def test_repo_name_beats_a_generic_pipeline_class(self):
        self.assertEqual(pipeline_task('DiffusionPipeline', 'k2-fsa/OmniVoice'), 'tts')
        self.assertEqual(infer_task('Serveurperso/OmniVoice-GGUF'), 'tts')
        self.assertEqual(infer_task('audio-cpp/MiniMax-Music3-GGUF'), 'audio')
        self.assertEqual(infer_task('vantagewithai/Krea-2-Turbo-GGUF'), 'image')
        self.assertEqual(infer_task('unsloth/LTX-2-GGUF'), 'video')
        self.assertEqual(infer_task('openmoss-team/moss-tts-nano-100m'), 'tts')
        self.assertIsNone(infer_task('unsloth/Qwen3.8-27B-GGUF'))
        self.assertIsNone(infer_task('OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano'))

    def test_voice_gguf_is_listed_under_speech(self):
        self.tmp.cleanup()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.snap = self.root / 'models--k2-fsa--OmniVoice-GGUF' / 'snapshots' / 'revision'
        self.snap.mkdir(parents=True)
        self.file('model.gguf')
        info = inspect_snapshot(self.snap, repo_id='k2-fsa/OmniVoice-GGUF')
        self.assertEqual(info['task'], 'tts')
        self.assertEqual(info['kind'], 'gguf')
        self.assertFalse(info['ready'])

    def test_unknown_safetensors_are_not_dumped_into_images(self):
        self.file('mystery.safetensors')
        self.assertIsNone(inspect_snapshot(self.snap, repo_id='someone/mystery-weights'))

    def test_omnivoice_config_stays_speech_even_without_class(self):
        self.file('config.json', {'model_type': 'omnivoice', 'architectures': ['OmniVoice']})
        self.file('model.safetensors')
        with patch('importlib.util.find_spec', return_value=None):
            info = inspect_snapshot(self.snap, repo_id='k2-fsa/OmniVoice')
        self.assertEqual(info['task'], 'tts')
        self.assertNotEqual(info['kind'], 'single_file')

    def test_pipeline_specific_controls(self):
        class Flux:
            def __call__(self, prompt, width=512): pass
        self.assertEqual(pipeline_kwargs(Flux(), {'prompt':'test','negative_prompt':None,'width':512}), {'prompt':'test','width':512})
        with self.assertRaisesRegex(ValueError,'negative prompt'): pipeline_kwargs(Flux(), {'prompt':'test','negative_prompt':'bad'})
        with self.assertRaisesRegex(ValueError,'audio_length'): pipeline_kwargs(Flux(), {'audio_length_in_s':10})

if __name__ == '__main__': unittest.main()
