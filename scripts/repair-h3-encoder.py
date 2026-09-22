"""Add the missing architecture tag to the raw-state-dict H3 encoder GGUF.

Preserves the source and tensor bytes; writes a separate ComfyUI-compatible copy.
"""
import sys
from pathlib import Path
import gguf
from gguf.scripts.gguf_new_metadata import copy_with_new_metadata
source, target = map(Path, sys.argv[1:3])
if target.exists():
    raise SystemExit('Output already exists')
reader = gguf.GGUFReader(str(source))
keys = {t.name for t in reader.tensors}
if reader.get_field('general.architecture') is not None:
    raise SystemExit('This repair is only for the encoder missing its architecture field')
# MiniMax H3 ships Qwen3-VL-32B truncated after layer 50 (indices 0–49) plus the vision tower.
expected = {
    'model.embed_tokens.weight',
    'model.layers.0.self_attn.q_proj.weight',
    'model.layers.49.self_attn.q_proj.weight',
    'visual.blocks.0.attn.qkv.weight',
}
if not expected <= keys:
    raise SystemExit('Not the expected 50-layer MiniMax H3 Qwen3-VL encoder')
writer = gguf.GGUFWriter(str(target), 'qwen3vl', endianess=reader.endianess)
copy_with_new_metadata(reader, writer, {}, [])
fixed = gguf.GGUFReader(str(target))
assert len(fixed.tensors) == len(reader.tensors)
for a, b in zip(reader.tensors, fixed.tensors):
    assert a.name == b.name and a.n_bytes == b.n_bytes and tuple(a.shape) == tuple(b.shape)
print(f'Preserved {len(fixed.tensors)} tensors; architecture metadata added to {target}')
