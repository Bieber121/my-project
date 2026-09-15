// Milestone backfill, task de-duplication, completion sheet, and responsive UI regression test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'life-milestone-tests-'));
const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(html);
});

async function resetForMilestoneTask(page, id = 'milestone-test') {
  await page.evaluate(taskId => {
    const task = {
      id: taskId, custom: true, rank: 'S', title: '海外独立凌晨跨城当天往返长距离徒步',
      exp: 1, attr: '探索', gain: 1, desc: '一次特殊旅行记录', regionReward: '法国'
    };
    state = migrateState({
      exp: 0, titles: ['新手旅人'], currentTitle: '新手旅人', regions: [], chapters: ['现实世界篇'],
      selectedRank: 'S', tasks: [task], activeTasks: [task.id], attrs: { 探索: 0 }, completed: [], milestones: [],
      migrations: { japanExpedition202608: true, stableImportedTaskIds: true }, finalTask: clone(DEFAULT_STATE.finalTask)
    });
    save();
  }, id);
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith(base)) return route.continue();
    if (route.request().url().includes('@supabase/supabase-js')) {
      return route.fulfill({ body: 'window.supabase={};', contentType: 'application/javascript' });
    }
    return route.fulfill({ body: '', contentType: 'text/plain' });
  });

  try {
    await page.goto(base);
    assert(await page.locator('[data-milestone-id="first-mountain"]').evaluate(el => el.classList.contains('achieved')), 'rendered history marks the Fuji mountain milestone achieved');
    assert(await page.locator('[data-milestone-id="first-cross-city"]').evaluate(el => el.classList.contains('achieved')), 'rendered history marks the Shanghai-to-Tokyo milestone achieved');

    // Old saves are scanned immediately; dates and satisfied conditions are retained.
    const history = await page.evaluate(() => {
      const migrated = migrateState({
        exp: 0, titles: ['新手旅人'], currentTitle: '新手旅人', regions: ['日本'], chapters: [],
        selectedRank: 'E', tasks: [], activeTasks: [], attrs: {}, milestones: [],
        migrations: { japanExpedition202608: true, stableImportedTaskIds: true }, finalTask: clone(DEFAULT_STATE.finalTask),
        completed: [{ title: '七日海外独立远征（日本）', rank: 'A', date: '2026-08', regionReward: '日本', rewards: '解锁区域「日本」' }]
      }, { persist: false });
      return {
        milestones: migrated.milestones,
        expedition: migrated.completed.find(record => record.title === '七日海外独立远征（日本）')
      };
    });
    const historyIds = new Set(history.milestones.map(record => record.id));
    for (const id of ['first-task', 'first-a-task', 'first-overseas-task', 'first-overseas-region', 'first-japan-region', 'first-overseas-independent', 'first-mountain', 'first-cross-city', 'first-special-travel']) {
      assert(historyIds.has(id), `historical save backfills ${id}`);
    }
    assert.equal(history.milestones.find(record => record.id === 'first-task').achievedAt, '2026-08');
    assert.equal(history.expedition.route, '上海 → 东京');
    assert(history.expedition.places.includes('富士山'));
    assert(history.expedition.milestoneTags.includes('mountain'));
    assert(history.expedition.milestoneTags.includes('cross-city'));

    // Route metadata detects travel even when the task text never says “跨城”.
    const routeOnlyMilestones = await page.evaluate(() => migrateState({
      exp: 0, titles: ['新手旅人'], currentTitle: '新手旅人', regions: [], chapters: [],
      selectedRank: 'E', tasks: [], activeTasks: [], attrs: {}, milestones: [],
      migrations: { japanExpedition202608: true, stableImportedTaskIds: true, historicalTravelMetadataV1: true }, finalTask: clone(DEFAULT_STATE.finalTask),
      completed: [{ title: '周末移动记录', rank: 'B', date: '2026-09', route: '上海 → 东京' }]
    }, { persist: false }).milestones.map(record => record.id));
    assert(routeOnlyMilestones.includes('first-cross-city'), 'explicit city-to-city route triggers cross-city milestone');

    await resetForMilestoneTask(page);
    await page.evaluate(() => { completeTask('milestone-test'); completeTask('milestone-test'); });
    await page.waitForSelector('#rewardOverlay.show');
    const result = await page.evaluate(() => ({
      completed: state.completed.length,
      milestoneIds: state.milestones.map(record => record.id),
      region: state.regions.slice(),
      taskCount: state.tasks.length,
      activeCount: state.activeTasks.length,
      overlay: document.getElementById('rewardOverlay').innerText,
      milestoneItems: document.querySelectorAll('#completionMilestoneList .completion-new-item').length
    }));
    assert.equal(result.completed, 1, 'rapid duplicate completion records the task once');
    assert.equal(new Set(result.milestoneIds).size, result.milestoneIds.length, 'milestones never duplicate');
    assert(result.milestoneItems >= 8, 'one meaningful trip can record multiple milestones together');
    assert.deepEqual(result.region, ['法国']);
    assert.equal(result.taskCount, 0);
    assert.equal(result.activeCount, 0);
    assert.match(result.overlay, /已记录到人生档案[\s\S]*任务完成[\s\S]*海外独立凌晨跨城当天往返长距离徒步[\s\S]*等级[\s\S]*S[\s\S]*完成日期[\s\S]*任务代码[\s\S]*新增记录[\s\S]*法国[\s\S]*新增里程碑/);
    assert(!/EXP|金币|属性|MISSION COMPLETE/i.test(result.overlay), 'completion sheet avoids game reward language');
    const removalAudit = await page.evaluate(() => ({
      hasLegacyMoney: needsLegacyMoneyCleanup(state),
      visibleText: document.body.innerText,
      shopSection: Boolean(document.getElementById('shopSection')),
      shopNav: Boolean(document.querySelector('[data-target="shopSection"]')),
      balanceNode: Boolean(document.getElementById('coinValue')),
      taskMoneyInput: Boolean(document.getElementById('taskCoins')),
      encodedTask: decodeTaskCode(encodeTaskCode({ title: '兼容任务', rank: 'E', exp: 1, coins: 100, attr: '探索', gain: 1 }))
    }));
    assert.equal(removalAudit.hasLegacyMoney, false, 'new state contains no legacy monetary data');
    assert.equal(removalAudit.shopSection, false);
    assert.equal(removalAudit.shopNav, false);
    assert.equal(removalAudit.balanceNode, false);
    assert.equal(removalAudit.taskMoneyInput, false);
    assert(!/金币|Coins?|余额|兑换|商城|商店/i.test(removalAudit.visibleText), 'no monetary wording remains visible');
    assert.equal(Object.hasOwn(removalAudit.encodedTask, 'coins'), false, 'new task codes do not carry monetary rewards');

    // A completed task code cannot be imported and completed again.
    const duplicateImport = await page.evaluate(() => {
      const code = state.completed[0].taskCode;
      document.getElementById('taskCodeInput').value = code;
      importTaskCode();
      return { tasks: state.tasks.length, completed: state.completed.length };
    });
    assert.deepEqual(duplicateImport, { tasks: 0, completed: 1 });

    await page.evaluate(() => closeReward());
    await page.waitForFunction(() => !document.getElementById('rewardOverlay').classList.contains('show'));
    await page.reload();
    await page.waitForFunction(() => state.completed.length === 1 && state.milestones.length >= 8);
    assert.equal(await page.locator('[data-milestone-id].achieved').count(), result.milestoneIds.length, 'refresh keeps milestone records');
    assert.equal(await page.locator('#recentMilestones .recent-milestone').count(), 3, 'home shows at most three recent milestones');
    await page.locator('#milestonesSection').scrollIntoViewIfNeeded();
    const desktopGeometry = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, screen: innerWidth, columns: getComputedStyle(document.querySelector('.milestone-grid')).gridTemplateColumns.split(' ').length }));
    assert.deepEqual(desktopGeometry, { width: 1440, screen: 1440, columns: 3 });
    await page.screenshot({ path: path.join(output, 'desktop-milestones.png') });

    // iPhone-width completion uses a reachable bottom sheet and one-column milestone cards.
    await page.setViewportSize({ width: 390, height: 844 });
    await resetForMilestoneTask(page, 'mobile-milestone-test');
    await page.evaluate(() => completeTask('mobile-milestone-test'));
    await page.waitForTimeout(750);
    const mobileGeometry = await page.evaluate(() => {
      const box = document.querySelector('.reward-box').getBoundingClientRect();
      return {
        bottom: Math.round(box.bottom), viewport: innerHeight,
        width: document.documentElement.scrollWidth, screen: innerWidth,
        columns: getComputedStyle(document.querySelector('.milestone-grid')).gridTemplateColumns.split(' ').length,
        buttonHeight: Math.round(document.querySelector('.completion-close').getBoundingClientRect().height)
      };
    });
    assert.deepEqual(mobileGeometry, { bottom: 844, viewport: 844, width: 390, screen: 390, columns: 1, buttonHeight: 48 });
    await page.screenshot({ path: path.join(output, 'mobile-completion.png') });

    // Reduced motion replaces movement with a short fade.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.reward-box').evaluate(el => getComputedStyle(el).animationName), 'completionFade');
    assert.deepEqual(consoleErrors, [], 'no console or page errors');

    console.log('PASS milestone history backfill, duplicate guards, multi-trigger settlement, refresh persistence, desktop/mobile layout, and reduced motion');
    console.log('Screenshots:', output);
  } finally {
    await context.close();
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
