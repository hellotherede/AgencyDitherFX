// Drives bench.html in a real Chrome over the DevTools Protocol and prints
// a before/after table. No dependencies: Node 22 has a global WebSocket.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = 8931;
const DEBUG_PORT = 9333;

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png'
};

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};
const HEADLESS = args.includes('--headless');
const FRAMES = Number(flag('frames', 90));
const ROUNDS = Number(flag('rounds', 3));
const ONLY = flag('only', '');
const OUT = flag('out', '');
const VERIFY = args.includes('--verify');
const CORRECTNESS = args.includes('--correctness');
const RENDERERS = args.includes('--renderers');
const BATCH = flag('batch', '');

// ---------------------------------------------------------------- server
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path = join(ROOT, decodeURIComponent(url.pathname));
    if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ---------------------------------------------------------------- chrome
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) { console.error('No Chrome/Edge found.'); process.exit(1); }

const profile = await mkdtemp(join(tmpdir(), 'adfx-bench-'));
const chromeArgs = [
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  '--disable-extensions', '--disable-popup-blocking',
  // Keep the renderer at full speed even if the window is not focused.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling',
  '--window-size=1500,980',
  '--window-position=40,40',
  `http://127.0.0.1:${PORT}/bench/bench.html`
];
if (HEADLESS) chromeArgs.unshift('--headless=new', '--hide-scrollbars');

const chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('bench.html'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* chrome not up yet */ }
    await sleep(150);
  }
  throw new Error('Could not attach to the benchmark page.');
}

const wsUrl = await findTarget();
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(msg.error.message));
  else slot.resolve(msg.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

async function evaluate(expression, timeout = 900000) {
  const res = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, timeout
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? 'page threw');
  }
  return res.result.value;
}

await send('Runtime.enable');
await send('Page.enable');

// wait for the module graph (and the source image decode) to settle
for (let i = 0; i < 200; i += 1) {
  if (await evaluate('window.__ready === true').catch(() => false)) break;
  await sleep(150);
}

const gpu = await evaluate(`(() => {
  const c = document.createElement('canvas').getContext('webgl');
  const e = c && c.getExtension('WEBGL_debug_renderer_info');
  return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown';
})()`);
const ua = await evaluate('navigator.userAgent');

