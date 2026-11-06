#!/usr/bin/env node
// webcode: agente tipo OpenCode que usa la web de ChatGPT (Puppeteer) en vez de una API.
import readline from 'node:readline/promises';
import path from 'node:path';
import os from 'node:os';
import { ProviderManager, normalizeProvider, PROVIDERS } from './provider.js';
import { chooseProviders, PROVIDER_ORDER } from './router.js';
import { probeProviders } from './probe.js';
import { parseActions, execute, listTree } from './tools.js';
import {
  buildFirstMessage,
  buildTaskMessage,
  buildResults,
  buildNoActions,
  buildResumeMessage,
} from './prompt.js';
import { runAgent } from './agent.js';
import { loadSpec, specOutline } from './spec.js';
import { loadState, saveState } from './state.js';

const MAX_STEPS = 40;
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

// ---- argumentos ----
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};

if (flag('--help') || flag('-h')) {
  console.log(`webcode - agente de programación vía ChatGPT/Gemini/DeepSeek web

Uso: webcode [opciones] ["tarea inicial"]

  --dir <ruta>       Directorio del proyecto (por defecto: el actual)
  --provider <p>     chatgpt | gemini | claude | deepseek | auto (por defecto: auto)
  --fallback <p>     Respaldo automático, separados por coma (por defecto el orden del router; "none" para desactivar)
  --connect <url>    Conectarse a un Chrome ya abierto (ej. http://127.0.0.1:9222)
  --profile <ruta>   Perfil de Chrome persistente (por defecto: ~/.webcode-profile)
  --yes, -y          Ejecutar comandos sin pedir confirmación (sin -y se pregunta una sola vez)
  --url <url>        URL del proveedor principal (por defecto según el proveedor)
  --rotate-after <n> Abrir un chat nuevo cada N pasos (por defecto: 25)
  --max-chars <n>    Abrir un chat nuevo al superar N caracteres enviados (por defecto: 50000)
  --max-message <n>  Recortar cada mensaje a N caracteres (por defecto: 16000)
  --busy-wait <s>    Espera ante avisos temporales del proveedor (por defecto: 65)
  --busy-retries <n> Reintentos ante avisos temporales (por defecto: 3)
  --probe            Verificar selectores/login de los proveedores y salir
  --probe-wait <s>   Espera máxima por proveedor en --probe (por defecto: 20)
  --spec <archivo>   Construir el proyecto desde un spec grande (usa varios chats)
  --parallel <n>     Chats en paralelo con --spec (por defecto: 2)
  --resume           Retomar un --spec desde .webcode/state.json

Comandos: /new (chat nuevo), /status (estado), /exit
`);
  process.exit(0);
}

const root = path.resolve(opt('--dir', process.cwd()));
let autoYes = flag('--yes') || flag('-y');
const profileDir = path.resolve(opt('--profile', path.join(os.homedir(), '.webcode-profile')));
const connect = opt('--connect');
const url = opt('--url');
const valueFlags = new Set([
  '--dir',
  '--provider',
  '--fallback',
  '--connect',
  '--profile',
  '--url',
  '--rotate-after',
  '--max-chars',
  '--max-message',
  '--busy-wait',
  '--busy-retries',
  '--probe-wait',
  '--spec',
  '--parallel',
]);
const initialTask = args.filter((a, i) => !a.startsWith('-') && !valueFlags.has(args[i - 1])).join(' ').trim();

const intOpt = (name, def) => {
  const v = Number(opt(name, def));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
};
const rotateAfter = intOpt('--rotate-after', 25);
const maxChars = intOpt('--max-chars', 50000);
const maxMessage = intOpt('--max-message', 16000);
const busyWaitMs = intOpt('--busy-wait', 65) * 1000;
const busyRetries = intOpt('--busy-retries', 3);
const specArg = opt('--spec');
const parallel = intOpt('--parallel', 2);
const resumeMode = flag('--resume');

// ---- proveedor principal (explícito o router automático) ----
const rawFallbackArg = opt('--fallback', '');
const explicitFallback = args.includes('--fallback');
const parseFallback = (raw) => {
  const s = String(raw || '').trim();
  return /^(none|off|no|-)$/i.test(s) ? '' : s;
};

