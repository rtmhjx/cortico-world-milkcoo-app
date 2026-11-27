# 0.6.0-beta.1 — unified 4-tab CooDock v71 client & dev.6 World contracts

- Bundled fresh Android APKs (CooDock-0.6.0-beta.1-companion-debug.apk and CooDock-0.6.0-beta.1-workbench-debug.apk, package net.tina.coodock, versionCode 71, commit d1e87b0) with unified 4-tab shell, FFA Hub PR #1 auth, Bambu-style multi-agent switcher, and 3-zone editable Coo tab.
- Aligned World backend with dev.6 contracts: lanEndpoint and hostLabel bootstrap preservation, /api/prompts/prefix, /api/worlds/visibility, /api/session/reload-prefix, and /api/worlds/activation status confirmation.
- Replaced legacy dev.2 APK templates in client/ and synced public source to rtmhjx/cortico-world-milkcoo-app.

# 0.6.0-dev.4-tina.3-native-v43

Local undeployed candidate: restores fixed native management transactions, pins every host request to the current Bot deployment, retains configuration backup and verifies write readbacks. Does not publish or replace live state. Android templates retained from the original World are legacy templates, not the Starpost v43 base/split delivery.

# 2026-11-14 — isolated sticker storage

- Removed automatic discovery, reading and rewriting of QQ/other-World sticker libraries.
- Images and index now live exclusively in milkcoo_app/stickers; prior CooDock-only index is read-only compatibility input.
- Preserve phone upload/download, explicit public-room saves and duplicate-save behavior. Storage failures no longer report a successful save.
- Added author, the messaging tag and the public World source repository: https://github.com/rtmhjx/cortico-world-milkcoo-app.

# 0.6.0-dev.2 — independent authentication adapter candidate

- Extracted sessions and handoff into a framework-independent, zero-dependency auth-adapter package; the World keeps a compatibility facade and source-hashed vendor copy.
- Preserved old Core storage and HTTP routes, and added optional principal type, installation, scopes and audience fields.
- Android exposes a replaceable driver/presenter bridge, atomic batch persistence and configured service slots.
- The separate relay adapter is prepared for verified Hub login and default text entitlement. No Hub protocol or endpoint is hard-coded, and no production route is mounted.

# 0.6.0-dev.1 — native service frontend candidate

- Preloaded native Starpost UI, native core Bottle mailbox, and an explicit author slot for Bloom's full native frontend.
- Added ServiceFrontend lifecycle, service context, per-service session storage and replaceable common-login interfaces.
- Added World-to-App short-lived authentication handoff and three fixed public-relay operations.
- Candidate only: ins common identity, Bloom native game frontend, real-account/device acceptance and production rollout remain pending.

# 更新记录

## 0.5.0-beta.6（公共大厅）

- 安卓增加「世界聊天」入口。绑定公网中转账号后可进同一个大厅，支持文字、表情包、引用回复和 `@`。收到的表情可收藏。
- Cortico Bot 可在用户开启收听后接收新群消息。手机与电脑使用同一个收听开关，默认关闭。
- 市场条目沿用「移动前端coodock」。从扩展页更新并重启 Coo，再从 World 下载新的安卓 APK 覆盖安装。已绑定的中转账号可直接进入大厅。

## 0.5.0-beta.5（控制台连接状态）

- World 卡片提供独立的「本机通道」和「公网中转」状态灯，分别表示电脑本机监听和公网连接器轮询状态。
- 使用 Coopanion 0.2.13 可识别的 World ID `milkcoo-app`，启用后在侧栏显示「移动前端coodock」及状态灯。
- 从旧 ID 升级时沿用启用状态、可见性、设置、连接密钥和数据库。手机接口沿用原来源名，兼容 beta.4 安卓安装包。

## 0.5.0-beta.4（移动前端coodock）

- World 更名为「移动前端coodock」，添加公网主页和备用入口。沿用原 World ID 和 npm 包名，已安装用户可以正常升级。
- 在电脑 World 的本机面板填入公网密钥，注册本机后生成专属 Android APK；首启自动配对这台电脑。公网中转支持文字和对应档位的媒体，局域网直连入口保留。
- npm 包只含无个人配置的通用安装模板。专属 APK 含手机配对信息，请自行保管。iOS 沿用已有直连方式。

## 0.5.0-beta.3（UI 重构前底层整合候选）

- 修复本机 World 的 8877 残留，统一 Android 宿主 8879 / 原生能力 8880，面板使用实际监听端口和既有 panel-session Cookie。
- 会话中继与本机 World 插座解耦；纯前端模式可在明确启用 World 时按需启动插座，远端主线不会因此处理第二条模型对话。
- 原生能力桥移到共同 Android 宿主，轻量版同样提供按设备寻址的采集、朗读、通知与音频中继状态。屏幕和相机复用现有原生采集服务；新默认由 World 按需取帧。
- 增加持久设备请求、执行回执和媒体引用；手机重发同一回执，不盲目重做已开始的动作。同步本身不唤醒模型。
- 统一主线选择与连接档案，独立保留本机/备份/远端的待发归属。World 与模型管理统一入口；漂流瓶复用通用页面与转发容器。
- 工作台装配正式 SharedGitMem 本地/HTTP 适配、lmem_* 工具与冻结前缀，旧临时蒸馏队列改只读。原记忆档案与批阅服务入口保留。
- Android 为本地构建候选；物理手机与生产服务器挂载另行验收。iOS 本轮未改。


