// Driver de ChatGPT vía navegador (Puppeteer). Sin API.
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, closeBrowser } from './browser.js';

// Si ChatGPT cambia su interfaz, ajusta los selectores aquí.
// Cada uno acepta varias alternativas separadas por coma.
export const SEL = {
  input: [
    '#prompt-textarea',
    'div#prompt-textarea[contenteditable="true"]',
    'textarea[name="prompt-textarea"]',
    'div.ProseMirror[contenteditable="true"]',
  ].join(', '),
  send: [
    'button[data-testid="send-button"]',
    '#composer-submit-button',
    'button[aria-label*="Send"]',
    'button[aria-label*="Enviar"]',
  ].join(', '),
  stop: [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="Detener"]',
  ].join(', '),
  assistant: [
    '[data-markdown-text-style="assistant-message"]',
    '[data-chatgpt-search-unit-key$=":assistant"]',
    '[data-message-author-role="assistant"]',
    '[data-turn="assistant"]',
  ].join(', '),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Frases típicas de límite de contexto/cuota o errores de envío.
const LIMIT_RE =
  /(you'?ve reached|has reached|reached (the|your)|demasiado largo|too long|maximum context|context length|l[ií]mite (de|del|alcanzado)|usage limit|message limit|start a new chat|inicia un chat nuevo|abre un chat nuevo|conversation is too long|no puedo continuar|can'?t continue|capacity|cuota|no se pudo enviar)/i;

const looksLikeLimit = (text) => !!text && LIMIT_RE.test(text);

// Error específico: el mensaje individual supera el largo máximo permitido.
const TOO_LONG_RE =
  /demasiado largo|too long|ed[ií]talo y vuelve|edit it and (try|send)|message you submitted was too long/i;
const looksTooLong = (text) => !!text && TOO_LONG_RE.test(text);

// Aviso TEMPORAL de ChatGPT ("revisión rápida... vuelve a intentarlo en 1 minuto").
// No es un límite real: conviene esperar y reintentar el mismo mensaje.
const BUSY_RE =
  /revisi[oó]n r[aá]pida|quick (check|review)|siga siendo confiable|vuelve a intentarlo en|try again in (a|one) (minute|moment)|estamos haciendo una revisi[oó]n|temporarily unavailable|no disponible temporalmente|high demand|demanda alta|we'?re experiencing|too many requests|demasiadas solicitudes/i;
const looksBusy = (text) => !!text && BUSY_RE.test(text);

