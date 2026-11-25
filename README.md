# 药理学刷题

- [用户端](https://ddddddking.github.io/pharm-quiz/?v=4)
- [管理端](https://ddddddking.github.io/pharm-quiz/admin/?v=4)

管理员填写学员 ID，学员按原样输入 ID 登录。所有页面通过服务器验证准入。

支持章节全题目录、未刷/已刷/待复习错题/历史错题/收藏/笔记/已掌握筛选、练习/背题/测试、逐题笔记、手动已刷与掌握标记、单题重做、错题重练、智能复习和按个人记录组卷。笔记与学习状态同步到 Supabase。管理端可查看每位学员的题目作答统计与笔记。

智能复习按待复习错题、错误比例、上次作答时间和收藏排序，排除已掌握题目。手动标记已刷计入章节完成状态，真实作答正确率依据作答记录计算。

AI 一键解析需要管理员在后台配置模型服务商、模型 ID 和 API Key。支持豆包火山方舟、Gemini 的 OpenAI 兼容接口和硅基流动。API Key 存于非公开数据库 schema，由 Edge Function 调用服务商，浏览器无法读取已保存的密钥。仅发送题目、选项和题库解析。后台可设置每人每天调用上限。免费额度、付费条件以对应服务商账户为准。未配置时界面会明确提示。

GitHub Pages 发布 main 分支的 /docs。Supabase schema 在 supabase/schema.sql，API 在 supabase/functions/pharm-quiz/index.js。