## 0.5.0-beta.2（主机优先与可选工作台）

- 安卓提供主机版和完整工作台两个 APK，同包名同签名，可覆盖更新。主机版从打包源集中排除 Node/Cortico、工作台引擎服务及运行时资产；完整包保留 beta.1 工作台能力。
- 新增“Coo 控制台”原生顶层 WebView，直接复用主机的正式界面。地址可由 World 热配置或手机手动设置，保留域名、HTTPS 和代理路径；不套 iframe、不猜固定端口、不注入手机通道密钥。
- World 卡片与安装页同时提供两种专属 APK；完整包仅在下载时生成，普通连接不因此常驻加载完整 APK。
- 保留消息关联、幂等原文、回执和现有手势，不引入全局单槽等待、全局 QQ 静默窗或任务二次总结流程。指南更新为 15 章。

## 0.5.0-beta.1（随身工作台整合候选）

- 安卓客户端整合 Tina 随身工作台：共同记忆接入、原文与来源、导入导出、批阅、电脑工作流水、主机配置与 World、本端侧 API 续聊及独立控制台。
- 内置 ARM64 Node 24/Cortico 运行时，进入工作台才启动；服务器模式不额外创建本地 Core。默认不加载 World，模型权重、个人记忆和凭据均不随包分发。
- 手机通道增加会话快照与主机工作台接口，沿用原通道认证；配置与状态备份加密后保存，会话与工作区原字节另由快照保留。
- 新增角色与装扮页，读取 Coo 现有角色、装扮轴和预设，复用 Coo 的 ZIP 检查、安装和移除流程；应用后回读确认，两端位置独立。
- 保留单击显示对话/语音球、双击静置 0.7 秒后看屏幕、连戳取消等已有逻辑。扩充离线图文指南。
- iOS 仍为原 0.2.2 未签名测试候选，本次新增工作台仅落在安卓；真机验证待手机接入。

## 0.4.0-beta.6（安装入口兼容候选）

- World 总览卡片直接提供安卓专属 APK 与未签名 iOS IPA 的下载入口，同时保留安装指南与苹果配对入口。
- 保留旧 World 标识、数据、连接和事件来源；Coopanion 0.2.13 的通用详情页仍不接受此标识，可直接使用卡片入口。
- 延用上一候选附带的安卓客户端和 iOS 未签名测试包；本次没有完成手机或 iPhone 真机验收。

## 0.4.0-beta.5

- 小人气泡关闭按钮跟随气泡下缘，关闭当前内容后仍可显示后续消息。
- 小人对话按钮打开悬浮输入窗口，支持保留草稿并通过手机原有队列发送。

## 0.4.0-beta.4

- 本机管理、配对和下载页面校验实际 Host 与端口；手机 API 的认证和跨网访问保持不变。
- 更新安卓客户端，修正深色模式标题的对比度；聊天图片直显与输入法在真机隔离测试中通过。

## 0.4.0-beta.3

- 安卓新增漂流瓶信箱入口、Compose 界面与外观设置。
- 手机通道增加漂流瓶桥接及设备定向的小人中断事件；正式真机验收待完成。
- iOS 保留原有未签名测试包，本次未新增漂流瓶入口。

# 更新记录

## 0.3.34-beta.6（连接修复候选）

- 延长手机附件上传时间上限，减少慢速网络传输大图时被中断的情况；同一消息重试仍使用原编号。
- 更新安卓候选至 0.3.38-beta.1：发送和接收分开运行，上传失败自动退避重试，同时保持待发顺序。

## 0.3.34-beta.5（公开接口修订候选）

- 不再访问未列为公开契约的扩展市场、扩展清单、模型目录与提供商能力目录；手机市场目录暂不可用，World 列表只反映公开运行列表，模型 ID 支持手动输入。

## 0.3.34-beta.4（社区兼容修订候选）

- 移除替换桌宠内部方法的逻辑和对内部读屏代码的导入；电脑桌宠动作镜像及电脑读屏目前不可用。
- 手机消息、媒体、屏幕分享与原有数据路径保持独立；悬浮小人仍依赖宿主网页资源，待确认公开接口。
- 尚未通过社区复核，手机端和 iOS 候选的验收状态分别记录。

## 0.3.34-beta.3（本地候选）

- 提供未签名的 iOS 0.2.2 测试 IPA 和 AltStore Classic Windows 安装说明；签名、安装及 iPhone 真机联调均待验证。
- 合并 iOS 编译修复与地址解析测试；特别鸣谢墨韵瞳对 iOS 构建和测试的帮助。
- 不改变现有安卓通用安装包；更新 World 内安卓图文指南的鸣谢。

## 0.3.34-beta.2

- 为 World 市场卡片添加头像。

## 0.3.34-beta.1

