<script>
  import { wmo, WEATHER_BG, dayName } from '../../lib/weather.js';
  import WeatherIcon from './WeatherIcon.svelte';

  let { data } = $props();
  const now = $derived(wmo(data.current.code, data.current.isDay));
  const bg = $derived(WEATHER_BG[now.theme] ?? WEATHER_BG.cloud);
  const u = $derived(data.units ?? { temp: '°', wind: 'km/h' });

  // which animated effects to layer in, from the icon/theme
  const isNight = $derived(now.theme.endsWith('-night') || now.icon === 'moon');
  const fx = $derived({
    sun: now.icon === 'sun' && !isNight,
    stars: isNight,
    clouds: ['partly', 'cloud', 'rain', 'drizzle', 'thunder', 'fog'].includes(now.icon),
    rain: now.icon === 'rain' || now.icon === 'drizzle',
    snow: now.icon === 'snow',
    thunder: now.icon === 'thunder',
    fog: now.icon === 'fog',
  });

  const rnd = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const drops = rnd(26, () => ({ l: Math.random() * 100, d: Math.random() * 1.2, t: 0.5 + Math.random() * 0.4 }));
  const flakes = rnd(20, () => ({ l: Math.random() * 100, d: Math.random() * 4, t: 4 + Math.random() * 4, x: (Math.random() * 20 - 10) }));
  const stars = rnd(22, () => ({ l: Math.random() * 100, o: Math.random() * 55, d: Math.random() * 3, t: 1.6 + Math.random() * 2, s: 1 + Math.random() * 1.6 }));
</script>

<div class="weather" style:background={bg} class:night={isNight}>
  <div class="fx" aria-hidden="true">
    {#if fx.sun}<div class="rays"></div><div class="glow"></div>{/if}
    {#if fx.stars}
      {#each stars as s, i (i)}
        <span class="star" style="left:{s.l}%;top:{s.o}%;width:{s.s}px;height:{s.s}px;animation-delay:{s.d}s;animation-duration:{s.t}s"></span>
      {/each}
    {/if}
    {#if fx.clouds}
      <div class="cloud c1"></div><div class="cloud c2"></div><div class="cloud c3"></div>
    {/if}
    {#if fx.fog}<div class="fogband f1"></div><div class="fogband f2"></div>{/if}
    {#if fx.rain}
      {#each drops as p, i (i)}
        <span class="drop" style="left:{p.l}%;animation-delay:{p.d}s;animation-duration:{p.t}s"></span>
      {/each}
    {/if}
    {#if fx.snow}
      {#each flakes as p, i (i)}
        <span class="flake" style="left:{p.l}%;--x:{p.x}px;animation-delay:{p.d}s;animation-duration:{p.t}s"></span>
      {/each}
    {/if}
    {#if fx.thunder}<div class="flash"></div>{/if}
  </div>

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
  .weather {
    position: relative; overflow: hidden;
    margin: 10px 0; max-width: 460px;
    border-radius: 16px; padding: 16px 18px 14px;
    color: #fff; box-shadow: var(--shadow-lg);
    text-shadow: 0 1px 2px rgba(0,0,0,0.28);
  }
  .content { position: relative; z-index: 2; }
  .fx { position: absolute; inset: 0; z-index: 1; pointer-events: none; }

  /* sun */
  .glow { position: absolute; top: -40px; right: -30px; width: 160px; height: 160px;
    background: radial-gradient(circle, rgba(255,240,190,0.55), transparent 65%); }
  .rays { position: absolute; top: -70px; right: -60px; width: 220px; height: 220px;
    background: repeating-conic-gradient(from 0deg, rgba(255,244,200,0.16) 0deg 8deg, transparent 8deg 22deg);
    border-radius: 50%; animation: spin 60s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* stars */
  .star { position: absolute; background: #fff; border-radius: 50%; opacity: 0.5;
    animation: twinkle linear infinite; }
  @keyframes twinkle { 0%,100% { opacity: 0.2; } 50% { opacity: 0.95; } }

  /* clouds */
  .cloud { position: absolute; background: rgba(255,255,255,0.16); border-radius: 40px;
    filter: blur(2px); animation: drift linear infinite; }
  .cloud::before, .cloud::after { content: ''; position: absolute; background: inherit; border-radius: 50%; }
  .c1 { width: 90px; height: 26px; top: 14px; left: -30%; animation-duration: 34s; }
  .c1::before { width: 42px; height: 42px; top: -18px; left: 14px; }
  .c1::after { width: 30px; height: 30px; top: -12px; left: 48px; }
  .c2 { width: 70px; height: 20px; top: 50px; left: -30%; animation-duration: 46s; animation-delay: -8s; opacity: 0.8; }
  .c2::before { width: 32px; height: 32px; top: -14px; left: 12px; }
  .c3 { width: 110px; height: 30px; top: 30px; left: -40%; animation-duration: 58s; animation-delay: -20s; opacity: 0.6; }
  .c3::before { width: 46px; height: 46px; top: -20px; left: 18px; }
  @keyframes drift { to { transform: translateX(560px); } }

  /* fog */
  .fogband { position: absolute; left: -20%; width: 140%; height: 22px; background: rgba(255,255,255,0.14);
    filter: blur(6px); animation: fogmove linear infinite; }
  .f1 { top: 40%; animation-duration: 22s; }
  .f2 { top: 62%; animation-duration: 30s; animation-delay: -6s; opacity: 0.7; }
  @keyframes fogmove { from { transform: translateX(-40px); } to { transform: translateX(40px); } }

  /* rain */
  .drop { position: absolute; top: -12%; width: 2px; height: 14px; border-radius: 2px;
    background: linear-gradient(transparent, rgba(200,225,255,0.75)); animation: fall linear infinite; }
  @keyframes fall { to { transform: translateY(320px); } }

  /* snow */
  .flake { position: absolute; top: -8%; width: 5px; height: 5px; border-radius: 50%;
    background: rgba(255,255,255,0.9); animation: snowfall linear infinite; }
  @keyframes snowfall { to { transform: translate(var(--x), 300px); } }

  /* thunder */
  .flash { position: absolute; inset: 0; background: rgba(255,255,255,0.85); opacity: 0;
    animation: flash 6s linear infinite; }
  @keyframes flash { 0%,92%,100% { opacity: 0; } 93% { opacity: 0.6; } 94% { opacity: 0.1; } 95% { opacity: 0.5; } 96% { opacity: 0; } }

  @media (prefers-reduced-motion: reduce) {
    .rays, .star, .cloud, .fogband, .drop, .flake, .flash { animation: none; }
  }

  .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
  .place { font-size: 15px; font-weight: 600; }
  .cond { font-size: 12.5px; opacity: 0.9; margin-top: 1px; }
  .mid { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin: 8px 0 14px; }
  .temp { font-size: 46px; font-weight: 300; line-height: 1; }
  .deg { font-size: 20px; font-weight: 400; opacity: 0.85; margin-left: 2px; }
  .meta { display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; opacity: 0.92; text-align: right; }
  .days { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px;
    padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.18); }
  .day { display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .dn { font-size: 11px; opacity: 0.9; }
  .dt { font-size: 11.5px; }
  .dt .lo { opacity: 0.7; }
  .pp { font-size: 10px; opacity: 0.85; }
</style>