const providerArg = String(opt('--provider', 'auto')).trim();
const autoProvider = /^(auto|)$/i.test(providerArg);

let provider;
let fallback = '';
let route = null;

if (autoProvider) {
  let specText = '';
  if (specArg) {
    try {
      specText = (await loadSpec(path.resolve(specArg))).text;
    } catch {}
  }
  let tree = '';
  try {
    tree = await listTree(root);
  } catch {}
  route = chooseProviders({ task: initialTask, specText, tree, messageChars: maxMessage });
  provider = route.primary;
  fallback = explicitFallback ? parseFallback(rawFallbackArg) : route.order.slice(1).join(',');
} else {
  try {
    provider = normalizeProvider(providerArg);
  } catch (e) {
    console.error(c.red(e.message));
    process.exit(1);
  }
  fallback = explicitFallback
    ? parseFallback(rawFallbackArg)
    : PROVIDER_ORDER.find((n) => n !== provider) || '';
}

if (flag('--probe')) {
  let list;
  try {
    const parsedFallback = parseFallback(fallback);
    const extra = parsedFallback
      ? parsedFallback
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map(normalizeProvider)
      : [];
    list = explicitFallback
      ? [...new Set([provider, ...extra])]
      : autoProvider
        ? route.order
        : [provider];
  } catch (e) {
    console.error(c.red(e.message));
    process.exit(1);
  }
  const ok = await probeProviders({
    providers: list,
    connect,
    profileDir,
    url,
    waitMs: intOpt('--probe-wait', 20) * 1000,
  });
  process.exit(ok ? 0 : 1);
}

function compactMessage(message, maxLen = maxMessage) {
  if (message.length <= maxLen) return message;
  const note = '\n\n[...recortado por límite de longitud...]\n\n';
  const head = Math.floor(maxLen * 0.7);
  const tail = Math.max(0, maxLen - head - note.length);
  return message.slice(0, head) + note + (tail ? message.slice(-tail) : '');
}

// ---- main ----
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let confirmChain = Promise.resolve();
const confirm = (q) => {
  const run = async () => {
    if (autoYes) return true;
    const a = (await rl.question(c.cyan(`? ${q} [s/N] `))).trim().toLowerCase();
    const yes = ['s', 'si', 'sí', 'y', 'yes'].includes(a);
    // Si aceptás una vez, no volvemos a preguntar durante esta sesión.
    if (yes) {
      autoYes = true;
      console.log(c.dim('  (aprobado: no volveré a pedir confirmación en esta sesión)'));
    }
    return yes;
  };
  const p = confirmChain.then(run, run);
  confirmChain = p.catch(() => {});
  return p;
};
const log = (s) => console.log(s);

console.log(c.bold('webcode') + c.dim(`  · proyecto: ${root}`));
const providerLabel = PROVIDERS[provider].label;
if (route) console.log(c.dim(`Router: ${route.reason}`));
console.log(c.dim(`Abriendo ${providerLabel} en el navegador...`));
if (fallback) console.log(c.dim(`Cadena de respaldo: ${fallback}`));

let gpt;
try {
  gpt = await ProviderManager.open({
    provider,
    fallback,
    connect,
    profileDir,
    url,
    busyWaitMs,
    busyRetries,
    allowPrimaryLoginWait: !autoProvider,
  });
} catch (e) {
  console.error(c.red(`No pude abrir ${providerLabel}: ` + e.message));
  console.error(c.dim('Probá con --provider <chatgpt|gemini|claude|deepseek> o iniciá sesión en el proveedor.'));
  process.exit(1);
}

let firstTurn = true;
let autoRouted = !autoProvider || Boolean(initialTask || specArg);
const changed = new Set();
let lastResults = [];
let sentChars = 0;
let stepsSinceRotate = 0;

const shutdown = async () => {
  rl.close();
  await gpt.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);

