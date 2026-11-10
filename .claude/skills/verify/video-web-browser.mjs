import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const run = process.argv[2];
const { port, refs, paths, pairCodes } = JSON.parse(
  readFileSync(join(run, 'fixture.json'), 'utf8')
);
assert(![8399, 8499].includes(port));
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.VERIFY_BROWSER,
});
const base = `http://127.0.0.1:${port}`;
const outside = [];
let lastPage;
const evidence = { passed: false, browser: browser.version(), states: [], readCounts: [] };
try {
  for (const width of process.argv.includes('--red') ? [1280] : [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, locale: 'en-US' });
    const paired = await context.request.post(`${base}/pair`, {
      headers: { origin: base },
      data: { code: pairCodes[width === 1280 ? 0 : 1], name: 'Video proof browser' },
    });
    assert.equal(paired.status(), 200);
    assert.equal((await paired.json()).kind, 'human');
    await context.addInitScript(() => {
      window.__videoUrls = { made: [], revoked: [] };
      const create = URL.createObjectURL.bind(URL),
        revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        const url = create(blob);
        window.__videoUrls.made.push(url);
        return url;
      };
      URL.revokeObjectURL = (url) => {
        window.__videoUrls.revoked.push(url);
        revoke(url);
      };
    });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(base) || url.startsWith('blob:') || url.startsWith('data:'))
        return route.continue();
      outside.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    lastPage = page;
    let byteReads = 0;
    page.on('websocket', (socket) =>
      socket.on('framesent', ({ payload }) => {
        try {
          const message = JSON.parse(String(payload));
          if (
            message.type === 'REQ' &&
            message.method === 'operation.invoke' &&
            ['artifact.file.read', 'file.reference.read'].includes(message.data?.name)
          )
            byteReads++;
        } catch {}
      })
    );
    page.setDefaultTimeout(15000);
    const shot = async (name) => {
      const region = page.locator('section[aria-label="File preview"]');
      await ((await region.count()) ? region : page.locator('body')).screenshot({
        path: join(run, 'evidence', `${name}-${width}.png`),
      });
    };
    const play = async () => {
      const video = page.locator('video');
      await video.waitFor();
      await page.waitForFunction(() => {
        const v = document.querySelector('video');
        return v?.readyState >= 2 && v.duration > 6;
      });
      assert.equal(await video.evaluate((v) => v.paused), true);
      assert.equal(await video.getAttribute('autoplay'), null);
      const readsBeforePlayback = byteReads;
      assert(readsBeforePlayback > 0, 'The byte RPC observer must see the transfer');
      assert((await video.getAttribute('src')).startsWith('blob:'));
      await video.evaluate((v) => {
        v.muted = true;
      });
      const bounds = await video.boundingBox();
      await video.click({ position: { x: 24, y: bounds.height - 48 } });
      await page.waitForFunction(() => {
        const v = document.querySelector('video');
        return v && !v.paused && v.currentTime > 0.1;
      });
      await video.click({ position: { x: 24, y: bounds.height - 48 } });
      await page.waitForFunction(() => document.querySelector('video').paused);
      const before = await video.evaluate((v) => v.currentTime);
      await video.click({
        position: { x: Math.floor(bounds.width * 0.65), y: bounds.height - 22 },
      });
      await page.waitForFunction(
        (time) => {
          const video = document.querySelector('video');
          return video.paused && video.currentTime > time + 1;
        },
        before,
        { timeout: 2000 }
      );
      await video.click({ position: { x: 24, y: bounds.height - 48 } });
      await page.waitForFunction(() => !document.querySelector('video').paused);
      assert.equal(byteReads, readsBeforePlayback, 'Playback and seeking must use the local Blob');
      evidence.readCounts.push({ width, before: readsBeforePlayback, after: byteReads });
      return video;
    };
    await page.goto(`${base}/neo?artifact=${refs['sample.mp4'].artifactId}`);
    if (process.argv.includes('--red')) {
      try {
        await page.locator('video').waitFor({ timeout: 4000 });
      } catch (error) {
        await shot('red-video');
        throw error;
      }
    }
    const video = await play();
    await video.hover();
    await shot('snapshot-playing');
    const snapshotUrl = await video.getAttribute('src');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.waitForURL(`${base}/neo`);
    assert.equal(
      await page.evaluate(
        (url) =>
          fetch(url).then(
            () => true,
            () => false
          ),
        snapshotUrl
      ),
      false
    );
    evidence.states.push({
      width,
      snapshotPlayed: true,
      snapshotSeeked: true,
      localSeeking: true,
      snapshotReleased: true,
    });
    await page.goto(`${base}/neo?artifact=${refs['external.mp4'].artifactId}`);
    await page.waitForFunction(
      () =>
        document.querySelector('video') || document.body.textContent.includes('Try H.264/AAC MP4.')
    );
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        video.muted = true;
        void video.play().catch(() => {});
      }
    });
    await page
      .getByText('This video cannot play here. Try H.264/AAC MP4.', { exact: true })
      .waitFor();
    await shot('unsupported-reference');
    await page.goto(`${base}/neo`);
    await page.getByText('Video samples:', { exact: false }).first().waitFor();
    const tap = (path) =>
      page.getByRole('link', { name: `Open preview: ${path}`, exact: true }).click();
    const close = (name) =>
      width >= 1120
        ? page.getByRole('button', { name: `Close ${name}`, exact: true }).click()
        : page.getByRole('button', { name: 'Back', exact: true }).click();
    await tap(paths[0]);
    const live = await play();
    await live.hover();
    await shot('live-playing');
    const liveUrl = await live.getAttribute('src');
    await close('sample.mp4');
    await page.waitForFunction((url) => window.__videoUrls?.revoked.includes(url), liveUrl);
    await tap(paths[0]);
    await page.locator('video').waitFor();
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    assert.equal(await page.locator('video').evaluate((v) => v.paused), true);
    await close('sample.mp4');
    await tap(paths[1]);
    await page.waitForFunction(
      () =>
        document.querySelector('video') || document.body.textContent.includes('Try H.264/AAC MP4.')
    );
    const mov = await page.waitForFunction(() => {
      const v = document.querySelector('video');
      return v?.readyState >= 2
        ? 'ready'
        : document.body.textContent.includes('Try H.264/AAC MP4.')
          ? 'unsupported'
          : false;
    });
    await shot('quicktime');
    await close('sample.mov');
    evidence.states.push({
      width,
      livePlayed: true,
      liveSeeked: true,
      liveReleased: true,
      reopenedPaused: true,
      quickTime: await mov.jsonValue(),
    });
    await context.close();
  }
  assert.deepEqual(outside, []);
  evidence.passed = true;
  evidence.outsideRequests = outside;
  writeFileSync(join(run, 'evidence/video-web.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} catch (error) {
  await lastPage?.screenshot({ path: join(run, 'evidence/browser-failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
