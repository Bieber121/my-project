# 区域详情云端配置

当前远端项目尚未创建区域详情表和图片 bucket。部署本次前端后，请在同一个 Supabase 项目的 **SQL Editor** 中完整执行 [`region-media.sql`](./region-media.sql) 一次。

该脚本会创建：

- `public.region_details`：每个区域的留言和最后修改时间。
- `public.region_photos`：Storage 路径、缩略图路径、排序和封面状态。
- `region-photos` public bucket：只公开读取图片；上传和删除仍受 Storage RLS 限制。
- `set_region_cover`：原子切换单一区域封面。
- `delete_region_photo_metadata`：删除元数据并在需要时自动选择下一张封面。
- 表级 RLS、Storage policy、索引和 Realtime publication。

写权限不仅检查 `auth.uid()`，还要求该 UID 是 `public_state.slug = 'zuoyu'` 的 `owner_id`。匿名访客和 `?preview=1` 只能读取；不要在前端加入或使用 `service_role` key。

执行完成后刷新网站，登录主人云存档，依次点击“区域”→某个区域→“＋ 上传照片”。无需在 Storage 页面手工再建 bucket，因为 SQL 会一并创建；如果选择改为手工创建，bucket 名必须严格为 `region-photos`，并仍需执行 SQL 中的表和 policy 部分。
