// Lectura y troceo de specs grandes, sin depender del contexto de ChatGPT.
import fs from 'node:fs/promises';

export async function loadSpec(file) {
  const text = (await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '').replace(/\r/g, '');
  return { file, text, sections: splitSpec(text) };
}

// Divide por encabezados markdown y, si una sección es muy grande, por tamaño.
export function splitSpec(text, { maxChars = 4000 } = {}) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  const raw = [];
  let cur = { title: 'Introducción', lines: [] };
  const push = () => {
    const body = cur.lines.join('\n').trim();
    if (body) raw.push({ title: cur.title, text: body });
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      push();
      cur = { title: m[2].trim(), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  push();

  const out = [];
  for (const s of raw) {
    const parts = s.text.length > maxChars ? chunkText(s.text, maxChars) : [s.text];
    parts.forEach((p, i) => {
      out.push({
        id: out.length,
        title: parts.length > 1 ? `${s.title} (parte ${i + 1})` : s.title,
        text: p,
      });
    });
  }
  return out;
}

function chunkText(text, maxChars) {
  const paras = text.split(/\n{2,}/);
  const parts = [];
  let cur = '';
  for (const p of paras) {
    if (cur && (cur + '\n\n' + p).length > maxChars) {
      parts.push(cur);
      cur = p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
    while (cur.length > maxChars) {
      parts.push(cur.slice(0, maxChars));
      cur = cur.slice(maxChars);
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'una', 'uno', 'unos', 'unas', 'los', 'las',
  'del', 'que', 'con', 'por', 'para', 'como', 'más', 'pero', 'sus', 'este', 'esta', 'entre', 'sobre',
  'ser', 'debe', 'deben', 'cada', 'todo', 'todos',
]);

function tokens(text) {
  return (text.toLowerCase().match(/[a-záéíóúñ0-9_./-]{3,}/gi) || []).filter((w) => !STOP.has(w));
}

// Elige las secciones más relevantes para una consulta, con tope de caracteres.
export function retrieveSections(sections, query, maxChars = 8000) {
  const q = new Set(tokens(query));
  const scored = sections.map((s) => {
    let score = 0;
    for (const t of tokens(s.title)) if (q.has(t)) score += 3;
    for (const t of tokens(s.text.slice(0, 3000))) if (q.has(t)) score += 1;
    return { s, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  let total = 0;
  for (const { s, score } of scored) {
    if (score === 0 && picked.length) continue;
    if (picked.length && total + s.text.length > maxChars) continue;
    picked.push(s);
    total += s.text.length;
    if (total >= maxChars) break;
  }
  if (!picked.length && sections.length) picked.push(sections[0]);
  return picked;
}

// Lista compacta de títulos (y opcionalmente el inicio de cada sección).
export function specOutline(sections, perSection = 0, limit = 120) {
  return sections
    .slice(0, limit)
    .map((s) => (perSection > 0 ? `## ${s.title}\n${s.text.slice(0, perSection)}` : `- ${s.title}`))
    .join('\n');
}
