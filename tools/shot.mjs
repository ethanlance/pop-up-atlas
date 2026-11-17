// Screenshot + perf probe using the installed Google Chrome (GPU). See docs/ARCHITECTURE.md.
import { chromium } from 'playwright';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const out = arg('out', 'captures/shot.png'), url = arg('url', '?auto=1'), wait = Number(arg('wait', 6000));
const perf = Number(arg('perf', 0)), w = Number(arg('w', 1440)), h = Number(arg('h', 900)), port = arg('port', 5183);
const browser = await chromium.launch({ channel: 'chrome', headless: arg('headed', '') ? false : true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    '--disable-frame-rate-limit=false'] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://localhost:${port}/${url}`);
await page.waitForFunction(() => window.__atlas, null, { timeout: 30000 }).catch(() => errors.push('no __atlas'));
await page.waitForTimeout(wait);
await page.screenshot({ path: out });
const res = { out, errors };
if (perf) {
  await page.evaluate(() => window.__atlas.resetStats());
  await page.waitForTimeout(perf * 1000);
  res.perf = await page.evaluate(() => window.__atlas.stats());
  res.gpu = await page.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2');
    const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; });
}
console.log(JSON.stringify(res, null, 1));
await browser.close();