function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Se ejecuta DENTRO de la página (vía page.evaluate). Debe ser autocontenida.
export function readChatState() {
  const all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const textOf = (el) => {
    if (!el) return '';
    const inner = el.innerText || '';
    return (inner.trim() ? inner : el.textContent || '').trim();
  };
  const isUserTurn = (el) =>
    !!(
      el.querySelector(
        '[data-message-author-role="user"], [data-user-message-bubble], [data-conversation-role="user"]'
      ) || el.getAttribute('data-turn') === 'user'
    );

  const convRoot = document.querySelector('[data-chatgpt-conversation-selection-target]') || document;

  // --- UI clásica: article[data-testid^="conversation-turn"] + data-message-author-role ---
  const turns = all('[data-testid^="conversation-turn"]').length
    ? all('[data-testid^="conversation-turn"]')
    : all('main article');
  const msgTurns = turns.filter(
    (el) => el.querySelector('[data-message-author-role], [data-turn]') || el.hasAttribute('data-turn')
  );
  const pool = msgTurns.length ? msgTurns : turns;

  const nonEmptyRole = all('[data-message-author-role="assistant"]').filter((el) => textOf(el));
  const nonEmptyTurn = all('[data-turn="assistant"]').filter((el) => textOf(el));

  // --- UI nueva ("Codex"/Work): sin article ni roles, con markdown del asistente ---
  const markdownAssistants = all('[data-markdown-text-style="assistant-message"]', convRoot).filter((el) =>
    textOf(el)
  );
  const keyAssistants = all('[data-chatgpt-search-unit-key$=":assistant"]', convRoot).filter((el) => textOf(el));

  // Prioridad: markdown del asistente (más preciso) > clásico > contenedor por clave de búsqueda.
  const assistants = markdownAssistants.length
    ? markdownAssistants
    : nonEmptyRole.length
      ? nonEmptyRole
      : nonEmptyTurn.length
        ? nonEmptyTurn
        : keyAssistants;

  // Si el DOM no trae ningún marcador de rol, asumimos turnos alternos: usuario, asistente, ...
  const hasRoleMarkers = pool.some(
    (el) => el.querySelector('[data-message-author-role], [data-turn]') || el.hasAttribute('data-turn')
  );
  const assistantTurns = hasRoleMarkers
    ? pool.filter((el) => !isUserTurn(el) && textOf(el))
    : pool.filter((el, i) => i % 2 === 1 && textOf(el));

  const candidate = assistants[assistants.length - 1] || assistantTurns[assistantTurns.length - 1] || null;

  const full = textOf(candidate);
  let prose = '';
  let blocks = [];
  if (candidate) {
    // Código: UI nueva usa [data-markdown-copy="code-block"] code; la clásica, pre code.
    let codeEls = all('[data-markdown-copy="code-block"] code', candidate);
    if (!codeEls.length) codeEls = all('pre code', candidate);
    if (!codeEls.length) codeEls = all('code', candidate);
    blocks = codeEls.map((c) => c.innerText);

    const clone = candidate.cloneNode(true);
    clone.querySelectorAll('[data-markdown-copy="code-block"], pre').forEach((p) => p.remove());
    prose = textOf(clone);
  }

  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const errorEls = [
    ...all('[role="alert"]'),
    ...all('[role="dialog"]'),
    ...all('[data-testid*="error"]'),
    ...all('[data-testid*="limit"]'),
  ].filter(visible);
  const pageError = errorEls
    .map((el) => textOf(el))
    .join('\n')
    .trim()
    .slice(0, 600);

  return {
    assistantCount: Math.max(assistants.length, assistantTurns.length),
    rawAssistantCount: Math.max(nonEmptyRole.length, markdownAssistants.length, keyAssistants.length),
    turnCount: pool.length,
    pageError,
    stop: !!document.querySelector(
      'button[data-testid="stop-button"], [data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Detener"]'
    ),
    text: full,
    full,
    prose,
    blocks,
  };
}

export class ChatGPT {
  constructor(browser, page, url, owned) {
    this.browser = browser;
    this.page = page;
    this.url = url;
    this.owned = owned;
  }

  /**
   * connect: URL de un Chrome ya abierto con --remote-debugging-port (ej. http://127.0.0.1:9222)
   * profileDir: carpeta de perfil persistente (para no re-loguearse) cuando lanzamos Chrome nosotros
   * browser/owned: reutilizar un Chrome ya abierto por otro proveedor (webcode cierra el browser).
   */
  static async open({ connect, profileDir, url = 'https://chatgpt.com/', browser, owned = false } = {}) {
    ({ browser, owned } = await openBrowser({ connect, profileDir, browser, owned }));

    const pages = await browser.pages();
    console.log(`   [debug] pestañas abiertas: ${pages.length}`);
    const page = pages.find((p) => p.url().startsWith(url)) ?? (await browser.newPage());
    await page.bringToFront().catch(() => {});
    const gpt = new ChatGPT(browser, page, url, owned);
    await gpt.newChat();
    return gpt;
  }

