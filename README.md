# 药理学刷题

- [用户端](https://ddddddking.github.io/pharm-quiz/)
- [管理端](https://ddddddking.github.io/pharm-quiz/admin/)

管理员通过管理端为学员生成随机刷题 ID。学员凭完整 ID 登录，答题记录、错题、收藏、练习位置和模拟考草稿自动同步。管理端可按学员查看进度并停用或恢复 ID。完整 ID 只在生成时显示。它是登录凭证，请单独发给对应学员。

GitHub Pages 发布 `main` 分支的 `/docs`。该目录只包含前端。题库和学习数据由 Supabase 项目提供，`supabase/schema.sql` 定义存储和权限，`supabase/functions/pharm-quiz/index.js` 是 API 入口。学生和管理员的凭证仅以 SHA-256 摘要存储。浏览器只使用公开 API key，Edge Function 在服务器验证凭证并访问数据库。
