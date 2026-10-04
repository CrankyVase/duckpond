"""Lifecycle checks that never start inference or contact Windows."""
import unittest
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
import bridge
import image_worker
import runtime_profiles


class LifecycleTests(unittest.TestCase):
    def test_performance_profiles_cannot_change_context_or_precision(self):
        for override in ({'context': 8192}, {'cacheType': 'q4_0'}, {'gpuLayers': 999}, {'threads': 0}, {'opOffload': 1},
                         {'specDraftMax': True}, {'fitMargin': 256.0}, {'cpuMask': None},
                         {'batchSize': True}, {'ubatchSize': 8192}, {'batchSize': 1000}):
            with self.assertRaises(ValueError):
                runtime_profiles.validate(override)
        profile = runtime_profiles.validate({'threads': 6, 'fitMargin': 256, 'opOffload': False})
        self.assertEqual(profile['threads'], 6)
        self.assertFalse(profile['opOffload'])

    def test_prompt_batch_tuning_keeps_context_and_precision_out_of_profiles(self):
        profile = runtime_profiles.validate({'batchSize': 4096, 'ubatchSize': 1024})
        self.assertEqual((profile['batchSize'], profile['ubatchSize']), (4096, 1024))
        self.assertNotIn('context', profile)
        self.assertNotIn('cacheType', profile)

    def test_matching_loaded_profile_reuses_worker(self):
        profile = runtime_profiles.validate({'threads': 6})
        with patch.object(bridge, 'running_model', 'test-model'), \
             patch.object(bridge, 'running_tuning', profile), \
             patch.object(bridge, 'health', return_value=True), \
             patch.dict(bridge.state, {'status': 'loaded'}), \
             patch.object(bridge, 'remote') as remote:
            bridge.load('test-model', tuning_override=profile)
        remote.assert_not_called()

    def test_saved_profile_applies_only_to_its_model_and_refreshes(self):
        with tempfile.TemporaryDirectory() as directory:
            profile_file = Path(directory) / 'profiles.json'
            with patch.object(runtime_profiles, 'PROFILE_FILE', profile_file):
                profile_file.write_text(json.dumps({'tested-model': {'threads': 6, 'specType': 'draft-mtp'}}))
                self.assertEqual(runtime_profiles.for_model('tested-model')['specType'], 'draft-mtp')
                self.assertEqual(runtime_profiles.for_model('new-model'), runtime_profiles.DEFAULT)
                profile_file.write_text('{}')
                self.assertEqual(runtime_profiles.for_model('tested-model'), runtime_profiles.DEFAULT)

    def test_cancelled_load_reservation_never_starts_a_worker(self):
        with patch.object(bridge, 'load_generation', 2), patch.object(bridge, 'health') as health:
            with self.assertRaises(bridge.LoadCancelled):
                bridge.load('cancelled-model', reservation=1)
        health.assert_not_called()

    def test_photo_progress_counts_sampling_and_not_tensor_or_tile_transfers(self):
        prog = {'phase': 'loading_windows_memory', 'steps': 9}
        image_worker.native_progress(prog, '  |########| 9/397 - 2.98GB/s', 9)
        self.assertNotIn('step', prog)
        image_worker.native_progress(prog, '  |=======>| 1/9 - 2.99s/it', 9)
        self.assertEqual((prog['phase'], prog['step'], prog['steps']), ('sampling', 1, 9))
        image_worker.native_progress(prog, 'image.cpp:554 - decoding 1 latents', 9)
        image_worker.native_progress(prog, '  |=======>| 2/9 - 11.49it/s', 9)
        self.assertEqual((prog['phase'], prog['step']), ('decoding', 1))

    def test_deleted_loaded_file_is_unloaded_before_pruning(self):
        states = [{'status': 'loaded'}, {'status': 'unloaded'}]
        events = []
        with patch.object(bridge, 'snapshot', side_effect=states), \
             patch.dict(bridge.transfer_assets, {'a': {'path': '/missing/duckpond-model.gguf', 'cacheKey': 'a'}}, clear=True), \
             patch.object(bridge, 'unload', side_effect=lambda: events.append('unload')), \
             patch.object(bridge.library, 'prune', side_effect=lambda delete, protected: events.append(('prune', protected))):
            bridge.prune_cache()
        self.assertEqual(events, ['unload', ('prune', [])])

    def test_existing_loaded_file_is_protected_from_deletion(self):
        with patch.object(bridge, 'snapshot', return_value={'status': 'loaded'}), \
             patch.dict(bridge.transfer_assets, {'a': {'path': __file__, 'cacheKey': 'a'}}, clear=True), \
             patch.object(bridge, 'unload') as unload, \
             patch.object(bridge.library, 'prune') as prune:
            bridge.prune_cache()
        unload.assert_not_called()
        self.assertEqual(prune.call_args.args[1], ['a'])


if __name__ == '__main__':
    unittest.main()