  async #diagnose() {
    const title = await this.page.title().catch(() => '');
    const url = this.page.url();
    console.log(`\n⚠  No veo el cuadro de chat.\n   URL: ${url}\n   Título: "${title}"`);
    if (await this.#busyNotice()) {
      console.log('   → ChatGPT está en una revisión temporal. Esperá ~1 minuto y reintentá.');
    } else if (/just a moment|attention required|un momento|verif/i.test(title)) {
      console.log('   → Cloudflare está pidiendo verificación. Resolvela a mano en la ventana del navegador.');
    } else if (/log-?in|auth|accounts/i.test(url)) {
      console.log('   → Estás en una pantalla de login. Iniciá sesión en la ventana del navegador.');
    } else {
      console.log('   → Puede que ChatGPT haya cambiado el DOM. Revisá debug.png y ajustá SEL.input.');
    }
    await this.page.screenshot({ path: 'debug.png' }).catch(() => {});
    console.log('   → Captura guardada en debug.png. Sigo esperando hasta 10 min...');
  }

  async waitForComposer() {
    try {
      await this.page.waitForSelector(SEL.input, { timeout: 20000 });
      return;
    } catch {
      const busy = await this.#busyNotice();
      if (busy) throw fail(`ChatGPT está temporalmente ocupado: ${busy}`, 'BUSY');
      await this.#diagnose();
    }

    // Espera con reintentos para poder mostrar si cambia algo (ej. se resuelve el captcha)
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      try {
        await this.page.waitForSelector(SEL.input, { timeout: 5000 });
        return;
      } catch {
        const busy = await this.#busyNotice();
        if (busy) throw fail(`ChatGPT está temporalmente ocupado: ${busy}`, 'BUSY');
        await sleep(2000);
      }
    }
    await this.#diagnose();
    throw new Error('No apareció el cuadro de chat en 10 minutos. Revisá debug.png.');
  }

  async newChat() {
    console.log('   [debug] abriendo chat nuevo');
    try {
      await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      console.log(`⚠  La navegación tardó o falló (${e.message}). Sigo igual...`);
    }
    await this.waitForComposer();
    await sleep(700);

    // Si ChatGPT restauró la conversación anterior, forzar "Chat nuevo".
    for (let i = 0; i < 3; i++) {
      const s = await this.#snapshot();
      if (s.assistantCount === 0 && s.turnCount === 0 && !s.text.trim()) return;
      const btn = await this.page
        .$('button[aria-label*="Chat nuevo"], button[aria-label*="New chat"], [data-testid="new-chat-button"]')
        .catch(() => null);
      if (!btn) break;
      console.log('   [debug] limpiando conversación anterior (Chat nuevo)');
      await btn.click().catch(() => {});
      await sleep(1200);
      await this.waitForComposer();
    }
  }

  // Abre otra pestaña/chat dentro del mismo Chrome (para trabajar en paralelo).
  async spawnWorker() {
    const page = await this.browser.newPage();
    await page.bringToFront().catch(() => {});
    const gpt = new ChatGPT(this.browser, page, this.url, false);
    await gpt.newChat();
    return gpt;
  }

  async closeWorker() {
    try {
      await this.page.close();
    } catch {}
  }

  async close() {
    await closeBrowser({ browser: this.browser, owned: this.owned });
  }

  // Lee el estado del chat de forma tolerante a cambios de DOM.
  // Devuelve el número de mensajes del asistente, si está generando y el texto del último turno.
  async #snapshot() {
    return this.page.evaluate(readChatState);
  }

  async #dumpDom() {
    const out = path.resolve('debug-dom.json');
    try {
      const info = await this.page.evaluate(() => {
        const attrs = (el) => {
          const o = {};
          for (const a of el.attributes || []) {
            if (/^(id|class|data-|aria-|role|type|name)/.test(a.name)) o[a.name] = a.value;
          }
          return o;
        };
        const len = (el) => (el.innerText || el.textContent || '').trim().length;
        const outline = (el, depth) => {
          if (!el || depth > 12) return null;
          const kids = [...el.children].slice(0, 40).map((c) => outline(c, depth + 1)).filter(Boolean);
          const n = { tag: el.tagName.toLowerCase(), a: attrs(el), len: len(el), kids };
          if (!kids.length) n.text = (el.textContent || '').trim().slice(0, 160);
          return n;
        };
        return {
          url: location.href,
          title: document.title,
          counts: {
            markdownAssistant: document.querySelectorAll('[data-markdown-text-style="assistant-message"]').length,
            keyAssistant: document.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"]').length,
            roleAssistant: document.querySelectorAll('[data-message-author-role="assistant"]').length,
            turns: document.querySelectorAll('[data-testid^="conversation-turn"]').length,
            articles: document.querySelectorAll('article').length,
            code: document.querySelectorAll('code').length,
            preCode: document.querySelectorAll('pre code').length,
          },
          buttons: [...document.querySelectorAll('button')]
            .map((b) => ({
              testid: b.getAttribute('data-testid'),
              aria: b.getAttribute('aria-label'),
              text: (b.innerText || '').trim().slice(0, 30),
            }))
            .slice(0, 80),
          outline: outline(
            document.querySelector('[data-chatgpt-conversation-selection-target]') ||
              document.querySelector('main') ||
              document.body,
            0
          ),
        };
      });
      fs.writeFileSync(out, JSON.stringify(info, null, 2));
      console.log(`   [debug] DOM: ${JSON.stringify(info.counts)}`);
      console.log(`   [debug] estructura guardada en ${out}`);
    } catch (e) {
      console.log(`   [debug] no pude inspeccionar el DOM: ${e.message}`);
    }
  }

  // Detecta el aviso de "mensaje demasiado largo" (sirve para acortar y reenviar).
  async #tooLongError() {
    try {
      return await this.page.evaluate(() => {
        const re =
          /demasiado largo|too long|ed[ií]talo y vuelve|edit it and (try|send)|message you submitted was too long/i;
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        // Ignorar el texto de la conversación: solo buscamos avisos de la interfaz.
        const inConversation = (el) =>
          !!el.closest(
            '[data-chatgpt-conversation-selection-target], [data-message-author-role], [data-markdown-text-style], article'
          );
        const els = [
          ...document.querySelectorAll(
            '[role="alert"], [aria-live], [class*="toast"], [class*="error"], [data-testid*="error"]'
          ),
        ];
        for (const el of els) {
          if (visible(el) && !inConversation(el) && re.test(el.textContent || '')) {
            return (el.textContent || '').trim().slice(0, 300);
          }
        }
        const small = [...document.querySelectorAll('div, span, p, section, h1, h2, h3, li, label')].filter(
          (el) =>
            visible(el) &&
            !inConversation(el) &&
            (el.textContent || '').trim().length < 400 &&
            re.test(el.textContent || '')
        );
        return small.length ? (small[0].textContent || '').trim().slice(0, 300) : '';
      });
    } catch {
      return '';
    }
  }

  // Detecta el aviso temporal ("revisión rápida... vuelve a intentarlo en 1 minuto").
  async #busyNotice() {
    try {
      return await this.page.evaluate(() => {
        const re =
          /revisi[oó]n r[aá]pida|quick (check|review)|siga siendo confiable|vuelve a intentarlo en|try again in (a|one) (minute|moment)|estamos haciendo una revisi[oó]n|temporarily unavailable|no disponible temporalmente|high demand|demanda alta|we'?re experiencing|too many requests|demasiadas solicitudes/i;
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const inConversation = (el) =>
          !!el.closest(
            '[data-chatgpt-conversation-selection-target], [data-message-author-role], [data-markdown-text-style], article'
          );
        const els = [
          ...document.querySelectorAll(
            '[role="alert"], [role="dialog"], [aria-live], [class*="toast"], [class*="banner"], [class*="error"], [data-testid*="error"]'
          ),
        ];
        for (const el of els) {
          if (visible(el) && !inConversation(el) && re.test(el.textContent || '')) {
            return (el.textContent || '').trim().slice(0, 300);
          }
        }
        const small = [...document.querySelectorAll('div, span, p, section, h1, h2, h3, li, label')].filter(
          (el) =>
            visible(el) &&
            !inConversation(el) &&
            (el.textContent || '').trim().length < 400 &&
            re.test(el.textContent || '')
        );
        if (small.length) return (small[0].textContent || '').trim().slice(0, 300);

        // Último recurso: la página quedó reducida a un aviso (modal de revisión/alta demanda).
        const raw = document.body.textContent || '';
        if (raw.length < 3000 && re.test(raw)) return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
        return '';
      });
    } catch {
      return '';
    }
  }

  async #clearComposer() {
    await this.page.focus(SEL.input).catch(() => {});
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await this.page.keyboard.down(mod);
    await this.page.keyboard.press('KeyA');
    await this.page.keyboard.up(mod);
    await this.page.keyboard.press('Backspace');
    await sleep(150);
  }

  // Pega texto en el composer (evita que Enter envíe el mensaje a mitad)
  async #paste(text) {
    await this.page.bringToFront().catch(() => {});
    try {
      await this.page.click(SEL.input);
      await this.page.focus(SEL.input);
    } catch (e) {
      throw fail(`No pude enfocar el cuadro de chat: ${e.message}`, 'COMPOSER');
    }
    // Limpiar restos (por ejemplo, un mensaje anterior rechazado por largo).
    await this.#clearComposer().catch(() => {});

    // Input.insertText escribe como si fuera tipeo real, sin disparar Enter
    const client = await this.page.createCDPSession();
    try {
      await client.send('Input.insertText', { text });
    } finally {
      await client.detach().catch(() => {});
    }
    await sleep(600);

    const len = await this.page.evaluate(
      (sel) => {
        const el = document.querySelector(sel);
        return (el?.innerText ?? el?.value ?? '').trim().length;
      },
      SEL.input
    );
    console.log(`   [debug] caracteres en el cuadro: ${len}`);
    if (!len) {
      await this.page.screenshot({ path: 'debug-paste.png' }).catch(() => {});
      throw fail('No se pudo escribir en el cuadro de chat. Revisá debug-paste.png', 'COMPOSER');
    }
    // Si el cuadro aceptó mucho menos de lo esperado, probablemente rechazó el mensaje.
    if (text.length > 200 && len < text.length * 0.5) {
      await this.page.screenshot({ path: 'debug-paste.png' }).catch(() => {});
      throw fail(
        `El cuadro de chat solo aceptó ${len} de ${text.length} caracteres (posible límite de contexto).`,
        'COMPOSER'
      );
    }
  }

  // Envía el mensaje y confirma que realmente salió (cuadro vacío, respuesta nueva o botón de detener)
  async #send(before) {
    const composerLen = () =>
      this.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return (el?.innerText ?? el?.value ?? '').trim().length;
      }, SEL.input);

    const sent = async () => {
      await sleep(1500);
      const s = await this.#snapshot();
      const busy = looksBusy(s.pageError) || (await this.#busyNotice());
      if (busy) throw fail(`ChatGPT pidió esperar: ${busy}`, 'BUSY');
      const tooLong = looksTooLong(s.pageError) || (await this.#tooLongError());
      if (tooLong) throw fail(`ChatGPT rechazó el mensaje: ${tooLong}`, 'TOO_LONG');
      return (await composerLen()) === 0 || s.assistantCount > before || s.stop;
    };

    const selectors = SEL.send.split(', ');

    // Esperar a que algún botón de enviar esté habilitado
    try {
      await this.page.waitForSelector(selectors.map((s) => `${s}:not([disabled])`).join(', '), { timeout: 20000 });
    } catch {}
    await sleep(300);

    // 1) Probar cada botón por orden de prioridad
    for (const sel of selectors) {
      const btn = await this.page.$(`${sel}:not([disabled])`);
      if (!btn) continue;
      await btn.click().catch(() => {});
      console.log(`   [debug] click en ${sel}`);
      if (await sent()) return;
    }

    // 2) Fallback: Enter con el foco en el cuadro
    for (let i = 0; i < 2; i++) {
      await this.page.focus(SEL.input).catch(() => {});
      await this.page.keyboard.press('Enter');
      console.log('   [debug] presioné Enter');
      if (await sent()) return;
    }

    const busy = await this.#busyNotice();
    if (busy) throw fail(`ChatGPT pidió esperar: ${busy}`, 'BUSY');
    const tooLong = await this.#tooLongError();
    if (tooLong) throw fail(`ChatGPT rechazó el mensaje: ${tooLong}`, 'TOO_LONG');

    await this.page.screenshot({ path: 'debug-send.png' }).catch(() => {});
    throw fail('El mensaje no se pudo enviar. Revisá debug-send.png', 'SEND');
  }

  /** Envía un mensaje y devuelve { full, prose, blocks } de la respuesta */
  async ask(text) {
    const busyNow = await this.#busyNotice();
    if (busyNow) throw fail(`ChatGPT pidió esperar: ${busyNow}`, 'BUSY');

    const before = await this.#snapshot();
    await this.#paste(text);

    await this.#send(before.assistantCount);

    // Esperar a que empiece la respuesta: mensaje nuevo, botón de detener o texto distinto.
    const t0 = Date.now();
    let waits = 0;
    while (true) {
      const s = await this.#snapshot();
      if (s.assistantCount > before.assistantCount || s.stop || (s.text.trim() && s.text !== before.text)) {
        break;
      }
      if (++waits % 4 === 0) {
        console.log(
          `   [debug] esperando respuesta (${Math.round((Date.now() - t0) / 1000)}s) · ` +
            `asistente=${s.assistantCount} · turnos=${s.turnCount} · stop=${s.stop}`
        );
        const busy = looksBusy(s.pageError) || (await this.#busyNotice());
        if (busy) throw fail(`ChatGPT pidió esperar: ${busy}`, 'BUSY');
      }
      if (Date.now() - t0 > 120000) {
        const busy = await this.#busyNotice();
        if (busy) throw fail(`ChatGPT pidió esperar: ${busy}`, 'BUSY');
        const tooLong = await this.#tooLongError();
        if (tooLong) throw fail(`ChatGPT rechazó el mensaje: ${tooLong}`, 'TOO_LONG');
        await this.page.screenshot({ path: 'debug-ask.png' }).catch(() => {});
        await this.#dumpDom();
        throw fail(
          'No detecté la respuesta de ChatGPT (¿cambió el DOM, límite de uso, captcha?). Revisá debug-ask.png y los datos de DOM en la consola.',
          'RESPONSE'
        );
      }
      await sleep(500);
    }
    console.log('   [debug] respuesta detectada, esperando que termine de generar...');

    // "Nueva" = más mensajes con texto o un texto distinto al que había antes de enviar.
    const isNew = (s) =>
      s.assistantCount > before.assistantCount || (!!s.text.trim() && s.text !== before.text);

    // Esperar a que termine de generar y el texto se estabilice
    let last = '';
    let stable = 0;
    let ticks = 0;
    let dumped = false;
    let noTextSince = 0;
    const t1 = Date.now();
    while (Date.now() - t1 < 15 * 60 * 1000) {
      await sleep(700);
      const s = await this.#snapshot();
      const cur = isNew(s) ? s.text : '';
      if (++ticks % 7 === 0) {
        console.log(
          `   [debug] generando=${s.stop} · caracteres de respuesta=${cur.length} · estable=${stable} · ` +
            `asistente=${s.assistantCount}/${s.rawAssistantCount} · turnos=${s.turnCount}`
        );
      }
      if (!cur && !s.stop) {
        if (!noTextSince) noTextSince = Date.now();
        if (!dumped && Date.now() - noTextSince > 5000) {
          dumped = true;
          const busy = looksBusy(s.pageError) || (await this.#busyNotice());
          if (busy) throw fail(`ChatGPT pidió esperar: ${busy}`, 'BUSY');
          await this.#dumpDom();
        }
        if (Date.now() - noTextSince > 20000) {
          const tooLong = await this.#tooLongError();
          if (tooLong) throw fail(`ChatGPT rechazó el mensaje: ${tooLong}`, 'TOO_LONG');
          await this.page.screenshot({ path: 'debug-ask.png' }).catch(() => {});
          throw fail(
            'ChatGPT terminó de generar pero no pude leer el texto. Revisá debug-dom.json y debug-ask.png.',
            'DOM'
          );
        }
      } else {
        noTextSince = 0;
      }
      if (cur && cur === last) {
        stable++;
        // Si el botón de detener no es fiable, cortamos igual tras un rato sin cambios.
        if ((!s.stop && stable >= 3) || stable >= 25) break;
      } else {
        stable = 0;
      }
      last = cur;
    }

    const final = await this.#snapshot();
    const pageError = final.pageError || '';
    if (!final.text.trim() || !isNew(final)) {
      if (last.trim()) {
        return {
          full: last,
          prose: last,
          blocks: [],
          limit: looksLikeLimit(pageError) || looksLikeLimit(last),
          pageError,
        };
      }
      await this.page.screenshot({ path: 'debug-ask.png' }).catch(() => {});
      await this.#dumpDom();
      throw fail(
        'ChatGPT respondió pero no pude leer el texto. Revisá debug-ask.png y los datos de DOM en la consola.',
        'DOM'
      );
    }

    const hasActions = final.blocks.some((b) => b.includes('@@@')) || final.full.includes('@@@');
    const limit =
      looksLikeLimit(pageError) || (!hasActions && final.full.length < 800 && looksLikeLimit(final.full));

    return { full: final.full, prose: final.prose, blocks: final.blocks, limit, pageError };
  }
}