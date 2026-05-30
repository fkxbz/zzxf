# AGENTS.md

## 项目概览

这是一个部署到 Cloudflare Pages 的消防设施操作员模拟考试系统。

## 当前工作目录约定

- `E:\zzxf\sync-work\` 是以后唯一正式项目目录。
- 后续开发、检查、Git 提交、GitHub 推送、Cloudflare 部署，都应在 `E:\zzxf\sync-work\` 中进行。
- `E:\zzxf\` 上一级目录中的同名 `public/`、`functions/`、`private/`、`tools/` 等只作为临时备份，过渡期不要再作为正式修改位置。
- 如果误改了 `E:\zzxf\` 上一级目录，必须先同步到 `E:\zzxf\sync-work\` 后才算进入正式版本。

主要能力：
- 普通用户必须登录后才能使用考试/练习系统。
- 管理员可进入管理后台维护模拟考试参数、章节/题型抽题权重、题型分值和注册账号。
- 题库不放在 `public/` 下作为静态文件发布；前端通过受保护的 `/api?action=questions` 接口读取题库。
- 用户、会话、考试设置、考试记录保存在 Cloudflare KV，绑定名为 `EXAM_KV`。

## 目录结构

- `public/index.html`
  - 普通考试入口。
  - 负责登录/注册、章节练习、随机刷题、背题模式、模拟考试、计时、结算和回顾。
  - 登录后通过 `/api?action=questions` 拉取题库，通过 `/api?action=settings` 拉取管理员配置。

- `public/admin.html`
  - 管理后台入口。
  - 管理员登录后维护考试题数、考试时长、满分、及格线、章节/题型权重、题型分值、用户账号。
  - 普通用户不能进入后台。

- `functions/api.js`
  - Cloudflare Pages Function 的统一 API 入口。
  - 导入 `functions/data/questions-data.js` 中的题库。
  - 处理注册、登录、退出、当前用户、题库读取、设置读取/保存、用户列表、删除用户、成绩保存。
  - 所有需要权限的接口都从 `Authorization: Bearer <token>` 读取会话令牌。

- `functions/data/questions-data.js`
  - 从 Excel 生成的题库 JS 模块。
  - 导出 `QUESTIONS` 数组。
  - 当前约 2251 道题。

- `private/题库.xlsx`
  - 题库源文件，不应作为静态资源发布。
  - 工作表包括 `汇总` 和 `题库数据`。
  - `题库数据` 列顺序：章节、题目ID、题型、题干、选项A、选项B、选项C、选项D、选项E、答案。

- `private/questions.json`
  - 旧版/备用题库文件。
  - 不应放到 `public/`。

- `tools/build-question-data.py`
  - 从 `private/*.xlsx` 生成 `functions/data/questions-data.js`。
  - 需要 `openpyxl`。
  - 当前脚本按题型限制选项范围：
    - 判断：只取 A/B；如 Excel 没写选项，自动补“对/错”。
    - 单选：只取 A-D。
    - 多选：只取 A-E。
  - 这样做是为了避免把第 10 列“答案”误当成选项。

- `public/1.jpg`
  - 页面二维码/图片资源。

- `sync-work/`
  - 当前唯一正式项目目录。
  - 已配置远程 `https://github.com/fkxbz/zzxf.git`。
  - 后续应直接在此目录修改、提交、推送和部署。

## 关键 API

`functions/api.js` 支持以下 `action`：

- `POST register`
- `POST login`
- `POST logout`
- `GET me`
- `GET questions`
- `GET settings`
- `POST save-settings`
- `GET users`
- `POST delete-user`
- `POST save-record`

注意：
- 未登录访问 `questions/settings` 应返回 401。
- 只有管理员可以 `save-settings/users/delete-user`。
- 初始管理员账号由 `ensureAdminUser()` 自动创建：
  - 用户名：`admin`
  - 初始密码：`Admin@123456`
- 线上部署后应尽快更换管理员密码；目前没有单独的改密界面。

## 维护题库

更新题库时：

```powershell
cd E:\zzxf\sync-work

# 1. 替换 private\题库.xlsx
# 2. 重新生成受保护题库数据
python tools\build-question-data.py

# 3. 部署 Cloudflare Pages
npx wrangler pages deploy public
```

重要：
- 不要把 `题库.xlsx` 或 `questions.json` 放回 `public/`。
- `.gitignore` 当前忽略 `*.xlsx`，所以 Excel 源文件默认不会提交到 Git。
- 如果需要 GitHub 仓库包含 Excel 源文件，要先明确这是有意公开题库源文件，再调整 `.gitignore`。

## 部署

常规部署命令：

```powershell
cd E:\zzxf\sync-work
npx wrangler pages deploy public
```

Cloudflare Pages 需要：
- `public/` 作为静态发布目录。
- `functions/` 作为 Pages Functions 目录。
- KV 绑定名为 `EXAM_KV`。

同步 GitHub：

```powershell
cd E:\zzxf\sync-work
git add .
git commit -m "更新说明"
git push
```

不要再从 `E:\zzxf\` 上一级目录提交或部署；那里只保留作临时备份。

## 安全注意事项

- 匿名用户不能通过网站接口读取题库。
- 登录用户仍可通过前端接口获得题目数据，因为浏览器答题需要题干和选项；如果要进一步防止登录用户一次性下载全题库，需要把抽题逻辑迁到后端，只给前端下发本次试卷。
- `functions/data/questions-data.js` 如果提交到公开 GitHub，题库内容会在 GitHub 暴露。当前“题库不匿名下载”只针对网站静态资源和 API 权限，不等于题库在公开仓库中保密。
- `.wrangler/` 是本地 Cloudflare 缓存，不要提交。
- `.env` 和 `.env.*` 不要提交。

## 已知容易踩坑

- `public/index.html` 的管理后台链接元素是 `admin-link`，脚本会根据用户角色隐藏/显示；删除该元素时必须同步修改脚本，否则登录后可能中断加载。
- `functions/api.js` 的异步路由需要 `return await ...`，这样权限错误能被统一 `try/catch` 转成 JSON 响应。
- 管理页保存考试配置时必须调用后端 `save-settings` action；不要误写成 `settings`，否则会得到 404。
- `comboKey` 在普通页使用 `chapter|||type`，管理页当前部分逻辑使用 `chapter||type`。修改权重功能时要确认前后端保存的 key 分隔符一致，否则模拟考试可能读不到管理员设置。
- `E:\zzxf\sync-work\` 是唯一正式项目目录；上一级 `E:\zzxf\` 只作临时备份。

## 快速检查

修改后建议至少运行：

```powershell
node --check functions\api.js
node --check functions\data\questions-data.js
```

如需检查页面内联脚本，可临时抽出 `<script>` 内容后用 `node --check` 检查。

还可以用一个伪 KV 环境测试：
- 管理员登录应成功。
- 登录后 `questions` 应返回 2251 道题。
- 匿名访问 `questions` 应返回 401。
