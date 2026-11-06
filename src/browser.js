// Lanzamiento/conexión compartida de Chrome para todos los proveedores web.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

/**
 * Devuelve { browser, owned }. Si ya hay un browser compartido, lo reutiliza.
 * connect: URL de un Chrome ya abierto con --remote-debugging-port (ej. http://127.0.0.1:9222)
 */
export async function openBrowser({ connect, profileDir, browser, owned = false } = {}) {
  if (browser) return { browser, owned };

  if (connect) {
    return { browser: await puppeteer.connect({ browserURL: connect, defaultViewport: null }), owned: false };
  }

  const executablePath = findChrome();
  if (!executablePath) {
    throw new Error('No encontré Chrome. Define CHROME_PATH o usa --connect http://127.0.0.1:9222');
  }
  console.log(`   [debug] lanzando Chrome: ${executablePath}`);
  console.log(`   [debug] perfil: ${profileDir}`);
  try {
    const b = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: profileDir,
      defaultViewport: null,
      timeout: 45000,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    });
    console.log('   [debug] Chrome lanzado');
    return { browser: b, owned: true };
  } catch (e) {
    throw new Error(
      `No pude lanzar Chrome (${e.message}). Cerrá TODAS las ventanas de Chrome que haya abierto webcode ` +
        `(Administrador de tareas → chrome.exe) o usá --connect con un Chrome abierto a mano.`
    );
  }
}

export async function closeBrowser({ browser, owned } = {}) {
  if (!browser) return;
  try {
    if (owned) await browser.close();
    else await browser.disconnect();
  } catch {}
}
