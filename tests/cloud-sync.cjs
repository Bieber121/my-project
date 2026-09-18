// End-to-end cloud architecture test with an isolated Supabase-compatible server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const database = { life_saves: null, public_state: null };
const streams = new Set();
let mutations = 0;
const pageErrors = [];

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}
function matches(row, filters) {
  return row && filters.every(([key, value]) => String(row[key]) === String(value));
}
function broadcast(table, row, eventType) {
  const message = `data: ${JSON.stringify({ eventType, new: structuredClone(row), old: {} })}\n\n`;
  for (const stream of streams) if (stream.table === table) stream.res.write(message);
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__db' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const query = JSON.parse(raw);
    const current = database[query.table];
    if (query.op === 'select') return send(res, 200, { data: matches(current, query.filters) ? structuredClone(current) : null, error: null });
    if (query.op === 'update') {
      if (!matches(current, query.filters)) return send(res, 200, { data: null, error: null });
      database[query.table] = structuredClone(query.payload);
      mutations++;
      send(res, 200, { data: structuredClone(database[query.table]), error: null });
      return broadcast(query.table, database[query.table], 'UPDATE');
    }
    if (query.op === 'upsert') {
      const eventType = current ? 'UPDATE' : 'INSERT';
      database[query.table] = structuredClone(query.payload);
      mutations++;
      send(res, 200, { data: structuredClone(database[query.table]), error: null });
      return broadcast(query.table, database[query.table], eventType);
    }
    return send(res, 400, { error: { message: 'Unsupported fake query' } });
  }
  if (url.pathname === '/__events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const stream = { table: url.searchParams.get('table'), res };
    streams.add(stream);
    req.on('close', () => streams.delete(stream));
    return;
  }
  send(res, 200, html, 'text/html');
});

const fakeSupabase = `
(() => {
  class Query {
    constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.payload = null; }
    select() { return this; }
    eq(key, value) { this.filters.push([key, value]); return this; }
    update(payload) { this.op = 'update'; this.payload = payload; return this; }
    upsert(payload) { this.op = 'upsert'; this.payload = payload; return this; }
    async maybeSingle() {
      const response = await fetch('/__db', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ table: this.table, op: this.op, filters: this.filters, payload: this.payload }) });
      return response.json();
    }
    then(resolve, reject) { return this.maybeSingle().then(resolve, reject); }
  }
  class Channel {
    constructor(name) { this.name = name; this.callback = null; this.filter = null; this.events = null; }
    on(events, filter, callback) { this.events = events; this.filter = filter; this.callback = callback; return this; }
    subscribe(statusCallback) {
      this.statusCallback = statusCallback;
      if (new URLSearchParams(location.search).get('realtime') === 'off') {
        queueMicrotask(() => statusCallback?.('CHANNEL_ERROR'));
        return this;
      }
      this.events = new EventSource('/__events?table=' + encodeURIComponent(this.filter.table));
      this.events.onopen = () => statusCallback?.('SUBSCRIBED');
      this.events.onmessage = event => this.callback?.(JSON.parse(event.data));
      return this;
    }
    unsubscribe() { this.events?.close?.(); this.statusCallback?.('CLOSED'); }
  }
  const user = { id: 'owner-1', email: 'owner@example.test' };
  window.supabase = { createClient() {
    return {
      from: table => new Query(table),
      channel: name => new Channel(name),
      removeChannel: channel => { channel?.unsubscribe(); },
      auth: {
        getSession: async () => ({ data: { session: { user } }, error: null }),
        getUser: async () => ({ data: { user }, error: null }),
        signInWithPassword: async () => ({ data: { user, session: { user } }, error: null }),
        signOut: async () => ({ error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
      }
    };
  }};
})();`;

async function waitFor(page, predicate, label, timeout = 6500) {
  await page.waitForFunction(predicate, null, { timeout }).catch(error => {
    error.message = `${label}: ${error.message}`;
    throw error;
  });
}
async function open(context, base, suffix = '') {
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base + suffix);
  await waitFor(page, () => supabaseClient && (new URLSearchParams(location.search).get('preview') === '1' ? knownPublicUpdatedAt : knownSaveUpdatedAt), 'cloud bootstrap');
  return page;
}
async function stateOf(page) { return page.evaluate(() => JSON.parse(JSON.stringify(state))); }
async function waitState(page, predicateSource, label, timeout) {
  return waitFor(page, new Function(`return (${predicateSource})(state)`), label, timeout);
}
async function waitArchiveClosed(page) {
  await page.waitForFunction(() => !document.querySelector('#archiveModal').classList.contains('open'));
}

