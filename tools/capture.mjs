// Gameplay capture without a screen recorder: steps game time exactly 1/30 s per frame (two 1/60 s sub-steps),
// screenshots each frame and encodes with ffmpeg. node tools/capture.mjs [--seconds 30] [--seed 7] [--out captures/gameplay.mp4]
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const seconds = Number(arg('seconds', 30)), seed = arg('seed', 7), out = arg('out', 'captures/gameplay.mp4');
const dir = 'captures/_frames'; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.goto(`http://localhost:${arg('port', 5183)}/?auto=1&manual=1&seed=${seed}`);
await page.waitForFunction(() => window.__atlas);
await page.evaluate(() => window.__atlas.step(1000 / 60, 90));
for (let f = 0; f < seconds * 30; f++) {
  await page.evaluate(() => window.__atlas.step(1000 / 60, 2));
  await page.screenshot({ path: `${dir}/f${String(f).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 92 });
}
await browser.close();
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '30', '-i', `${dir}/f%05d.jpg`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', out]);
rmSync(dir, { recursive: true, force: true });
console.log('wrote', out);
