# 维护说明

## 数据结构

主状态保存在浏览器 `localStorage` 的 `zuoyuLifeV2`，并同步到 Supabase `life_saves.state`；公开预览读取 `public_state.state`。核心字段包括 `tasks`、`activeTasks`、`completed`、`titles` / `titleRecords`、`regions` / `regionRecords`、`milestones`、`finalTask`、`attrs`、`chapters` 和 `lastModifiedAt`。旧金币字段只在迁移时识别并删除。

当前 `schemaVersion` 为 `1`。结构升级时提高 `SCHEMA_VERSION`，并在 `runSchemaMigrations()` 中按 `v1 → v2 → v3` 逐级处理；迁移必须保留未知字段，避免静默丢失旧数据。

## 扩展规则

- 新增里程碑：编辑 `index.html` 中的 `MILESTONE_DEFINITIONS`，保持稳定 `id`，补充历史回溯测试。
- 新增任务字段：同时检查 `importedTaskFields()`、`encodeTaskCode()`、`normalizeTask()`、完成记录和搜索索引；可选字段必须兼容缺失值。
- 区域仍以 `regionRecords` 为主，`regions` 保留旧存档兼容；区域照片元数据来自 Supabase，不写进主状态。

## 保存、同步与备份

所有主人端状态修改统一调用 `save()`：先写本地，再防抖推送 `life_saves`，随后更新 `public_state`。Realtime、前台恢复、网络恢复和 4 秒低频轮询负责补漏；较新的云端版本优先，冲突中的本地版本会进入安全备份。

“数据管理”导出的 JSON 包含 `backupVersion`、`schemaVersion`、`exportedAt` 和完整 `state`。导入先由 `validateBackupPayload()` 验证，再显示摘要并确认。自动备份位于 `zuoyuLifeBackups`，最多 3 份；损坏原文隔离到 `zuoyuLifeCorruptState`。

## PWA 与部署

`manifest.webmanifest`、`icon.svg` 和 `sw.js` 提供安装与同源应用外壳离线缓存。发布会改变静态资源时更新 `sw.js` 的 `CACHE_NAME`；不要缓存 Supabase 或其他跨域 API 响应。

网站由 GitHub Pages 从 `main` 分支部署。提交前运行：

```text
node tests/stability.cjs
node tests/cloud-sync.cjs
node tests/milestones.cjs
node tests/final-page.cjs
node tests/region-media.cjs
```

推送后以线上 `index.html` 与提交版本的 SHA-256 完全一致作为部署完成标准。
