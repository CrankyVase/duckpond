<script>
  // Hand-drawn SVG weather glyphs (no emoji). icon: sun|moon|partly|cloud|fog|drizzle|rain|snow|thunder
  let { icon = 'cloud', size = 44 } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 64 64" fill="none"
  stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"
  class="wi {icon}">
  {#if icon === 'sun'}
    <circle cx="32" cy="32" r="12" fill="currentColor" stroke="none" />
    {#each [0,45,90,135,180,225,270,315] as a}
      <line x1="32" y1="6" x2="32" y2="14" transform="rotate({a} 32 32)" />
    {/each}
  {:else if icon === 'moon'}
    <path d="M42 40a16 16 0 0 1-19-19 16 16 0 1 0 19 19z" fill="currentColor" stroke="none" />
  {:else if icon === 'partly'}
    <circle cx="24" cy="22" r="9" fill="currentColor" stroke="none" opacity="0.9" />
    {#each [200,245,290,335] as a}
      <line x1="24" y1="6" x2="24" y2="12" transform="rotate({a} 24 22)" opacity="0.9" />
    {/each}
    <path d="M20 46h22a8 8 0 0 0 0-16 11 11 0 0 0-21-2 8 8 0 0 0-1 18z" fill="currentColor" stroke="none" opacity="0.95" />
  {:else if icon === 'fog'}
    <path d="M18 34h22a8 8 0 0 0 0-16 11 11 0 0 0-21-2 8 8 0 0 0-1 18z" fill="currentColor" stroke="none" />
    <line x1="14" y1="44" x2="46" y2="44" opacity="0.8" />
    <line x1="18" y1="52" x2="42" y2="52" opacity="0.6" />
  {:else}
    <!-- cloud base for cloud / drizzle / rain / snow / thunder -->
    <path d="M20 40h22a9 9 0 0 0 0-18 12 12 0 0 0-23-2 9 9 0 0 0 1 20z" fill="currentColor" stroke="none" />
    {#if icon === 'rain'}
      {#each [24,32,40] as x}<line x1={x} y1="46" x2={x - 3} y2="56" stroke-width="3" />{/each}
    {:else if icon === 'drizzle'}
      {#each [26,38] as x}<line x1={x} y1="46" x2={x - 2} y2="53" stroke-width="2.5" />{/each}
    {:else if icon === 'snow'}
      {#each [24,32,40] as x}<circle cx={x} cy="50" r="2.2" fill="currentColor" stroke="none" />{/each}
    {:else if icon === 'thunder'}
      <path d="M32 44l-6 9h6l-4 8 11-12h-6l4-5z" fill="currentColor" stroke="none" />
    {/if}
  {/if}
</svg>

<style>
  .wi { display: block; }
</style>
