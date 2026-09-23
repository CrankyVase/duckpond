// Every tool a model can be offered, for the per-model "enabled tools" settings
// UI. Kept separate from routes/chat.js and routes/agent.js (which own the real
// tool-call schemas sent to the model) so neither has to import the other —
// these are UI labels/descriptions, written for a human reading a settings
// panel, not the LLM-facing tool descriptions.
export const TOOL_CATALOG = [
  { id: 'start_project', label: 'Start project', category: 'Coding', description: 'Lets the model spin up a sandboxed workspace to build real, multi-file software instead of just answering in chat.' },
  { id: 'list_files', label: 'List files', category: 'Coding', description: 'Lets the model see what files exist in a project workspace.' },
  { id: 'search_files', label: 'Search files', category: 'Coding', description: 'Finds filenames and source text in the project workspace.' },
  { id: 'read_file', label: 'Read file', category: 'Coding', description: 'Lets the model open and read a file in a project workspace.' },
  { id: 'list_documents', label: 'List documents', category: 'Documents', description: 'Lists the documents attached to the current conversation.' },
  { id: 'search_documents', label: 'Search documents', category: 'Documents', description: 'Finds relevant passages in attached documents.' },
  { id: 'read_document', label: 'Read document', category: 'Documents', description: 'Reads text from an attached document.' },
  { id: 'write_file', label: 'Write file', category: 'Coding', description: 'Lets the model create or edit a file in a project workspace.' },
  { id: 'edit_file', label: 'Edit file', category: 'Coding', description: 'Lets the model make targeted search-and-replace edits to a file instead of rewriting the whole thing.' },
  { id: 'run_command', label: 'Run command', category: 'Coding', description: 'Lets the model run a shell command in the sandboxed workspace (tests, builds, scripts).' },
  { id: 'start_server', label: 'Start preview server', category: 'Coding', description: 'Starts a managed development server for the project.' },
  { id: 'server_status', label: 'Preview server status', category: 'Coding', description: 'Reads the development server status, URL, and recent logs.' },
  { id: 'stop_server', label: 'Stop preview server', category: 'Coding', description: 'Stops the managed development server.' },
  { id: 'browser', label: 'Project browser', category: 'Coding', description: 'Inspects and interacts with the project preview in an isolated browser.' },
  { id: 'screenshot', label: 'Screenshot', category: 'Coding', description: 'Lets the model take a picture of a web page or a local HTML file so it can see what it built.' },
  { id: 'github_repo_info', label: 'GitHub: repo info', category: 'GitHub', description: 'Lets the model look up a repository’s default branch, language, and whether it can push.' },
  { id: 'github_list_files', label: 'GitHub: list files', category: 'GitHub', description: 'Lets the model browse the file tree of a repository.' },
  { id: 'github_read_file', label: 'GitHub: read file', category: 'GitHub', description: 'Lets the model read a file straight from a repository.' },
  { id: 'github_pull', label: 'GitHub: pull into workspace', category: 'GitHub', description: 'Lets the model copy a repository into the sandbox so it can work on it with the normal file tools.' },
  { id: 'github_create_branch', label: 'GitHub: create branch', category: 'GitHub', description: 'Lets the model create a branch. Asks for your approval first.' },
  { id: 'github_commit', label: 'GitHub: commit & push', category: 'GitHub', description: 'Lets the model commit files and push them to a branch. Asks for your approval first, and never touches your default branch.' },
  { id: 'github_open_pr', label: 'GitHub: open pull request', category: 'GitHub', description: 'Lets the model open a pull request. Asks for your approval first.' },
  { id: 'generate_image', label: 'Generate image', category: 'Media', description: 'Lets the model create an original picture with the local image generator.' },
  { id: 'web_search', label: 'Web search', category: 'Search', description: 'Lets the model search the web for current or unfamiliar information, with cited sources.' },
  { id: 'fetch_page', label: 'Fetch page', category: 'Search', description: 'Lets the model open a specific web page and read it in full.' },
  { id: 'show_chart', label: 'Chart', category: 'Widgets', description: 'Bar, line, area, pie, donut, or scatter charts built from data the model provides.' },
  { id: 'show_diagram', label: 'Diagram (Mermaid)', category: 'Widgets', description: 'A rendered, copyable flowchart / sequence / mind-map diagram.' },
  { id: 'show_table', label: 'Data table', category: 'Widgets', description: 'A sortable table built from data the model provides.' },
  { id: 'generate_slides', label: 'PowerPoint deck', category: 'Media', description: 'Builds a real downloadable .pptx presentation from an outline the model writes (also opens in Google Slides).' },
  { id: 'export_csv', label: 'CSV export', category: 'Media', description: 'Saves tabular data as a downloadable CSV file.' },
  { id: 'save_memory', label: 'Save memory', category: 'Memory', description: 'Lets the model store a durable fact about you in its long-term memory the moment you share it.' },
  { id: 'update_memory', label: 'Update memory', category: 'Memory', description: "Lets the model correct one of its memories when you point out it's wrong or outdated." },
  { id: 'forget_memory', label: 'Forget memory', category: 'Memory', description: 'Lets the model delete one of its memories when you ask it to forget something.' },
];

export const TOOL_CATEGORIES = ['Coding', 'Documents', 'Search', 'Media', 'Widgets', 'Memory'];
export const ALL_TOOL_IDS = TOOL_CATALOG.map((t) => t.id);
