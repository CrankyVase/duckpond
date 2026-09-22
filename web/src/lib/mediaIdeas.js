// "Try an idea" is a tree, not a bag of independent slots.
// Pick a category → a subject in that category → a stance that subject
// can actually hold → actions, place, and light that follow from those.

const MOOD = [
  'cute', 'happy', 'melancholy', 'cozy', 'dramatic', 'playful', 'serene',
  'mysterious', 'whimsical', 'nostalgic', 'stormy', 'tender', 'sleepy',
  'gleeful', 'wistful', 'hushed', 'golden',
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function article(noun) {
  return /^[aeiou]/i.test(String(noun).replace(/^(old|red|tiny|paper|brass|hot-air)\s+/i, '')) ? 'an' : 'a';
}

function cap(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function fill(template, slots) {
  const raw = String(template).replace(/\{([A-Za-z]\w*)\}/g, (_, key) => slots[key] ?? '');
  return raw.replace(/\b([Aa]n?)\s+([A-Za-z][\w'-]*)/g, (_, art, word) => {
    const want = article(word);
    const out = art[0] === 'A' ? cap(want) : want;
    return `${out} ${word}`;
  });
}

const INDOOR_LIGHT = ['candlelight', 'fireplace glow', 'lamp light', 'overcast window light', 'warm indoor tungsten'];
const OUTDOOR_LIGHT = ['golden hour', 'blue hour', 'overcast glow', 'shaft of dust-lit sun', 'aurora', 'moonlight', 'sodium streetlamps'];
const TRANSIT_LIGHT = ['rain-streaked window light', 'sodium streetlamps', 'flickering carriage lamps', 'overcast glow'];

function lightFor(placeKind) {
  if (placeKind === 'indoor') return pick(INDOOR_LIGHT);
  if (placeKind === 'transit') return pick(TRANSIT_LIGHT);
  return pick(OUTDOOR_LIGHT);
}

// Each category owns its subjects, stances, and the places those stances allow.
const CATEGORIES = {
  creature: {
    subjects: [
      { name: 'rubber duck', habitat: 'water' },
      { name: 'koi', habitat: 'water' },
      { name: 'otter', habitat: 'water' },
      { name: 'swan', habitat: 'water' },
      { name: 'frog', habitat: 'water' },
      { name: 'red fox', habitat: 'land' },
      { name: 'tabby cat', habitat: 'land' },
      { name: 'deer', habitat: 'land' },
      { name: 'hedgehog', habitat: 'land' },
      { name: 'rabbit', habitat: 'land' },
      { name: 'crow', habitat: 'air' },
      { name: 'moth', habitat: 'air' },
    ],
    stances: {
      moving: {
        action1: {
          water: ['paddling', 'circling', 'gliding', 'bobbing along'],
          land: ['wandering', 'trotting', 'leaping', 'scampering'],
          air: ['circling', 'drifting past', 'alighting', 'weaving'],
        },
        action2: {
          water: ['stirring the reeds', 'leaving a small wake', 'catching the last light'],
          land: ['shaking off rain', 'leaving wet footprints', 'cutting across the path', 'nosing at a firefly'],
          air: ['cutting across the lamplight', 'skimming the wet glass', 'vanishing into the eaves'],
        },
        places: {
          water: [
            { text: 'a misty pond at dawn', kind: 'outdoor' },
            { text: 'a tide pool', kind: 'outdoor' },
            { text: 'a reed bed', kind: 'outdoor' },
            { text: 'a foggy pier', kind: 'outdoor' },
          ],
          land: [
            { text: 'a moonlit meadow', kind: 'outdoor' },
            { text: 'a lantern-lit alley', kind: 'outdoor' },
            { text: 'a mossy train platform', kind: 'outdoor' },
            { text: 'the floor of a rainy tram', kind: 'transit' },
            { text: 'a rooftop garden', kind: 'outdoor' },
          ],
          air: [
            { text: 'a lantern-lit alley', kind: 'outdoor' },
            { text: 'a rainy tram window', kind: 'transit' },
            { text: 'a cabin porch lamp', kind: 'outdoor' },
            { text: 'a rooftop garden', kind: 'outdoor' },
          ],
        },
        image: [
          '{A} {mood} {subject} {action1} through {place}, {action2}, {light}',
          'Wide shot of {a} {subject} {action1} across {place}, {action2}, {light}, {mood}',
          '{A} {mood} {subject} {action1} along {place}, {action2}, 35mm photograph',
          'From above, {a} {subject} {action1} through {place}, {action2}, {light}',
        ],
        video: [
          'Handheld drift following {a} {mood} {subject} {action1} through {place}, {action2}, {light}',
          'Slow pan as {a} {subject} {action1} across {place}, {action2}, {light}',
          'Gentle tracking shot of {a} {mood} {subject} {action1} through {place}, {light}',
        ],
      },
      resting: {
        action1: {
          water: ['floating still', 'waiting', 'listening', 'tucked in the reeds'],
          land: ['sleeping', 'waiting', 'huddling', 'peeking', 'stretching'],
          air: ['perching', 'waiting', 'listening', 'folding its wings'],
        },
        action2: {
          water: ['holding very still', 'watching the water', 'catching the last light'],
          land: ['holding very still', 'tucked into the weeds', 'catching the last light'],
          air: ['catching the last light', 'watching the platform below', 'out of the rain'],
        },
        places: {
          water: [
            { text: 'the edge of a misty pond', kind: 'outdoor' },
            { text: 'a tide pool', kind: 'outdoor' },
            { text: 'a reed bed at dusk', kind: 'outdoor' },
          ],
          land: [
            { text: 'a snowed-in porch', kind: 'outdoor' },
            { text: 'a cabin stoop', kind: 'outdoor' },
            { text: 'a moonlit meadow', kind: 'outdoor' },
            { text: 'a windowsill above a rainy tram', kind: 'transit' },
          ],
          air: [
            { text: 'a porch railing', kind: 'outdoor' },
            { text: 'a tram handrail', kind: 'transit' },
            { text: 'a greenhouse rafter', kind: 'indoor' },
          ],
        },
        image: [
          '{A} {mood} {subject} {action1} at {place}, {action2}, {light}',
          'Close-up of {a} {mood} {subject} {action1}, {place} behind it, {light}',
          '{A} {subject} {action1} in {place}, {mood}, {action2}, {light}',
          'Quiet portrait of {a} {subject} {action1} at {place}, {light}',
        ],
        video: [
          'Locked-off shot: {a} {mood} {subject} {action1} at {place}, {action2}, {light}, slight breeze',
          'Gentle push-in on {a} {subject} {action1} at {place}, {light}, unhurried',
          'Soft rack focus from {a} {subject} {action1} to {place}, {mood}, {light}',
        ],
      },
    },
  },

  character: {
    subjects: ['scarecrow', 'marionette', 'snowman', 'garden statue', 'tailor\'s dummy'],
    stances: {
      posed: {
        action1: ['standing watch', 'slumping', 'facing the wind', 'leaning on a post', 'keeping still'],
        action2: ['a firefly resting on its shoulder', 'catching the last light', 'its shadow stretching long', 'crows settling nearby'],
        places: [
          { text: 'a moonlit wheat field', kind: 'outdoor' },
          { text: 'the edge of a vegetable garden', kind: 'outdoor' },
          { text: 'a fence line at dusk', kind: 'outdoor' },
          { text: 'a sunken greenhouse', kind: 'indoor' },
          { text: 'a foggy orchard', kind: 'outdoor' },
        ],
        image: [
          '{A} {mood} {subject} {action1} in {place}, {action2}, {light}',
          'Wide shot of {a} {subject} {action1} in {place}, {mood}, {light}',
          'Low angle on {a} {subject} {action1}, {place} behind it, {light}',
          'Hand-tinted still of {a} {subject} {action1} in {place}, {action2}, {light}',
        ],
        video: [
          'Locked-off shot of {a} {mood} {subject} {action1} in {place}, {action2}, {light}, slow clouds',
          'Gentle push-in on {a} {subject} {action1} in {place}, {light}',
          'Slow crane past {a} {subject} {action1} in {place}, {mood}, {light}',
        ],
      },
    },
  },

  object: {
    subjects: [
      'umbrella', 'teapot', 'vinyl record', 'brass key', 'typewriter',
      'paper lantern', 'enamel mug', 'pocket watch', 'pair of boots',
    ],
    stances: {
      still: {
        action1: ['resting', 'catching the light', 'left out', 'leaning', 'sitting slightly open'],
        action2: ['a thin film of dust on it', 'still wet from the rain', 'next to a half-written note', 'warming the wood underneath'],
        places: [
          { text: 'a cabin table', kind: 'indoor' },
          { text: 'an attic full of maps', kind: 'indoor' },
          { text: 'a rainy windowsill', kind: 'indoor' },
          { text: 'a snowed-in porch rail', kind: 'outdoor' },
          { text: 'a greenhouse shelf', kind: 'indoor' },
          { text: 'a shop counter after closing', kind: 'indoor' },
        ],
        image: [
          'Still life: {a} {mood} {subject} {action1} on {place}, {action2}, {light}',
          'Close-up of {a} {subject} {action1} on {place}, {mood}, {light}',
          '{A} {subject} {action1} on {place}, {action2}, {light}, shallow depth of field',
          'Quiet tabletop of {a} {mood} {subject} {action1} at {place}, {light}',
        ],
        video: [
          'Locked-off still life, dust drifting: {a} {subject} {action1} on {place}, {light}',
          'Gentle push-in on {a} {mood} {subject} {action1} on {place}, {action2}, {light}',
          'Slow rack focus across {place} to {a} {subject} {action1}, {light}',
        ],
      },
    },
  },

  vessel: {
    subjects: [
      { name: 'sailboat', habitat: 'water' },
      { name: 'rowboat', habitat: 'water' },
      { name: 'fishing skiff', habitat: 'water' },
      { name: 'old bicycle', habitat: 'land' },
      { name: 'hot-air balloon', habitat: 'air' },
    ],
    stances: {
      underway: {
        action1: {
          water: ['drifting', 'easing along', 'coming about', 'gliding'],
          land: ['rolling quietly', 'following the path', 'coasting downhill'],
          air: ['drifting', 'easing along', 'climbing slowly'],
        },
        action2: {
          water: ['its wake barely there', 'catching the last light', 'cutting a slow line'],
          land: ['a scarf trailing off it', 'catching the last light', 'tires ticking on wet stone'],
          air: ['catching the last light', 'its burner ticking', 'a slow shadow on the fields'],
        },
        places: {
          water: [
            { text: 'a misty pond at dawn', kind: 'outdoor' },
            { text: 'a foggy harbor', kind: 'outdoor' },
            { text: 'a canal between warehouses', kind: 'outdoor' },
          ],
          land: [
            { text: 'a coastal path', kind: 'outdoor' },
            { text: 'a village lane', kind: 'outdoor' },
            { text: 'a lantern-lit alley', kind: 'outdoor' },
          ],
          air: [
            { text: 'open fields under a huge sky', kind: 'outdoor' },
            { text: 'a ridge above fog', kind: 'outdoor' },
          ],
        },
        image: [
          '{A} {mood} {subject} {action1} on {place}, {action2}, {light}',
          'Wide shot of {a} {subject} {action1} across {place}, {mood}, {light}',
          '{A} {subject} {action1} through {place}, {action2}, {light}, cinematic still',
        ],
        video: [
          'Slow camera glide past {a} {mood} {subject} {action1} on {place}, {action2}, {light}',
          'Gentle tracking of {a} {subject} {action1} across {place}, {light}',
          'Locked-off long lens: {a} {subject} {action1} on {place}, {mood}, {light}',
        ],
      },
      moored: {
        action1: {
          water: ['tied up', 'resting at the bank', 'waiting'],
          land: ['leaning on its kickstand', 'waiting', 'propped by the door'],
          air: ['tethered', 'waiting', 'settled just off the grass'],
        },
        action2: {
          water: ['catching the last light', 'ropes slack in the breeze'],
          land: ['a puddle gathering under it', 'catching the last light'],
          air: ['catching the last light', 'the envelope barely stirring'],
        },
        places: {
          water: [
            { text: 'a foggy pier', kind: 'outdoor' },
            { text: 'a mossy boathouse', kind: 'outdoor' },
          ],
          land: [
            { text: 'a village lane', kind: 'outdoor' },
            { text: 'a snowed-in porch', kind: 'outdoor' },
          ],
          air: [
            { text: 'open fields under a huge sky', kind: 'outdoor' },
            { text: 'a ridge above fog', kind: 'outdoor' },
          ],
        },
        image: [
          '{A} {mood} {subject} {action1} at {place}, {action2}, {light}',
          'Quiet wide shot of {a} {subject} {action1} at {place}, {light}',
        ],
        video: [
          'Locked-off shot of {a} {subject} {action1} at {place}, {action2}, {light}, slow water',
          'Gentle push-in on {a} {mood} {subject} {action1} at {place}, {light}',
        ],
      },
    },
  },

  landmark: {
    subjects: ['lighthouse', 'windmill', 'stone chapel', 'clock tower', 'covered bridge'],
    stances: {
      standing: {
        action1: ['standing over the water', 'catching the last light', 'weathering the wind', 'glowing at the edge of town'],
        action2: ['its beam just starting to turn', 'crows turning above it', 'spray lifting off the rocks', 'the village lamps coming on below'],
        places: [
          { text: 'a rocky headland', kind: 'outdoor' },
          { text: 'a stormy shoreline', kind: 'outdoor' },
          { text: 'a ridge above fog', kind: 'outdoor' },
          { text: 'the mouth of a quiet harbor', kind: 'outdoor' },
          { text: 'winter fields', kind: 'outdoor' },
        ],
        image: [
          '{A} {mood} {subject} {action1} on {place}, {action2}, {light}',
          'Wide landscape: {a} {subject} {action1} above {place}, {mood}, {light}',
          'Low angle on {a} {subject} {action1}, {place} stretching out, {light}',
          'Silhouette of {a} {subject} {action1} against {place}, {mood}, {light}',
        ],
        video: [
          'Slow drone-like glide past {a} {mood} {subject} {action1} on {place}, {light}',
          'Locked-off long take of {a} {subject} {action1} on {place}, {action2}, {light}',
          'Gentle push-in on {a} {subject} {action1} above {place}, {mood}, {light}',
        ],
      },
    },
  },
};

const AUDIO_TREES = [
  {
    lead: ['piano', 'felted piano', 'cello', 'acoustic guitar', 'harp', 'flute'],
    bed: ['soft choir', 'room tone', 'felted hammers', 'distant chimes'],
    genre: ['lullaby', 'piano miniature', 'chamber folk', 'rainy-day score'],
    templates: [
      'A {mood} {genre} for solo {lead}, {bed} underneath, {tempo}',
      'Close-mic {lead}, {mood} and {tempo}, a little {bed}',
      'Short {mood} cue: {lead} melody, {bed}, no vocals',
    ],
  },
  {
    lead: ['Rhodes', 'analog synth', 'upright bass', 'muted trumpet'],
    bed: ['brushed drums', 'vinyl crackle', 'tape hiss', 'spare kick drum'],
    genre: ['lo-fi beat', 'jazz sketch', 'dream pop', 'tape-worn soul'],
    templates: [
      'A {mood} {genre}, {lead} and {bed}, {tempo}',
      '{mood} instrumental with {lead}, {bed} entering late, {tempo}',
      'Looped {lead} figure, {mood}, {bed}, late-night',
    ],
  },
  {
    lead: ['choir', 'bowed glass', 'music box', 'glockenspiel'],
    bed: ['field-recorded rain', 'analog warmth', 'choir pad', 'tape hiss'],
    genre: ['ambient wash', 'music-box air', 'brass chorale', 'lullaby'],
    templates: [
      'A {mood} {genre} built from {lead} and {bed}, no lyrics, {tempo}',
      '{tempo} {mood} piece for {lead}, dusted with {bed}',
      'Warm {mood} sketch, {lead} then {bed}, {genre}',
    ],
  },
];

const TEMPO = ['unhurried', 'swaying', 'late-night', 'slow-blooming', 'gently looping', 'half-time'];

const TTS = [
  'Hey. I saved you the good mug. Come sit a minute.',
  'The rain started just as the kettle clicked. Perfect timing, if you ask me.',
  'You don\'t have to have the whole day figured out. Just this next small, kind thing.',
  'Welcome in. Shoes anywhere, coat on the chair, stay as long as you like.',
  'I walked down to the pond at dusk. The ducks were already arguing about bedtime.',
  'If this finds you tired, I hope it also finds you warm, and a little less alone.',
  'Tell me the long version. I have time, and the good biscuits.',
  'The attic still smells like paper and rain. I left the maps out, in case you want to wander.',
  'Good morning, slowly. The light is being very gentle about it.',
  'I thought of you in the grocery line and bought the extra honey. Don\'t ask me why.',
  'It\'s okay to close the tab and go outside. The world will keep your place.',
  'Listen: the house is quiet, the window is open, and nobody needs anything from you right now.',
  'I made a playlist for the tram ride home. It\'s mostly piano and the sound of trying again.',
  'Come look at this. The fog is sitting on the water like it paid rent.',
  'Leave the porch light on. I like knowing the path back is still warm.',
];

function branchOf(value, habitat) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    return value[habitat] || value.land || Object.values(value)[0];
  }
  return [];
}

function rollVisual(task) {
  const cat = CATEGORIES[pick(Object.keys(CATEGORIES))];
  const raw = pick(cat.subjects);
  const subject = typeof raw === 'string' ? raw : raw.name;
  const habitat = typeof raw === 'string' ? null : raw.habitat;
  const stance = cat.stances[pick(Object.keys(cat.stances))];
  const place = pick(branchOf(stance.places, habitat));
  const templates = task === 'video' ? stance.video : stance.image;
  const slots = {
    subject,
    a: article(subject),
    A: cap(article(subject)),
    mood: pick(MOOD),
    action1: pick(branchOf(stance.action1, habitat)),
    action2: pick(branchOf(stance.action2, habitat)),
    place: place.text,
    light: lightFor(place.kind),
  };
  return fill(pick(templates), slots);
}

function rollAudio() {
  const branch = pick(AUDIO_TREES);
  const slots = {
    mood: pick(MOOD),
    lead: pick(branch.lead),
    bed: pick(branch.bed),
    genre: pick(branch.genre),
    tempo: pick(TEMPO),
  };
  return fill(pick(branch.templates), slots);
}

export function freshIdea(task, previousPrompt) {
  let filled = '';
  for (let i = 0; i < 12; i++) {
    if (task === 'tts') filled = pick(TTS);
    else if (task === 'audio') filled = rollAudio();
    else filled = rollVisual(task);
    if (filled !== previousPrompt) return filled;
  }
  return filled;
}

export { CATEGORIES };
