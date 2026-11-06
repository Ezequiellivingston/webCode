// Gestor de proveedores web: elige ChatGPT o Gemini, reintenta avisos temporales
// y puede cambiar al proveedor de respaldo si el actual deja de responder.
import { ChatGPT } from './chatgpt.js';
import { Gemini } from './gemini.js';
import { openBrowser, closeBrowser } from './browser.js';

const PROVIDERS = {
  chatgpt: { cls: ChatGPT, url: 'https://chatgpt.com/', label: 'ChatGPT' },
  gemini: { cls: Gemini, url: 'https://gemini.google.com/app', label: 'Gemini' },
};

const ALIASES = {
  gpt: 'chatgpt',
  openai: 'chatgpt',
  google: 'gemini',
  bard: 'gemini',
};

export function normalizeProvider(name = 'chatgpt') {
  const n = String(name).trim().toLowerCase();
  const key = ALIASES[n] || n;
  if (!PROVIDERS[key]) {
    throw new Error(`Proveedor desconocido: "${name}". Usá "chatgpt" o "gemini".`);
  }
  return key;
}

function fail(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const FAILOVER_CODES = new Set(['BUSY', 'RESPONSE', 'COMPOSER', 'SEND', 'DOM']);

export class ProviderManager {
  constructor({
    provider = 'chatgpt',
    fallback = '',
    connect,
    profileDir,
    url,
    busyWaitMs = 65000,
    busyRetries = 3,
  } = {}) {
    const primary = normalizeProvider(provider);
    const rest = String(fallback || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(normalizeProvider);
    this.names = [primary, ...rest].filter((v, i, a) => a.indexOf(v) === i);
    this.connect = connect;
    this.profileDir = profileDir;
    this.url = url;
    this.busyWaitMs = busyWaitMs;
    this.busyRetries = busyRetries;

    this.index = 0;
    this.instance = null;
    this.instances = new Map();
    this.browser = null;
    this.owned = false;
    this.freshPages = false;
  }

  get name() {
    return this.names[this.index];
  }

  get label() {
    return PROVIDERS[this.name].label;
  }

  get hasNext() {
    return this.index < this.names.length - 1;
  }

  static async open(opts = {}) {
    const m = new ProviderManager(opts);
    try {
      await m.ensure();
    } catch (e) {
      if (!(FAILOVER_CODES.has(e.code) && m.hasNext)) throw e;
      // El proveedor principal no está disponible al arrancar: pasamos al respaldo.
      await m.#switchNext(e.message, e.code);
    }
    return m;
  }

  #urlFor(index) {
    const cfg = PROVIDERS[this.names[index]];
    return (index === 0 && this.url) || cfg.url;
  }

  #busyDelay() {
    // Espera base con jitter (±15%) para no golpear al proveedor siempre igual.
    return Math.max(1000, Math.round(this.busyWaitMs * (0.85 + Math.random() * 0.3)));
  }

  async ensure(index = this.index) {
    const name = this.names[index];
    if (this.instances.has(name)) {
      this.instance = this.instances.get(name);
      return this.instance;
    }

    const cfg = PROVIDERS[name];
    console.log(dim(`   [debug] proveedor: ${cfg.label}`));

    // Abrimos/conectamos el navegador una sola vez para poder reintentar el login
    // o los avisos temporales sin relanzar Chrome (el perfil quedaría bloqueado).
    if (!this.browser) {
      ({ browser: this.browser, owned: this.owned } = await openBrowser({
        connect: this.connect,
        profileDir: this.profileDir,
      }));
    }

    // Los workers usan siempre una pestaña propia (nunca reutilizan la del manager).
    let inst = null;
    if (this.freshPages) {
      const page = await this.browser.newPage();
      await page.bringToFront().catch(() => {});
      inst = new cfg.cls(this.browser, page, this.#urlFor(index), false);
    }

    for (let attempt = 0; ; attempt++) {
      try {
        if (inst) {
          await inst.newChat();
        } else {
          inst = await cfg.cls.open({
            url: this.#urlFor(index),
            browser: this.browser,
            owned: false, // el navegador lo cierra ProviderManager
          });
        }
        this.instances.set(name, inst);
        this.instance = inst;
        return inst;
      } catch (e) {
        if (e.code === 'BUSY' && attempt < this.busyRetries) {
          const delay = this.#busyDelay();
          console.log(dim(`⏳ ${e.message}`));
          console.log(dim(`   Reintentando en ${Math.round(delay / 1000)}s (${attempt + 1}/${this.busyRetries})...`));
          await sleep(delay);
          continue;
        }
        throw e;
      }
    }
  }

  async ask(text) {
    if (!this.instance) await this.ensure();

    for (let attempt = 0; ; attempt++) {
      let reply = null;
      let switchReason = null;
      let switchCode = null;

      try {
        reply = await this.instance.ask(text);
      } catch (e) {
        if (e.code === 'BUSY' && attempt < this.busyRetries) {
          const delay = this.#busyDelay();
          console.log(dim(`⏳ ${e.message}`));
          console.log(dim(`   Reintentando en ${Math.round(delay / 1000)}s (${attempt + 1}/${this.busyRetries})...`));
          await sleep(delay);
          continue;
        }
        if (!(FAILOVER_CODES.has(e.code) && this.hasNext)) throw e;
        switchReason = e.message;
        switchCode = e.code;
      }

      if (switchReason || (reply?.limit && this.hasNext)) {
        await this.#switchNext(switchReason || 'el proveedor indicó límite de uso', switchCode || 'RESPONSE');
        throw fail(`Cambiando a ${this.label} para continuar...`, 'RESPONSE');
      }

      return reply;
    }
  }

  async newChat() {
    if (!this.instance) await this.ensure();
    return this.instance.newChat();
  }

  // Crea una sesión aislada para un worker: pestaña propia, proveedor propio y
  // su propio failover. Así un worker no cambia de proveedor a los demás.
  async spawnWorker() {
    if (!this.instance) await this.ensure();

    const w = new ProviderManager({
      provider: this.names[0],
      fallback: this.names.slice(1).join(','),
      connect: this.connect,
      profileDir: this.profileDir,
      url: this.url,
      busyWaitMs: this.busyWaitMs,
      busyRetries: this.busyRetries,
    });
    w.browser = this.browser;
    w.owned = false;
    w.freshPages = true;
    w.index = this.index;

    try {
      await w.ensure();
    } catch (e) {
      if (!(FAILOVER_CODES.has(e.code) && w.hasNext)) throw e;
      await w.#switchNext(e.message, e.code);
    }
    return w;
  }

  async closeWorker() {
    for (const inst of this.instances.values()) {
      await inst.closeWorker().catch(() => {});
    }
    this.instances.clear();
    this.instance = null;
  }

  async close() {
    await closeBrowser({ browser: this.browser, owned: this.owned });
  }

  async #switchNext(reason, code) {
    if (!this.hasNext) throw fail(reason, code || 'RESPONSE');
    const from = this.label;
    this.index++;
    this.instance = null;
    console.log(dim(`↪ ${from} no disponible (${reason}). Cambiando a ${this.label}...`));
    if (code === 'DOM') {
      console.log(dim('   Posible cambio de DOM en el proveedor: verificá los selectores con --probe.'));
    }
    await this.ensure();
  }
}
