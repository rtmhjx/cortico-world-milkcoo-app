# CooDock 原生服务前端接入 v1

本文给星邮、花语乡、漂流瓶作者及宿主维护者使用。目标是在同一个 CooDock App 内预载服务自己的原生前端，保持原有风格、页面、功能和使用逻辑。服务端继续运行在各自服务器；CooDock 提供入口、当前设备能力及认证交接接口。

这里的“预载”指前端源代码或正式原生模块参与 App 构建。`manifest.json` 是构建和作者交付契约，当前版本由宿主显式注册模块，不会根据 manifest 动态下载、执行任意代码。网页入口、外部浏览器或在 WebView 中打开服务不计作本协议的原生前端交付。

## 当前交付边界

| 服务 | Android 现状 | 仍需作者或联调补齐 |
|---|---|---|
| 星邮 | 原版 Android 1.10.3 的 19 个 Compose/网络/通知源文件已迁入 `net.tina.mobile.starpost`，通过独立原生 Activity 承载 | 统一账号提供方接入；真实账号、收发、游戏及通知验收 |
| 花语乡 | 已注册 `FlowerTownFrontend` 原生插槽、身份与场景接口 | **完整小镇游戏前端仍待作者提供**；插槽页面不是完成的游戏界面 |
| 漂流瓶 | 已预载原生核心信箱；完整主题等未覆盖，真实服务与设备联调待验收，复用既有 World 服务能力 | 原生交互、认证及完整动作链验收；旧 WebView 页面不作为此模块完成依据 |
| iOS / Windows / Linux / 鸿蒙 | 共用身份、来源和会话协议的约定 | 各平台原生前端实现；本文不声明已交付 iOS 等模块 |

示例位于 `examples/service-frontend-v1/manifest.json`，Schema 位于 `schemas/service-frontend-v1.schema.json`。示例中的 `bundled` 表示源码已经预载，不表示线上服务或真实账号已经验收。服务 ID 在一个 manifest 中必须唯一。

## 作者交付什么

建议每个服务交付以下目录，并固定来源版本：

```text
my-service/
  manifest.json            服务 ID、World 映射、平台模块及认证提供方
  android/                原生 View / Compose 或既有完整 Activity 源码
  assets/                 图标、字体、主题、图片、动画及原路径说明
  protocol/               API、实时事件、认证、版本和错误约定
  fixtures/               合成账号、场景、消息、动作回执样本
  tests/                  原生导航和协议测试
  LICENSE                 原许可、版权与第三方声明
  INTEGRATION.md          依赖、生命周期、服务器及设备接口说明
```

作者标明真实前端入口、所有业务页面、资源和字体路径、必要 Android 依赖及原 App 的启动逻辑。宿主适配保留这些内容，不把完整应用重写成缩减的列表。如果源 App 有独立 APK 自动更新器，需要交由 CooDock 的应用更新流程管理，避免服务模块安装另一个包或尝试替换宿主。

## Android 原生模块接口

现有接口在 `coo-lite/android/app/src/main/java/net/tina/mobile/ServiceFrontend.java`：

```java
public interface ServiceFrontend extends AutoCloseable {
    String id();
    default Class<? extends Activity> activityClass() { return null; }
    default View mount(Activity activity, ServiceFrontendHost host) throws Exception {
        throw new UnsupportedOperationException("此模块使用独立原生界面");
    }
    default void resume() { }
    default void pause() { }
    default boolean back() { return false; }
    default boolean onActivityResult(int requestCode, int resultCode, Intent data) { return false; }
    default void close() { }
}
```

`mount` 在界面线程创建并返回本服务的原生根 View。Compose 前端可返回 `ComposeView`，继续使用本服务自己的主题、组件、导航和状态模型。网络和文件 IO 在后台线程进行，结果再提交到界面线程。`pause`、`close` 释放本模块拥有的监听、任务、计时器及 View；不停止远端服务，也不退出其他服务账号。

完成原生实现后显式注册：

```java
ServiceFrontends.register("my-service", MyServiceFrontend::new);
ServiceFrontends.open(activity, "my-service");
```

这段是模块注册方式示意。新增服务 ID 也要加入当前服务目录、会话存储及 World 端路由允许的服务清单；v1 默认交付星邮、花语乡和漂流瓶三项。