async function resumeMessage(task, next) {
  const tree = await listTree(root);
  // Si "next" ya es el prompt inicial completo, no lo dupliques.
  const pending = next.includes('REGLAS IMPORTANTES') ? '' : next;
  return buildResumeMessage(task, root, tree, {
    changed: [...changed],
    lastResults,
    next: pending,
  });
}

async function send(message, task, { forceRotate = false } = {}) {
  const needRotate =
    forceRotate || stepsSinceRotate >= rotateAfter || (sentChars >= maxChars && stepsSinceRotate >= 2);

  if (needRotate) {
    const resume = compactMessage(await resumeMessage(task, message));
    console.log(
      c.dim(`↻ Abriendo chat nuevo con el contexto (${stepsSinceRotate} pasos, ${sentChars} caracteres)...`)
    );
    await gpt.newChat();
    firstTurn = false;
    stepsSinceRotate = 0;
    sentChars = 0;
    const reply = await gpt.ask(resume);
    sentChars += resume.length;
    return reply;
  }

  const outbound = compactMessage(message);
  if (outbound !== message) {
    console.log(c.dim(`   (mensaje recortado a ${outbound.length} caracteres)`));
  }
  const reply = await gpt.ask(outbound);
  sentChars += outbound.length;
  return reply;
}

async function runTask(task) {
  // En modo interactivo sin tarea inicial, el router decide con la primera tarea.
  if (autoProvider && !autoRouted) {
    autoRouted = true;
    const r = chooseProviders({ task, tree: await listTree(root), messageChars: maxMessage });
    console.log(c.dim(`Router: ${r.reason}`));
    if (r.primary !== gpt.name) {
      try {
        await gpt.switchTo(r.primary);
        firstTurn = true;
        changed.clear();
        lastResults = [];
        sentChars = 0;
        stepsSinceRotate = 0;
      } catch (e) {
        console.log(c.dim(`Router: no pude usar ${PROVIDERS[r.primary].label} (${e.message}); sigo con ${gpt.label}.`));
      }
    }
  }

  let message = firstTurn
    ? buildFirstMessage(task, root, await listTree(root))
    : buildTaskMessage(task);
  firstTurn = false;
  let emptyReplies = 0;

  for (let step = 1; step <= MAX_STEPS; step++) {
    stepsSinceRotate++;
    console.log(c.dim(`\n[paso ${step}] → enviando a ${gpt.label} y esperando respuesta...`));

    let reply;
    let rotated = false;
    try {
      reply = await send(message, task);
    } catch (e) {
      if (e.code === 'TOO_LONG') {
        console.log(c.dim(`↻ ${e.message}`));
        const shorter = compactMessage(message, Math.floor(maxMessage * 0.6));
        if (shorter === message) {
          console.log(c.red('✘ No pude acortar más el mensaje.'));
          return;
        }
        console.log(c.dim(`   Reenviando versión recortada (${shorter.length} caracteres)...`));
        try {
          reply = await gpt.ask(shorter);
          sentChars += shorter.length;
        } catch (e2) {
          console.log(c.red('✘ ' + e2.message));
          return;
        }
      } else if (['COMPOSER', 'SEND', 'RESPONSE', 'DOM'].includes(e.code)) {
        console.log(c.dim(`↻ ${e.message}`));
        console.log(c.dim('   Reintentando en un chat nuevo con el contexto...'));
        try {
          reply = await send(message, task, { forceRotate: true });
          rotated = true;
        } catch (e2) {
          console.log(c.red('✘ ' + e2.message));
          return;
        }
      } else if (e.code === 'BUSY') {
        console.log(c.red('✘ ' + e.message));
        console.log(c.dim('   El proveedor pidió esperar. Probá de nuevo en unos minutos o usá --fallback gemini.'));
        return;
      } else {
        console.log(c.red('✘ ' + e.message));
        return;
      }
    }

    // El proveedor avisó que la conversación llegó a su límite: rotar una vez.
    if (reply.limit) {
      if (rotated) {
        console.log(c.red('✘ El proveedor sigue rechazando mensajes (límite de uso/cuota). Probá más tarde.'));
        return;
      }
      console.log(c.dim('↻ El proveedor indicó límite de contexto; abriendo chat nuevo...'));
      try {
        reply = await send(message, task, { forceRotate: true });
      } catch (e2) {
        console.log(c.red('✘ ' + e2.message));
        return;
      }
      if (reply.limit) {
        console.log(c.red('✘ El proveedor sigue rechazando mensajes (límite de uso/cuota). Probá más tarde.'));
        return;
      }
    }

    if (reply.prose) console.log('\n' + c.cyan(gpt.label + ': ') + reply.prose.slice(0, 1200));

    const actions = parseActions(reply.blocks, reply.full);
    if (!actions.length) {
      if (++emptyReplies > 2) {
        console.log(c.red('✘ El proveedor no devolvió acciones válidas. Abortando tarea.'));
        return;
      }
      message = buildNoActions();
      continue;
    }
    emptyReplies = 0;

    const results = [];
    let finished = false;
    for (const a of actions) {
      if (a.type === 'done') {
        // Si alguna acción de esta misma respuesta falló, no damos la tarea por terminada:
        // los errores vuelven al proveedor para que los corrija.
        if (results.some((r) => !r.ok)) {
          console.log(c.dim('  (ignoro "done": hubo acciones con error)'));
          break;
        }
        console.log('\n' + c.green('✔ Listo: ') + (a.arg || 'Tarea completada.'));
        finished = true;
        break;
      }
      const r = await execute(a, { root, confirm, log });
      if (r.ok && (a.type === 'write_file' || a.type === 'edit_file')) changed.add(a.arg);
      results.push({ label: `${a.type} ${a.arg}`.trim(), ...r });
    }
    lastResults = results;
    if (finished) return;

    message = buildResults(results);
  }
  console.log(c.red(`✘ Se alcanzó el máximo de ${MAX_STEPS} pasos.`));
}

