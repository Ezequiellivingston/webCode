# webcode

Agente de programación tipo OpenCode que, en vez de usar una API, **controla la web de ChatGPT, Gemini, Claude o DeepSeek con Puppeteer**: le envía tu tarea, lee la respuesta, ejecuta localmente lo que pide (crear archivos, editar, correr comandos), le devuelve los resultados y repite hasta terminar.

## Proveedores: ChatGPT, Gemini, Claude y DeepSeek

```bash
webcode "crea una API REST con Express"                          # router automático
webcode --provider claude "refactorizá este módulo y agregá tests" # proveedor fijo
webcode --provider gemini "tu tarea"                             # proveedor fijo
webcode --provider chatgpt --fallback gemini,claude "tu tarea"    # principal + respaldos
webcode --fallback none "tu tarea"                               # sin respaldo
```

- **Router automático (por defecto)**: elige el proveedor según la tarea y el contexto real (tamaño del proyecto/spec). Ejemplos: specs enormes → Gemini; razonamiento/matemática → DeepSeek; documentación → Claude; código/tests → ChatGPT/Claude. Se calcula al arrancar (tarea inicial o `--spec`) y, en modo interactivo sin tarea inicial, con la primera tarea que escribas.
- `--provider chatgpt|gemini|claude|deepseek` fija el proveedor y desactiva el router.
- El respaldo también es automático: por defecto usa el resto del orden del router. Podés fijarlo con `--fallback` o desactivarlo con `--fallback none`.
- Al cambiar de proveedor, webcode abre un chat nuevo y le pasa el contexto acumulado (tarea, árbol real del proyecto, archivos modificados, últimos resultados y próximo paso).
- Si el proveedor pide esperar (“revisión rápida… vuelve a intentarlo en 1 minuto”) y hay respaldo, **cambia al respaldo al instante**; si no hay respaldo, espera y reintenta.
- Necesitás iniciar sesión una vez en cada proveedor que uses; la sesión queda en el mismo perfil de Chrome (`~/.webcode-profile`).

### Login por proveedor

La primera vez que uses un proveedor explícito (`--provider claude`), webcode abre su página y espera (hasta 10 min) a que inicies sesión a mano. Un proveedor elegido por el router o usado como respaldo **falla rápido** si no hay sesión, para no colgar la tarea; en ese caso usa `--provider` una vez para loguearte. Después verificá los selectores con:

```bash
webcode --provider deepseek --probe
webcode --provider claude --probe
```

## Instalación

Requisitos: Node 18+ y Google Chrome (o Chromium/Edge). Si no lo encuentra solo, definí `CHROME_PATH`.

### Global desde npm

```bash
npm install -g webcode
```

### Global desde GitHub (sin publicar en npm)

```bash
npm install -g github:USUARIO/webcode
```

### Desarrollo local

```bash
git clone https://github.com/USUARIO/webcode.git
cd webcode
npm install
npm link
```

## Uso

Desde la carpeta donde quieres construir el proyecto:

```bash
webcode
# o con una tarea inicial:
webcode "crea una API REST con Express y una ruta /health"
# o sobre otra carpeta:
webcode --dir "C:\ruta\a\mi-proyecto" "tu tarea"
```

La primera vez se abre Chrome: **inicia sesión en el proveedor que uses** (ChatGPT, Gemini y/o DeepSeek) una sola vez. La sesión queda guardada en `~/.webcode-profile`.

### Opciones

| Opción | Descripción |
|---|---|
| `--dir <ruta>` | Directorio del proyecto (por defecto el actual) |
| `--provider <p>` | `chatgpt`, `gemini`, `claude`, `deepseek` o `auto` (por defecto `auto`) |
| `--fallback <p>` | Respaldo automático, separado por coma (`gemini,claude`). Por defecto usa el orden del router; `none` lo desactiva |
| `--connect <url>` | Conectarse a un Chrome ya abierto (ver abajo) |
| `--profile <ruta>` | Perfil persistente de Chrome |
| `--yes`, `-y` | Ejecutar comandos sin pedir confirmación |
| `--url <url>` | URL del proveedor principal (por defecto según el proveedor) |
| `--busy-wait <s>` | Espera ante avisos temporales del proveedor (por defecto 65 s) |
| `--busy-retries <n>` | Reintentos ante avisos temporales (por defecto 3) |
| `--probe` | Verificar selectores/login de los proveedores y salir |
| `--probe-wait <s>` | Espera máxima por proveedor en `--probe` (por defecto 20 s) |
| `--rotate-after <n>` | Abrir un chat nuevo cada N pasos (por defecto: 25) |
| `--max-chars <n>` | Abrir un chat nuevo al superar N caracteres enviados (por defecto: 50000) |
| `--max-message <n>` | Recortar cada mensaje a N caracteres (por defecto: 16000) |
| `--spec <archivo>` | Construir el proyecto completo desde un spec grande |
| `--parallel <n>` | Cantidad de chats en paralelo al usar `--spec` (por defecto: 2) |
| `--resume` | Retomar un `--spec` desde `.webcode/state.json` |

### Construir desde un spec grande (`--spec`)

```bash
webcode --dir ./mi-proyecto --spec ./mi-proyecto/SPEC.md --parallel 2 -y
```

- El spec se trocea por encabezados markdown (y por tamaño si una sección es enorme), sin mandarle todo junto a ChatGPT.
- Cada sección se trabaja como una tarea independiente, en un chat propio. Con `--parallel 2` se abren dos pestañas/chats y avanzan a la vez. Cada worker tiene su propio proveedor y failover: si uno cambia de proveedor, los demás no se ven afectados.
- Las escrituras se serializan por archivo y los comandos `run` se ejecutan de a uno para evitar choques entre workers.
- El progreso se guarda en `.webcode/state.json` (secciones hechas, archivos y resúmenes). Si algo falla, `--resume` retoma solo lo pendiente.
- Al terminar todas las secciones, un chat hace una verificación final (tests/build/completar faltantes).
- Si las secciones dependen entre sí (por ejemplo, una usa archivos de otra), usá `--parallel 1` para que se ejecuten en orden.

