# 企业微信派活（enso-wecom-bridge）

EnsoCode 桌面端插件。把企业微信群和单聊里派给机器人的消息送进绑定的 Enso 会话，再把最终回复发回企微。需求看板按聊天保存待做和待决定事项，并可以用带权限的链接分享。

## 本地运行

```bash
npm install
npm test
npm run test:panel-smoke
npm run build
```

`npm test` 跑 `test/*.test.mjs`。侧栏浏览器冒烟不在默认测试里，用 `npm run test:panel-smoke`。构建产物是 `plugin/main.mjs`（已 gitignore）。

## 安装到 Enso

1. 在本机执行 `npm run build`。
2. Enso 设置 → 插件 → 企业微信派活 → 从来源重新安装，选这个目录的 `plugin/`。
3. 同意新增权限，至少包括 `agent.intercept`（每轮把看板摘要附到系统提示）。复制链接和打开网页还会用到 `ui.clipboard`、`ui.openExternal`。
4. 重新打开或新建要派活的 Enso 会话。已经开着的会话看不到新工具和新的拦截。
5. 填 Bot ID 和 Secret。已有绑定和 `state.json` 会保留。

新安装默认只有允许名单里的人能派活，新绑定默认不能读文档。旧安装保持原来的开放行为。侧栏可以一键放开。

## 看板和隧道

侧栏「看板」页有本机管理地址、公网地址和分享链接。隧道方式见插件设置 `tunnelMode`，默认 `auto`：优先 `~/.cloudflared/config.yml` 里的命名隧道，其次 `/usr/local/bin/tailscale funnel`，否则 `/opt/homebrew/bin/cloudflared` 临时隧道。服务只听 `127.0.0.1`。没有链接不能看数据。

- 自动模式按「命名隧道 → Tailscale Funnel → 临时隧道」依次尝试：某一种退出了，或者一段时间（Tailscale 15 秒、临时隧道 45 秒、命名隧道 30 秒）拿不到公网地址，就换下一种，侧栏会写明原因，例如「Tailscale 没有开启 Funnel，已改用临时隧道」。显式选择的方式不会自动更换，只显示失败原因。
- 看板和侧栏都显示群名（手动备注优先，其次同步到的群名），群 id 只出现在鼠标悬停提示里。可以按群切换查看，选择会记在这条链接的布局里；分享链接只能看到授权范围内的群。创建分享链接时按群名勾选。
- 0.2.2 起群聊有「需求审核人门槛」（默认开启，审核人默认只有所有者）：非审核人提的需求先登记为「待审核」，只能澄清，不能实现；审核人在管理页点同意/驳回，或在群里回复「同意 3」「驳回 3 原因」、引用登记回复说「同意」。管理页可按群设置审核人、开关门槛、一键「补登记」旧请求，并提示「会话可能没有看板工具」。没有新增权限。详见 `plugin/README.md` 的「需求审核门槛」。

更细的群成员绑定、外发和文档读取说明在 `plugin/README.md`。