async function runSpec(specPath, baseTask) {
  const spec = await loadSpec(specPath);
  console.log(c.bold('\nspec') + c.dim(` · ${specPath} · ${spec.sections.length} secciones`));

  let state = resumeMode ? await loadState(root) : null;
  if (!state || state.specFile !== specPath) {
    state = { task: baseTask, specFile: specPath, done: [], files: [], summaries: [] };
  }
  state.task = state.task || baseTask;

  const pending = spec.sections.filter((s) => !state.done.includes(s.id));
  if (!pending.length) {
    console.log(c.green('✔ El spec ya estaba completo según .webcode/state.json.'));
    return;
  }

  const titles = specOutline(spec.sections, 0, 120);
  const n = Math.max(1, Math.min(parallel, pending.length));
  const workers = [];
  if (n === 1) {
    // Un solo worker: aprovechamos la pestaña ya abierta.
    workers.push(gpt);
  } else {
    for (let i = 0; i < n; i++) {
      console.log(c.dim(`Abriendo worker ${i + 1}...`));
      workers.push(await gpt.spawnWorker());
    }
  }
  console.log(c.dim(`Secciones pendientes: ${pending.length} · chats en paralelo: ${workers.length}`));

  const fileLocks = new Map();
  const withFileLock = async (file, fn) => {
    const key = path.resolve(root, file);
    const prev = fileLocks.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((r) => (release = r));
    fileLocks.set(key, prev.then(() => gate));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  };

  let runChain = Promise.resolve();
  const withRunLock = (fn) => {
    const p = runChain.then(fn, fn);
    runChain = p.catch(() => {});
    return p;
  };

  let saveChain = Promise.resolve();
  const persist = () => {
    saveChain = saveChain.then(() => saveState(root, state)).catch(() => {});
    return saveChain;
  };

  const executeAction = (a) => {
    const ctx = { root, confirm, log };
    if (a.type === 'write_file' || a.type === 'edit_file') return withFileLock(a.arg, () => execute(a, ctx));
    if (a.type === 'run') return withRunLock(() => execute(a, ctx));
    return execute(a, ctx);
  };

  let next = 0;
  const failures = [];
  await Promise.all(
    workers.map(async (worker, wi) => {
      while (true) {
        const idx = next++;
        if (idx >= pending.length) break;
        const section = pending[idx];
        const label = `[w${wi + 1}] ${section.title}`;
        console.log(c.dim(`\n${label} → trabajando...`));
        const sectionTask =
          `${state.task}\n\n[SECCIONES DEL PROYECTO]\n${titles}\n\n` +
          `Implementá esta parte del spec: "${section.title}". Si no aplica al código, respondé "@@@ done (no aplica)".`;
        try {
          const res = await runAgent({
            gpt: worker,
            task: sectionTask,
            root,
            spec: section.text,
            state,
            confirm,
            log,
            executeAction,
            maxSteps: MAX_STEPS,
            rotateAfter,
            maxChars,
            maxMessage,
          });
          if (res.ok) {
            state.done.push(section.id);
            state.files = [...new Set([...(state.files || []), ...res.files])];
            state.summaries.push({ title: section.title, summary: res.summary });
            console.log(c.green(`✔ ${label}: ${res.summary}`));
          } else {
            failures.push(section);
            state.summaries.push({ title: section.title, summary: `INCOMPLETO: ${res.summary}` });
            console.log(c.red(`✘ ${label}: ${res.summary}`));
          }
        } catch (e) {
          failures.push(section);
          state.summaries.push({ title: section.title, summary: `ERROR: ${e.message}` });
          console.log(c.red(`✘ ${label}: ${e.message}`));
        }
        await persist();
      }
    })
  );

  if (!failures.length) {
    console.log(c.dim('\nVerificación final...'));
    const doneList = state.summaries
      .map((s) => `- ${s.title}: ${s.summary}`)
      .join('\n')
      .slice(0, 4000);
    try {
      const res = await runAgent({
        gpt: workers[0],
        task:
          'Verificá el proyecto completo. Revisá que estén todos los archivos, corré tests/build si corresponde y completá lo que falte.\n' +
          `Secciones completadas:\n${doneList}`,
        root,
        state,
        confirm,
        log,
        executeAction,
        maxSteps: Math.min(MAX_STEPS, 15),
        rotateAfter,
        maxChars,
        maxMessage,
      });
      console.log(res.ok ? c.green(`✔ Verificación: ${res.summary}`) : c.red(`✘ Verificación: ${res.summary}`));
    } catch (e) {
      console.log(c.red(`✘ Verificación: ${e.message}`));
    }
  }

  for (const w of workers) await w.closeWorker().catch(() => {});
  await persist();

  if (failures.length) {
    console.log(c.red(`\n✘ Quedaron ${failures.length} secciones sin completar:`));
    for (const f of failures) console.log(c.red(`  - ${f.title}`));
    console.log(c.dim('Volvé a ejecutar con --resume para reintentarlas.'));
  } else {
    console.log(c.green('\n✔ Spec completado.'));
  }
}

if (specArg) {
  try {
    await runSpec(path.resolve(specArg), initialTask || 'Implementa el proyecto completo descripto en el spec.');
  } catch (e) {
    console.error(c.red('✘ No pude completar el spec: ' + e.message));
  } finally {
    await shutdown();
  }
}

if (initialTask) await runTask(initialTask);

while (true) {
  const line = (await rl.question(c.bold('\n> '))).trim();
  if (!line) continue;
  if (line === '/exit' || line === '/quit') break;
  if (line === '/new') {
    await gpt.newChat();
    firstTurn = true;
    changed.clear();
    lastResults = [];
    sentChars = 0;
    stepsSinceRotate = 0;
    console.log(c.dim('Nuevo chat iniciado (contexto local reiniciado).'));
    continue;
  }
  if (line === '/status') {
    console.log(c.dim(`proyecto: ${root}`));
    console.log(
      c.dim(`rotación: ${stepsSinceRotate}/${rotateAfter} pasos · ${sentChars}/${maxChars} caracteres`)
    );
    console.log(c.dim(`archivos modificados: ${[...changed].join(', ') || '(ninguno)'}`));
    continue;
  }
  await runTask(line);
}

await shutdown();