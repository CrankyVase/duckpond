import { modelKind, mediaTask } from '../src/modelKind.js';

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name} ${extra}`); fails += 1; }
};

console.log('\n== 1. Hub kind from pipeline tags ==');
ok('text-to-speech is audio', modelKind('k2-fsa/OmniVoice', 'text-to-speech') === 'audio');
ok('text-to-audio is audio', modelKind('facebook/musicgen-small', 'text-to-audio') === 'audio');
ok('text-to-image is image', modelKind('stabilityai/sdxl', 'text-to-image') === 'image');
ok('text-to-video is video', modelKind('Lightricks/LTX-Video', 'text-to-video') === 'video');
ok('text-generation is chat', modelKind('unsloth/Qwen3.8-27B-GGUF', 'text-generation') === 'chat');

console.log('\n== 2. Filename heuristics (no tag) ==');
ok('OmniVoice is audio, not image', modelKind('k2-fsa/OmniVoice') === 'audio');
ok('OmniVoice-GGUF is audio', modelKind('Serveurperso/OmniVoice-GGUF') === 'audio');
ok('moss-tts is audio', modelKind('openmoss-team/moss-tts-nano-100m') === 'audio');
ok('higgs-tts is audio', modelKind('bosonai/higgs-tts-2-3b-base') === 'audio');
ok('MiniMax-Music3 is audio', modelKind('audio-cpp/MiniMax-Music3-GGUF') === 'audio');
ok('Krea GGUF is image, not chat', modelKind('vantagewithai/Krea-2-Turbo-GGUF') === 'image');
ok('ideogram is image', modelKind('ideogram-ai/ideogram-4-fp8') === 'image');
ok('LTX-2-GGUF is video', modelKind('unsloth/LTX-2-GGUF') === 'video');
ok('LTX-Video is video', modelKind('Lightricks/LTX-Video-0.9.7-distilled') === 'video');
ok('chat GGUF stays chat', modelKind('unsloth/Qwen3.8-27B-GGUF') === 'chat');
ok('Dream-7B text diffusion stays chat', modelKind('Dream-v0-7B-GGUF') === 'chat');
ok('HiDream image model is image', modelKind('HiDream-ai/HiDream-I1-Full') === 'image');
ok('embed model', modelKind('unsloth/bge-small-en-v1.5') === 'embed');

console.log('\n== 3. Media Studio task (voice vs music vs image) ==');
ok('OmniVoice declared image still becomes tts', mediaTask('k2-fsa/OmniVoice', 'image') === 'tts');
ok('moss-tts declared image still becomes tts', mediaTask('openmoss-team/moss-tts-nano-100m', 'image') === 'tts');
ok('MusicGen is audio not tts', mediaTask('facebook/musicgen-small', 'image') === 'audio');
ok('MiniMax-Music3 is audio', mediaTask('audio-cpp/MiniMax-Music3-GGUF', 'image') === 'audio');
ok('SDXL stays image', mediaTask('stabilityai/stable-diffusion-xl-base-1.0', 'image') === 'image');
ok('Krea stays image', mediaTask('vantagewithai/Krea-2-Turbo-GGUF', 'image') === 'image');
ok('LTX stays video', mediaTask('Lightricks/LTX-Video-0.9.7-distilled', 'image') === 'video');
ok('declared tts kept when name is unknown', mediaTask('someone/mystery', 'tts') === 'tts');
ok('speech tag beats id', mediaTask('org/untitled', 'image', 'text-to-speech') === 'tts');

console.log(fails ? `\n${fails} FAILURES` : '\nAll green.');
process.exit(fails ? 1 : 0);
