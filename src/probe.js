// Verificación de selectores: abre cada proveedor, inspecciona su DOM y avisa
// si los selectores del driver siguen siendo válidos (o si falta iniciar sesión).
import fs from 'node:fs';
import { openBrowser, closeBrowser } from './browser.js';
import { SEL as CHATGPT_SEL } from './chatgpt.js';
import { SEL as GEMINI_SEL } from './gemini.js';
import { SEL as DEEPSEEK_SEL } from './deepseek.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

const PROVIDERS = {
  chatgpt: {
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    sel: CHATGPT_SEL,
    login: /\/auth\/|log-?in|accounts/i,
    busy:
      /revisi[oó]n r[aá]pida|siga siendo confiable|vuelve a intentarlo en|temporarily unavailable|high demand|demanda alta/i,
  },
  gemini: {
    label: 'Gemini',
    url: 'https://gemini.google.com/app',
    sel: GEMINI_SEL,
    login: /accounts\.google\.com|signin|\/login/i,
    busy: /temporarily unavailable|no disponible temporalmente|try again|vuelve a intentarlo|high demand|demanda alta/i,
  },
  deepseek: {
    label: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    sel: DEEPSEEK_SEL,
    login: /\/sign_in|\/signin|\/login|\/forgot_password|\/reset_password/i,
    busy: /temporarily unavailable|no disponible temporalmente|try again|vuelve a intentarlo|high demand|demanda alta|servidor ocupado/i,
    sendRequired: false,
  },
};

// Se ejecuta dentro de la página. Recibe los selectores como argumento.
function inspect(selectors) {
  const count = (sel) => {
    try {
      return document.querySelectorAll(sel).length;
    } catch {
      return -1;
    }
  };
  const first = (sel) => {
    try {
      const el = document.querySelector(sel);
      if (!el) return '';
      return (el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.tagName || '').slice(0, 60);
    } catch {
      return '';
    }
  };

  const groups = {};
  for (const [key, sel] of Object.entries(selectors)) {
    const alternatives = sel.split(',').map((s) => s.trim()).filter(Boolean);
    const matches = alternatives.map((s) => ({ selector: s, count: count(s), first: first(s) }));
    groups[key] = {
      total: matches.reduce((n, m) => n + Math.max(0, m.count), 0),
      matches: matches.filter((m) => m.count > 0),
      broken: matches.filter((m) => m.count < 0).map((m) => m.selector),
    };
  }

  const bodyClass = document.body.className || '';
  return {
    url: location.href,
    title: document.title,
    bodyClass,
    // Ojo: "hide-ogb-signed-out-mweb" es un flag de CSS, no significa sin sesión.
    signedOut: /(^|\s)viewer-signed-out(\s|$)/.test(bodyClass),
    groups,
    buttons: [...document.querySelectorAll('button')]
      .map((b) => ({
        aria: b.getAttribute('aria-label'),
        testid: b.getAttribute('data-test-id'),
        cls: b.className ? String(b.className).slice(0, 60) : '',
        text: (b.innerText || '').trim().slice(0, 30),
        disabled: b.disabled,
        visible: !!(b.offsetWidth || b.offsetHeight || b.getClientRects().length),
      }))
      .filter((b) => b.visible)
      .slice(0, 80),
    bodyText: (document.body.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 800),
  };
}

async function probeOne(browser, name, { url, waitMs }) {
  const cfg = PROVIDERS[name];
  const target = url || cfg.url;
  console.log(`\n${cfg.label} ${dim('· ' + target)}`);

  const page = await browser.newPage();
  await page.bringToFront().catch(() => {});
  try {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      console.log(red(`  ✘ no pude navegar: ${e.message}`));
      return false;
    }

    let info;
    const deadline = Date.now() + waitMs;
    while (true) {
      info = await page.evaluate(inspect, cfg.sel);
      if (info.groups.input.total > 0 || Date.now() > deadline) break;
      await sleep(1000);
    }

    // El botón de enviar suele aparecer recién al escribir: probamos sin enviar.
    if (info.groups.input.total > 0) {
      try {
        await page.click(cfg.sel.input);
        await page.focus(cfg.sel.input);
        const client = await page.createCDPSession();
        try {
          await client.send('Input.insertText', { text: 'webcode probe' });
        } finally {
          await client.detach().catch(() => {});
        }
        await sleep(2000);
      } catch {}
      info = await page.evaluate(inspect, cfg.sel);

      // Limpiar el texto de prueba.
      const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.keyboard.down(mod).catch(() => {});
      await page.keyboard.press('KeyA').catch(() => {});
      await page.keyboard.up(mod).catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
    }

    const login = cfg.login.test(info.url) || cfg.login.test(info.title) || info.signedOut;
    const busy = cfg.busy.test(info.bodyText);

    for (const [key, g] of Object.entries(info.groups)) {
      const required = key === 'input' || (key === 'send' && cfg.sendRequired !== false);
      const ok = g.total > 0;
      const mark = ok ? green('✓') : required ? red('✘') : yellow('·');
      const detail = g.matches
        .map((m) => `${m.selector} (${m.count})`)
        .slice(0, 3)
        .join(', ');
      const note = !ok && key === 'assistant' ? dim('  (normal en un chat vacío)') : '';
      const note2 = !ok && key === 'stop' ? dim('  (solo aparece mientras responde)') : '';
      const note3 = !ok && key === 'send' && cfg.sendRequired === false ? dim('  (se envía con Enter)') : '';
      console.log(`  ${mark} ${key}: ${g.total}${detail ? dim(`  → ${detail}`) : ''}${note}${note2}${note3}`);
    }

    if (login) console.log(yellow('  ⚠ Parece una pantalla de login: iniciá sesión una vez en ese proveedor.'));
    if (busy) console.log(yellow('  ⚠ Se detectó un aviso temporal del proveedor (revisión/alta demanda).'));

    const out = `debug-probe-${name}.json`;
    fs.writeFileSync(out, JSON.stringify(info, null, 2));
    console.log(dim(`  DOM guardado en ${out}`));

    const sendOk = info.groups.send.total > 0 || cfg.sendRequired === false;
    const coreOk = info.groups.input.total > 0 && sendOk;
    return coreOk && !login;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function probeProviders({ providers, connect, profileDir, url, waitMs = 20000 }) {
  const names = [...new Set(providers)].filter((n) => PROVIDERS[n]);
  const { browser, owned } = await openBrowser({ connect, profileDir });
  console.log(dim('Verificando selectores de webcode...'));
  let allOk = true;
  try {
    for (let i = 0; i < names.length; i++) {
      const ok = await probeOne(browser, names[i], { url: i === 0 ? url : undefined, waitMs });
      if (!ok) allOk = false;
    }
  } finally {
    await closeBrowser({ browser, owned });
  }

  console.log(allOk ? green('\n✔ Selectores principales OK.') : red('\n✘ Hay selectores rotos o falta sesión.'));
  return allOk;
}
