# 三服务前端来源与实际可复用边界

核验日期：2026-11-11。只匿名下载公开发布包、读取公开源码与官网；未安装或执行第三方包，未登录线上服务或修改服务进程。

下载目录：`research/ecosystem-sources-20261111/`。每个包保留 npm 元数据、原始 `source.tgz` 与解包后的 `package/`。`manifest.json` 记录版本、来源地址、SHA-256 与 npm SHA-1 核验结果；三份 SHA-1 均与 npm 元数据一致。

| 服务 | 实际发布包 | 本次版本 | 原版前端 |
|---|---|---|---|
| 星邮 | `cortico-world-starpost` | `0.29.1` | 包内 `web/` 完整网页；GitHub 仓库另有原生 Android Compose App |
| 花语乡 | `cortico-world-bloom-kpect` | `0.3.2-dev.v13Loop` | 包内 `dist/webui.js` 仅入镇与通知面板；完整游戏界面由 `https://projectbloom.cn` 提供 |
| 漂流瓶 | `cortico-world-bottle` | `0.8.3` | 包内 `world/page*.ts`、`dist/webui-*.js/.css`，有完整信箱与公开 JSON 动作接口 |

## 星邮

- 官方仓库：<https://github.com/hth768/cortico-world-starpost>
- 人类网页登录/注册和 Android 登录同用 `/web/auth`、`/mobile/auth`，人类动作走 `/mobile/rpc`；Bot 的 `/rpc` 凭据与人类会话不是同一身份。
- 已有邮箱密码/验证码、一个人绑定多个 Bot、选中 Bot、单聊/群聊、消息引用、图片/表情、动态和游戏等能力。
- npm 包中的 `web/` 是网页实现，不能标为 Android 原生模块；原生前端需读取官方仓库 `android/` 并抽出网络与业务状态后接宿主。
- MIT：包内有 `LICENSE`。保留原作者与许可。统一登录仍需作者实现身份提供/交换协议，不能用 Bot key 冒充人类会话。

## 花语乡

- 官方站：<https://projectbloom.cn>
- npm：<https://www.npmjs.com/package/cortico-world-bloom-kpect>
- World ID 为 `bloom`，公开面板是 `account`；`getMethods` 为 `state`、`channels`。
- 面板 RPC：`state`、`register([nickname, inviteCode?])`、维护登录 `login([botToken])`、`channels`、`saveChannels([commaSeparatedChannels])`。
- `state` 返回的是 `{loggedIn,name}`，不是全游戏状态。注册会沿原版规则启用游戏和发言权限。
- Bot 工具具有 `state`、`discover`、`actions`、`guide`、`inbox`、`action`、群与聊天等功能；这些只说明 Bot 可进入世界，不等于已提供可嵌入的完整人类前端。
- 公开运行包仅含压缩/混淆的 JS；元数据未提供源码仓库。没有把官网 JS 当作获准再发布的原生 UI 源码，也没有重建出一套声称等同原版的游戏。
- 包声明 MIT；README 明确插件许可不包含服务器数据与游戏美术再许可。应请作者按宿主原生模块协议提供完整游戏 UI 模块和场景上下文。
- 旧 `WorldWorkspace` 中的 `cortico-world-bloom@0.1.0` 以及 `Pal-AI-Lab/cortico-extensions` 链接不是本次核实的花语乡项目，不应沿用。

## 漂流瓶

- 官方仓库：<https://github.com/Unnori/cortico-world-bottle-client>
- npm 元数据声明 MIT；`world/page.ts` 是本次原生适配的 API 依据。
- 原有发现接口仍可用：`/api/webui/providers/world%3Abottle/panels/mailbox/status` 返回 `url`（本机 loopback 信箱）。CooDock 的瓶桥通过已有认证连接访问该接口。
- 新原生前端经 `BottleBridge.invoke(method,path,body)` 调 JSON，路径为原信箱相对路径。不会将网页装进 App，也不把手机连接凭据交给前端页面。

### JSON 接口

| 方法/路径 | 内容 |
|---|---|
| `GET /draft` | 当前信、信稿、回信稿、收寄历史、星笺、额度、邀请及连接状态 |
| `POST /catch` / `/write` | `{actor:"human"|"bot"}`，原版捞信/请 Coo 起草 |
| `POST /send` / `/rewrite` / `/discard` | `{kind:"letter"|"reply"}`，原样寄出、重新起草或放弃 |
| `POST /read` / `/open` | 当前信共读、请求回信稿 |
| `POST /peruse` | `{letterId}`，历史共读 |
| `POST /dismiss` / `/keep` | 放回海里或珍藏 |
| `POST /star` | `{letterId,starred}` |
| `POST /star-memory` | `{letterId,enabled}`，单封信是否允许记忆 |
| `POST /star-memory-setting` | `{enabled}`，星笺记忆总开关 |
| `POST /forget` | `{letterId}`；整本清空需明确 `{all:true}` |
| `GET /archive/export` / `POST /archive/import` | 原版信册格式 |
| `GET/POST /appearance` | 原版外观配置 |
| `POST /background` / `/my-font` | 原版图片/字体定制 |
| `GET /notes`；`POST /note*` | 小纸条及其读/回/重写/放弃/确认 |
| `POST /wake` | `{action:"write"|"catch"|"remind",command:"pause"|"resume"|"interval",hours?,dayLimit?}` |

信件正文由 Coo 起草，原版 JSON 接口不提供任意人类正文编辑；原生适配保留该规则。

### 本次原生模块

新增 `coo-lite/android/app/src/main/java/net/tina/mobile/services/bottle/BottleFrontend.java`，无 WebView：

- `new BottleFrontend(activity, client)`；`client.request(method,path,body)` 在后台调用。
- `view()` 返回原生 View；`close()` 释放轮询与工作线程。
- `onActivityResult(request,result,data)` 对接系统文档选择与保存，码为 `47321` / `47322`。
- 已覆盖核心捞信/读信/起草/回信/人工寄出、信册、星笺收藏与独立记忆、档案导入导出、邀请暂停恢复。
- 未宣称已完成原版全部定制：小纸条、完整外观/字体/背景/声音、邀请间隔编辑仍待按作者模块契约继续接入。
- 源码已用 Android 35 `android.jar` 与 JDK 17 单文件编译；未宣称手机实机验收。

### Legacy 页桥兼容性

本轮早期对 `WorldPageServer.java` / `WorldPagePanel.java` 增加了旧页桥的大文件、文件选择和导出支持；用户明确原生模块方向后已停止继续扩展。新服务入口应使用原生 `BottleFrontend`，不把这两个 legacy 文件作为新前端模块。若保留旧入口，其 Activity 回调需要单独转发 `47311` / `47312`，并非新模块的请求码。

`BottleBridge` 的传输预算按原版 0.8.3 调整：背景 8 MiB（JSON base64预算）、字体 32 MiB（JSON base64预算）、归档导入32 MiB；大字体与归档响应不再被旧4 MiB上限截断。原 HTTP 桥保留字体缓存/显示surface提示，POST结果未知时不重试。

验证：`node --test test/bottle-bridge.test.mjs` 4/4，通过真实本机 HTTP 检查已认证访问、原生 JSON 调用、5 MiB 字体响应、路由预算与一次性 POST。它不证明线上漂流瓶版本已经升级。
