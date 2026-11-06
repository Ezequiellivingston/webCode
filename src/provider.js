// Gestor de proveedores web: elige ChatGPT, Gemini o DeepSeek, reintenta avisos
// temporales y puede cambiar al proveedor de respaldo si el actual deja de responder.
import { ChatGPT } from './chatgpt.js';
import { Gemini } from './gemini.js';
import { Claude } from './claude.js';
import { DeepSeek } from './deepseek.js';
import { openBrowser, closeBrowser } from './browser.js';

export const PROVIDERS = {
  chatgpt: { cls: ChatGPT, url: 'https://chatgpt.com/', label: 'ChatGPT' },
  gemini: { cls: Gemini, url: 'https://gemini.google.com/app', label: 'Gemini' },
  claude: { cls: Claude, url: 'https://claude.ai/new', label: 'Claude' },
  deepseek: { cls: DeepSeek, url: 'https://chat.deepseek.com/', label: 'DeepSeek' },
};

const ALIASES = {
  gpt: 'chatgpt',
  openai: 'chatgpt',
  google: 'gemini',
  bard: 'gemini',
  anthropic: 'claude',
  ds: 'deepseek',
  deep: 'deepseek',
};

export function normalizeProvider(name = 'chatgpt') {
  const n = String(name).trim().toLowerCase();
  const key = ALIASES[n] || n;
  if (!PROVIDERS[key]) {
    throw new Error(`Proveedor desconocido: "${name}". Usá "chatgpt", "gemini", "claude" o "deepseek".`);
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

const FAILOVER_CODES = new Set(['BUSY', 'RESPONSE', 'COMPOSER', 'SEND', 'DOM', 'LOGIN']);

export class ProviderManager {
  constructor({
    provider = 'chatgpt',
    fallback = '',
    connect,
    profileDir,
    url,
    busyWaitMs = 65000,
    busyRetries = 3,
    allowPrimaryLoginWait = true,
  } = {}) {
    const primary = normalizeProvider(provider);
    const rawFallback = String(fallback || '').trim();
    const rest = /^(none|off|no|-)$/i.test(rawFallback)
      ? []
      : rawFallback
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map(normalizeProvider);
    this.names = [primary, ...rest].filter((v, i, a) => a.indexOf(v) === i);
    this.connect = connect;
    this.profileDir = profileDir;
    this.url = url;
    // --url solo aplica al proveedor principal configurado, no a los respaldos.
    this.urlByName = url ? { [primary]: url } : {};
    this.busyWaitMs = busyWaitMs;
    this.busyRetries = busyRetries;
    this.allowPrimaryLoginWait = allowPrimaryLoginWait;

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
    const name = this.names[index];
    return this.urlByName[name] || PROVIDERS[name].url;
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
      inst = new cfg.cls(this.browser, page, this.#urlFor(index), false, false);
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
            // El proveedor principal explícito puede esperar a que el usuario inicie
            // sesión; con routing automático o como respaldo, fallamos rápido.
            allowLoginWait: !this.freshPages && index === 0 && this.allowPrimaryLoginWait,
          });
        }
        this.instances.set(name, inst);
        this.instance = inst;
        return inst;
      } catch (e) {
        // Si hay un proveedor de respaldo, no esperamos: cambiamos al instante.
        if (e.code === 'BUSY' && !this.hasNext && attempt < this.busyRetries) {
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
        if (e.code === 'BUSY' && this.hasNext) {
          // "Revisión rápida / volvé en 1 minuto" con respaldo: no esperamos.
          console.log(dim('↪ El proveedor pidió esperar; cambio inmediato al respaldo.'));
          switchReason = e.message;
          switchCode = e.code;
        } else if (e.code === 'BUSY' && attempt < this.busyRetries) {
          const delay = this.#busyDelay();
          console.log(dim(`⏳ ${e.message}`));
          console.log(dim(`   Reintentando en ${Math.round(delay / 1000)}s (${attempt + 1}/${this.busyRetries})...`));
          await sleep(delay);
          continue;
        } else if (FAILOVER_CODES.has(e.code) && this.hasNext) {
          switchReason = e.message;
          switchCode = e.code;
        } else {
          throw e;
        }
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

  // Cambia el proveedor activo (usado por el router antes de empezar una tarea).
  async switchTo(name) {
    const target = normalizeProvider(name);
    if (target === this.name) return;
    this.names = [target, ...this.names.filter((n) => n !== target)];
    this.index = 0;
    this.instance = null;
    console.log(dim(`   [debug] cambiando a ${PROVIDERS[target].label}`));
    try {
      await this.ensure();
    } catch (e) {
      if (!(FAILOVER_CODES.has(e.code) && this.hasNext)) throw e;
      await this.#switchNext(e.message, e.code);
    }
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
      allowPrimaryLoginWait: false,
    });
    w.browser = this.browser;
    w.owned = false;
    w.freshPages = true;
    w.index = this.index;
    w.urlByName = { ...this.urlByName };

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