已经有完整原生 App 的服务可以适配其 Activity。当前星邮是具体例子：`ServiceFrontends.open(activity, "starpost")` 进入 `net.tina.mobile.starpost.StarpostActivity`，它直接承载原版 `StarpostApp` 和主题。另一个服务采用 Activity 时，模块通过 `activityClass()` 返回其 Activity 类；作者交付 Manifest 需求与进入/退出约定，宿主按同一注册流程挂载。**仅在 manifest 填入任意 Activity 类名不会自动获得执行能力**，也不存在尚未实现的通用 `registerActivity` API。

## 宿主上下文与服务调用

`ServiceFrontendHost` 当前公开：

```java
Activity activity();
JSONObject session();
void saveSession(JSONObject value);
void logout();
boolean signIn();
void setScene(JSONObject scene);
JSONObject context();
JSONObject request(String method, String path, JSONObject body);
```

`session/saveSession/logout` 仅操作当前 `serviceId` 的服务会话。`setScene` 由服务在页面/地点切换时更新，例如：

```java
host.setScene(new JSONObject()
    .put("sceneId", "town-square")
    .put("channelId", "town-2026-main")
    .put("objectId", "notice-42")
    .put("action", "comment"));
JSONObject source = host.context();
```

`context()` 补入 `serviceId`、本次前端 `instanceId`、`deviceId`、`actorKind: "human"`，以及已有会话的 `issuer/subject/botId`。业务方保留自己的 `sceneId/channelId/objectId/messageId` 等来源。这样用户针对哪条公告、哪个地点提出建议可以随动作传递；框架不能凭页面标题推断用户没有表达的意图。

`request` 在后台线程调用，经当前 Coo 通道发送到 `/v1/ecosystem/invoke`，附服务 ID、场景来源及 operation ID。服务方要交付对应 World 后端方法映射；它不是可以输入任意远程 URL 的通用代理。新请求的 operation ID 不表示任意业务动作都可自动重试，写操作的回执及重试语义应在该服务协议中明确。

本机 Coo 通道 token 由宿主网络层持有，**不能放进服务的 UI 参数、网页、消息来源或发给其他服务服务器**。交给前端和服务端适配器的是本服务自己的凭据。需要截图、文件选择、音频等本机能力时使用宿主已有设备接口，并在交付文件中列出实际使用项；登录某个服务不会自动授予操作系统权限。

## 共同登录器：由 ins 接入

共同登录器当前预留为 `ins-identity`。它尚未实现时，目录明确返回 pending，不把“登录了一个 World”宣称为所有服务的人类账号均已登录。既有服务的登录方式可以作为独立适配器继续存在。

一份服务会话的核心格式：

```json
{
  "serviceId": "starpost",
  "issuer": "https://identity.example.invalid",
  "subject": "stable-human-id",
  "botId": "optional-bot-id",
  "providerId": "ins-identity",
  "credential": {
    "accessToken": "SERVICE_SCOPED_TOKEN",
    "baseUrl": "https://service.example.invalid"
  },
  "expiresAt": 2000000000000
}
```

凭据示例是占位符。World 会话以 `serviceId + issuer + subject + botId` 定位；Android 当前每个连接的每个服务只保存一份活跃会话，不承诺同服务多账号并存。昵称和相同邮箱不作为跨服务同一人的凭证。`botId` 为可选，持有 Bot key 不等于获得完整人类账号。星邮本地 `humanId` 可保存为 `serviceSubject`，不能覆盖共同身份提供方签发的 `subject`。

World 侧提供方接口位于 `coo-app-world/src/ecosystem-session.mjs`：

```js
ecosystem.registerProvider({
  id: 'ins-identity',
  title: '共同账号',
  state: 'ready',
  async begin({ serviceId, ...input }) {
    // 返回作者实现的真实认证流程所需信息。
    return beginCommonLogin({ serviceId, ...input });
  },
  async complete({ serviceId, ...input }) {
    // 完成验证/令牌交换后返回真实服务会话；不是仅凭客户端提交身份签发。
    return { sessions: await exchangeServiceSessions({ serviceId, ...input }) };
  }
});
```

`beginCommonLogin/exchangeServiceSessions` 是 ins 要提供的实现示意，不是现有 SDK 方法。已验证的原服务登录结果可通过 `adoptSession` 登记；公开目录仅展示身份、状态和过期时间，不返回 credential。

App 侧共同存储为 `new EcosystemSessions(context)` 的 `session(serviceId)`、`putSession(serviceId, value)`、`clearSession(serviceId)`。星邮适配已读写此存储，并兼容旧 `credentials` 字段名。ins 可以安装：

