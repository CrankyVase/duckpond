"""CPU-only screening of image previews and finished images.

The small Marqo classifier lives in the existing Hugging Face cache. Loading
with local_files_only keeps a generation from making surprise network calls.
"""
from functools import lru_cache

import torch

MODEL_ID = 'Marqo/nsfw-image-detection-384'


@lru_cache(maxsize=1)
def _classifier():
    import timm
    from huggingface_hub import snapshot_download
    from safetensors.torch import load_file

    directory = snapshot_download(MODEL_ID, allow_patterns=['config.json', 'model.safetensors'],
                                  local_files_only=True)
    model = timm.create_model('vit_tiny_patch16_384', pretrained=False,
                              img_size=384, num_classes=2).eval().cpu()
    model.load_state_dict(load_file(f'{directory}/model.safetensors', device='cpu'))
    transform = timm.data.create_transform(
        input_size=(3, 384, 384), interpolation='bicubic', crop_pct=1.0,
        mean=(0.5, 0.5, 0.5), std=(0.5, 0.5, 0.5), is_training=False)
    return model, transform


def unsafe_probability(image):
    """Index zero is NSFW in this model's published label_names."""
    model, transform = _classifier()
    with torch.inference_mode():
        scores = model(transform(image.convert('RGB')).unsqueeze(0)).softmax(dim=-1)
    return float(scores[0, 0])


def require_safe_image(image, threshold=0.70, label='result'):
    try:
        probability = unsafe_probability(image)
    except Exception as exc:
        raise RuntimeError('Image safety check unavailable; no image was released') from exc
    if probability >= threshold:
        raise ValueError(f'Image safety check blocked the {label}. This local checker cannot reliably distinguish adult nudity from prohibited sexual content, so no image was saved.')
    return probability
