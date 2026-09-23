<script>
  let { plan = null, error = '' } = $props();

  const steps = $derived(Array.isArray(plan?.steps) ? plan.steps : []);
  const files = $derived(Array.isArray(plan?.changed_files) ? plan.changed_files : []);
  const failures = $derived(Array.isArray(plan?.failures) ? plan.failures : []);
  const constraints = $derived(Array.isArray(plan?.constraints) ? plan.constraints.map(String) : []);
  const verification = $derived(Array.isArray(plan?.verification) ? plan.verification : []);
  const remaining = $derived(Array.isArray(plan?.remaining) ? plan.remaining.map(String) : []);
  const current = $derived.by(() => {
    const index = Number(plan?.current_step);
    const step = steps[index];
    if (!step || typeof step.text !== 'string') return 'Not started';
    return `${index + 1}. ${step.text} (${step.status || 'pending'})`;
  });

  function evidence(item) {
    if (typeof item === 'string') return item;
    const command = item?.command || 'command';
    const outcome = item?.outcome ? ` — ${item.outcome}` : '';
    const tag = item?.ok === true ? 'passed' : item?.ok === false ? 'failed' : 'evidence';
    return `${tag}: ${command}${outcome}`;
  }
</script>

<details class="agent-plan" open>
  <summary>Plan</summary>
  <div class="plan-body">
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if !plan}
      <p>{error ? 'Plan unavailable.' : 'Loading plan…'}</p>
    {:else}
      {#if plan.persisted === false}
        <p class="note">No saved plan yet. Objective is the run task.</p>
      {/if}
      <dl>
        <div>
          <dt>Objective</dt>
          <dd class="objective">{plan.objective || 'None'}</dd>
        </div>
        <div>
          <dt>Current step</dt>
          <dd>{current}</dd>
        </div>
        <div>
          <dt>Checklist</dt>
          <dd>
            {#if steps.length}
              <ol>
                {#each steps as step, i}
                  <li>{step.status || 'pending'}: {step.text}{i === plan.current_step ? ' (current)' : ''}</li>
                {/each}
              </ol>
            {:else}
              No checklist yet.
            {/if}
          </dd>
        </div>
        <div>
          <dt>Files</dt>
          <dd>
            {#if files.length}
              <ul>
                {#each files as path}<li>{path}</li>{/each}
              </ul>
            {:else}
              No file changes yet.
            {/if}
          </dd>
        </div>
        <div>
          <dt>Failures</dt>
          <dd>
            {#if failures.length}
              <ul>
                {#each failures as failure}<li>{failure}</li>{/each}
              </ul>
            {:else}
              None.
            {/if}
          </dd>
        </div>
        <div>
          <dt>Constraints</dt>
          <dd>{constraints.length ? constraints.join('; ') : 'None.'}</dd>
        </div>
        <div>
          <dt>Verification</dt>
          <dd>
            {#if verification.length}
              <ul>
                {#each verification as item}<li>{evidence(item)}</li>{/each}
              </ul>
            {:else}
              None.
            {/if}
          </dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>{remaining.length ? remaining.join('; ') : 'None.'}</dd>
        </div>
      </dl>
    {/if}
  </div>
</details>

<style>
  .agent-plan {
    min-width: 0;
    margin-top: 8px;
    border-top: 1px solid var(--border-soft);
    color: var(--text);
    font-size: 12px;
    line-height: 1.45;
  }
  summary {
    cursor: pointer;
    padding: 6px 0;
    font-size: 12px;
    font-weight: 650;
  }
  summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .plan-body {
    max-height: min(220px, 34vh);
    overflow: auto;
    padding-bottom: 4px;
  }
  .note, .error { margin: 0 0 6px; }
  .note { color: var(--text-dim); }
  .error { color: var(--red); }
  dl { margin: 0; }
  dl > div { margin: 0 0 6px; min-width: 0; }
  dt { color: var(--text-dim); font-size: 11px; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .objective { white-space: pre-wrap; }
  ul, ol { margin: 0; padding-left: 1.1rem; }
  li { overflow-wrap: anywhere; }
  @media (max-width: 768px) {
    .plan-body { max-height: 160px; }
    summary { min-height: 32px; }
  }
</style>
