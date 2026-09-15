// Region detail, compression, owner controls, and preview read-only regression test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'life-region-tests-'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
});

function fakeSupabase(seed = {}) {
  return `(() => {
    const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
    const db = ${JSON.stringify(seed.db || { life_saves: null, public_state: null, region_details: [], region_photos: [] })};
    const uploaded = new Map();
    const failures = {};
    const matches = (row, filters) => filters.every(([key, value]) => String(row?.[key]) === String(value));
    class Query {
      constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.payload = null; }
      select() { return this; }
      eq(key, value) { this.filters.push([key, value]); return this; }
      update(payload) { this.op = 'update'; this.payload = payload; return this; }
      upsert(payload) { this.op = 'upsert'; this.payload = payload; return this; }
      insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
      delete() { this.op = 'delete'; return this; }
      async execute(single = false) {
        const collection = Array.isArray(db[this.table]);
        if (this.op === 'select') {
          const rows = collection ? db[this.table].filter(row => matches(row, this.filters)) : (matches(db[this.table], this.filters) ? db[this.table] : null);
          return { data: clone(single && Array.isArray(rows) ? rows[0] || null : rows), error: null };
        }
        if (collection) {
          if (this.op === 'insert') { db[this.table].push(clone(this.payload)); return { data: clone(this.payload), error: null }; }
          if (this.op === 'upsert') {
            const index = db[this.table].findIndex(row => row.owner_id === this.payload.owner_id && row.region_id === this.payload.region_id);
            if (index >= 0) db[this.table][index] = clone(this.payload); else db[this.table].push(clone(this.payload));
            return { data: clone(this.payload), error: null };
          }
          if (this.op === 'delete') { db[this.table] = db[this.table].filter(row => !matches(row, this.filters)); return { data: null, error: null }; }
        } else if (this.op === 'upsert' || this.op === 'update') {
          db[this.table] = clone(this.payload); return { data: clone(this.payload), error: null };
        }
        return { data: null, error: null };
      }
      maybeSingle() { return this.execute(true); }
      single() { return this.execute(true); }
      then(resolve, reject) { return this.execute(false).then(resolve, reject); }
    }
    class Channel { on() { return this; } subscribe(callback) { queueMicrotask(() => callback?.('SUBSCRIBED')); return this; } unsubscribe() {} }
    const transparent = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="%23888"/></svg>');
    const storage = {
      upload: async (name, blob) => {
        const failure = name.includes('-thumb.') ? failures.thumbnail : failures.main;
        if (failure) return { data: null, error: failure };
        uploaded.set(name, blob); return { data: { path: name }, error: null };
      },
      remove: async names => { names.forEach(name => uploaded.delete(name)); return { data: names, error: null }; },
      getPublicUrl: name => ({ data: { publicUrl: uploaded.has(name) ? URL.createObjectURL(uploaded.get(name)) : transparent } })
    };
    const user = { id: 'owner-1', email: 'owner@example.test' };
    window.__regionFake = { db, uploaded, failures };
    window.heic2any = async ({ blob }) => blob;
    window.supabase = { createClient() { return {
      from: table => new Query(table), storage: { from: () => storage },
      rpc: async (name, args) => {
        if (name === 'set_region_cover') db.region_photos.forEach(row => { if (row.region_id === args.p_region_id) row.is_cover = row.id === args.p_photo_id; });
        if (name === 'delete_region_photo_metadata') {
          const target = db.region_photos.find(row => row.id === args.p_photo_id);
          db.region_photos = db.region_photos.filter(row => row.id !== args.p_photo_id);
          if (target?.is_cover) { const next = db.region_photos.find(row => row.region_id === target.region_id); if (next) next.is_cover = true; }
        }
        return { data: null, error: null };
      },
      channel: () => new Channel(), removeChannel: () => {},
      auth: {
        getSession: async () => ({ data: { session: ${seed.preview ? 'null' : '{ user }'} }, error: null }),
        getUser: async () => ({ data: { user: ${seed.preview ? 'null' : 'user'} }, error: null }),
        signInWithPassword: async () => ({ data: { user, session: { user } }, error: null }),
        signOut: async () => ({ error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
      }
    }; } };
  })();`;
}