- 独立 World ID、配置、数据库、端口和工具命名，保留手机事件类型并兼容新旧安卓来源。
- 可选 EasyTier 组件下载；可选启动统计和故障反馈默认关闭，日志可预览。iOS 源码及跨网仍需实机验证。

## 0.3.31

- 安卓冷启动加入原始 Coo GIF 动画：加速播放约 2.3 秒，可轻点跳过。
- 安卓离线使用指南加入启动动画点子的原始截图与鸣谢。

## 0.3.30

- 修复右上角头像可能只显示桌宠阴影：优先使用形象提供的缩略图，Coo 本体使用官方形象绘制，识别失效缓存并显示默认图。
- 星邮更新汇总在手机上显示为简短提示，完整事件仍保留在时间线；限制气泡高度，避免覆盖整个对话。

## 0.3.29

- 安卓右上角图标再次点击可返回进入星邮私聊前的页面；首次使用有星邮流程引导，连接出错时点击提示重试。
- 图标使用黄色背景与当前小人画面；支持按桌面提示添加可跟随小人更新的独立快捷入口。部分人物未提供头部坐标，暂用完整轮廓，渲染不可用时沿用上次画面或默认图标。

## 0.3.28

- 安卓右上角奶coo 图标打开星邮「我的 bot」私聊，内容占满标题栏下方；保留侧栏原对话和公网 World 入口。
- 同步更新安卓图文指南；苹果客户端保持 0.2.2 源码版本。

## 0.3.27

- 安卓侧栏加入「公网 World」，可打开星邮的官方网页，也可填写其他 World 提供的 HTTPS 网页地址；各站点使用自己的账号和连接。星邮域名首页连接失败时尝试官方客户端公布的 HTTPS 备用地址，仍验证证书。
- 该入口复用网站本身，不会安装星邮 World 或为奶coo 局域网连接创建公网隧道；苹果客户端保持 0.2.2 源码版本。

## 0.3.26

- 新增主机本地统一入口，提供安卓专属包、苹果配对、两端图文指南及苹果客户端源码；没有假称已生成 iOS 安装包。
- 安卓客户端加入可预览、手动分享的明文诊断日志，以及按页面打开的离线图文指南；保持原有事件、连接与桌宠数据。
- 两种客户端共用同一 World 事件通道；设备各自的对话 feed 仍按设备隔离。

## 0.3.25

- 允许在发送已有附件句柄时附带已知原文件名；同步 World 静态工具说明和运行时定义。

## 0.3.24

- 在原有图片、语音通道上增加短视频与文件的原字节收发，单个附件仍不超过 8 MiB；模型是否能理解附件仍取决于模型及对应工具。
- 媒体表只追加可选文件名字段，旧记录和原有 Android 请求继续兼容；健康接口声明文件能力。更新前应取得 SQLite 一致备份。

## 0.3.23

- 为苹果设备提供本机生成、五分钟有效且一次性使用的扫码连接；连接仍使用现有手机事件流。
- 扫码页面和二维码在本机生成，不把配对信息发送给第三方服务。

## 0.3.22

- 更新手机 App 至 0.3.21：键盘收起后复核系统状态，避免固定 Y 轴的小人仍被限制在键盘顶部。
- 小人根据手机键盘变化升降；手机系统漏发动画结束时恢复可活动范围。

## 0.3.21

- 更新手机 App 至 0.3.20：聊天刷新时只滚动消息，不转移输入焦点，避免打断拼音输入。
- 已连接且悬浮窗权限已开启时，打开 App 默认显示小人；可在“随身小人”关闭自动显示。

## 0.3.20

- 自适应观察以最近一次送给模型的画面为基准，稳定画面仅更新缓存，不反复唤醒模型；上一帧未了结时不重复排队。

## 0.3.19

- 聊天中增加系统相机拍照并进入原有图片队列。
- 增加由手机主动开启和关闭的摄像头抽帧通道，支持前后摄、按需查看、主动观察以及手机/Coo 共同调节清晰度与频率；并非实时双向视频流。

## 0.3.18

- 手机 World 页保留断连提示、支持点状态重试，并收紧页面标题布局。

## 0.3.17

- 手机页面向 Coo 深色界面对齐，增加“我的 World / 扩展市场”浏览和搜索；安装、卸载与运行控制仍在电脑端完成。
- 手机 World 工作区只返回运行状态和公开市场信息，不传工作目录、提示词或凭据。

## 0.3.16

- 修复手机桌宠消息在系统主线程网络限制下无法显示；发送队列保序，连接写入失败时让桌宠自动重连。
- 增加手机本地连接与主线程发送的回归检查。

## 0.3.15

- 手机端按 World 来源管理小人气泡、通知栏、可选横幅和锁屏正文，提供本机示范和独立透明度设置。
- 手机读取 World 公开名称和启用状态；原始事件和来源不变，首次补历史不补发旧提醒。
- 手机小人快捷按钮比桌面默认延长 0.75 秒。

## 0.3.14

- 适配 Cortico World API 6。
- 手机端设置收进左侧菜单，提供新手引导；聊天图片直接显示，语音按需播放。
- 手机通道保留离线记录和来源，添加媒体类型轻量读取。


