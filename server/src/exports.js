// File exports the model can hand the user: real .pptx decks (opens in
// PowerPoint, LibreOffice, or Google Slides via upload — the self-hosted
// answer to "make me a slideshow") and .csv data files. Files land in
// data/exports/<userId>/ and are served back through an ownership-checked
// route; the chat shows a `file` widget with a download button.
import { mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pptxgen from 'pptxgenjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EXPORT_DIR = process.env.EXPORT_DIR ?? join(ROOT, 'data', 'exports');

const ACCENT = 'C89968'; // the DuckPond warm gold, minus the #
const INK = '2B2723';
const DIM = '6F695E';

const safeName = (s, fallback) =>
  (String(s ?? '').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-zA-Z0-9-_ ]+/g, '').trim()
    .replace(/\s+/g, '-').slice(0, 60) || fallback);

function exportPath(userId, base, ext) {
  const dir = join(EXPORT_DIR, String(userId));
  mkdirSync(dir, { recursive: true });
  const file = `${base}-${Date.now().toString(36)}${ext}`;
  return { dir, file, full: join(dir, file), url: `/api/exports/${userId}/${file}` };
}

// spec: { title, subtitle?, slides: [{ title, bullets?: string[], notes? }] }
export async function buildPptx(userId, spec) {
  const slides = Array.isArray(spec.slides) ? spec.slides.slice(0, 40) : [];
  if (!slides.length) throw new Error('generate_slides needs a slides array');
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_16x9';
  pres.author = 'DuckPond';
  pres.title = spec.title ?? 'Presentation';

  // title slide
  const t = pres.addSlide();
  t.background = { color: 'FBF7F0' };
  t.addShape('rect', { x: 0, y: 4.55, w: 10, h: 0.16, fill: { color: ACCENT } });
  t.addText(String(spec.title ?? 'Presentation'), {
    x: 0.6, y: 1.7, w: 8.8, h: 1.4, fontSize: 40, bold: true, color: INK, fontFace: 'Arial',
  });
  if (spec.subtitle) {
    t.addText(String(spec.subtitle), { x: 0.62, y: 3.0, w: 8.8, h: 0.7, fontSize: 18, color: DIM, fontFace: 'Arial' });
  }

  for (const sl of slides) {
    const s = pres.addSlide();
    s.background = { color: 'FFFFFF' };
    s.addText(String(sl.title ?? ''), {
      x: 0.55, y: 0.35, w: 9, h: 0.85, fontSize: 27, bold: true, color: INK, fontFace: 'Arial',
    });
    s.addShape('rect', { x: 0.6, y: 1.18, w: 1.5, h: 0.07, fill: { color: ACCENT } });
    const bullets = (sl.bullets ?? []).slice(0, 12).map((b) => ({
      text: String(b),
      options: { bullet: { code: '2022', indent: 14 }, fontSize: 16, color: INK, fontFace: 'Arial', paraSpaceAfter: 8 },
    }));
    if (bullets.length) s.addText(bullets, { x: 0.75, y: 1.5, w: 8.6, h: 3.7, valign: 'top' });
    if (sl.notes) s.addNotes(String(sl.notes));
  }

  const p = exportPath(userId, safeName(spec.title, 'slides'), '.pptx');
  await pres.writeFile({ fileName: p.full });
  const size = (await stat(p.full)).size;
  return { name: p.file, url: p.url, size, kind: 'pptx', slides: slides.length + 1 };
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// spec: { name?, columns: string[], rows: string[][] }
export async function buildCsv(userId, spec) {
  const cols = Array.isArray(spec.columns) ? spec.columns : [];
  const rows = Array.isArray(spec.rows) ? spec.rows.slice(0, 5000) : [];
  if (!cols.length || !rows.length) throw new Error('export_csv needs columns and rows');
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push((Array.isArray(r) ? r : [r]).map(csvCell).join(','));
  const p = exportPath(userId, safeName(spec.name, 'data'), '.csv');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(p.full, lines.join('\n') + '\n', 'utf8');
  const size = (await stat(p.full)).size;
  return { name: p.file, url: p.url, size, kind: 'csv', rows: rows.length };
}
