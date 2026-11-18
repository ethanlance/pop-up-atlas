// Blind A/B builder: node tools/ab.mjs <round>. Shoots game frames, pairs each with a concept frame in random
// left/right order, writes critic/round<N>/pair_k.jpg and key.json (the critic must NOT read key.json), plus a
// fold-motion strip (12 frames, 100 ms apart) critic/round<N>/strip.jpg.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const round = process.argv[2] ?? '1';
const dir = `critic/round${round}`; mkdirSync(dir, { recursive: true });
const shots = [ { seed: 7, wait: 9000, concept: 2 }, { seed: 3, wait: 12000, concept: 3 }, { seed: 11, wait: 15000, concept: 4 },
  { seed: 5, wait: 7000, concept: 1 } ];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const key = {};
for (const [i, s] of shots.entries()) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(`http://localhost:5183/?auto=1&seed=${s.seed}`);
  await page.waitForFunction(() => window.__atlas);
  await page.waitForTimeout(s.wait);
  const g = `${dir}/game_${i + 1}.png`;
  await page.screenshot({ path: g });
  if (i === 0) {
    // Motion strip: fresh context with video, walk straight up the page, frames exactly 100 ms apart.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir, size: { width: 1280, height: 720 } } });
    const vp = await ctx.newPage();
    await vp.goto(`http://localhost:5183/?seed=${s.seed}`);
    await vp.waitForFunction(() => window.__atlas);
    await vp.waitForTimeout(2500);
    await vp.keyboard.down('KeyW');
    await vp.waitForTimeout(5000);
    await vp.keyboard.up('KeyW');
    const video = await vp.video().path();
    await ctx.close();
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '5.0', '-i', video, '-vf', 'fps=10,scale=640:360,tile=4x3', '-frames:v', '1', `${dir}/strip.jpg`]);
  }
  await page.close();
  const c = `reference/concept/concept_0${s.concept}.png`;
  const gameLeft = Math.random() < 0.5;
  const [l, r] = gameLeft ? [g, c] : [c, g];
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', l, '-i', r, '-filter_complex',
    '[0]scale=1280:720[a];[1]scale=1280:720[b];[a][b]hstack=inputs=2', '-q:v', '2', `${dir}/pair_${i + 1}.jpg`]);
  key[`pair_${i + 1}`] = { left: gameLeft ? 'game' : 'reference', right: gameLeft ? 'reference' : 'game', seed: s.seed, concept: s.concept };
}
writeFileSync(`${dir}/key.json`, JSON.stringify(key, null, 1));
await browser.close();
console.log('done', dir);