async function run() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER || 'chrome', headless: true });
  const contexts = [];
  try {
    async function context(options = {}) {
      const value = await browser.newContext(options);
      await value.addInitScript({ content: fakeSupabase });
      await value.route('https://cdn.jsdelivr.net/**', route => route.fulfill({ body: '', contentType: 'application/javascript' }));
      contexts.push(value);
      return value;
    }
    const computerContext = await context({ viewport: { width: 1440, height: 900 } });
    const mobileContext = await context({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const friendContext = await context({ viewport: { width: 1024, height: 800 } });
    const staleContext = await context({ viewport: { width: 800, height: 800 } });
    const fallbackContext = await context({ viewport: { width: 900, height: 700 } });

    const computer = await open(computerContext, base);
    const initial = await stateOf(computer);
    const mobile = await open(mobileContext, base);
    const friend = await open(friendContext, base, '?preview=1');
    const stale = await open(staleContext, base, '?realtime=off');
    const fallback = await open(fallbackContext, base, '?preview=1&realtime=off');
    assert.deepEqual(await stateOf(mobile), initial, 'owner startup reads life_saves');
    assert.deepEqual(await stateOf(friend), initial, 'preview startup reads public_state');
    assert.equal(await friend.evaluate(() => localStorage.getItem(STORAGE_KEY)), null, 'preview does not write owner local cache');
    assert.equal(await friend.locator('#milestoneCount').textContent(), String(initial.milestones.length), 'preview renders synced milestone records');
    assert.equal(await friend.locator('#milestoneGroups [data-milestone-id]').count(), await computer.locator('#milestoneGroups [data-milestone-id]').count(), 'preview exposes the same read-only milestone catalog');

    // Legacy arrays migrate losslessly into metadata records with historical fallbacks.
    const legacyMigration = await computer.evaluate(() => {
      const legacy = clone(state);
      legacy.titles.push('历史称号');
      legacy.regions.push('历史区域');
      legacy.coins = 900;
      legacy.coinBalance = 800;
      legacy.gold = 700;
      legacy.currency = 600;
      legacy.balance = 500;
      legacy.shop = [{ name: '旧商品', cost: 100 }];
      const legacyImportedId = 'imported_1723456789000_4821';
      legacy.tasks.push({ id: legacyImportedId, custom: true, imported: true, title: '旧随机导入任务', rank: 'C', exp: 260, coins: 90, attr: '探索', gain: 2, desc: '旧设备已接取' });
      legacy.activeTasks.push(legacyImportedId);
      delete legacy.titleRecords;
      delete legacy.regionRecords;
      const migrated = migrateState(legacy, { persist: false });
      const migratedTask = migrated.tasks.find(x => x.title === '旧随机导入任务');
      return {
        titles: migrated.titles,
        regions: migrated.regions,
        oldTitle: migrated.titleRecords.find(x => x.title === '历史称号'),
        oldRegion: migrated.regionRecords.find(x => x.name === '历史区域'),
        japan: migrated.regionRecords.find(x => x.name === '日本'),
        migratedTaskId: migratedTask.id,
        migratedTaskActive: migrated.activeTasks.includes(migratedTask.id),
        deterministicId: normalizeTask({ title: '旧随机导入任务', rank: 'C', exp: 260, coins: 90, attr: '探索', gain: 2, desc: '旧设备已接取' }).id,
        hasLegacyMoney: needsLegacyMoneyCleanup(migrated),
        taskHasCoins: Object.hasOwn(migratedTask, 'coins'),
        hasShop: Object.hasOwn(migrated, 'shop')
      };
    });
    assert(legacyMigration.titles.includes('历史称号'));
    assert(legacyMigration.regions.includes('历史区域'));
    assert.equal(legacyMigration.oldTitle.source, '历史解锁');
    assert.equal(legacyMigration.oldTitle.unlockedAt, null);
    assert.equal(legacyMigration.oldRegion.source, '历史解锁');
    assert.equal(legacyMigration.japan.source, '七日海外独立远征（日本）');
    assert.match(legacyMigration.migratedTaskId, /^imported_[a-z0-9]{14}$/);
    assert.equal(legacyMigration.migratedTaskId, legacyMigration.deterministicId);
    assert(legacyMigration.migratedTaskActive, 'legacy activeTasks reference migrates with the imported task id');
    assert.equal(legacyMigration.hasLegacyMoney, false, 'legacy monetary fields are removed during migration');
    assert.equal(legacyMigration.taskHasCoins, false, 'legacy task reward is ignored');
    assert.equal(legacyMigration.hasShop, false, 'legacy shop data is discarded');

    // Interactive stats are native keyboard buttons; title switching renders and syncs immediately.
    const titleEntry = computer.locator('button[onclick="openArchiveModal(\'titles\')"]');
    await titleEntry.hover();
    assert.equal(await titleEntry.evaluate(el => getComputedStyle(el).cursor), 'pointer');
    await titleEntry.focus();
    await titleEntry.press('Enter');
    await computer.waitForSelector('#archiveModal.open');
    assert.equal(await computer.locator('#archiveTitle').textContent(), '已解锁称号');
    assert.equal(await computer.locator('.title-card.current').count(), 1);
    await computer.locator('button.title-card', { hasText: '新手旅人' }).click();
    assert.equal((await computer.locator('#heroTitle').textContent()).trim(), '新手旅人');
    await waitState(mobile, 's => s.currentTitle === "新手旅人"', 'title switch reaches mobile owner');
    await waitState(friend, 's => s.currentTitle === "新手旅人"', 'title switch reaches preview');
    await computer.keyboard.press('Escape');
    await waitArchiveClosed(computer);
    assert(!(await computer.evaluate(() => document.body.classList.contains('modal-open'))));

    // Preview can inspect title metadata but receives no equip controls.
    await friend.locator('button[onclick="openArchiveModal(\'titles\')"]').click();
    assert.equal(await friend.locator('#archiveTitle').textContent(), '已解锁称号');
    assert.equal(await friend.locator('button.title-card').count(), 0);
    assert.equal(await friend.locator('.title-card.current').count(), 1);
    await friend.locator('#archiveModal .close-btn').click();
    await waitArchiveClosed(friend);

    // Mobile uses a bottom sheet, and region history includes its inferred source.
    await mobile.evaluate(() => openArchiveModal('regions'));
    await mobile.waitForTimeout(450);
    const mobileSheet = await mobile.locator('.archive-sheet').evaluate(el => {
      const rect = el.getBoundingClientRect();
      return { bottom: rect.bottom, viewport: innerHeight, width: rect.width, screen: innerWidth };
    });
    assert(Math.abs(mobileSheet.bottom - mobileSheet.viewport) < 1);
    assert(mobileSheet.width <= mobileSheet.screen);
    assert((await mobile.locator('.region-card', { hasText: '日本' }).textContent()).includes('七日海外独立远征（日本）'));
    await mobile.locator('#archiveModal .close-btn').click();
    await waitArchiveClosed(mobile);

    // A + C: computer accepts, mobile owner and friend update via Realtime without refresh.
    await computer.evaluate(() => acceptTask('e1'));
    await waitState(mobile, 's => s.activeTasks.includes("e1")', 'mobile receives accepted task');
    await waitState(friend, 's => s.activeTasks.includes("e1")', 'friend receives accepted task');
    assert(database.life_saves.state.activeTasks.includes('e1'));
    assert(database.public_state.state.activeTasks.includes('e1'));

    // A stale device cannot overwrite the newer accepted-task state before its fallback poll.
    await stale.evaluate(() => selectRank('D'));
    await waitState(stale, 's => s.activeTasks.includes("e1")', 'stale owner accepts newer cloud row');
    assert(database.life_saves.state.activeTasks.includes('e1'), 'compare-and-set protects newer cloud state');
    assert(await stale.evaluate(() => getSafetyBackups().some(item => item.reason.includes('同步冲突'))), 'conflicting local state is preserved as a safety backup');

    // B + C: mobile completes; computer and friend update all derived values automatically.
    const beforeCompletion = structuredClone(database.life_saves.state);
    await mobile.evaluate(() => completeTask('e1'));
    await waitState(computer, 's => !s.activeTasks.includes("e1") && s.completed.some(x => x.title === "跑步机 20 分钟")', 'computer receives completion');
    await waitState(friend, 's => !s.activeTasks.includes("e1") && s.completed.some(x => x.title === "跑步机 20 分钟")', 'friend receives completion');
    const completed = await stateOf(computer);
    assert.equal(completed.exp, beforeCompletion.exp + 80);
    assert.equal(Object.hasOwn(completed, 'coins'), false);
    assert.equal(completed.attrs['耐力'], beforeCompletion.attrs['耐力'] + 1);

    // Imported task IDs are deterministic across devices and preserve active/completed state through Realtime.
    const importedPayload = { title: '跨设备导入任务', rank: 'C', exp: 240, coins: 88, attr: '探索', gain: 2, desc: '验证稳定任务 ID 与 activeTasks 同步' };
    const [computerImportedId, mobileImportedId] = await Promise.all([
      computer.evaluate(payload => normalizeTask(payload).id, importedPayload),
      mobile.evaluate(payload => normalizeTask(payload).id, importedPayload)
    ]);
    assert.equal(computerImportedId, mobileImportedId, 'same task content has the same imported id on every device');
    await mobile.evaluate(payload => {
      document.querySelector('#taskCodeInput').value = JSON.stringify(payload);
      importTaskCode();
    }, importedPayload);
    await waitState(computer, `s => s.tasks.some(x => x.id === "${mobileImportedId}")`, 'computer receives mobile imported task');
    await mobile.evaluate(id => acceptTask(id), mobileImportedId);
    await waitState(computer, `s => s.activeTasks.includes("${mobileImportedId}")`, 'computer receives imported active task');
    const importedCard = computer.locator('.task-card', { hasText: '跨设备导入任务' });
    assert((await importedCard.textContent()).includes('正在进行'));
    assert.equal((await importedCard.locator('.action-btn').first().textContent()).trim(), '完成任务');
    await computer.evaluate(id => completeTask(id), mobileImportedId);
    await computer.evaluate(() => closeReward());
    await waitState(mobile, `s => !s.tasks.some(x => x.id === "${mobileImportedId}") && !s.activeTasks.includes("${mobileImportedId}") && s.completed.some(x => x.title === "跨设备导入任务")`, 'mobile receives imported task completion');

    // A cloud save from the old random-ID release is migrated and written back during bootstrap.
    const legacyCloudId = 'imported_1723999999000_7712';
    const legacyCloudTask = { id: legacyCloudId, custom: true, imported: true, title: '云端旧随机任务', rank: 'D', exp: 180, coins: 60, attr: '探索', gain: 1, desc: '验证启动迁移回写' };
    database.life_saves.state.tasks.push(legacyCloudTask);
    database.life_saves.state.activeTasks.push(legacyCloudId);
    const legacyExpedition = database.life_saves.state.completed.find(record => record.title === '七日海外独立远征（日本）');
    delete legacyExpedition.route;
    delete legacyExpedition.places;
    delete legacyExpedition.milestoneTags;
    delete database.life_saves.state.migrations.historicalTravelMetadataV1;
    database.life_saves.updated_at = new Date(Date.parse(database.life_saves.updated_at) + 1000).toISOString();
    const migrationContext = await context({ viewport: { width: 760, height: 760 } });
    const migrationOwner = await open(migrationContext, base);
    const stableCloudId = await migrationOwner.evaluate(() => state.tasks.find(task => task.title === '云端旧随机任务').id);
    assert.match(stableCloudId, /^imported_[a-z0-9]{14}$/);
    await waitState(computer, `s => s.activeTasks.includes("${stableCloudId}")`, 'bootstrap writes migrated imported id back to cloud');
    assert(database.life_saves.state.activeTasks.includes(stableCloudId));
    assert(!database.life_saves.state.activeTasks.includes(legacyCloudId));
    assert.equal(Object.hasOwn(database.life_saves.state.tasks.find(task => task.id === stableCloudId), 'coins'), false);
    const migratedExpedition = database.life_saves.state.completed.find(record => record.title === '七日海外独立远征（日本）');
    assert.equal(migratedExpedition.route, '上海 → 东京');
    assert(migratedExpedition.places.includes('富士山'));
    assert(migratedExpedition.milestoneTags.includes('mountain'));
    assert(database.life_saves.state.milestones.some(record => record.id === 'first-mountain'));
    assert(database.life_saves.state.milestones.some(record => record.id === 'first-cross-city'));
    await migrationOwner.evaluate(id => deleteTask(id), stableCloudId);
    await waitState(computer, `s => !s.tasks.some(x => x.id === "${stableCloudId}") && !s.activeTasks.includes("${stableCloudId}")`, 'migrated task cleanup reaches cloud');
    await waitState(mobile, `s => !s.tasks.some(x => x.id === "${stableCloudId}") && !s.activeTasks.includes("${stableCloudId}")`, 'migrated task cleanup syncs');

    // Public preview remains consistent after refresh.
    await friend.reload();
    await waitState(friend, 's => s.completed.some(x => x.title === "跑步机 20 分钟")', 'friend refresh persists latest public row');
    assert.deepEqual(await stateOf(friend), database.public_state.state);

    // Realtime-off preview catches up through the four-second fallback poll.
    await computer.evaluate(() => acceptTask('e2'));
    await Promise.all([
      waitState(fallback, 's => s.activeTasks.includes("e2")', 'fallback polling updates friend', 6000),
      waitState(stale, 's => s.activeTasks.includes("e2")', 'fallback polling updates owner', 6000)
    ]);

    // New title/region unlock metadata, deletion and FINAL conditions use the same save pipeline.
    await computer.evaluate(() => {
      document.querySelector('#taskName').value = '称号解锁任务';
      document.querySelector('#taskRank').value = 'E';
      document.querySelector('#taskExp').value = '10';
      document.querySelector('#taskAttr').value = '探索';
      document.querySelector('#taskGain').value = '1';
      document.querySelector('#taskTitleReward').value = '同步勇者';
      createTask();
    });
    await waitState(friend, 's => s.tasks.some(x => x.title === "称号解锁任务")', 'friend receives created title task');
    const titleTaskId = database.life_saves.state.tasks.find(x => x.title === '称号解锁任务').id;
    await computer.evaluate(id => { acceptTask(id); completeTask(id); }, titleTaskId);
    await computer.evaluate(() => closeReward());
    await waitState(friend, 's => s.currentTitle === "同步勇者" && s.titleRecords.some(x => x.title === "同步勇者")', 'friend receives title metadata');
    await waitState(mobile, 's => s.currentTitle === "同步勇者"', 'new equipped title reaches mobile');
    const newTitleRecord = database.life_saves.state.titleRecords.find(x => x.title === '同步勇者');
    assert.equal(newTitleRecord.source, '称号解锁任务');
    assert(Number.isFinite(Date.parse(newTitleRecord.unlockedAt)));
    assert(newTitleRecord.equipped);

    await computer.evaluate(() => {
      document.querySelector('#taskCodeInput').value = JSON.stringify({ title: '区域解锁任务', rank: 'A', exp: 20, coins: 10, attr: '探索', gain: 1, regionReward: '测试区域' });
      importTaskCode();
    });
    await waitState(friend, 's => s.tasks.some(x => x.title === "区域解锁任务")', 'friend receives imported region task');
    const regionTaskId = database.life_saves.state.tasks.find(x => x.title === '区域解锁任务').id;
    await computer.evaluate(id => { acceptTask(id); completeTask(id); }, regionTaskId);
    await computer.evaluate(() => closeReward());
    await waitState(friend, 's => s.regionRecords.some(x => x.name === "测试区域")', 'friend receives region metadata');
    const newRegionRecord = database.life_saves.state.regionRecords.find(x => x.name === '测试区域');
    assert.equal(newRegionRecord.source, '区域解锁任务');
    assert(Number.isFinite(Date.parse(newRegionRecord.unlockedAt)));

    await computer.evaluate(() => {
      document.querySelector('#taskName').value = '同步删除任务';
      document.querySelector('#taskTitleReward').value = '';
      createTask();
    });
    await waitState(friend, 's => s.tasks.some(x => x.title === "同步删除任务")', 'friend receives deletable task');
    const customId = database.life_saves.state.tasks.find(x => x.title === '同步删除任务').id;
    await computer.evaluate(id => deleteTask(id), customId);
    await waitState(mobile, 's => !s.tasks.some(x => x.title === "同步删除任务")', 'mobile receives deleted task');

    await computer.evaluate(() => openArchiveModal('regions'));
    const regionCardText = await computer.locator('.region-card', { hasText: '测试区域' }).textContent();
    assert(regionCardText.includes('区域解锁任务'));
    assert(!regionCardText.includes('历史解锁'));
    await computer.locator('#archiveModal').click({ position: { x: 5, y: 5 } });
    await waitArchiveClosed(computer);

    await computer.locator('button[onclick="openArchiveModal(\'records\')"]').click();
    assert.equal((await computer.locator('.record-card').first().locator('.archive-card-name').textContent()).trim(), '区域解锁任务');
    await computer.locator('[data-record-filter="high"]').click();
    assert(await computer.locator('.record-card.high').count() >= 1);
    assert.equal(await computer.locator('.record-card.normal').count(), 0);
    await computer.locator('#archiveModal .close-btn').click();
    await waitArchiveClosed(computer);

    await computer.evaluate(() => toggleFinalCondition(0));
    await waitState(friend, 's => s.finalTask.conditionStatus[0] === true', 'friend receives FINAL condition');

    // Preview mutation entry points are inert and never write Supabase.
    await friend.waitForTimeout(750);
    const mutationsBeforePreviewActions = mutations;
    const databaseBeforePreviewActions = structuredClone(database);
    await friend.evaluate(() => {
      acceptTask('e2'); completeTask('e2'); deleteTask('e2');
      toggleFinalCondition(1); completeFinalTask(); resetAll();
    });
    await friend.waitForTimeout(500);
    assert.equal(mutations, mutationsBeforePreviewActions);
    assert.deepEqual(database, databaseBeforePreviewActions);
    assert.deepEqual(await stateOf(friend), database.public_state.state);

    // D: a reopened mobile page prioritizes the latest cloud save over stale localStorage.
    await mobile.evaluate(staleState => localStorage.setItem(STORAGE_KEY, JSON.stringify(staleState)), initial);
    await mobile.close();
    const reopenedMobile = await open(mobileContext, base);
    await waitState(reopenedMobile, 's => !Object.hasOwn(s, "coins") && s.finalTask.conditionStatus[0] === true', 'reopened mobile restores newest cloud state');
    assert.deepEqual(await stateOf(reopenedMobile), database.life_saves.state);

    // FINAL completion is also a normal cloud mutation and reaches every open client.
    reopenedMobile.on('dialog', dialog => dialog.accept());
    await reopenedMobile.evaluate(() => {
      for (let index = 1; index < state.finalTask.conditionStatus.length; index++) toggleFinalCondition(index);
      completeFinalTask();
    });
    await waitState(computer, 's => s.finalTask.completed && s.completed.some(x => x.rank === "FINAL")', 'computer receives FINAL completion');
    await waitState(friend, 's => s.finalTask.completed && s.completed.some(x => x.rank === "FINAL")', 'friend receives FINAL completion');
    await friend.locator('button[onclick="openArchiveModal(\'records\')"]').click();
    await friend.locator('[data-record-filter="final"]').click();
    assert.equal(await friend.locator('.record-card.final').count(), 1);
    assert((await friend.locator('.record-card.final').textContent()).includes('FINAL'));
    await friend.locator('#archiveModal .close-btn').click();
    await waitArchiveClosed(friend);

    // visibilitychange and online each perform an explicit catch-up pull.
    database.life_saves.state.selectedRank = 'SS';
    database.life_saves.updated_at = new Date(Date.parse(database.life_saves.updated_at) + 1000).toISOString();
    await reopenedMobile.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await waitState(reopenedMobile, 's => s.selectedRank === "SS"', 'foreground refresh pulls latest owner state');
    database.life_saves.state.selectedRank = 'SSS';
    database.life_saves.updated_at = new Date(Date.parse(database.life_saves.updated_at) + 1000).toISOString();
    await computer.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitState(computer, 's => s.selectedRank === "SSS"', 'online refresh pulls latest owner state');
    database.public_state.state.selectedRank = 'A';
    database.public_state.updated_at = new Date(Date.parse(database.public_state.updated_at) + 2000).toISOString();
    await friend.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitState(friend, 's => s.selectedRank === "A"', 'online refresh pulls latest public state');
    assert.deepEqual(pageErrors, [], 'no browser JavaScript errors');

    console.log('PASS A: owner-to-owner accepted task Realtime sync');
    console.log('PASS B: completion sync updates EXP, attributes, records and task status without monetary fields');
    console.log('PASS imported task stable ID, legacy migration, active UI and cross-device completion');
    console.log('PASS C: preview Realtime + four-second fallback polling + refresh persistence');
    console.log('PASS D: reopened owner prioritizes life_saves over stale localStorage');
    console.log('PASS conflict protection, lifecycle refresh, unified save path and preview read-only guards');
  } finally {
    for (const context of contexts) await context.close();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
