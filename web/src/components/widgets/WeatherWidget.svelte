<script>
  import { wmo, dayName } from '../../lib/weather.js';
  import WeatherIcon from './WeatherIcon.svelte';
  let { data } = $props();
  const now = $derived(wmo(data.current.code, data.current.isDay));
  const u = $derived(data.units ?? { temp: '°', wind: 'km/h' });
</script>
<div class="weather">
  <div class="content">
    <div class="top">
      <div class="loc">
        <div class="place">{data.place}</div>
        <div class="cond">{now.label}</div>
      </div>
      <div class="ico"><WeatherIcon icon={now.icon} size={52} /></div>
    </div>

    <div class="mid">
      <div class="temp">{data.current.temp}<span class="deg">{u.temp}</span></div>
      <div class="meta">
        <span>Feels {data.current.feelsLike}{u.temp}</span>
        <span>Humidity {data.current.humidity}%</span>
        <span>Wind {data.current.wind} {u.wind}</span>
      </div>
    </div>

    {#if data.daily?.length}
      <div class="days">
        {#each data.daily.slice(0, 5) as d (d.date)}
          {@const dw = wmo(d.code, true)}
          <div class="day">
            <span class="dn">{dayName(d.date)}</span>
            <span class="di"><WeatherIcon icon={dw.icon} size={24} /></span>
            <span class="dt"><b>{d.max}°</b> <span class="lo">{d.min}°</span></span>
            {#if d.precip != null && d.precip > 0}<span class="pp">{d.precip}%</span>{/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .weather { margin: 12px 0; width: 100%; max-width: 540px; border: 1px solid var(--border-soft); border-radius: calc(12px * var(--rf)); background: var(--bg-card); padding: 22px; color: var(--text); }
  .top { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .place { font-size: 16px; font-weight: 550; letter-spacing: -.02em; }
  .cond { font-size: 12px; color: var(--text-dim); margin-top: 3px; }
  .ico { color: var(--text-dim); }
  .mid { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin: 22px 0; }
  .temp { font-size: 52px; font-weight: 400; letter-spacing: -.05em; line-height: 1; font-variant-numeric: tabular-nums; }
  .deg { font-size: 22px; color: var(--text-dim); margin-left: 4px; vertical-align: top; }
  .meta { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-dim); text-align: right; }
  .days { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0,1fr); gap: 8px; border-top: 1px solid var(--border-soft); padding-top: 18px; }
  .day { display: flex; flex-direction: column; align-items: center; gap: 8px; }
  .dn { font-size: 11px; color: var(--text-dim); }
  .dt { font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .dt b { font-weight: 500; }
  .lo { color: var(--text-faint); margin-left: 3px; }
  .pp { font-size: 10px; color: var(--text-dim); }
  @media(max-width: 500px) { .weather { padding: 16px; } .temp { font-size: 44px; } .meta { font-size: 11px; } .days { gap: 4px; } }
</style>