async function makePage(browser, base, seed, mobile = false) {
  const context = await browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
    : { viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (url.includes('heic2any')) return route.fulfill({ body: 'window.heic2any=async({blob})=>blob;', contentType: 'application/javascript' });
    if (url.includes('@supabase/supabase-js')) return route.fulfill({ body: fakeSupabase(seed), contentType: 'application/javascript' });
    return route.fulfill({ body: '', contentType: 'text/plain' });
  });
  const page = await context.newPage();
  await page.goto(base + (seed.preview ? '?preview=1' : ''));
  return { page, context };
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER || 'chrome', headless: true });
  try {
    const owner = await makePage(browser, base, {}, false);
    await owner.page.waitForFunction(() => cloudUser?.id === 'owner-1' && regionOwnerVerified);
    await owner.page.waitForSelector('[data-showcase-region-id="japan"]');
    const initialShowcase = owner.page.locator('[data-showcase-region-id="japan"]');
    assert.equal(await initialShowcase.count(), 1, 'one unlocked region renders as one showcase card');
    assert.match(await initialShowcase.textContent(), /JAPAN[\s\S]*日本[\s\S]*2026\.08 解锁[\s\S]*七日海外独立远征（日本）[\s\S]*暂无照片[\s\S]*查看档案/);
    const singleGeometry = await initialShowcase.evaluate(el => ({ card: el.getBoundingClientRect().width, grid: el.parentElement.getBoundingClientRect().width }));
    assert(singleGeometry.card > 900 && Math.abs(singleGeometry.card - singleGeometry.grid) < 1, 'single region uses a wide card');
    await owner.page.locator('button[onclick="goTo(\'regionsSection\')"]').click();
    await owner.page.waitForFunction(() => Math.abs(document.querySelector('#regionsSection').getBoundingClientRect().top) < 20);
    await owner.page.screenshot({ path: path.join(output, 'desktop-regions-showcase.png') });
    await initialShowcase.click();
    await owner.page.waitForSelector('.region-detail');
    assert.equal(await owner.page.locator('.region-upload-btn').count(), 1, 'owner sees upload control');
    assert.equal(await owner.page.locator('#regionNoteInput').count(), 1, 'owner sees note editor');
    await owner.page.locator('#regionNoteInput').fill('第一次真正走出去。\n这里会继续生长。');
    await owner.page.locator('button', { hasText: '保存留言' }).click();
    await owner.page.waitForFunction(() => regionDetails.get('japan')?.note.includes('这里会继续生长'));

    await owner.page.evaluate(async () => {
      async function photo(name, color) {
        const canvas = document.createElement('canvas'); canvas.width = 3000; canvas.height = 1800;
        const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .98));
        return new File([blob], name, { type: 'image/jpeg' });
      }
      await processRegionFiles([await photo('one.jpg', '#ba7b50'), await photo('two.jpg', '#456b89')]);
    });
    await owner.page.waitForFunction(() => regionPhotosFor('japan').length === 2);
    assert.match(await owner.page.locator('#regionUploadStatus').textContent(), /上传完成/);
    assert.match(await owner.page.locator('[data-showcase-region-id="japan"]').textContent(), /2 张照片/);
    assert(await owner.page.locator('[data-showcase-region-id="japan"]').evaluate(el => el.classList.contains('has-cover') && getComputedStyle(el).backgroundImage !== 'none'));
    await owner.page.screenshot({ path: path.join(output, 'desktop-region-detail.png') });
    const compression = await owner.page.evaluate(async () => {
      const entries = [...window.__regionFake.uploaded.entries()];
      const main = entries.filter(([name]) => !name.includes('-thumb.'));
      const thumbs = entries.filter(([name]) => name.includes('-thumb.'));
      const mainBitmap = await createImageBitmap(main[0][1]);
      const thumbBitmap = await createImageBitmap(thumbs[0][1]);
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      canvas.getContext('2d').fillRect(0, 0, 640, 480);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .9));
      const heic = await compressRegionImage(new File([jpeg], 'iphone.heic', { type: 'image/heic' }));
      const heicBitmap = await createImageBitmap(heic.main);
      const nativeToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
        return nativeToBlob.call(this, callback, type === 'image/webp' ? 'image/png' : type, quality);
      };
      const safariFallback = await compressRegionImage(new File([jpeg], 'safari.png', { type: 'image/png' }));
      HTMLCanvasElement.prototype.toBlob = nativeToBlob;
      return { count: entries.length, mainType: main[0][1].type, mainEdge: Math.max(mainBitmap.width, mainBitmap.height), thumbEdge: Math.max(thumbBitmap.width, thumbBitmap.height), heicType: heic.main.type, heicEdge: Math.max(heicBitmap.width, heicBitmap.height), safariFallbackType: safariFallback.main.type, safariThumbType: safariFallback.thumbnail.type };
    });
    assert.deepEqual(compression, { count: 4, mainType: 'image/webp', mainEdge: 2560, thumbEdge: 720, heicType: 'image/webp', heicEdge: 640, safariFallbackType: 'image/jpeg', safariThumbType: 'image/jpeg' });

    await owner.page.locator('[data-region-photo-index="1"]').click();
    const secondPhotoId = await owner.page.evaluate(() => regionPhotosFor('japan')[1].id);
    await owner.page.locator('.lightbox-action.cover').click();
    await owner.page.waitForFunction(() => regionPhotosFor('japan')[1].is_cover);
    assert.equal(await owner.page.locator('[data-showcase-region-id="japan"]').getAttribute('data-cover-photo-id'), secondPhotoId, 'cover change immediately updates showcase card');
    owner.page.once('dialog', dialog => dialog.accept());
    await owner.page.locator('.lightbox-action.danger').click();
    await owner.page.waitForFunction(() => regionPhotosFor('japan').length === 1 && regionPhotosFor('japan')[0].is_cover);
    const fallbackCoverId = await owner.page.evaluate(() => regionPhotosFor('japan')[0].id);
    assert.equal(await owner.page.locator('[data-showcase-region-id="japan"]').getAttribute('data-cover-photo-id'), fallbackCoverId, 'cover deletion immediately selects the remaining cover');

    const stagedErrors = await owner.page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 90;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'IMG_0027.png', { type: 'image/png' });
      const before = window.__regionFake.uploaded.size;
      window.__regionFake.failures.main = { message: 'new row violates row-level security policy', statusCode: 403, code: '403' };
      await processRegionFiles([file]);
      const mainMessage = regionUploadMessage;
      delete window.__regionFake.failures.main;
      window.__regionFake.failures.thumbnail = { message: 'thumbnail policy denied', statusCode: 400, code: 'StorageApiError' };
      await processRegionFiles([file]);
      const thumbnailMessage = regionUploadMessage;
      const after = window.__regionFake.uploaded.size;
      delete window.__regionFake.failures.thumbnail;
      return { mainMessage, thumbnailMessage, before, after };
    });
    assert.match(stagedErrors.mainMessage, /主图 Storage 上传失败：new row violates row-level security policy（HTTP 403/);
    assert.match(stagedErrors.thumbnailMessage, /缩略图 Storage 上传失败：thumbnail policy denied（HTTP 400/);
    assert.equal(stagedErrors.after, stagedErrors.before, 'failed thumbnail cleans up the uploaded main image');

    const multiLayout = await owner.page.evaluate(() => {
      state.regionRecords.push(
        { name: '香港', regionId: 'hongkong', unlockedAt: '2026-09-01T00:00:00Z', source: '城市探索' },
        { name: '法国', regionId: 'france', unlockedAt: null, source: '历史解锁' }
      );
      renderRegions();
      const grid = document.getElementById('regionsGrid');
      return { count: grid.children.length, columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length };
    });
    assert.deepEqual(multiLayout, { count: 3, columns: 3 }, 'multiple regions form a desktop grid');
    await owner.page.evaluate(() => { state.regionRecords = state.regionRecords.filter(record => record.regionId === 'japan'); renderRegions(); });

    const snapshot = await owner.page.evaluate(() => ({ db: JSON.parse(JSON.stringify(window.__regionFake.db)), state: JSON.parse(JSON.stringify(state)) }));
    snapshot.db.public_state = { slug: 'zuoyu', owner_id: 'owner-1', state: snapshot.state, updated_at: new Date().toISOString() };
    const preview = await makePage(browser, base, { db: snapshot.db, preview: true }, true);
    await preview.page.waitForFunction(() => knownPublicUpdatedAt && state.regionRecords.some(row => row.regionId === 'japan'));
    await preview.page.waitForSelector('[data-showcase-region-id="japan"]');
    const mobileShowcase = await preview.page.locator('#regionsGrid').evaluate(el => ({ count: el.children.length, columns: getComputedStyle(el).gridTemplateColumns.split(' ').length, width: document.documentElement.scrollWidth, screen: innerWidth }));
    assert.deepEqual(mobileShowcase, { count: 1, columns: 1, width: 390, screen: 390 }, 'preview showcase is one column with no mobile overflow');
    await preview.page.locator('[data-showcase-region-id="japan"]').click();
    await preview.page.waitForFunction(() => document.querySelector('.region-note-copy')?.textContent.includes('这里会继续生长'));
    assert.equal(await preview.page.locator('.region-upload-btn').count(), 0, 'preview has no upload control');
    assert.equal(await preview.page.locator('#regionNoteInput').count(), 0, 'preview has no editor');
    await preview.page.locator('[data-region-photo-index="0"]').click();
    assert.equal(await preview.page.locator('#lightboxActions button').count(), 0, 'preview has no photo management controls');
    await preview.page.evaluate(() => closeRegionLightbox());
    const geometry = await preview.page.locator('.archive-sheet').evaluate(el => ({ bottom: el.getBoundingClientRect().bottom, viewport: innerHeight, width: document.documentElement.scrollWidth, screen: innerWidth }));
    assert(Math.abs(geometry.bottom - geometry.viewport) < 1, 'mobile archive is a bottom sheet');
    assert.equal(geometry.width, geometry.screen, 'mobile has no horizontal overflow');
    await preview.page.screenshot({ path: path.join(output, 'mobile-preview-region.png') });
    console.log('PASS owner verification, Safari PNG fallback, staged Supabase errors, thumbnails, upload cleanup, cover, deletion, preview read-only, and mobile layout');
    console.log('Screenshots:', output);
    await preview.context.close();
    await owner.context.close();
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
