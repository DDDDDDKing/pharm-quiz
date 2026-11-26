# 药理学刷题

- [用户端](https://ddddddking.github.io/pharm-quiz/?v=10)
- [管理端](https://ddddddking.github.io/pharm-quiz/admin/?v=10)

新学员在闲鱼以 ¥9.90 下单后提交纯数字订单编号。服务端按配置校验位数，邮箱验证码通过后激活账号，并在后台登记待核对的订单。订单编号不能重复使用。昵称选填，留空显示「学员」加随机四位编号。邮箱为登录账号。

老学员可用原刷题 ID 绑定邮箱，无需重新购买。绑定沿用原账号，已同步的答题、评论、收藏和 AI 余额随账号保留。在有待同步记录的旧设备上首次绑定时，浏览器会迁移本机旧待同步记录。评论公开显示昵称。

支持章节全题目录、未刷/已刷/待复习错题/历史错题/收藏/已掌握筛选、练习/背题/测试、题目评论、收藏评论、单题重做、错题重练、智能复习和按个人记录组卷。旧笔记可以由原作者主动发布为评论。管理端可查看学员题目作答统计与评论。

答题卡显示本轮和历史作答。每次实际作答都会记录进度。可以按题或者按章清除作答记录及其错题状态。智能复习按待复习错题、错误比例、上次作答时间和收藏排序，排除已掌握题目。

AI 一键解析需要管理员在后台配置模型服务商、模型 ID 和 API Key。支持豆包火山方舟、Gemini 的 OpenAI 兼容接口和硅基流动。火山方舟的预填模型为 doubao-seed-2-0-mini-260428，可按控制台实际可用模型修改。API Key 存于非公开数据库 schema，由 Edge Function 调用服务商，浏览器无法读取已保存的密钥。仅发送题目、选项和题库解析。后台可设置每人每天调用上限。免费额度、付费条件以对应服务商账户为准。未配置时界面会明确提示。

GitHub Pages 发布 main 分支的 /docs。Supabase schema 在 supabase/schema.sql，API 在 supabase/functions/pharm-quiz/index.js。

普通学员默认每天有 20 次免费解析，按北京时间换日。免费次数和加购余额都用完时显示 ¥4.90 加购 100 次的入口。提交闲鱼订单编号后，由管理员核对并发放 100 次。加购余额可跨天使用，每日免费额度优先扣除。注册订单核验未通过可停用账号。

## 部署邮箱注册

1. 按编号在现有项目应用 `supabase/migrations/` 内两项增量迁移。新建数据库先运行 `supabase/schema.sql`。
2. Supabase Authentication 的 Email Provider 开启邮箱注册和 Confirm Email。Auth Hooks 启用 Before User Created，选择 Postgres 函数 `public.pharm_quiz_signup_hook`。维护窗口内先启用授权钩子，再开放新页面。
3. 在 Authentication 的 SMTP Settings 开启 Custom SMTP。主机填 `smtp.163.com`，端口填 `465`，用户名和发件邮箱填同一个网易 163 邮箱，密码填该邮箱的客户端授权码，显示名可填「药理学刷题」。检查 Send Email Hook 处于停用状态，以使用 SMTP。
4. Authentication 邮件模板的 Confirm signup 和 Reset password 均加入 `{{ .Token }}`。上线前按项目实际的验证码长度和有效时间验证。发送上限按试运行人数设置。
5. 部署 `pharm-quiz` Edge Function，包含 `index.js` 和 `registration.js`。公开请求继续使用项目 publishable key；Edge Function 负责验证学生会话并使用项目预置的 `SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`。将 GitHub Pages 设为发布 main 的 `/docs`。
6. 用 PostgreSQL 管理员调用 `pharm.configure_admin`，传入管理员用户名及单独生成的 bcrypt 12 轮哈希。管理员密码和实际哈希通过有权限的环境配置。
7. 发布前验证无效或已用订单编号不发码、有效格式的订单能开通、拒绝注册订单后账号停用、AI 同一订单只加一次、旧 ID 原记录及评论还在。用外部邮箱验证注册和密码重置送达，再检查新版管理员可登录。

## 订单格式与核对

默认订单编号格式为 19 位 ASCII 数字。确认短信或订单详情中实际使用的编号后，可以用 Edge Function 环境变量 `PHARM_ORDER_LENGTHS` 指定一个或多个支持的位数，用逗号分隔。编号始终以文本存储。

注册提交只校验格式及是否重复，付款由管理员在闲鱼查实。AI 套餐在后台审核后添加余额。
