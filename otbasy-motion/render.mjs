// Покадровый рендер: node render.mjs <mode> ...
//   stills 1.5,4.2,...     — отдельные кадры в probe/
//   frames <from> <to> [step] — кадры [from,to) в frames/ (JPEG), для параллельных воркеров
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import path from 'path';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.otf': 'font/otf', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(0);
const port = server.address().port;

const [mode, a, b, c] = process.argv.slice(2);
const q = process.env.Q || '';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/deprecated|PCFSoft/.test(m.text())) console.log('[page]', m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${port}/index.html?${q}`);
await page.waitForFunction('window.READY === true', null, { timeout: 120000 });

if (mode === 'events') {
  fs.writeFileSync(path.join(ROOT, 'events.json'), JSON.stringify(await page.evaluate('window.EVENTS'), null, 1));
} else if (mode === 'stills') {
  fs.mkdirSync(path.join(ROOT, 'probe'), { recursive: true });
  for (const t of a.split(',').map(Number)) {
    const t0 = Date.now();
    await page.evaluate((t) => window.renderAt(t), t);
    await page.screenshot({ path: path.join(ROOT, 'probe', `${(b || 's')}_${t.toFixed(2)}.jpg`), type: 'jpeg', quality: 90 });
    console.log(t, Date.now() - t0, 'ms');
  }
} else if (mode === 'frames') {
  const dir = path.join(ROOT, process.env.OUT || 'frames'); fs.mkdirSync(dir, { recursive: true });
  const from = +a, to = +b, step = +(c || 1), fps = 60;
  for (let i = from; i < to; i += step) {
    const f = path.join(dir, `f${String(i).padStart(5, '0')}.jpg`);
    if (fs.existsSync(f)) continue;
    await page.evaluate((t) => window.renderAt(t), i / fps);
    await page.screenshot({ path: f, type: 'jpeg', quality: 96 });
    if (i % 60 === 0) console.log('frame', i);
  }
}
await browser.close(); server.close();
