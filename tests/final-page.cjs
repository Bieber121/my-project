// Run with Node.js and Playwright available: node tests/final-page.cjs
// Uses an isolated browser, local HTTP server and blocked cloud traffic; never writes a user's save.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const baseline = execFileSync('git', ['show', 'f980176:index.html'], { cwd: root, encoding: 'utf8' });
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'life-final-tests-'));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(req.url.startsWith('/baseline') ? baseline : html);
});
const routes = ['home', 'tasksSection', 'recordsSection', 'shopSection', 'finalSection'];
const pause = (page, ms) => page.waitForTimeout(ms);
async function active(page, id) {
  await page.waitForFunction(id => location.hash === '#' + id &&
    document.querySelectorAll('.nav-item.active').length === 1 &&
    document.querySelector('.nav-item.active').dataset.target === id &&
    document.querySelector('[aria-current="page"]').dataset.target === id, id);
}
async function instant(page, id) {
  await page.evaluate(id => navigatePage(id, { behavior: 'instant' }), id);
  await active(page, id);
  await pause(page, 220);
}
async function content(page) {
  return page.evaluate(() => ({
    title: document.querySelector('#finalTitle').textContent,
    description: document.querySelector('#finalDesc').textContent,
    conditions: document.querySelector('#finalConditions').textContent,
    rewards: document.querySelector('#finalRewards').textContent,
    actions: document.querySelector('#finalActions').textContent,
    progress: document.querySelector('#finalProgress').textContent,
    task: JSON.stringify(state.finalTask)
  }));
}
async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER || 'chrome', headless: true });
  try {
    for (const profile of [
      { name: 'desktop', viewport: { width: 1440, height: 1000 }, hasTouch: false },
      { name: 'mobile', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 },
      { name: 'tablet', viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
    ]) {
      const { name, ...options } = profile;
      const context = await browser.newContext(options);
      await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.fulfill({ body: '', contentType: 'application/javascript' }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base + '/baseline');
      const before = await content(page);
      await page.goto(base);
      await active(page, 'home');
      assert.deepEqual(await content(page), before, name + ': existing content and state preserved');
      assert.equal(await page.evaluate(() => document.body.dataset.finalDevice), name);
      for (const id of routes.slice(0, 4)) {
        await page.locator(`[data-target="${id}"]`).click();
        await active(page, id);
        await pause(page, 1500);
        await active(page, id);
      }
      // Observe actual start events, not merely final CSS state.
      await page.evaluate(() => {
        window.entranceStarts = 0;
        window.frameDeltas = [];
        const original = Element.prototype.animate;
        Element.prototype.animate = function (...args) {
          if (this.classList.contains('final-title')) window.entranceStarts++;
          return original.apply(this, args);
        };
      });
      await page.locator('[data-target="finalSection"]').click();
      await active(page, 'finalSection');
      await page.waitForFunction(() => window.entranceStarts === 1);
      await pause(page, 230);
      assert.equal(await page.evaluate(() => window.entranceStarts), 1);
      assert(await page.locator('.bottom-nav').evaluate(el => el.classList.contains('final-pressure')));
      assert(await page.locator('.nav-pressure-shade').evaluate(el => +getComputedStyle(el).opacity > .1));
      assert.equal(await page.locator('.bottom-nav button:disabled').count(), 0);
      assert.equal(await page.locator('.final-particles i').count(), name === 'mobile' ? 8 : name === 'tablet' ? 14 : 24);
      const timing = await page.evaluate(() => {
        const animation = selector => document.querySelector(selector).getAnimations()[0].effect.getTiming().delay;
        return { title: animation('.final-title'), progress: animation('.final-progress-wrap'),
          conditions: [...document.querySelectorAll('.final-condition')].map(el => el.getAnimations()[0].effect.getTiming().delay),
          locked: animation('.final-actions') };
      });
      assert(timing.title < timing.progress && timing.progress < timing.conditions[0]);
      assert(timing.conditions.every((delay, i, all) => i === 0 || delay > all[i - 1]));
      assert(timing.locked > timing.conditions.at(-1));
      await page.screenshot({ path: path.join(output, name + '-pressure.png') });
      await page.evaluate(() => {
        const end = performance.now() + 1700;
        let previous = performance.now();
        function sample(now) {
          window.frameDeltas.push(now - previous);
          previous = now;
          if (now < end) requestAnimationFrame(sample);
        }
        requestAnimationFrame(sample);
      });
      await pause(page, 700);
      await page.screenshot({ path: path.join(output, name + '-unsealing.png') });
      await page.waitForSelector('.final-settled');
      assert(!(await page.locator('.bottom-nav').evaluate(el => el.classList.contains('final-pressure'))));
      assert.equal(await page.locator('.nav-pressure-shade').evaluate(el => getComputedStyle(el).opacity), '0');
      assert.equal(await page.locator('.final-title').evaluate(el => getComputedStyle(el).opacity), '1');
      assert.equal(await page.locator('.final-actions').evaluate(el => getComputedStyle(el).opacity), '1');
      await page.screenshot({ path: path.join(output, name + '-settled.png'), fullPage: false });
      await page.evaluate(() => document.querySelector('#finalActions').scrollIntoView({ behavior: 'instant', block: 'center' }));
      await pause(page, 220);
      await active(page, 'finalSection');
      await page.screenshot({ path: path.join(output, name + '-locked.png') });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ': no horizontal overflow');
      assert.deepEqual(await content(page), before);
      // Scrolling around the section, including its boundary, must not restart this visit.
      for (const offset of [500, 130, -0.58, -0.5, 0]) {
        await page.evaluate(offset => window.scrollTo({ top: document.querySelector('#finalSection').offsetTop +
          (offset < 0 ? innerHeight * offset : offset), behavior: 'instant' }), offset);
        await pause(page, 220);
      }
      assert.equal(await page.evaluate(() => window.entranceStarts), 1);
      await active(page, 'finalSection');
      await instant(page, 'home');
      // At 44% viewport coverage wait; at 46% start, even on a tall mobile section.
      await page.evaluate(() => window.scrollTo({ top: document.querySelector('#finalSection').offsetTop - innerHeight * .56, behavior: 'instant' }));
      await pause(page, 250);
      assert.equal(await page.evaluate(() => window.entranceStarts), 1);
      await page.evaluate(() => window.scrollBy({ top: innerHeight * .02, behavior: 'instant' }));
      await pause(page, 250);
      await active(page, 'finalSection');
      assert.equal(await page.evaluate(() => window.entranceStarts), 2, name + ': replay after leaving');
      await page.waitForSelector('.final-settled');
      const frames = await page.evaluate(() => window.frameDeltas.filter(n => n > 0).sort((a, b) => a - b));
      console.log('Frame sample', name, 'median ms:', frames[Math.floor(frames.length / 2)]?.toFixed(1), 'p95 ms:', frames[Math.floor(frames.length * .95)]?.toFixed(1));
      // Refresh/deep link and history derive active state from the URL.
      await page.reload();
      await active(page, 'finalSection');
      await page.waitForSelector('.final-settled');
      await instant(page, 'shopSection');
      await instant(page, 'finalSection');
      await page.goBack();
      await active(page, 'shopSection');
      assert.equal(await page.locator('.final-vignette').evaluate(el => getComputedStyle(el).opacity), '0');
      await page.goForward();
      await active(page, 'finalSection');
      await page.waitForSelector('.final-settled');
      // Mid-animation route changes must leave every navigation button usable.
      await instant(page, 'home');
      await instant(page, 'finalSection');
      await page.locator('[data-target="tasksSection"]').click();
      await active(page, 'tasksSection');
      assert(!(await page.locator('.bottom-nav').evaluate(el => el.classList.contains('final-pressure'))));
      await pause(page, 1500);
      await active(page, 'tasksSection');
      // Dynamic reduced-motion changes cancel an in-progress sequence immediately.
      await instant(page, 'finalSection');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await pause(page, 100);
      assert.equal(await page.locator('.final-title').evaluate(el => getComputedStyle(el).opacity), '1');
      assert.equal(await page.locator('.final-vignette').evaluate(el => getComputedStyle(el).display), 'none');
      assert(!(await page.locator('.bottom-nav').evaluate(el => el.classList.contains('final-pressure'))));
      await page.reload();
      await active(page, 'finalSection');
      assert.equal(await page.locator('.final-particles i').count(), 0);
      assert.equal(await page.locator('.final-title').evaluate(el => el.getAnimations().length), 0);
      assert.deepEqual(await content(page), before);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await instant(page, 'home');
      await instant(page, 'finalSection');
      // Re-rendering live data during an entrance must neither replay nor hide fresh controls.
      await page.evaluate(() => renderFinal());
      assert.equal(await page.locator('.final-title').evaluate(el => getComputedStyle(el).opacity), '1');
      assert.equal(await page.locator('.final-condition').first().evaluate(el => getComputedStyle(el).opacity), '1');
      assert(!(await page.locator('.bottom-nav').evaluate(el => el.classList.contains('final-pressure'))));
      // Breakpoints depend on width AND pointer type; resizing keeps current content visible.
      for (const width of [320, 768, 769, 1280]) {
        await page.setViewportSize({ width, height: profile.viewport.height });
        await pause(page, 100);
        const expected = profile.hasTouch ? width <= 768 ? 'mobile' : 'tablet' : width <= 1024 ? 'tablet' : 'desktop';
        assert.equal(await page.evaluate(() => document.body.dataset.finalDevice), expected);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} at ${width}: no horizontal overflow`);
      }
      // The original checkbox/progress/reward gating remains live in an isolated save.
      await page.locator('.final-condition').first().click();
      assert.equal(await page.locator('#finalProgress').textContent(), '1 / 5');
      assert(await page.locator('.final-action-disabled').isDisabled());
      await page.locator('.final-condition').first().click();
      assert.equal(await page.locator('#finalProgress').textContent(), '0 / 5');
      assert.deepEqual(errors, [], name + ': no browser JavaScript errors');
      console.log('PASS', name, 'navigation, history, refresh, entrance, stagger, cancellation, reduced motion, content and conditions');
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  console.log('Screenshots:', output);
}
run().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
