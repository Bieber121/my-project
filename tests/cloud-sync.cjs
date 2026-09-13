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

    // B + C: mobile completes; computer and friend update all derived values automatically.
    const beforeCompletion = structuredClone(database.life_saves.state);
    await mobile.evaluate(() => completeTask('e1'));
    await waitState(computer, 's => !s.activeTasks.includes("e1") && s.completed.some(x => x.title === "跑步机 20 分钟")', 'computer receives completion');
    await waitState(friend, 's => !s.activeTasks.includes("e1") && s.completed.some(x => x.title === "跑步机 20 分钟")', 'friend receives completion');
    const completed = await stateOf(computer);
    assert.equal(completed.exp, beforeCompletion.exp + 80);
    assert.equal(completed.coins, beforeCompletion.coins + 30);
    assert.equal(completed.attrs['耐力'], beforeCompletion.attrs['耐力'] + 1);

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

    // New/delete task, FINAL condition and coin exchange all use the same save pipeline.
    await computer.evaluate(() => {
      document.querySelector('#taskName').value = '同步测试任务';
      document.querySelector('#taskRank').value = 'E';
      document.querySelector('#taskExp').value = '10';
      document.querySelector('#taskCoins').value = '5';
      document.querySelector('#taskAttr').value = '探索';
      document.querySelector('#taskGain').value = '1';
      createTask();
    });
    await waitState(friend, 's => s.tasks.some(x => x.title === "同步测试任务")', 'friend receives created task');
    const customId = database.life_saves.state.tasks.find(x => x.title === '同步测试任务').id;
    await computer.evaluate(id => deleteTask(id), customId);
    await waitState(mobile, 's => !s.tasks.some(x => x.title === "同步测试任务")', 'mobile receives deleted task');
    await computer.evaluate(() => toggleFinalCondition(0));
    await waitState(friend, 's => s.finalTask.conditionStatus[0] === true', 'friend receives FINAL condition');
    await computer.evaluate(() => { state.coins = 5000; save(); });
    await waitState(mobile, 's => s.coins === 5000', 'mobile receives generic state mutation');
    await computer.evaluate(() => buyItem(0));
    await waitState(friend, 's => s.coins === 4000', 'friend receives coin exchange');

    // Preview mutation entry points are inert and never write Supabase.
    await friend.waitForTimeout(750);
    const mutationsBeforePreviewActions = mutations;
    const databaseBeforePreviewActions = structuredClone(database);
    await friend.evaluate(() => {
      acceptTask('e2'); completeTask('e2'); deleteTask('e2'); buyItem(0);
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
    await waitState(reopenedMobile, 's => s.coins === 4000 && s.finalTask.conditionStatus[0] === true', 'reopened mobile restores newest cloud state');
    assert.deepEqual(await stateOf(reopenedMobile), database.life_saves.state);

    // FINAL completion is also a normal cloud mutation and reaches every open client.
    reopenedMobile.on('dialog', dialog => dialog.accept());
    await reopenedMobile.evaluate(() => {
      for (let index = 1; index < state.finalTask.conditionStatus.length; index++) toggleFinalCondition(index);
      completeFinalTask();
    });
    await waitState(computer, 's => s.finalTask.completed && s.completed.some(x => x.rank === "FINAL")', 'computer receives FINAL completion');
    await waitState(friend, 's => s.finalTask.completed && s.completed.some(x => x.rank === "FINAL")', 'friend receives FINAL completion');

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
    console.log('PASS B: completion sync updates EXP, coins, attributes, records and task status');
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
