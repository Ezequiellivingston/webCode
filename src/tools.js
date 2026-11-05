// Parser de acciones (lo que responde ChatGPT) y ejecutor local.
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';

const BODY_TYPES = new Set(['write_file', 'edit_file']);
const LINE_TYPES = new Set(['run', 'read', 'list', 'done']);
const IGNORE = new Set([
  'node_modules',
  '.git',
  '.webcode',
  '.webcode-profile',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '.venv',
]);

/**
 * Formato esperado (dentro de un bloque de código o en texto plano):
 *   @@@ write_file ruta
 *   contenido...
 *   @@@ end
 *   @@@ run comando
 *   @@@ read ruta
 *   @@@ list ruta
 *   @@@ done mensaje
 */
export function parseActions(blocks, full) {
  const sources = blocks.some((b) => b.includes('@@@')) ? blocks : [full];
  const actions = [];

  for (const src of sources) {
    let cur = null;
    for (const line of src.replace(/\r/g, '').split('\n')) {
      if (cur) {
        // Tolera espacios al inicio (ChatGPT a veces indenta)
        if (/^\s*@@@\s+end\s*$/.test(line)) {
          actions.push(cur);
          cur = null;
        } else {
          cur.body.push(line);
        }
        continue;
      }
      const m = line.match(/^\s*@@@\s+(\w+)(?:\s+(.*))?$/);
      if (!m) continue;
      const type = m[1];
      const arg = (m[2] || '').trim();
      if (BODY_TYPES.has(type)) cur = { type, arg, body: [] };
      else if (LINE_TYPES.has(type)) actions.push({ type, arg });
      else actions.push({ type: 'unknown', arg: type });
    }
    if (cur) actions.push({ ...cur, truncated: true });
  }
  return actions;
}

function safePath(root, p) {
  if (!p) throw new Error('Falta la ruta');
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Ruta fuera del proyecto: ${p}`);
  return abs;
}

const ok = (output) => ({ ok: true, output });
const fail = (output) => ({ ok: false, output });

export async function listTree(root, rel = '.', maxDepth = 3, limit = 200) {
  const out = [];
  async function walk(dir, depth, prefix) {
    if (depth > maxDepth || out.length >= limit) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (IGNORE.has(e.name) || out.length >= limit) continue;
      out.push(prefix + e.name + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) await walk(path.join(dir, e.name), depth + 1, prefix + '  ');
    }
  }
  await walk(safePath(root, rel), 1, '');
  return out.length ? out.join('\n') : '(vacío)';
}

function runShell(cmd, cwd, timeout = 120000) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      let text = `${stdout || ''}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
      if (text.length > 6000) text = '...(recortado)...\n' + text.slice(-6000);
      const code = err ? (err.killed ? 'TIMEOUT' : err.code ?? 1) : 0;
      resolve({ ok: code === 0, output: `exit code: ${code}\n${text || '(sin salida)'}` });
    });
  });
}

export async function execute(a, ctx) {
  const { root, confirm, log } = ctx;
  try {
    switch (a.type) {
      case 'write_file': {
        if (a.truncated) return fail('Bloque truncado (falta "@@@ end"). Reenvía el archivo completo.');
        const p = safePath(root, a.arg);
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.writeFile(p, a.body.join('\n') + '\n', 'utf8');
        log(`  ✎ escrito ${a.arg} (${a.body.length} líneas)`);
        return ok(`Archivo escrito: ${a.arg} (${a.body.length} líneas)`);
      }

      case 'edit_file': {
        if (a.truncated) return fail('Bloque truncado (falta "@@@ end").');
        const p = safePath(root, a.arg);
        let content = await fs.readFile(p, 'utf8');
        const body = a.body.join('\n');
        const re = /<<<<<<< SEARCH\n([\s\S]*?)\n=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g;
        let m;
        let n = 0;
        while ((m = re.exec(body))) {
          const [, search, replace] = m;
          if (!content.includes(search)) return fail(`No encontré el texto a reemplazar en ${a.arg}:\n${search.slice(0, 300)}`);
          content = content.replace(search, () => replace);
          n++;
        }
        if (!n) return fail('Formato inválido: usa <<<<<<< SEARCH / ======= / >>>>>>> REPLACE');
        await fs.writeFile(p, content, 'utf8');
        log(`  ✎ editado ${a.arg} (${n} cambio/s)`);
        return ok(`Archivo editado: ${a.arg} (${n} cambio/s)`);
      }

      case 'read': {
        const p = safePath(root, a.arg);
        let c = await fs.readFile(p, 'utf8');
        if (c.length > 20000) c = c.slice(0, 20000) + '\n...(recortado)';
        log(`  📖 leído ${a.arg}`);
        return ok(c);
      }

      case 'list': {
        const t = await listTree(root, a.arg || '.');
        log(`  📂 listado ${a.arg || '.'}`);
        return ok(t);
      }

      case 'run': {
        if (!a.arg) return fail('Comando vacío');
        const yes = await confirm(`¿Ejecutar?  $ ${a.arg}`);
        if (!yes) return fail('El usuario rechazó ejecutar este comando.');
        log(`  ▶ $ ${a.arg}`);
        const r = await runShell(a.arg, root);
        log(`    ${r.ok ? '✔' : '✘'} ${r.output.split('\n')[0]}`);
        return r;
      }

      case 'unknown':
        return fail(`Acción desconocida: "${a.arg}". Usa solo write_file, edit_file, run, read, list, done.`);

      default:
        return fail(`Acción no soportada: ${a.type}`);
    }
  } catch (e) {
    return fail(`Error: ${e.message}`);
  }
}