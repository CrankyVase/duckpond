"""No model inference: check the sole Fedora exception and its lifecycle."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
import local_worker as local

class HelperTests(unittest.TestCase):
    def test_only_exact_helper_id_is_local(self):
        self.assertTrue(local.is_model('lfm2-700m-q4-0'))
        for model in ('unsloth/Qwen3.8-27B-UD-Q4_K_M', 'qwen-image-2.1', str(local.MODEL), 'other-700m'):
            self.assertFalse(local.is_model(model))

    def test_replaced_file_cannot_start_local_inference(self):
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory)/'model.gguf'
            model.write_bytes(b'wrong-model')
            with patch.object(local,'MODEL',model), patch.object(local,'MODEL_BYTES',len(b'wrong-model')), \
                 patch.object(local,'verified_stat',None):
                with self.assertRaisesRegex(RuntimeError,'checksum'):
                    local.verify_model()

    def test_cpu_launch_keeps_context_and_never_offloads(self):
        fake = Mock(); fake.poll.return_value = None
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(local,'ROOT',Path(directory)), patch.object(local,'process',None), \
                 patch.object(local,'log',None), patch.dict(local.state, {'status':'unloaded','active':0}), \
                 patch.object(local,'verify_model'), patch.object(local,'health',side_effect=[False,True]), \
                 patch.object(local.subprocess,'Popen',return_value=fake) as popen:
                local.load()
                args = popen.call_args.args[0]
                for flag,value in [('--device','none'),('--n-gpu-layers','0'),('--ctx-size','32768'),('--cache-ram','128')]:
                    self.assertEqual(args[args.index(flag)+1],value)
                self.assertIn('--no-op-offload',args)
                local.unload()
                fake.terminate.assert_called_once()

    def test_unload_refuses_active_helper(self):
        with patch.dict(local.state,{'active':1}), patch.object(local,'_stop') as stop:
            with self.assertRaisesRegex(RuntimeError,'active'):
                local.unload()
            stop.assert_not_called()

if __name__ == '__main__':
    unittest.main()
