// Every tool a model can be offered, for the per-model "enabled tools" settings
// UI. Kept separate from routes/chat.js and routes/agent.js (which own the real
// tool-call schemas sent to the model) so neither has to import the other —
// these are UI labels/descriptions, written for a human reading a settings
// panel, not the LLM-facing tool descriptions.
export const TOOL_CATALOG = [
  { id: 'start_project', label: 'Start project', category: 'Coding', description: 'Lets the model spin up a sandboxed workspace to build real, multi-file software instead of just answering in chat.' },
  { id: 'list_files', label: 'List files', category: 'Coding', description: 'Lets the model see what files exist in a project workspace.' },
  { id: 'read_file', label: 'Read file', category: 'Coding', description: 'Lets the model open and read a file in a project workspace.' },
  { id: 'write_file', label: 'Write file', category: 'Coding', description: 'Lets the model create or edit a file in a project workspace.' },
  { id: 'run_command', label: 'Run command', category: 'Coding', description: 'Lets the model run a shell command in the sandboxed workspace (tests, builds, scripts).' },
  { id: 'generate_image', label: 'Generate image', category: 'Media', description: 'Lets the model create an original picture with the local image generator.' },
  { id: 'web_search', label: 'Web search', category: 'Search', description: 'Lets the model search the web for current or unfamiliar information, with cited sources.' },
  { id: 'fetch_page', label: 'Fetch page', category: 'Search', description: 'Lets the model open a specific web page and read it in full.' },
  { id: 'show_weather', label: 'Weather card', category: 'Widgets', description: 'A live weather card for a place or the user’s location.' },
  { id: 'show_map', label: 'Map card', category: 'Widgets', description: 'A pannable 3D map with a pin for a place or address.' },
  { id: 'show_github_repo', label: 'GitHub repo card', category: 'Widgets', description: 'Stars, language, and description for a GitHub repository.' },
  { id: 'show_wikipedia', label: 'Wikipedia card', category: 'Widgets', description: 'A summary card for a Wikipedia article.' },
  { id: 'show_youtube', label: 'YouTube embed', category: 'Widgets', description: 'An embedded, playable YouTube video.' },
  { id: 'show_images', label: 'Photo grid', category: 'Widgets', description: 'A grid of real photos for a search term.' },
  { id: 'show_chart', label: 'Chart', category: 'Widgets', description: 'Bar, line, area, pie, donut, or scatter charts built from data the model provides.' },
  { id: 'show_crypto', label: 'Crypto price card', category: 'Widgets', description: 'A coin’s price with a 7-day sparkline.' },
  { id: 'show_dictionary', label: 'Dictionary card', category: 'Widgets', description: 'A word’s pronunciation, definitions, and example sentences.' },
  { id: 'show_link_preview', label: 'Link preview', category: 'Widgets', description: 'A rich preview card for any web page URL.' },
  { id: 'show_diagram', label: 'Diagram (Mermaid)', category: 'Widgets', description: 'A rendered, copyable flowchart / sequence / mind-map diagram.' },
  { id: 'show_currency', label: 'Currency conversion', category: 'Widgets', description: 'Converts between two currencies at the latest exchange rate.' },
  { id: 'show_npm', label: 'npm package card', category: 'Widgets', description: 'Version, downloads, and description for an npm package.' },
  { id: 'show_hackernews', label: 'Hacker News card', category: 'Widgets', description: 'The top Hacker News story for a topic.' },
  { id: 'show_table', label: 'Data table', category: 'Widgets', description: 'A sortable table built from data the model provides.' },
  { id: 'show_news', label: 'News headlines', category: 'Widgets', description: 'Recent news headlines for a topic.' },
  { id: 'show_countdown', label: 'Countdown', category: 'Widgets', description: 'A live countdown to a date or time.' },
  { id: 'show_color_palette', label: 'Color palette', category: 'Widgets', description: 'Copyable hex color swatches.' },
  { id: 'show_qr', label: 'QR code', category: 'Widgets', description: 'A scannable QR code for a URL or bit of text.' },
  { id: 'show_math_plot', label: 'Math plot', category: 'Widgets', description: 'Graphs a function y = f(x) over a range.' },
];

export const TOOL_CATEGORIES = ['Coding', 'Search', 'Media', 'Widgets'];
export const ALL_TOOL_IDS = TOOL_CATALOG.map((t) => t.id);
