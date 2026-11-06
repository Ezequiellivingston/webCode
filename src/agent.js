// Motor de un agente ChatGPT (una conversación) reutilizable por varios workers.
import { listTree, parseActions } from './tools.js';
import { buildFirstMessage, buildResults, buildNoActions, buildResumeMessage } from './prompt.js';

function compact(message, maxLen) {
  if (message.length <= maxLen) return message;
  const note = '\n\n[...recortado por límite de longitud...]\n\n';
  const head = Math.floor(maxLen * 0.7);
  const tail = Math.max(0, maxLen - head - note.length);
  return message.slice(0, head) + note + (tail ? message.slice(-tail) : '');
}

/**
 * Corre el ciclo leer-respuesta-ejecutar en UNA conversación de ChatGPT.
 * Devuelve { ok, summary, files }.
 */
export async function runAgent({
  gpt,
  task,
  root,
  spec = '',
  state = {},
  confirm,
  log,
  executeAction,
  maxSteps = 40,
  rotateAfter = 25,
  maxChars = 50000,
  maxMessage = 16000,
}) {
  const fullTask = spec ? `${task}\n\n[ESPECIFICACIÓN RELEVANTE]\n${spec}` : task;
  const changed = new Set(state.files || []);
  let lastResults = [];
  let sentChars = 0;
  let stepsSinceRotate = 0;
  let emptyReplies = 0;

  let message = buildFirstMessage(fullTask, root, await listTree(root));

  const makeResume = async (next) => {
    const pending = next.includes('REGLAS IMPORTANTES') ? '' : next;
    const useLast = pending.includes('[RESULTADOS]') ? [] : lastResults;
    return compact(
      buildResumeMessage(fullTask, root, await listTree(root), {
        changed: [...changed],
        lastResults: useLast,
        next: pending,
      }),
      maxMessage
    );
  };

  const rotate = async (next) => {
    message = await makeResume(next);
    await gpt.newChat();
    stepsSinceRotate = 0;
    sentChars = 0;
  };

  for (let step = 1; step <= maxSteps; step++) {
    stepsSinceRotate++;
    let reply;
    const outbound = compact(message, maxMessage);
    try {
      reply = await gpt.ask(outbound);
      sentChars += outbound.length;
    } catch (e) {
      if (e.code === 'TOO_LONG') {
        const shorter = compact(message, Math.floor(maxMessage * 0.6));
        if (shorter === message) throw e;
        log(`   (mensaje recortado a ${shorter.length} caracteres y reenviado)`);
        reply = await gpt.ask(shorter);
        sentChars += shorter.length;
      } else if (['COMPOSER', 'SEND', 'RESPONSE', 'DOM'].includes(e.code)) {
        log(`   ↻ ${e.message} → chat nuevo con contexto`);
        await rotate(message);
        reply = await gpt.ask(message);
        sentChars += message.length;
      } else {
        throw e;
      }
    }

    if (reply.limit) {
      log('   ↻ límite indicado por el proveedor → chat nuevo con contexto');
      await rotate('');
      reply = await gpt.ask(message);
      if (reply.limit) throw new Error('El proveedor sigue rechazando mensajes (límite de uso/cuota).');
    }

    if (reply.prose) log('\n' + reply.prose.slice(0, 900));

    const actions = parseActions(reply.blocks, reply.full);
    if (!actions.length) {
      const preview = (reply.full || reply.prose || '').trim().replace(/\s+/g, ' ').slice(0, 180);
      log(`   (respuesta sin acciones: ${preview || '(vacía)'}...)`);
      if (++emptyReplies > 2) throw new Error('El proveedor no devolvió acciones válidas.');
      if (
        emptyReplies === 2 &&
        typeof gpt.switchNextProvider === 'function' &&
        gpt.hasNext
      ) {
        log(`   ↻ ${gpt.label || 'el proveedor'} no siguió el formato → cambio de proveedor`);
        await gpt.switchNextProvider('no devolvió acciones válidas');
        await rotate('');
        continue;
      }
      message = buildNoActions();
      continue;
    }
    emptyReplies = 0;

    const results = [];
    let done = null;
    for (const a of actions) {
      if (a.type === 'done') {
        if (results.some((r) => !r.ok)) break;
        done = a.arg || 'Tarea completada';
        break;
      }
      const r = await executeAction(a);
      if (r.ok && (a.type === 'write_file' || a.type === 'edit_file')) changed.add(a.arg);
      results.push({ label: `${a.type} ${a.arg}`.trim(), ...r });
    }
    lastResults = results;

    if (done) return { ok: true, summary: done, files: [...changed] };

    if (stepsSinceRotate >= rotateAfter || sentChars >= maxChars) {
      log('   ↻ contexto largo → chat nuevo con resumen');
      await rotate('');
      continue;
    }
    message = buildResults(results);
  }

  return { ok: false, summary: `máximo de ${maxSteps} pasos`, files: [...changed] };
}
