// Five useful visual outputs remain model-facing. Historical widget objects
// are already stored in messages and rendered by the browser's lazy fallback.
import { randomUUID } from 'node:crypto';

const widget = (type, data) => ({ type, id: `w_${randomUUID().slice(0, 8)}`, v: 1, data });

export function makeTableWidget({ title, columns, rows }) {
  const cols = (Array.isArray(columns) ? columns : []).map((c) => String(c)).slice(0, 8);
  const rs = (Array.isArray(rows) ? rows : []).slice(0, 50)
    .map((r) => (Array.isArray(r) ? r : cols.map((c) => r?.[c]))
      .map((v) => (v == null ? '' : String(v))).slice(0, cols.length));
  if (!cols.length || !rs.length) throw new Error('table needs columns and rows');
  return widget('table', { title: title ? String(title) : null, columns: cols, rows: rs });
}

export function makeMermaidWidget({ code, title }) {
  const src = String(code || '').trim();
  if (!src) throw new Error('mermaid needs diagram source');
  return widget('mermaid', { code: src.slice(0, 8000), title: title ? String(title) : null });
}

const CHART_KINDS = new Set(['bar', 'line', 'area', 'pie', 'donut', 'scatter']);
export function makeChartWidget({ kind = 'bar', title, labels, series, values, name, x_label, y_label }) {
  const k = CHART_KINDS.has(kind) ? kind : 'bar';
  const labs = (Array.isArray(labels) ? labels : []).map((l) => String(l)).slice(0, 30);
  let ser;
  if (Array.isArray(series) && series.length) {
    ser = series.slice(0, 8).map((s, i) => ({
      name: String(s.name ?? `Series ${i + 1}`),
      values: (Array.isArray(s.values) ? s.values : []).map(Number)
        .map((v) => (Number.isFinite(v) ? v : 0)).slice(0, 30),
    }));
  } else {
    ser = [{ name: String(name ?? title ?? ''), values: (Array.isArray(values) ? values : []).map(Number)
      .map((v) => (Number.isFinite(v) ? v : 0)).slice(0, 30) }];
  }
  if (!ser.some((s) => s.values.length)) throw new Error('chart needs numeric values');
  return widget('chart', { kind: k, title: title ? String(title) : null, labels: labs, series: ser,
    xLabel: x_label ?? null, yLabel: y_label ?? null });
}

export function makeFileWidget({ name, url, size, kind, detail }) {
  return widget('file', { name, url, size, kind, detail });
}
