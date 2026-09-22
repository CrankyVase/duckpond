import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import comfy_media


class ComfyMediaTests(unittest.TestCase):
    def test_text_to_video_has_no_load_image(self):
        graph = comfy_media.workflow('lake at dawn', 608, 352, 22, 8, 1, 'duckpond/t-0')
        self.assertNotIn('15', graph)
        self.assertNotIn('first_frame', graph['5']['inputs'])
        self.assertEqual(graph['2']['class_type'], 'CLIPLoader')
        self.assertEqual(graph['14']['inputs']['format'], 'mp4')
        self.assertNotIn('codec', graph['14']['inputs'])

    def test_image_to_video_wires_first_and_last_frame(self):
        graph = comfy_media.workflow('the duck turns', 608, 352, 22, 8, 1, 'duckpond/t-0',
                                     first_name='first.png', last_name='last.png')
        self.assertEqual(graph['15']['class_type'], 'LoadImage')
        self.assertEqual(graph['15']['inputs']['image'], 'first.png')
        self.assertEqual(graph['5']['inputs']['first_frame'], ['15', 0])
        self.assertEqual(graph['16']['inputs']['image'], 'last.png')
        self.assertEqual(graph['5']['inputs']['last_frame'], ['16', 0])

    def test_history_prefers_video_files(self):
        files = comfy_media.history_files({
            'outputs': {'14': {'images': [{'filename': 'preview.png'}], 'videos': [{'filename': 'clip.mp4', 'subfolder': 'duckpond', 'type': 'output'}]}}
        })
        self.assertEqual(files[0]['filename'], 'clip.mp4')

    def test_catalog_marks_h3_as_editable_video(self):
        with patch.object(comfy_media, 'request', return_value={}), patch.object(comfy_media.Path, 'is_file', return_value=True):
            info = comfy_media.catalog()[comfy_media.MODEL]
        self.assertTrue(info['ready'])
        self.assertTrue(info['supports_image'])
        self.assertEqual(info['max_references'], 2)
        self.assertEqual(info['task'], 'video')

    def test_frames_for_duration_snaps_to_h3(self):
        self.assertEqual(comfy_media.frames_for_duration(5), 124)
        self.assertEqual(comfy_media.frames_for_duration(1), 22)

    def test_generate_maps_duration_to_aligned_frames(self):
        graphs = []
        def fake_request(path, body=None, timeout=15):
            if path == '/prompt':
                graphs.append(body['prompt'])
                return {'prompt_id': 'job1'}
            if path.startswith('/history/'):
                return {'job1': {'outputs': {'14': {'videos': [{'filename': 'clip.mp4'}]}}}}
            return {}
        with patch.object(comfy_media, 'request', side_effect=fake_request), \
             patch.object(comfy_media, 'read_output', return_value=b'mp4'), \
             patch.object(comfy_media.time, 'sleep'):
            result = comfy_media.generate(
                {'prompt': 'lake', 'size': '608x352', 'duration': 5, 'n': 1},
                'tag', lambda: False, lambda *a, **k: None)
        self.assertEqual(graphs[0]['5']['inputs']['length'], 124)
        self.assertTrue(result['data'])


if __name__ == '__main__':
    unittest.main()
