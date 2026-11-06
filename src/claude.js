// Driver de Claude (claude.ai) vía navegador (Puppeteer). Sin API.
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser, closeBrowser } from './browser.js';

// Si Claude cambia su interfaz, ajusta los selectores aquí y corré: webcode --provider claude --probe
export const SEL = {
  input: [
    'div.ProseMirror[contenteditable="true"]',
    'fieldset div[contenteditable="true"]',
    'div[contenteditable="true"][data-placeholder]',
    'div[contenteditable="true"]',
  ].join(', '),
  send: [
    'button[aria-label="Send message"]',
    'button[aria-label="Send Message"]',
    'button[aria-label="Enviar mensaje"]',
    'button[aria-label="Enviar"]',
    'button[data-testid="send-button"]',
    'button[type="submit"]',
  ].join(', '),
  stop: [
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop Response"]',
    'button[aria-label="Detener respuesta"]',
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="Detener"]',
  ].join(', '),
  assistant: ['.font-claude-message', '[data-testid="assistant-message"]', '[data-is-streaming]'].join(', '),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIMIT_RE =
  /(you'?ve reached|has reached|reached (the|your)|límite (de|del|alcanzado)|l[ií]mite de contexto|context window (is )?full|window is full|ventana de contexto llena|contexto lleno|ventana llena|usage limit|message limit|too many requests|demasiadas solicitudes|conversation is too long|start a new chat|inicia un chat nuevo|out of messages)/i;
const looksLikeLimit = (text) => !!text && LIMIT_RE.test(text);

const TOO_LONG_RE =
  /demasiado largo|too long|message you submitted was too long|prompt is too long|input is too long/i;
const looksTooLong = (text) => !!text && TOO_LONG_RE.test(text);

const BUSY_RE =
  /temporarily unavailable|no disponible temporalmente|try again (later|in a (minute|moment))|vuelve a intentarlo|high demand|demanda alta|we'?re experiencing|estamos experimentando|something went wrong|algo salió mal|service is busy|servicio ocupado|overloaded/i;
const looksBusy = (text) => !!text && BUSY_RE.test(text);

const SIGNED_OUT_RE = /\/(login|logout|oauth|sso|magic-link|auth)(\?|$|\/)|accounts\.google\.com/i;

function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Se ejecuta DENTRO de la página (vía page.evaluate). Debe ser autocontenida.
export function readClaudeState() {
  const all = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const textOf = (el) => {
    if (!el) return '';
    const inner = el.innerText || '';
    return (inner.trim() ? inner : el.textContent || '').trim();
  };
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  const convRoot = document.querySelector('main') || document.body;

  let assistants = all('.font-claude-message', convRoot).filter((el) => textOf(el));
  if (!assistants.length) assistants = all('[data-testid="assistant-message"]', convRoot).filter((el) => textOf(el));
  if (!assistants.length) {
    assistants = all('[data-is-streaming]', convRoot).filter((el) => textOf(el) && !el.querySelector('[contenteditable="true"]'));
  }

  const candidate = assistants[assistants.length - 1] || null;
  const full = textOf(candidate);
  let prose = '';
  let blocks = [];
  if (candidate) {
    let codeEls = all('pre code', candidate);
    if (!codeEls.length) codeEls = all('code', candidate);
    blocks = codeEls.map((c) => c.innerText);

    const clone = candidate.cloneNode(true);
    clone.querySelectorAll('pre, .code-block').forEach((p) => p.remove());
    prose = textOf(clone);
  }

  const errorEls = [
    ...all('[role="alert"]'),
    ...all('[role="dialog"]'),
    ...all('[class*="error"]'),
    ...all('[class*="toast"]'),
  ].filter(visible);
  const pageError = errorEls
    .map((el) => textOf(el))
    .join('\n')
    .trim()
    .slice(0, 600);

  return {
    assistantCount: assistants.length,
    rawAssistantCount: all('.font-claude-message', convRoot).length,
    turnCount: assistants.length,
    pageError,
    stop:
      !!document.querySelector(
        'button[aria-label="Stop response"], button[aria-label="Stop Response"], button[aria-label="Detener respuesta"], button[data-testid="stop-button"], button[aria-label*="Stop"], button[aria-label*="Detener"]'
      ) || !!document.querySelector('[data-is-streaming="true"]'),
    text: full,
    full,
    prose,
    blocks,
  };
}

export class Claude {
  constructor(browser, page, url, owned, allowLoginWait = false) {
    this.browser = browser;
    this.page = page;
    this.url = url;
    this.owned = owned;
    this.allowLoginWait = allowLoginWait;
  }

  static async open({
    connect,
    profileDir,
    url = 'https://claude.ai/new',
    browser,
    owned = false,
    allowLoginWait = false,
  } = {}) {
    ({ browser, owned } = await openBrowser({ connect, profileDir, browser, owned }));

    const pages = await browser.pages();
    console.log(`   [debug] pestañas abiertas: ${pages.length}`);
    const page = pages.find((p) => p.url().startsWith(url)) ?? (await browser.newPage());
    await page.bringToFront().catch(() => {});
    const cl = new Claude(browser, page, url, owned, allowLoginWait);
    await cl.newChat();
    return cl;
  }

  #signedOut() {
    return SIGNED_OUT_RE.test(this.page.url());
  }

  async #waitForLogin() {
    console.log('   → Claude pide iniciar sesión. Iniciá sesión en la ventana del navegador (espero hasta 10 min)...');
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      if (!this.#signedOut()) return;
    }
    throw fail('Claude sigue pidiendo iniciar sesión. Iniciá sesión y volvé a intentar.', 'LOGIN');
  }

  async #diagnose() {
    const title = await this.page.title().catch(() => '');
    const url = this.page.url();
    console.log(`\n⚠  No veo el cuadro de chat de Claude.\n   URL: ${url}\n   Título: "${title}"`);
    if (this.#signedOut()) {
      console.log('   → Iniciá sesión en Claude en la ventana del navegador.');
    } else {
      console.log('   → Puede que Claude haya cambiado el DOM. Revisá debug-claude.png y ajustá SEL.input.');
    }
    await this.page.screenshot({ path: 'debug-claude.png' }).catch(() => {});
    console.log('   → Captura guardada en debug-claude.png. Sigo esperando hasta 10 min...');
  }

  async waitForComposer() {
    if (this.#signedOut()) {
      if (this.allowLoginWait) await this.#waitForLogin();
      else throw fail('Claude pide iniciar sesión. Iniciá sesión y volvé a intentar.', 'LOGIN');
    }

    try {
      await this.page.waitForSelector(SEL.input, { timeout: 20000 });
      return;
    } catch {
      const busy = await this.#busyNotice();
      if (busy) throw fail(`Claude está temporalmente ocupado: ${busy}`, 'BUSY');
      await this.#diagnose();
    }

    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      try {
        await this.page.waitForSelector(SEL.input, { timeout: 5000 });
        return;
      } catch {
        if (this.#signedOut()) {
          if (this.allowLoginWait) await this.#waitForLogin();
          else throw fail('Claude pide iniciar sesión. Iniciá sesión y volvé a intentar.', 'LOGIN');
        }
        const busy = await this.#busyNotice();
        if (busy) throw fail(`Claude está temporalmente ocupado: ${busy}`, 'BUSY');
        await sleep(2000);
      }
    }
    await this.#diagnose();
    throw new Error('No apareció el cuadro de chat de Claude en 10 minutos. Revisá debug-claude.png.');
  }

  async newChat() {
    console.log('   [debug] abriendo chat nuevo (Claude)');
    try {
      await this.page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      console.log(`⚠  La navegación tardó o falló (${e.message}). Sigo igual...`);
    }
    await this.waitForComposer();
    await sleep(700);

    for (let i = 0; i < 3; i++) {
      const s = await this.#snapshot();
      if (s.assistantCount === 0 && !s.text.trim()) return;
      const btn = await this.page
        .$(
          'a[href="/new"], button[aria-label*="New chat"], button[aria-label*="Nuevo chat"], [data-testid="new-chat-button"]'
        )
        .catch(() => null);
      if (!btn) break;
      console.log('   [debug] limpiando conversación anterior (New chat)');
      await btn.click().catch(() => {});
      await sleep(1200);
      await this.waitForComposer();
    }
  }

  async spawnWorker() {
    const page = await this.browser.newPage();
    await page.bringToFront().catch(() => {});
    const cl = new Claude(this.browser, page, this.url, false, false);
    await cl.newChat();
    return cl;
  }

  async closeWorker() {
    try {
      await this.page.close();
    } catch {}
  }

  async close() {
    await closeBrowser({ browser: this.browser, owned: this.owned });
  }

  async #snapshot() {
    return this.page.evaluate(readClaudeState);
  }

  async #dumpDom() {
    const out = path.resolve('debug-dom-claude.json');
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
            claudeMessage: document.querySelectorAll('.font-claude-message').length,
            streaming: document.querySelectorAll('[data-is-streaming]').length,
            preCode: document.querySelectorAll('pre code').length,
          },
          buttons: [...document.querySelectorAll('button, [role="button"]')]
            .map((b) => ({
              aria: b.getAttribute('aria-label'),
              testid: b.getAttribute('data-testid'),
              text: (b.innerText || '').trim().slice(0, 30),
            }))
            .slice(0, 80),
          outline: outline(document.querySelector('main') || document.body, 0),
        };
      });
      fs.writeFileSync(out, JSON.stringify(info, null, 2));
      console.log(`   [debug] DOM: ${JSON.stringify(info.counts)}`);
      console.log(`   [debug] estructura guardada en ${out}`);
    } catch (e) {
      console.log(`   [debug] no pude inspeccionar el DOM: ${e.message}`);
    }
  }

  async #notice(reSource) {
    try {
      return await this.page.evaluate((src) => {
        const re = new RegExp(src, 'i');
        const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        const inConversation = (el) =>
          !!el.closest('.font-claude-message, [data-is-streaming], [data-testid="assistant-message"], [contenteditable="true"]');
        const els = [
          ...document.querySelectorAll(
            '[role="alert"], [role="dialog"], [aria-live], [class*="toast"], [class*="banner"], [class*="error"]'
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

        const raw = document.body.textContent || '';
        if (raw.length < 3000 && re.test(raw)) return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
        return '';
      }, reSource);
    } catch {
      return '';
    }
  }

  #busyNotice() {
    return this.#notice(
      'temporarily unavailable|no disponible temporalmente|try again (later|in a (minute|moment))|vuelve a intentarlo|high demand|demanda alta|we.?re experiencing|estamos experimentando|something went wrong|algo salió mal|service is busy|servicio ocupado|overloaded'
    );
  }

  #tooLongError() {
    return this.#notice('demasiado largo|too long|message you submitted was too long|prompt is too long|input is too long');
  }

  #composerLen() {
    return this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return ((el?.value ?? el?.innerText ?? '') + '').trim().length;
    }, SEL.input);
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

  async #paste(text) {
    await this.page.bringToFront().catch(() => {});
    try {
      await this.page.click(SEL.input);
      await this.page.focus(SEL.input);
    } catch (e) {
      throw fail(`No pude enfocar el cuadro de chat de Claude: ${e.message}`, 'COMPOSER');
    }
    await this.#clearComposer().catch(() => {});

    const client = await this.page.createCDPSession();
    try {
      await client.send('Input.insertText', { text });
    } finally {
      await client.detach().catch(() => {});
    }
    await sleep(600);

    const len = await this.#composerLen();
    console.log(`   [debug] caracteres en el cuadro: ${len}`);
    if (!len) {
      await this.page.screenshot({ path: 'debug-claude-paste.png' }).catch(() => {});
      throw fail('No se pudo escribir en el cuadro de Claude. Revisá debug-claude-paste.png', 'COMPOSER');
    }
    if (text.length > 200 && len < text.length * 0.5) {
      await this.page.screenshot({ path: 'debug-claude-paste.png' }).catch(() => {});
      throw fail(
        `El cuadro de Claude solo aceptó ${len} de ${text.length} caracteres (posible límite de contexto).`,
        'COMPOSER'
      );
    }
  }

  async #send(before) {
    const sent = async () => {
      await sleep(1500);
      const s = await this.#snapshot();
      const busy = looksBusy(s.pageError) || (await this.#busyNotice());
      if (busy) throw fail(`Claude pidió esperar: ${busy}`, 'BUSY');
      const tooLong = looksTooLong(s.pageError) || (await this.#tooLongError());
      if (tooLong) throw fail(`Claude rechazó el mensaje: ${tooLong}`, 'TOO_LONG');
      if (looksLikeLimit(s.pageError)) return true;
      return (await this.#composerLen()) === 0 || s.assistantCount > before || s.stop;
    };

    const selectors = SEL.send.split(', ');
    try {
      await this.page.waitForSelector(selectors.map((s) => `${s}:not([disabled])`).join(', '), { timeout: 20000 });
    } catch {}
    await sleep(300);

    for (const sel of selectors) {
      const btn = await this.page.$(`${sel}:not([disabled])`);
      if (!btn) continue;
      await btn.click().catch(() => {});
      console.log(`   [debug] click en ${sel}`);
      if (await sent()) return;
    }

    for (let i = 0; i < 2; i++) {
      await this.page.focus(SEL.input).catch(() => {});
      await this.page.keyboard.press('Enter');
      console.log('   [debug] presioné Enter');
      if (await sent()) return;
    }

    if (this.#signedOut()) {
      throw fail('Claude pide iniciar sesión. Iniciá sesión y volvé a intentar.', 'LOGIN');
    }
    const busy = await this.#busyNotice();
    if (busy) throw fail(`Claude pidió esperar: ${busy}`, 'BUSY');
    const tooLong = await this.#tooLongError();
    if (tooLong) throw fail(`Claude rechazó el mensaje: ${tooLong}`, 'TOO_LONG');

    await this.page.screenshot({ path: 'debug-claude-send.png' }).catch(() => {});
    throw fail('El mensaje no se pudo enviar a Claude. Revisá debug-claude-send.png', 'SEND');
  }

  /** Envía un mensaje y devuelve { full, prose, blocks } de la respuesta */
  async ask(text) {
    if (this.#signedOut()) {
      if (this.allowLoginWait) await this.#waitForLogin();
      else throw fail('Claude pide iniciar sesión. Iniciá sesión y volvé a intentar.', 'LOGIN');
    }

    const busyNow = await this.#busyNotice();
    if (busyNow) throw fail(`Claude pidió esperar: ${busyNow}`, 'BUSY');

    const before = await this.#snapshot();
    await this.#paste(text);
    await this.#send(before.assistantCount);

    const t0 = Date.now();
    let waits = 0;
    while (true) {
      const s = await this.#snapshot();
      if (looksLikeLimit(s.pageError)) {
        return { full: '', prose: '', blocks: [], limit: true, pageError: s.pageError };
      }
      if (s.assistantCount > before.assistantCount || s.stop || (s.text.trim() && s.text !== before.text)) break;
      if (++waits % 4 === 0) {
        console.log(
          `   [debug] esperando respuesta (${Math.round((Date.now() - t0) / 1000)}s) · ` +
            `asistente=${s.assistantCount} · stop=${s.stop}`
        );
        const busy = looksBusy(s.pageError) || (await this.#busyNotice());
        if (busy) throw fail(`Claude pidió esperar: ${busy}`, 'BUSY');
      }
      if (Date.now() - t0 > 120000) {
        const busy = await this.#busyNotice();
        if (busy) throw fail(`Claude pidió esperar: ${busy}`, 'BUSY');
        const tooLong = await this.#tooLongError();
        if (tooLong) throw fail(`Claude rechazó el mensaje: ${tooLong}`, 'TOO_LONG');
        await this.page.screenshot({ path: 'debug-claude-ask.png' }).catch(() => {});
        await this.#dumpDom();
        throw fail(
          'No detecté la respuesta de Claude (¿cambió el DOM, límite de uso, login?). Revisá debug-claude-ask.png y debug-dom-claude.json.',
          'RESPONSE'
        );
      }
      await sleep(500);
    }
    console.log('   [debug] respuesta detectada, esperando que termine de generar...');

    const isNew = (s) =>
      s.assistantCount > before.assistantCount || (!!s.text.trim() && s.text !== before.text);

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
      if (!cur && looksLikeLimit(s.pageError)) {
        return { full: '', prose: '', blocks: [], limit: true, pageError: s.pageError };
      }
      if (++ticks % 7 === 0) {
        console.log(
          `   [debug] generando=${s.stop} · caracteres de respuesta=${cur.length} · estable=${stable} · ` +
            `asistente=${s.assistantCount}/${s.rawAssistantCount}`
        );
      }
      if (!cur && !s.stop) {
        if (!noTextSince) noTextSince = Date.now();
        if (!dumped && Date.now() - noTextSince > 5000) {
          dumped = true;
          const busy = looksBusy(s.pageError) || (await this.#busyNotice());
          if (busy) throw fail(`Claude pidió esperar: ${busy}`, 'BUSY');
          await this.#dumpDom();
        }
        if (Date.now() - noTextSince > 20000) {
          const busy = await this.#busyNotice();
          if (busy) throw fail(`Claude pidió esperar: ${busy}`, 'BUSY');
          const tooLong = await this.#tooLongError();
          if (tooLong) throw fail(`Claude rechazó el mensaje: ${tooLong}`, 'TOO_LONG');
          await this.page.screenshot({ path: 'debug-claude-ask.png' }).catch(() => {});
          throw fail(
            'Claude terminó de generar pero no pude leer el texto. Revisá debug-dom-claude.json y debug-claude-ask.png.',
            'DOM'
          );
        }
      } else {
        noTextSince = 0;
      }
      if (cur && cur === last) {
        stable++;
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
      await this.page.screenshot({ path: 'debug-claude-ask.png' }).catch(() => {});
      await this.#dumpDom();
      throw fail(
        'Claude respondió pero no pude leer el texto. Revisá debug-claude-ask.png y debug-dom-claude.json.',
        'DOM'
      );
    }

    const busy = looksBusy(final.pageError || '');
    if (busy) throw fail(`Claude pidió esperar: ${final.pageError}`, 'BUSY');

    const hasActions = final.blocks.some((b) => b.includes('@@@')) || final.full.includes('@@@');
    const limit =
      !hasActions && (looksLikeLimit(pageError) || (final.full.length < 800 && looksLikeLimit(final.full)));

    return { full: final.full, prose: final.prose, blocks: final.blocks, limit, pageError };
  }
}