if (BATCH) await evaluate(`globalThis.__ADFX_BATCH = ${BATCH === 'inf' ? 'Infinity' : Number(BATCH)}`);
const only = ONLY ? JSON.stringify(ONLY.split(',')) : 'null';
if (args.includes('--noise')) {
  const res = await evaluate('window.__noise()');
  const hash = (x, y, seed) => {
    let v = Math.imul(x + seed * 1013, 374761393) ^ Math.imul(y + seed * 7919, 668265263);
    v = Math.imul(v ^ (v >>> 13), 1274126177);
    return ((v ^ (v >>> 16)) >>> 0) / 4294967295;
  };
  const frame = Math.floor(4000 * 0.35 * 0.02);
  console.log('\nnoise readback: shader vs Canvas hash (frame ' + frame + ')');
  console.log('cell  shader  expected');
  res.read.forEach((got, x) => {
    const want = Math.round(hash(x, 0, frame) * 255);
    console.log(String(x).padStart(4) + String(got).padStart(8) + String(want).padStart(10) +
      (Math.abs(got - want) <= 2 ? '  ok' : '  MISMATCH'));
  });
  ws.close(); chrome.kill(); server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
if (args.includes('--diag')) {
  const rows = await evaluate('window.__diag()');
  console.log('symbolDiag', JSON.stringify(await evaluate('globalThis.__symbolDiag')));
  console.log('symbolPixels', JSON.stringify(await evaluate('globalThis.__symbolPixels')));
  for (const row of rows) console.log(JSON.stringify(row));
  ws.close(); chrome.kill(); server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
if (args.includes('--micro')) {
  const rows = await evaluate('window.__micro()');
  console.log('\nmain-thread CPU cost of one WebGL frame');
  console.log('-'.repeat(52));
  for (const row of rows) {
    console.log(row.id.padEnd(16) + row.renderer.padEnd(8) + row.usPerFrame.toFixed(1).padStart(9) + ' us');
  }
  ws.close(); chrome.kill(); server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
if (RENDERERS) {
  const rows = await evaluate('window.__renderers()');
  console.log('\nCanvas vs WebGL on identical config (luminance delta, 0-255)');
  console.log('-'.repeat(78));
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(16)} ${row.actual.padEnd(16)}` +
      ` mean=${row.meanDiff.toFixed(2).padStart(6)}` +
      ` max=${row.maxDiff.toFixed(0).padStart(4)}` +
      ` >8:${row.pctPixels.toFixed(1).padStart(5)}%` +
      ` >32:${row.pct32.toFixed(1).padStart(5)}%` +
      ` >64:${row.pct64.toFixed(1).padStart(5)}%` +
      ` >128:${row.pct128.toFixed(1).padStart(5)}%`
    );
  }
  ws.close(); chrome.kill(); server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
if (CORRECTNESS) {
  const rows = await evaluate('window.__correctness()');
  console.log('\nWebGL transparent-reveal residue (frame 2 must be fully clear)');
  console.log('-'.repeat(72));
  for (const row of rows) {
    if (row.skipped) { console.log(`${row.lib.padEnd(11)} skipped`); continue; }
    if (row.error) { console.log(`${row.lib.padEnd(11)} ERROR ${row.error}`); continue; }
    console.log(
      `${row.lib.padEnd(11)} frame1 inked=${String(row.inkedFirst).padStart(7)}` +
      `  frame2 residue=${String(row.residue).padStart(7)}` +
      `  maxAlpha=${String(row.maxAlpha).padStart(3)}  ` +
      (row.clean ? 'CLEAN' : 'STALE PIXELS')
    );
  }
  ws.close(); chrome.kill(); server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(rows.some(r => r.lib === 'optimized' && !r.clean) ? 1 : 0);
}
if (VERIFY) {
  const rows = await evaluate(`window.__verify({ only: ${only} })`);
  console.log('\npixel parity: baseline vs optimized');
  console.log('-'.repeat(72));
  for (const row of rows) {
    if (row.skipped) { console.log(`${row.id.padEnd(26)} skipped`); continue; }
    if (row.error) { console.log(`${row.id.padEnd(26)} ERROR ${row.error}`); continue; }
    const verdict = row.maxDiff === 0 ? 'IDENTICAL'
      : row.maxDiff <= 2 ? 'ok (rounding)' : 'DIFFERS';
    console.log(
      `${row.id.padEnd(26)} maxDiff=${String(row.maxDiff).padStart(4)}` +
      `  channels changed=${row.pctChannels.toFixed(3)}%  ${verdict}`
    );
  }
  ws.close(); chrome.kill(); server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
const results = await evaluate(
  `window.__bench({ frames: ${FRAMES}, rounds: ${ROUNDS}, only: ${only} })`
);

ws.close();
chrome.kill();
server.close();
await rm(profile, { recursive: true, force: true }).catch(() => {});

// ---------------------------------------------------------------- report
const byId = new Map();
for (const row of results) {
  const slot = byId.get(row.id) ?? {};
  slot[row.lib] = row;
  byId.set(row.id, slot);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n, d = 2) => (v == null ? '—' : v.toFixed(d)).padStart(n);

console.log(`\nGPU: ${gpu}`);
console.log(`UA:  ${ua}`);
console.log(`mode: ${HEADLESS ? 'headless' : 'headful'}  frames/run: ${FRAMES}  rounds: ${ROUNDS}\n`);

const hasB = [...byId.values()].some((s) => s.optimized);
if (hasB) {
  console.log(pad('scenario', 24) + pad('cells', 8) +
    '   before ms    after ms     before fps    after fps       speedup');
  console.log('-'.repeat(96));
  for (const [id, slot] of byId) {
    const a = slot.baseline, b = slot.optimized;
    if (!a || !b) continue;
    console.log(
      pad(id, 24) + pad(a.cells, 8) +
      num(a.flushedMs, 10) + num(b.flushedMs, 12) +
      num(a.capableFps, 15, 1) + num(b.capableFps, 13, 1) +
      num(a.flushedMs / b.flushedMs, 14, 2) + 'x' +
      (b.renderer !== a.renderer || b.warning ? `   [${b.renderer}${b.warning ? ': ' + b.warning : ''}]` : '')
    );
  }
  console.log('\nlive rAF fps (vsync-bound) and phase breakdown (median ms):');
  console.log(pad('scenario', 24) +
    '  live fps b→a       sample b→a        dither b→a         draw b→a');
  console.log('-'.repeat(96));
  for (const [id, slot] of byId) {
    const a = slot.baseline, b = slot.optimized;
    if (!a || !b) continue;
    console.log(
      pad(id, 24) +
      `${num(a.liveFps, 7, 1)} →${num(b.liveFps, 6, 1)}  ` +
      `${num(a.sampleMs, 8, 2)} →${num(b.sampleMs, 7, 2)}  ` +
      `${num(a.ditherMs, 8, 2)} →${num(b.ditherMs, 7, 2)}  ` +
      `${num(a.drawMs, 8, 2)} →${num(b.drawMs, 7, 2)}`
    );
  }
} else {
  console.log(pad('scenario', 24) + pad('cells', 8) +
    '  flushed ms   record ms   capable fps    live fps   sample   dither     draw');
  console.log('-'.repeat(100));
  for (const [id, slot] of byId) {
    const a = slot.baseline;
    console.log(
      pad(id, 24) + pad(a.cells, 8) +
      num(a.flushedMs, 11) + num(a.medianMs, 12) + num(a.capableFps, 14, 1) +
      num(a.liveFps, 12, 1) + num(a.sampleMs, 9) + num(a.ditherMs, 9) + num(a.drawMs, 9)
    );
  }
}

if (OUT) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(OUT, JSON.stringify({ gpu, ua, headless: HEADLESS, results }, null, 2));
  console.log(`\nwrote ${OUT}`);
}
process.exit(0);
