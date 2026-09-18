const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'life-stability-tests-'));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const target = path.join(root, file);
  if (!target.startsWith(root) || !fs.existsSync(target)) {
    response.writeHead(404); response.end('not found'); return;
  }
  response.writeHead(200, { 'content-type': mime[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
  response.end(fs.readFileSync(target));
});

async function openPage(context, base, suffix = '') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', route => {
    if (route.request().url().startsWith(base)) return route.continue();
    if (route.request().url().includes('@supabase/supabase-js')) return route.fulfill({ body: 'window.supabase={};', contentType: 'application/javascript' });
    return route.fulfill({ body: '', contentType: 'text/plain' });
  });
  await page.goto(base + suffix, { waitUntil: 'domcontentloaded' });
  return { page, errors };
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: process.env.TEST_BROWSER || 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const { page, errors } = await openPage(context, base);

  try {
    // Versioned migration and repair preserve conflicting data while removing obsolete money fields.
    const repaired = await page.evaluate(() => {
      const migrated = migrateState({
        current_title: '旧称号', titles: ['旧称号'], regions: ['日本', '日本'], region_records: [{ name: '日本' }, { name: '日本' }],
        completedTasks: [], active_tasks: ['duplicate'], attrs: {}, chapters: [], milestones: [{ id: 'custom-note' }, { id: 'custom-note' }],
        tasks: [
          { id: 'duplicate', title: '保留任务 A', rank: 'E', exp: 1, attr: '探索', gain: 1, coins: 50 },
          { id: 'duplicate', title: '保留任务 B', rank: 'D', exp: 2, attr: '耐力', gain: 1 }
        ], coins: 900, shop: [{ name: 'old' }]
      }, { persist: false });
      return {
        schemaVersion: migrated.schemaVersion,
        taskIds: migrated.tasks.map(task => task.id),
        titles: migrated.titles,
        regions: migrated.regions,
        milestones: migrated.milestones.filter(item => item.id === 'custom-note').length,
        hasMoney: needsLegacyMoneyCleanup(migrated),
        aliases: ['active_tasks', 'region_records', 'completedTasks', 'current_title'].some(key => Object.hasOwn(migrated, key))
      };
    });
    assert.equal(repaired.schemaVersion, 1);
    assert.equal(new Set(repaired.taskIds).size, 2, 'conflicting duplicate task ids are preserved with repaired ids');
    assert.deepEqual(repaired.regions, ['日本']);
    assert.equal(repaired.milestones, 1);
    assert.equal(repaired.hasMoney, false);
    assert.equal(repaired.aliases, false);

    // Export envelope is complete, versioned and free of obsolete monetary data.
    const [download] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => exportSave())]);
    const downloadPath = await download.path();
    const exported = JSON.parse(fs.readFileSync(downloadPath, 'utf8'));
    assert.equal(exported.backupVersion, 1);
    assert.equal(exported.schemaVersion, 1);
    assert(exported.exportedAt && exported.state);
    assert.equal(await page.evaluate(payload => needsLegacyMoneyCleanup(payload), exported), false);
    assert.throws(() => JSON.parse('{broken'));
    assert.equal(await page.evaluate(() => { try { validateBackupPayload({ hello: 'world' }); return false; } catch { return true; } }), true);

    // Automatic safety backups are capped at three and a restore first protects the current state.
    const backupResult = await page.evaluate(() => {
      localStorage.removeItem(BACKUP_STORAGE_KEY);
      for (let exp = 1; exp <= 4; exp++) createSafetyBackup(`test-${exp}`, { ...clone(state), exp });
      const before = getSafetyBackups();
      state.exp = 999;
      window.confirm = () => true;
      restoreLastKnownGood();
      return { beforeCount: before.length, latestExp: before[0].state.exp, restoredExp: state.exp, afterCount: getSafetyBackups().length };
    });
    assert.deepEqual(backupResult, { beforeCount: 3, latestExp: 4, restoredExp: 4, afterCount: 3 });

    const expBeforeInvalidImport = await page.evaluate(() => state.exp);
    await page.locator('#saveFile').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => state.exp), expBeforeInvalidImport, 'invalid JSON never overwrites current state');
    assert(errors.some(message => message.includes('Backup import failed')), 'invalid import keeps a detailed console diagnostic');
    errors.length = 0;
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#saveFile').setInputFiles({ name: 'valid-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exported)) });
    await page.waitForFunction(value => state.exp === value, exported.state.exp);
    assert.equal(await page.evaluate(() => state.schemaVersion), 1, 'valid import path completed');

    // Create, edit, accept, complete, filter and duplicate-import protection use the real UI/state flow.
    const taskFlow = await page.evaluate(() => {
      openTaskModal();
      taskName.value = '需要编辑的超长移动端任务名称用于稳定性检查';
      taskRank.value = 'B'; taskExp.value = 10; taskAttr.value = '探索'; taskGain.value = 1; taskDesc.value = '初始描述';
      createTask();
      const created = state.tasks.find(task => task.title.startsWith('需要编辑'));
      openEditTaskModal(created.id); taskName.value = '已编辑的稳定任务'; taskDesc.value = '编辑后的长描述仍然能够正常显示和同步'; createTask();
      const edited = state.tasks.find(task => task.id === created.id);
      acceptTask(edited.id); setTaskStatusFilter('active');
      const activeVisible = taskList.innerText.includes('已编辑的稳定任务');
      completeTask(edited.id); closeReward(); setTaskStatusFilter('completed');
      const completedVisible = taskList.innerText.includes('已编辑的稳定任务');
      const imported = normalizeTask({ title: '稳定导入任务', rank: 'C', exp: 2, attr: '探索', gain: 1, desc: 'same code' });
      const code = encodeTaskCode(imported); taskCodeInput.value = code; importTaskCode(); taskCodeInput.value = code; importTaskCode();
      return { editedTitle: edited.title, activeVisible, completedVisible, importedCount: state.tasks.filter(task => task.title === '稳定导入任务').length };
    });
    assert.deepEqual(taskFlow, { editedTitle: '已编辑的稳定任务', activeVisible: true, completedVisible: true, importedCount: 1 });
    await page.waitForTimeout(250);

    // Search and annual archive derive only from current state and remain usable in the shared utility sheet.
    await page.evaluate(() => openGlobalSearch());
    await page.locator('#globalSearchInput').fill('日本');
    assert.match(await page.locator('#searchResults').innerText(), /区域|里程碑|日本/);
    await page.evaluate(() => openYearArchive());
    assert.match(await page.locator('#utilityBody').innerText(), /2026[\s\S]*完成任务[\s\S]*新增区域[\s\S]*新增里程碑/);
    const archiveDedup = await page.evaluate(() => {
      const year = buildYearArchive().find(([value]) => value === '2026');
      const events = year ? [...year[1].months.values()].flatMap(month => [...month.values()]) : [];
      return { expedition: events.filter(event => event.title === '七日海外独立远征（日本）').length, duplicateRegion: events.some(event => event.title === '到达 日本') };
    });
    assert.deepEqual(archiveDedup, { expedition: 1, duplicateRegion: false });
    await page.evaluate(() => openDataManager());
    assert.match(await page.locator('#utilityBody').innerText(), /导出备份[\s\S]*导入备份[\s\S]*恢复上一版本/);
    await page.screenshot({ path: path.join(output, 'desktop-data-manager.png') });

    // Corrupt JSON never produces a white screen and keeps the original bytes quarantined.
    const corruptContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await corruptContext.addInitScript(key => localStorage.setItem(key, '{broken-json'), 'zuoyuLifeV2');
    const corrupt = await openPage(corruptContext, base);
    assert(await corrupt.page.locator('#dataErrorPanel').evaluate(element => element.classList.contains('show')));
    assert.equal(await corrupt.page.locator('#home').count(), 1);
    assert.equal(await corrupt.page.evaluate(() => localStorage.getItem(CORRUPT_STORAGE_KEY)), '{broken-json');
    await corrupt.page.screenshot({ path: path.join(output, 'mobile-data-recovery.png') });
    await corruptContext.close();

    // Five iPhone widths: every primary page and utility sheet remains inside the viewport.
    const widths = [375, 390, 393, 414, 430];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 844 });
      for (const route of ['home', 'tasksSection', 'recordsSection', 'finalSection']) {
        await page.evaluate(target => { closeUtilityModal(); goTo(target); }, route);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${width}px ${route} has no horizontal overflow`);
      }
      await page.evaluate(() => { goTo('home'); goTo('regionsSection'); });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${width}px regions fit`);
      await page.evaluate(() => { goTo('home'); goTo('milestonesSection'); });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${width}px milestones fit`);
      await page.evaluate(() => openTaskModal());
      const taskSheet = await page.locator('#taskModal .sheet').evaluate(element => ({ width: element.getBoundingClientRect().width, viewport: innerWidth, maxHeight: element.getBoundingClientRect().height <= innerHeight }));
      assert(taskSheet.width <= taskSheet.viewport && taskSheet.maxHeight, `${width}px task editor fits`);
      await page.evaluate(() => { closeTaskModal(); openDataManager(); });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, `${width}px data manager fits`);
      if (width === 390) {
        await page.screenshot({ path: path.join(output, 'mobile-data-manager-390.png') });
        await page.evaluate(() => openYearArchive());
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, '390px annual archive fits');
        await page.screenshot({ path: path.join(output, 'mobile-year-archive-390.png') });
      }
    }

    assert.deepEqual(errors, [], 'main flow has no console or page errors');

    // Manifest and service worker support install, same-origin shell caching and offline navigation.
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
    const workerText = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
    assert.equal(manifest.display, 'standalone');
    assert.match(workerText, /CACHE_NAME/);
    assert.doesNotMatch(workerText, /supabase\.co|public_state|life_saves/);
    const pwaContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'allow' });
    const pwa = await openPage(pwaContext, base, '?pwa=1');
    await pwa.page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
    await pwa.page.reload({ waitUntil: 'domcontentloaded' });
    await pwaContext.setOffline(true);
    await pwa.page.reload({ waitUntil: 'domcontentloaded' });
    assert.equal(await pwa.page.locator('#home').count(), 1, 'PWA reopens its main shell offline');
    await pwaContext.setOffline(false);
    await pwaContext.close();

    console.log('PASS schema migration, repair, corrupt recovery, versioned export, validation, 3-generation backup/restore, task edit/filter/import, search, annual archive, five mobile widths, and PWA offline shell');
    console.log('Screenshots:', output);
  } finally {
    await context.close();
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
