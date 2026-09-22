<script>
  // Chat ↔ Agent workspace switcher. Lives in the sidebar (the conversation
  // list below it is scoped to the active mode) and falls back to a compact
  // form in the topbar whenever the sidebar is collapsed / on phones.
  import { app, switchMode } from '../lib/state.svelte.js';
  import { toast } from '../lib/toast.svelte.js';
  import Code from '@lucide/svelte/icons/code';
  import MessageSquare from '@lucide/svelte/icons/message-square';

  let { compact = false, onpick = null } = $props();
  let busy = $state(false);

  async function pick(mode) {
    if (busy) return;
    if (app.mode === mode && app.conv) {
      app.view = 'chat';
      app.themeStudioOpen = false;
      app.modelPickerOpen = false;
      onpick?.();
      return;
    }
    busy = true;
    try {
      app.themeStudioOpen = false;
      app.modelPickerOpen = false;
      await switchMode(mode);
      onpick?.();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      busy = false;
    }
  }
</script>

<div class="modeswitch" class:compact class:agent-active={app.mode === 'agent'} role="group" aria-label="Workspace mode" aria-busy={busy}>
  <span class="thumb" aria-hidden="true"></span>
  <button type="button" class:chosen={app.mode === 'chat'} aria-pressed={app.mode === 'chat'}
    disabled={busy}
    onclick={() => pick('chat')} title="Chat — everyday conversations">
    <MessageSquare size={13} /><span>Chat</span>
  </button>
  <button type="button" class:chosen={app.mode === 'agent'} aria-pressed={app.mode === 'agent'}
    disabled={busy}
    onclick={() => pick('agent')} title="Agent — coding workbench with project files">
    <Code size={14} /><span>Agent</span>
  </button>
</div>

<style>
  /* Same warm palette as the rest of the app: a raised track, a quiet
     bg-hover thumb and one small accent tick on the active side. No neon,
     no glow — the motion is the only thing that announces the swap. */
  .modeswitch {
    position: relative;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border-soft);
    border-radius: calc(10px * var(--rf));
    background: var(--bg-raised);
    isolation: isolate;
    animation: switchIn 200ms ease;
  }
  @keyframes switchIn {
    from { opacity: 0; transform: translateY(-2px); }
    to { opacity: 1; transform: none; }
  }
  /* sliding selection — width is half the track, so 100% + gap lands on "Agent" */
  .thumb {
    position: absolute;
    z-index: 0;
    top: 3px; bottom: 3px; left: 3px;
    width: calc(50% - 4px);
    border-radius: calc(7px * var(--rf));
    background: var(--bg-hover);
    border: 1px solid var(--border);
    transition: transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .modeswitch.agent-active .thumb { transform: translateX(calc(100% + 2px)); }
  .modeswitch button {
    all: unset;
    position: relative;
    z-index: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 7px 10px;
    border-radius: calc(7px * var(--rf));
    color: var(--text-faint);
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
    transition: color 160ms ease;
  }
  .modeswitch button:hover { color: var(--text-dim); }
  .modeswitch button:disabled { cursor: progress; opacity: .6; }
  .modeswitch button.chosen { color: var(--text); }
  /* active side gets a small accent tick — the same "you are here" cue the
     sidebar uses on the open chat, so the two read as one system */
  .modeswitch button.chosen::before {
    content: '';
    width: 3px; height: 3px; border-radius: 50%;
    background: var(--accent);
    margin-right: 1px;
  }
  .modeswitch button :global(svg) { flex-shrink: 0; opacity: 0.9; }
  .modeswitch.compact button { padding: 6px 9px; font-size: 12.5px; gap: 5px; }

  @media (max-width: 768px) {
    .modeswitch button { min-height: 34px; }
  }
</style>
