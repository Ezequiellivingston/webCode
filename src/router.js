// Router heurístico: elige el proveedor que mejor encaja con la tarea y el contexto.
// No es magia: combina palabras clave de la tarea con el tamaño del contexto real.

export const PROVIDER_ORDER = ['chatgpt', 'gemini', 'claude', 'deepseek'];

const SIGNALS = [
  {
    tag: 'code',
    re: /\b(api|endpoint|funci[oó]n|componente|react|vue|angular|node|python|typescript|javascript|java|c#|php|sql|docker|backend|frontend|cli|script|programa)\b/i,
    points: { claude: 2, chatgpt: 2, deepseek: 2, gemini: 1 },
  },
  {
    tag: 'refactor',
    re: /refactor|reestructur|migrar|migraci[oó]n|optimiz|limpiar c[oó]digo|deuda t[eé]cnica/i,
    points: { claude: 3, chatgpt: 2, gemini: 1, deepseek: 1 },
  },
  {
    tag: 'debug',
    re: /\b(bug|error|falla|fallo|arregl|correg|debug|excepci[oó]n|exception|stack ?trace|no funciona)\b/i,
    points: { chatgpt: 2, claude: 2, deepseek: 1, gemini: 1 },
  },
  {
    tag: 'tests',
    re: /\b(test|tests|prueba|pruebas|testing|jest|vitest|pytest|coverage|cobertura)\b/i,
    points: { chatgpt: 3, claude: 3, deepseek: 1 },
  },
  {
    tag: 'planning',
    re: /arquitectura|architecture|dise[nñ]|plan|roadmap|estructura del proyecto|organizar/i,
    points: { claude: 2, gemini: 2, chatgpt: 1 },
  },
  {
    tag: 'docs',
    re: /documentaci[oó]n|readme|explic|redact|escribir (un|el) (texto|art[ií]culo)|gu[ií]a|tutorial/i,
    points: { claude: 3, chatgpt: 1 },
  },
  {
    tag: 'reasoning',
    re: /razon|algoritm|matem[aá]tic|math|complejidad|por qu[eé]|analiz|demuestra|l[oó]gica|optimizaci[oó]n/i,
    points: { deepseek: 3, chatgpt: 1, claude: 1 },
  },
  {
    tag: 'ui',
    re: /landing|css|html|tailwind|dise[nñ]o web|responsive|animaci[oó]n|interfaz|\bui\b|\bux\b/i,
    points: { gemini: 2, claude: 1, chatgpt: 1 },
  },
  {
    tag: 'data',
    re: /base de datos|database|\bsql\b|postgres|mysql|mongo|consulta|query/i,
    points: { deepseek: 2, chatgpt: 1, claude: 1 },
  },
  {
    tag: 'devops',
    re: /docker|kubernetes|ci\/cd|deploy|despliegue|github actions|terraform/i,
    points: { chatgpt: 1, claude: 1, gemini: 1 },
  },
];

export function analyzeTask({ task = '', specText = '', tree = '', messageChars = 0 } = {}) {
  const text = `${task}\n${specText}`;
  const tags = [];
  const points = Object.fromEntries(PROVIDER_ORDER.map((p) => [p, 0]));

  for (const s of SIGNALS) {
    if (s.re.test(text)) {
      tags.push(s.tag);
      for (const [p, n] of Object.entries(s.points)) points[p] += n;
    }
  }

  const estimated = tree.length + specText.length + messageChars;
  let sizeNote = '';
  if (estimated > 400000) {
    points.gemini += 8;
    points.claude += 2;
    sizeNote = 'contexto enorme (>400k)';
  } else if (estimated > 150000) {
    points.gemini += 5;
    points.claude += 1;
    sizeNote = 'contexto grande (>150k)';
  } else if (estimated > 60000) {
    points.gemini += 2;
    sizeNote = 'contexto mediano (>60k)';
  }
  if (specText) {
    points.gemini += 2;
    points.claude += 1;
    tags.push('spec');
  }

  return { tags, points, estimated, sizeNote };
}

export function chooseProviders({ task, specText, tree, messageChars, candidates } = {}) {
  const allowed = (candidates && candidates.length ? candidates : PROVIDER_ORDER).filter((p) =>
    PROVIDER_ORDER.includes(p)
  );
  const analysis = analyzeTask({ task, specText, tree, messageChars });
  const order = [...allowed].sort(
    (a, b) => analysis.points[b] - analysis.points[a] || PROVIDER_ORDER.indexOf(a) - PROVIDER_ORDER.indexOf(b)
  );

  const parts = [];
  if (analysis.tags.length) parts.push(`tarea: ${[...new Set(analysis.tags)].join(', ')}`);
  if (analysis.sizeNote) parts.push(analysis.sizeNote);
  if (!parts.length) parts.push('sin señales fuertes, orden por preferencia');

  return {
    order,
    primary: order[0],
    reason: `${parts.join(' · ')} → ${order[0]}`,
    analysis,
  };
}
