import os from 'node:os';

const F = '`'.repeat(4); // fence de 4 backticks (permite ``` dentro de los archivos)

export function buildFirstMessage(task, root, tree) {
  return `Eres un agente de programación autónomo. Trabajas sobre un proyecto LOCAL mediante un programa intermediario ("webcode") que lee tus respuestas y ejecuta las acciones que escribas. Tú no tienes acceso directo al disco.

REGLAS IMPORTANTES
- NO uses Canvas, ni búsqueda web, ni generación de archivos descargables, ni el intérprete de código de ChatGPT. Todo se hace SOLO con las acciones de abajo.
- Pon TODAS las acciones dentro de UN único bloque de código con cuatro backticks y lenguaje "webcode", así:

${F}webcode
@@@ write_file src/ejemplo.js
console.log("hola");
@@@ end
@@@ run node src/ejemplo.js
${F}

ACCIONES DISPONIBLES (cada una empieza con una línea que comienza con "@@@ ")
- "@@@ write_file <ruta>" + contenido completo del archivo + "@@@ end"   → crea o sobrescribe un archivo.
- "@@@ edit_file <ruta>" + uno o más bloques + "@@@ end"                  → modifica un archivo existente. Cada bloque:
    <<<<<<< SEARCH
    texto exacto existente
    =======
    texto nuevo
    >>>>>>> REPLACE
- "@@@ run <comando>"     → ejecuta un comando de shell en la raíz del proyecto (instalar, compilar, probar...).
- "@@@ read <ruta>"       → te devuelvo el contenido de un archivo.
- "@@@ list <ruta>"       → te devuelvo el árbol de carpetas.
- "@@@ done <mensaje>"    → úsalo SOLO cuando la tarea esté completa y verificada; el mensaje es un resumen para el usuario.

FLUJO
1. Antes del bloque puedes explicar muy brevemente qué harás (en el idioma del usuario).
2. Yo ejecuto las acciones y te respondo con un mensaje que empieza con [RESULTADOS].
3. Continúa iterando (corrige errores, ejecuta tests) hasta terminar y entonces usa "@@@ done".
- Usa rutas relativas a la raíz del proyecto. Escribe archivos COMPLETOS (sin "...resto igual...").
- No pidas permiso ni hagas preguntas innecesarias: toma decisiones razonables y avanza.
- Si necesitas ver un archivo antes de editarlo, usa "@@@ read".
- Sé breve para ahorrar contexto: no repitas archivos que no cambian ni des explicaciones largas.
- Usa "@@@ read" solo cuando realmente necesites ver el contenido de un archivo.
- Cada respuesta debe contener exactamente un bloque webcode.

CONTEXTO
- Sistema operativo: ${os.platform()} (${os.arch()})
- Directorio del proyecto: ${root}
- Contenido actual:
${tree}

[TAREA]
${task}`;
}

export function buildTaskMessage(task) {
  return `[TAREA]\n${task}`;
}

export function buildResults(results) {
  const body = results
    .map((r, i) => `### ${i + 1}. ${r.label} → ${r.ok ? 'OK' : 'ERROR'}\n${r.output}`)
    .join('\n\n');
  return `[RESULTADOS]\n${body}\n\nContinúa con el siguiente paso. Responde con un bloque ${F}webcode. Si ya terminaste y verificaste todo, usa "@@@ done".`;
}

export function buildNoActions() {
  return `[RESULTADOS]\nNo encontré ninguna acción válida en tu respuesta. Responde SOLO con un bloque de código de cuatro backticks con lenguaje webcode que contenga líneas "@@@ ..." (write_file, edit_file, run, read, list o done).`;
}

// Primer mensaje de un chat nuevo que continúa una tarea empezada en otro chat.
export function buildResumeMessage(task, root, tree, { changed = [], lastResults = [], next = '' } = {}) {
  const changedList = changed.length ? changed.map((f) => `- ${f}`).join('\n') : '(ninguno todavía)';
  const last = lastResults.length
    ? lastResults
        .map((r) => `### ${r.label} → ${r.ok ? 'OK' : 'ERROR'}\n${String(r.output ?? '').slice(0, 1500)}`)
        .join('\n\n')
    : '(sin resultados previos)';

  return `${buildFirstMessage(task, root, tree)}

[ESTADO ACTUAL — CONTINUACIÓN]
Este chat es NUEVO porque el anterior llegó a su límite de contexto. Conservá este estado y seguí desde acá.
- Archivos ya creados/editados en esta sesión:
${changedList}

- Últimos resultados de acciones:
${last}

[SIGUIENTE PASO]
${next || 'Continúa la tarea desde donde quedó.'}`;
}
