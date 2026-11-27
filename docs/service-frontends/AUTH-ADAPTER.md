# CooDock 认证接入适配层

独立的服务会话、身份提供方接线和设备交接模块。可用于普通 Node 服务、App、命令行或 Cortico 适配器；不导入 Cortico，不加载 World，也不要求业务服务相互依赖。正式 Hub URL、OAuth／OIDC 实现、扫码、成员管理及恢复规则由 ins 的驱动提供，本模块没有虚构线上认证端点。

## 模块与宿主边界

| 部分 | 入口 | 负责 |
|---|---|---|
| 通用 JS | `src/index.mjs` | `AuthSessions`、`createProviderBridge`，服务目录、会话、短时设备交接 |
| 通用 Java | `android/src/main/java/net/coodock/auth/` | `AuthClient` 驱动编排与脱敏回执、`SessionPersistence` 批次保存／失败恢复 |
| CooDock World 适配 | `../coo-app-world/src/ecosystem-session.mjs` | 原 Core secret、服务目录及 HTTP 路由的薄接线；保留旧存储 key 和旧会话 |
| Android 宿主接线 | `EcosystemAuthentication.installDriver()` | IO 执行器、作者登录界面、主线程回调和 App 加密会话存储 |
| 中转服务接线 | `../paid-relay/federated_auth.py` | 验证端口、共同身份到本地账号映射、本通道安装凭据与默认 text 权益 |

Cortico 适配器使用 `tools/sync-auth-adapter.mjs` 的本地源码副本。`UPSTREAM.json` 记录每份来源和 SHA-256；独立模块是维护源，vendor 是分发副本。普通使用者直接导入本包，不需要这个副本或 Cortico。

## JS 最小接入

```js
import { AuthSessions, createProviderBridge } from './src/index.mjs';

// 内存示例仅演示契约；实际宿主使用私有持久存储。
const values = new Map();
const sessions = new AuthSessions({
  storage: { read: key => values.get(key), write: (key, value) => values.set(key, value) },
  storageKey: 'my-app-service-sessions',
  services: [{ id: 'my-service', title: '自己的服务' }],
  defaultProviderId: 'procoo-hub',
  handoffEndpoint: '/my-app/auth/handoff', // 由宿主选择和认证保护
});

// 先留出插口；尚无 driver/exchange 时保持 pending，不产生登录成功。
sessions.registerProvider(createProviderBridge({ id: 'procoo-hub' }));
```

正式接入时由 ins／服务适配方提供：

```js
sessions.registerProvider(createProviderBridge({
  id: 'procoo-hub',
  driver: {
    async begin(input) { return startAuthorLogin(input); },
    async complete(input) { return verifyAuthorLogin(input); },
  },
  async exchange({ serviceId, authorization, input }) {
    return obtainRealServiceSessions(serviceId, authorization, input);
  },
}));
```

上面的三个函数是作者要交付的实现，不是 SDK 自带的联网能力。begin 只返回可展示的流程信息；complete 验证协议结果；exchange 再取得目标服务真正接受的会话。不要把 App 自报的 subject、角色或昵称当作已验证授权。

storage.read/write 是**同步、原子**的序列化状态存储接口。write 失败应抛错且不替换原记录；模块在读回一致后才发布新的内存状态。浏览器或异步数据库需由宿主另接适当存储，不直接假定此 Node 实现可以在所有浏览器运行。

服务会话保留 `serviceId/issuer/subject/credential`，可选 `principalType: human|bot`、`botId`、`installationId`、`scopes`、`audience`、`serviceSubject`、`expiresAt`。JS／Java 的 expiresAt 为 Unix 毫秒。未增加新身份字段的旧四维键不变；新安装／主体类型参与扩展定位。多个外部身份与同一个 Bot 的成员关系由 Hub 定义，模块不把它写成一对一。

公开 catalog 与登录完成回执不返回 credential。短时 handoff 的兑换包含真实服务凭据，只能放在宿主已有的认证通道上。handoff 票据保存在内存，进程重启后失效；这不影响已保存的服务会话。

## 原生 App 驱动

`AuthClient.Driver` 使用同步 begin／complete，由宿主放到 IO 执行器；ProviderFlow 将公开流程字段与私有 state 分开。完成时先验证整个会话批次，再交给 SessionSink.save；失败不会发布成功回执。保存失败后的同 Flow 重试复用已验证批次，不重复调用驱动。Flow 不可跨 AuthClient 使用，取消后不再提交。

CooDock 通过 `EcosystemAuthentication.installDriver(driver, presenter, ioExecutor)` 安装一次接线。Presenter 由作者实现：展示原生／系统认证页，回交协议结果，显示成功或失败。默认不安装任何真实驱动；仍保留原服务登录入口。Activity 生命周期、回跳与系统浏览器由接入方实现，本模块不写一个空白登录页假装认证可用。

Android 仍是一份选中连接下、每服务一份活跃会话。原远端三服务存储键保留；本机主路、检查点与远端分开，新服务使用独立会话命名空间。服务目录可由已认证宿主配置，不再只允许三项写死服务。App 的动态源码模块注册与完整多账号界面不是认证目录的自动能力。

`SessionPersistence` 验证批次写盘返回失败时恢复旧进程缓存和待兑换票据。纯 Java 测试模拟这种失败；Android Keystore、真实磁盘故障与手机登录尚未实机验证。

## 本通道默认非全能权益

本轮按用户明确要求：ins 的服务端认证验证成功、尚无本地映射时，默认开通原有 **text 档**。不能接受客户端自选 full；已有账号与升级权益不被默认档位覆盖。正式部署者可通过配置关闭自动开通，但本项目交付默认是 text。

验证、映射、开户和本通道凭据属于 `paid-relay` 的独立服务适配器。它不向 Hub 注册一个假的账号，也不把 Hub token 当成本地 mcd 凭据；只有原服务本身决定设备槽、配额和业务权限。无需让其他 World 参与这个过程。

## 本地验证

```text
node --test auth-adapter/test/*.test.mjs
node tools/sync-auth-adapter.mjs
node --test coo-app-world/test/*.test.mjs
cd paid-relay
python -m unittest -v test_federated_auth
```

Java 17 可编译 `android/src/main/java/net/coodock/auth/*.java` 与 `android/test/AuthClientCheck.java`，运行 AuthClientCheck。Android App 编译另外包含上述独立 Java 目录。所有样本均为合成身份和临时本机数据；本轮不调用真实 Hub、不挂载新服务、不更新线上。
