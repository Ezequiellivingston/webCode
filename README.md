# webcode

Agente de programación tipo OpenCode que, en vez de usar una API, **controla la web de ChatGPT con Puppeteer**: le envía tu tarea, lee la respuesta, ejecuta localmente lo que pide (crear archivos, editar, correr comandos), le devuelve los resultados y repite hasta terminar.

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

La primera vez se abre Chrome: **inicia sesión en ChatGPT** una sola vez. La sesión queda guardada en `~/.webcode-profile`.

### Opciones

| Opción | Descripción |
|---|---|
| `--dir <ruta>` | Directorio del proyecto (por defecto el actual) |
| `--connect <url>` | Conectarse a un Chrome ya abierto (ver abajo) |
| `--profile <ruta>` | Perfil persistente de Chrome |
| `--yes`, `-y` | Ejecutar comandos sin pedir confirmación |
| `--url <url>` | URL de ChatGPT (por defecto: https://chatgpt.com/) |
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
- Cada sección se trabaja como una tarea independiente, en un chat propio. Con `--parallel 2` se abren dos pestañas/chats y avanzan a la vez.
- Las escrituras se serializan por archivo y los comandos `run` se ejecutan de a uno para evitar choques entre workers.
- El progreso se guarda en `.webcode/state.json` (secciones hechas, archivos y resúmenes). Si algo falla, `--resume` retoma solo lo pendiente.
- Al terminar todas las secciones, un chat hace una verificación final (tests/build/completar faltantes).
- Si las secciones dependen entre sí (por ejemplo, una usa archivos de otra), usá `--parallel 1` para que se ejecuten en orden.

### Comandos dentro de la app

- Escribe cualquier tarea y presiona Enter.
- `/new` inicia un chat nuevo en ChatGPT y reinicia el contexto local.
- `/status` muestra pasos, caracteres y archivos modificados de la sesión.
- `/exit` sale.

### Contexto largo / límite de ChatGPT

Cuando la conversación se acerca al límite (por pasos o por caracteres) o ChatGPT rechaza el mensaje, `webcode` abre un **chat nuevo** y le pasa un resumen del estado: tarea original, árbol del proyecto, archivos ya modificados y últimos resultados. Así la tarea continúa sin repetir todo desde cero.

Si ChatGPT responde “El mensaje que enviaste era demasiado largo”, `webcode` recorta ese mensaje (a `--max-message`, o a un 60% si vuelve a pasar) y lo reenvía automáticamente en el mismo chat.

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

1. `chatgpt.js` pega tu mensaje en el cuadro de chat, lo envía y espera a que termine de generar.
2. El primer mensaje incluye instrucciones (`prompt.js`) para que ChatGPT responda con un bloque de código `webcode` con acciones:
   `write_file`, `edit_file`, `run`, `read`, `list`, `done`.
3. `tools.js` interpreta esas acciones y las ejecuta en tu carpeta (con rutas restringidas al proyecto).
4. Los resultados se envían de vuelta a ChatGPT como `[RESULTADOS]` y el ciclo continúa (máx. 40 pasos por tarea).

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

- **Selectores frágiles**: si ChatGPT cambia su HTML, edita `SEL` al inicio de `src/chatgpt.js`.
- Automatizar la interfaz web puede ir contra los términos de uso de OpenAI y puede dispararle límites de uso o captchas. Úsalo bajo tu responsabilidad y con tu propia cuenta.
- Respuestas muy largas pueden cortarse; si pasa, el agente avisa del bloque truncado y ChatGPT lo reenvía.
- ChatGPT puede ignorar el formato a veces; el programa reintenta hasta 2 veces.
- Probado contra la UI nueva de ChatGPT (Codex/Work) y la clásica. Si vuelve a cambiar el DOM, el programa guarda `debug-dom.json`; con eso se ajustan los selectores de `src/chatgpt.js`.
