// Small, local cues for Dumpling. Keep only an animation name, never a draft.
// These are playful word matches, not sentiment analysis or model instructions.
export function textReaction(text) {
  if (typeof text !== 'string') return null;
  const words = text.slice(0, 2000)
    .replace(/```[\s\S]*?(?:```|$)|`[^`]*`|https?:\/\/\S+/g, ' ')
    .toLowerCase().trim();
  if (/\b(thanks|thank you|thank u|tysm)\b/.test(words)) return 'heartgift';
  if (/\b(lol|lmao|haha|hahaha|hehe)\b|😂|🤣/.test(words)) return 'giggle';
  if (/^(hi|hello|hey|howdy|good morning|good evening)\b/.test(words)) return 'wave';
  if (/\b(duck|ducks|dumpling|quack)\b|🦆/.test(words)) return 'quack';
  if (/\b(coffee|espresso|cappuccino)\b|☕/.test(words)) return 'coffee';
  if (/\b(cook|cooking|recipe|pancakes|baking)\b/.test(words)) return 'cook';
  if (/\b(guitar|music|song|sing)\b|🎵|🎸/.test(words)) return 'guitar';
  if (/\b(stars|stargazing|constellation|astronomy)\b/.test(words)) return 'stargaze';
  if (/\b(garden|gardening|flowers)\b/.test(words)) return 'garden';
  return null;
}

const PHASES = { loading: 'loading', thinking: 'thinking', delta: 'reply',
  tool_delta: 'tool', reset_text: 'thinking', image_job: 'image',
  image_done: 'thinking', diffusion_step: 'diffusion' };

// Called at SSE arrival, before rAF batching or stream teardown. Buffer presence
// cannot describe the current phase: earlier reply text survives later reasoning.
export function recordDuckEvent(stream, event) {
  if (!stream || !event) return;
  if (Object.hasOwn(PHASES, event.type)) stream.duckPhase = PHASES[event.type];
  if (event.type === 'user_msg') stream.duckCue = textReaction(event.msg?.content);
  if (event.type === 'resume') {
    if (event.phase) stream.duckPhase = event.phase;
    if (event.userMsg) stream.duckCue = textReaction(event.userMsg.content);
    stream.duckStatus = [...(event.events ?? [])].reverse().find(e => e.type === 'status')?.status ?? stream.duckStatus;
    if (event.outcome) stream.duckOutcome = event.outcome;
  }
  if (event.type === 'agent') {
    const e = event.event;
    if (e?.type === 'assistant' || e?.type === 'tool_result') stream.duckPhase = 'thinking';
    if (e?.type === 'tool_call') stream.duckPhase = 'tool';
    if (e?.type === 'status') stream.duckStatus = e.status;
  }
  if (event.type === 'done') {
    stream.duckOutcome = stream.error ? 'error' : stream.duckOutcome === 'stopped' ? 'stopped'
      : event.outcome ?? (['done', 'stopped', 'error', 'aborted', 'steplimit'].includes(stream.duckStatus)
        ? stream.duckStatus : 'done');
    // Acknowledging a delivered reply does not validate its claims or tools.
    // Only short conversational replies contribute their own social cue.
    if (stream.duckOutcome === 'done') {
      const reply = event.msg?.content;
      stream.duckCue = stream.duckCue ?? (reply?.length < 240 ? textReaction(reply) : null);
    }
  }
}

// A quiet peek into the character, available on hover and to assistive tech.
export function duckThought(name, affection = 0) {
  const thoughts = {
    think: 'Hmm. Let me turn that over in my little duck head.',
    thinkhard: 'Thinking cap on. This one needs extra duck brain.',
    talk: 'I have something to tell you!',
    read: 'One more page. There might be a clue.',
    write: 'Tiny notes, big ideas.',
    code: 'My wings are surprisingly good at typing.',
    search: 'A clue hunt! I love a clue hunt.',
    wait: 'I can be patient. Mostly.',
    image: 'A little paint on my feathers is worth it.',
    error: 'Oof. Let’s catch our breath.',
    facepalm: 'Oh, feathers. That was a bumpy one.',
    shrug: 'We can pick it up when you’re ready.',
    nod: 'Got it. I’m here with you.',
    heartgift: 'A little wing hug for you.',
    quack: 'You called? Quack!',
    giggle: 'Hehe. You got me.',
    wave: 'Oh, hello! I saved you a spot by the pond.',
    coffee: 'One tiny coffee. For a very busy duck.',
    guitar: 'Every pond needs a soundtrack.',
    cook: 'Do you think this recipe works with duck-sized pancakes?',
    stargaze: 'So many stars. Such a small duck.',
    garden: 'Just checking on my little patch of flowers.',
    sleep: 'Resting my wings. Wake me when you need me.',
    listen: 'You have my whole duck attention.',
  };
  return thoughts[name] ?? (affection > 0.4 ? 'My favorite place is keeping you company.'
    : 'A little curious. A little silly. Happy to keep you company.');
}
