// Jarvis desktop launcher.
//
// Starts the local server and opens Jarvis in its own app window (Microsoft
// Edge or Google Chrome in app mode, with a private profile kept in your
// user data folder). Closing that window quits Jarvis. If neither browser is
// installed, Jarvis opens in your default browser and keeps running until
// you close the console window.
//
//   node desktop.js           run from source
//   Jarvis.exe / ./Jarvis     the packaged app (see scripts/build-desktop.mjs)

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, delimiter } from 'node:path';
import { createServer } from './server.js';

// A fixed port keeps the page's origin the same between launches, which is
// what keeps your saved keys, settings and memories.
const PORT = Number(process.env.JARVIS_PORT || 47815);
const URL_ = `http://127.0.0.1:${PORT}/`;

export function dataDir() {
  const os = platform();
  if (os === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Jarvis');
  if (os === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Jarvis');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'jarvis');
}

function onPath(names) {
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    for (const n of names) {
      const p = join(dir, n);
      if (dir && existsSync(p)) return p;
    }
  }
  return null;
}

export function findAppBrowser() {
  const os = platform();
  if (os === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    const rel = [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
    ];
    for (const r of rel) for (const root of roots) { const p = join(root, ...r); if (existsSync(p)) return p; }
    return null;
  }
  if (os === 'darwin') {
    const apps = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
    for (const base of ['', homedir()]) for (const a of apps) { const p = base + a; if (existsSync(p)) return p; }
    return null;
  }
  return onPath(['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'microsoft-edge-stable', 'chromium', 'chromium-browser']);
}

function openDefaultBrowser(url) {
  const os = platform();
  const [cmd, args] = os === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : os === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
  } catch { console.log(`Open ${url} in your browser.`); }
}

// Opens the app window. Resolves when the window is closed (or immediately
// when falling back to the default browser, with { attached: false }).
function openWindow() {
  const browser = findAppBrowser();
  if (!browser) {
    openDefaultBrowser(URL_);
    return { attached: false, done: new Promise(() => {}) };
  }
  const profile = join(dataDir(), 'window');
  mkdirSync(profile, { recursive: true });
  const child = spawn(browser, [
    `--app=${URL_}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,860',
  ], { stdio: 'ignore' });
  return { attached: true, done: new Promise((r) => { child.on('exit', r); child.on('error', r); }) };
}

async function alreadyRunning() {
  try {
    const r = await fetch(`${URL_}health`, { signal: AbortSignal.timeout(800) });
    return (await r.json()).app === 'jarvis';
  } catch { return false; }
}

export async function runDesktop({ assets } = {}) {
  console.log('Jarvis: a voice-first thinking partner that only talks to Claude.');
  if (await alreadyRunning()) {
    console.log('Jarvis is already running; opening another window.');
    openWindow();
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  const server = createServer({ assets });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  }).catch((e) => {
    console.error(e.code === 'EADDRINUSE'
      ? `Port ${PORT} is used by another program. Close it, or start Jarvis with JARVIS_PORT set to a free port.`
      : `Jarvis could not start: ${e.message}`);
    process.exit(1);
  });
  console.log(`Running at ${URL_}`);
  const win = openWindow();
  if (win.attached) {
    console.log('Close the Jarvis window to quit.');
    const started = Date.now();
    await win.done;
    if (Date.now() - started > 4000) {
      server.close();
      process.exit(0);
    }
    // The browser handed the window to a process it already had running, so
    // we can't tell when it closes. Stay up until the console is closed.
    console.log('Close this console window to quit Jarvis.');
  } else {
    console.log('Opened in your default browser (install Microsoft Edge or Google Chrome for a separate app window).');
    console.log('Close this console window to quit Jarvis.');
  }
}

const invokedDirectly = process.argv[1] && /desktop\.(m?js)$/.test(process.argv[1]);
if (invokedDirectly) runDesktop();
