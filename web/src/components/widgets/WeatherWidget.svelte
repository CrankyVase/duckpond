<script>
  import { wmo, WEATHER_BG, dayName } from '../../lib/weather.js';
  import WeatherIcon from './WeatherIcon.svelte';

  let { data } = $props();
  const now = $derived(wmo(data.current.code, data.current.isDay));
  const bg = $derived(WEATHER_BG[now.theme] ?? WEATHER_BG.cloud);
  const u = $derived(data.units ?? { temp: '°', wind: 'km/h' });
</script>

<div class="weather" style:background={bg}>
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

<style>
  .weather {
    margin: 10px 0; max-width: 460px;
    border-radius: 16px; padding: 16px 18px 14px;
    color: #fff; box-shadow: var(--shadow-lg);
    text-shadow: 0 1px 2px rgba(0,0,0,0.25);
  }
  .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .place { font-size: 15px; font-weight: 600; }
  .cond { font-size: 12.5px; opacity: 0.9; margin-top: 1px; }
  .ico { opacity: 0.98; }
  .mid { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin: 8px 0 14px; }
  .temp { font-size: 46px; font-weight: 300; line-height: 1; }
  .deg { font-size: 20px; font-weight: 400; opacity: 0.85; margin-left: 2px; }
  .meta { display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; opacity: 0.92; text-align: right; }
  .days {
    display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px;
    padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.18);
  }
  .day { display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .dn { font-size: 11px; opacity: 0.9; }
  .di { opacity: 0.95; }
  .dt { font-size: 11.5px; }
  .dt .lo { opacity: 0.7; }
  .pp { font-size: 10px; opacity: 0.85; }
</style>