### Comandos dentro de la app

- Escribe cualquier tarea y presiona Enter.
- `/new` inicia un chat nuevo en el proveedor activo y reinicia el contexto local.
- `/status` muestra pasos, caracteres y archivos modificados de la sesión.
- `/exit` sale.

### Contexto largo / límite de ChatGPT

Cuando la conversación se acerca al límite (por pasos o por caracteres) o ChatGPT rechaza el mensaje, `webcode` abre un **chat nuevo** y le pasa un resumen del estado: tarea original, árbol del proyecto, archivos ya modificados y últimos resultados. Así la tarea continúa sin repetir todo desde cero.

Si ChatGPT responde “El mensaje que enviaste era demasiado largo”, `webcode` recorta ese mensaje (a `--max-message`, o a un 60% si vuelve a pasar) y lo reenvía automáticamente en el mismo chat.

### Diagnóstico de selectores (`--probe`)

Si el proveedor cambia su HTML, verificá los selectores antes de correr una tarea:

```bash
webcode --probe
webcode --provider gemini --probe
webcode --provider chatgpt --fallback gemini --probe
```

Muestra qué selectores de `input`, `send`, `stop` y `assistant` matchean, avisa si hay una pantalla de login o un aviso temporal, y guarda el DOM en `debug-probe-<proveedor>.json`. Escribe un texto de prueba en el cuadro (sin enviarlo) porque en Gemini el botón de enviar aparece recién al escribir. `stop` y `assistant` solo se pueden validar con una respuesta real.

### Avisos temporales (“revisión rápida… vuelve a intentarlo en 1 minuto”)

Cuando el proveedor muestra un aviso temporal (revisión rápida, alta demanda, servicio no disponible), `webcode` **no aborta**:

- Si hay `--fallback`, cambia al siguiente proveedor **de inmediato** y continúa con el contexto acumulado.
- Si no hay respaldo, espera `--busy-wait` segundos y reintenta el mismo mensaje hasta `--busy-retries` veces, conservando la conversación.

## Si ChatGPT detecta la automatización (captcha / Cloudflare)

Abre tu propio Chrome con el puerto de depuración y conéctate a él:

```bash
# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.webcode-chrome
# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=$HOME/.webcode-chrome
# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir=%USERPROFILE%\.webcode-chrome

node src/index.js --connect http://127.0.0.1:9222
```

## Cómo funciona

1. `chatgpt.js` / `gemini.js` / `claude.js` / `deepseek.js` pegan tu mensaje en el cuadro de chat, lo envían y esperan a que termine de generar.
2. El primer mensaje incluye instrucciones (`prompt.js`) para que el proveedor responda con un bloque de código `webcode` con acciones:
   `write_file`, `edit_file`, `run`, `read`, `list`, `done`.
3. `tools.js` interpreta esas acciones y las ejecuta en tu carpeta (con rutas restringidas al proyecto).
4. Los resultados se envían de vuelta al proveedor como `[RESULTADOS]` y el ciclo continúa (máx. 40 pasos por tarea).

## Publicar en npm / GitHub

El paquete se llama `webcode` y el binario ya está declarado en `package.json` (`"bin": { "webcode": "./src/index.js" }`).

El repo incluye `.gitignore` y `.npmignore` para no subir `node_modules`, `.webcode`, perfiles de Chrome, debug, logs ni `.tgz`.

### npm

```bash
npm login
npm publish
```

Verificar antes qué se sube:

```bash
npm pack --dry-run
```

Nueva versión:

```bash
npm version patch   # o minor / major
npm publish
```

Una vez publicado, cualquiera instala con `npm install -g webcode`.

### GitHub

```bash
git init
git add .
git commit -m "webcode 0.1.0"
git branch -M main
git remote add origin https://github.com/USUARIO/webcode.git
git push -u origin main
```

Desde GitHub se instala con `npm install -g github:USUARIO/webcode` (no con `npm install -g webcode`, salvo que también esté publicado en npm).

## Seguridad

- Los comandos `run` piden confirmación (`s/N`) solo la primera vez; si aceptás, no vuelve a preguntar durante la sesión. Con `--yes` no pregunta nunca.
- Las rutas de archivos no pueden salir del directorio del proyecto.
- Los comandos de shell sí pueden hacer cualquier cosa: revisa lo que aceptas.

## Limitaciones

- **Selectores frágiles**: si ChatGPT, Gemini, Claude o DeepSeek cambian su HTML, edita `SEL` al inicio de `src/chatgpt.js`, `src/gemini.js`, `src/claude.js` o `src/deepseek.js` (y verificá con `--probe`).
- **El router es heurístico**: usa palabras clave y tamaño de contexto; no conoce el modelo exacto detrás de cada web. Si no te gusta la elección, fijá `--provider`.
- Automatizar la interfaz web puede ir contra los términos de uso de OpenAI y puede dispararle límites de uso o captchas. Úsalo bajo tu responsabilidad y con tu propia cuenta.
- Respuestas muy largas pueden cortarse; si pasa, el agente avisa del bloque truncado y ChatGPT lo reenvía.
- ChatGPT puede ignorar el formato a veces; el programa reintenta hasta 2 veces.
- Probado contra la UI nueva de ChatGPT (Codex/Work) y la clásica. Si vuelve a cambiar el DOM, el programa guarda `debug-dom.json`; con eso se ajustan los selectores de `src/chatgpt.js`.