```kotlin
StarpostHostAuthentication.install { context ->
    // 打开共同登录器，成功后把 starpost 的服务会话存入 EcosystemSessions。
    // 返回星邮 Activity 时，原生客户端会重新读取已经变化的会话。
    openCommonLogin(context)
}
```

`openCommonLogin` 同样由接入方实现，返回 Boolean 表示是否成功发起。当前钩子针对星邮；其他服务通过同一会话协议接入自己的原生登录入口，不需要复制星邮的人类账号逻辑。

## World 登录后打印 App 的认证交接

World 仅为当前已登录且未过期的服务会话生成短时 handoff。打印或连接配置中放入票据与到期信息，不把长效服务凭据公开在目录、下载链接或 UI URL 中。

App 通过已有认证通道向 `POST /v1/ecosystem/handoff` 发送：

```json
{
  "ticket": "SHORT_LIVED_TICKET",
  "deviceId": "receiving-device",
  "operationId": "stable-for-this-redemption"
}
```

当前实现的默认票据寿命是 15 分钟，内存票据在 World 进程重启后失效。首次兑换绑定接收设备和 operation ID；同设备、同 operation ID 在有效期内重试返回同一回执，不重复消费。另一设备或不同 operation ID 再次消费返回冲突。App 应持久保存本次兑换的 operation ID，直到回执已安全写入本机后移除本地票据。写入失败时不能换一个 operation ID 盲目重试。

handoff 返回的会话按服务存入 App。哪个服务没有真实会话，就仍然显示未登录。共同登录器尚未接入时，不会凭其他服务的会话伪造它的登录状态。票据过期或 World 重启后由当前 World 重新打印/生成交接配置。

## 作者与宿主共同验收

1. 提交固定版本、许可、原生源码、资源、依赖和原 App 功能清单。宿主确认入口已参与构建，且打开时没有退回浏览器。
2. 按原有顺序走通主要页面、返回、输入、媒体选择及状态恢复；保留原主题和业务语义。
3. 使用合成账号验证每项服务的 credential 独立，切换账号和退出不会误用另一服务会话。
4. 验证 World 中已有登录的 App 交接：正常兑换、同 operation ID 重试、错误设备、过期和重启；成功后本机读取到正确服务身份。
5. 验证动作携带具体服务、场景、对象与发言者来源。服务端收到的身份由其自身认证验证，不能仅信任显示昵称。
6. 在经授权的真实设备和账号上分别验收实际收发、游戏动作及需要的后台通知。源码、编译和合成接口测试不替代这一步。
7. 逐项记录哪些能力已预载、可打开、已登录、可交互、通过真实设备验证。花语乡原始游戏前端未交付时保持 `awaiting-upstream`。

跨平台共用 manifest 的服务 ID、身份结构、来源字段和任务回执；Android、iOS、Windows、Linux、鸿蒙分别使用各自原生 UI 和权限接口。不能把一个 Android Activity 或网页模块的完成，直接记成其他平台也已实现。

## App 的统一登录启动接口

`EcosystemAuthentication.install(Launcher)` 安装一次登录器；`Launcher.signIn(Context, List<String> serviceIds)` 打开作者提供的原生认证流程。认证成功后，把每个服务的真实会话写入 `EcosystemSessions`，返回前台后由服务自己的客户端恢复。它同时接通星邮原版登录页的 `StarpostHostAuthentication` 入口。

`ServiceFrontendHost.signIn()` 请求当前模块登录；账号管理页可以请求三项服务共同登录。未安装 Launcher 时仍使用原服务登录，不显示虚假的共同账号入口。

带场景进入服务可调用 `ServiceFrontends.open(activity, serviceId, sceneJSONObject)`。View 模块从 `host.context()` 取得场景，完整 Activity 从 Intent 的 `scene` 字符串取得。接收方负责把场景映射到自己的真实路由，尚未接入该映射的原版页面不应被标为已支持跨服务跳转。

## 当前构建边界

本轮源码候选为 `0.6.0-dev.1`。星邮复用了完整上游原生前端；漂流瓶已预载原生核心信箱，不含上游全部主题、自定义字体背景声音、小纸条和邀请间隔编辑。花语乡保持 `awaiting-upstream`，完整原生游戏 UI 需由作者交付。CooDock 的旧通用 Web 面板仍可供其他 World 使用，以上三服务的新预载入口不以网页浏览器实现。
