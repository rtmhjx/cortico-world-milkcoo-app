# 三服务登录与 App 认证交接接口 v1

此模块位于 `src/ecosystem-session.mjs`。它把现有各服务登录封装为可替换接口，等待 ins 提供共同认证实现。它不签发全生态用户身份，也不把 Coo 连接密钥当作星邮、花语乡或漂流瓶的登录凭据。

0.6.0-dev.2 已将公共实现移到独立 `auth-adapter` 包；本文件所述模块只保留 Core secret、旧服务目录与路由的兼容适配，使用有来源哈希的 vendor 副本。正式驱动通过 createProviderBridge 接入。通用模块与中转的默认 text 权益不依赖 Cortico 或其他 World，正式 Hub 未配置时保持 pending。

## 身份和服务

服务 ID 固定为 `starpost`、`flower-town`、`bottle`。每份服务会话由 `(serviceId, issuer, subject, botId)` 唯一标识，三个服务的 token 分开保存。昵称和邮箱相同不表示两个服务中的用户已经得到共同认证。

会话由 World 的 Core `secret` / `storeSecret` 保存。目录、状态与登录成功回执只返回身份和状态，不返回 `credential`。初始 `ins-identity` provider 是 `pending`；调用它会得到 `ECOSYSTEM_PROVIDER_PENDING`，不会显示为共同登录成功。既有服务的登录使用 `providerId: 'legacy'`，公开状态明确是 `mode: 'per-service'`。

四维定位与多会话选择指 World 存储。Android `EcosystemSessions` 当前以连接 scope＋serviceId 保存一份活跃会话，内容保留完整身份字段，但未实现同服务多账号并存。

## World 集成

```js
import { EcosystemSessions, dispatchEcosystemRequest } from './ecosystem-session.mjs';

// start() 时建立；有真实自定义服务目录时可传 services。
this.ecosystem = new EcosystemSessions({ context: this.context });

// 下列分支必须位于 world.mjs 已有的 Bearer 认证之后。
if (url.pathname === '/v1/ecosystem' || url.pathname.startsWith('/v1/ecosystem/')) {
  const input = req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readJson(req, 65536);
  const result = await dispatchEcosystemRequest(this.ecosystem, req.method, url.pathname, input);
  if (!result) throw new MobileError('NOT_FOUND', 404);
  send(res, result.status, result.body);
  return;
}

// 现有 World Owner 面板 RPC 可直接调用相同方法；不要向匿名页面开放。
await this.ecosystem.invoke('overview');
await this.ecosystem.invoke('login', { action: 'begin', providerId: 'ins-identity', serviceId: 'starpost' });
// stop() 时丢弃未使用的设备交接票据；服务会话继续保留在 Core secret。
this.ecosystem.clearHandoffs();
```

HTTP 路由：

| 方法 | 路径 | 输入 / 结果 |
| --- | --- | --- |
| GET | `/v1/ecosystem` | 三服务目录、provider 状态、非敏感会话状态 |
| GET | `/v1/ecosystem/sessions?serviceId=starpost` | 指定服务的非敏感身份 |
| POST | `/v1/ecosystem/login` | `{action:'begin'|'complete', providerId, serviceId?, ...providerInput}` |
| POST | `/v1/ecosystem/select` | `{serviceId,issuer,subject,botId?}`，切换该服务的活跃身份 |
| POST | `/v1/ecosystem/logout` | `{serviceId,issuer?,subject?,botId?}`，本机解除选定服务绑定 |
| POST | `/v1/ecosystem/handoff` | `{ticket,deviceId,operationId}`，兑换安装包中的认证交接 |

`logout` 是 CooDock 本地解除绑定，不承诺远程服务 token 已注销；需要远端撤销时由对应 provider 或原服务实现提供。Owner RPC 另支持 `catalog/overview/sessions/login/selectSession/logout/createHandoff/consumeHandoff`。所有方法均不调用模型。

## 现有服务登录接入

由对应服务适配器在真正完成登录、确认账号后导入；不要从昵称猜测 `subject`，也不要扫描用户凭据文件。

```js
this.ecosystem.adoptSession({
  serviceId: 'starpost',
  issuer: verifiedStarpostServerOrigin,
  subject: successfulLogin.account.id,
  botId: successfulLogin.selectedBotId,
  displayName: successfulLogin.account.name,
  providerId: 'legacy',
  credential: { kind: 'bearer', accessToken: successfulLogin.accessToken },
  // 可选，毫秒 Unix 时间；不传则不推测上游有效期。
  expiresAt: successfulLogin.expiresAt,
});
```

`credential` 是服务适配器自己的 JSON 对象。v1 示例使用 Bearer token；保留此对象便于今后替换为可交换的短期凭据。CooDock 内部不解析或伪造该服务的 token。

## ins 的共同 provider 插口

```js
this.ecosystem.registerProvider({
  id: 'ins-identity',
  title: '星邮共同账号',
  async begin({ serviceId, ...input }) {
    // 交给真实认证端发起登录。只返回用于打开登录页/确认设备的流程信息。
    return { flowId, authorizationUrl, userCode, expiresAt };
  },
  async complete({ flowId, code, serviceId }) {
    // 认证端验证结果，并向已经接入信任关系的服务换取它们各自可接受的会话。
    // 可以一次只返回一个服务；不能把同一个总 token 无条件广播到全部服务。
    return { sessions: [
      { serviceId: 'starpost', issuer, subject, botId,
        credential: { kind: 'bearer', accessToken }, expiresAt },
    ] };
  },
});
```

`begin` 和 `complete` 均已实现才会显示 provider 为 `ready`。一批会话全部校验通过并保存成功之后才返回登录成功；结果为空或包含未知服务时不产生部分成功状态。SDK 不限定 ins 的认证后端，也不自建账号服务器。

## World 已登录 → 打印 App 继承

在每次下载个性化 APK 时创建交接，不能在 World 启动时提前生成并长期缓存同一个票据：

```js
const catalog = this.ecosystem.catalog();
const handoff = this.ecosystem.createBootstrapHandoff();
const bootstrap = {
  ...existingConnectionBootstrap,
  ecosystem: {
    version: 1,
    services: catalog.services,
    ...(handoff ? { handoff } : {}),
  },
};
const bytes = addBootstrap(templateBytes, bootstrap);
```

`apk-bootstrap.mjs` 必须显式保留 `connection.ecosystem`，Android `ApkBootstrap` 同样需要读回该字段。handoff 默认为 15 分钟，可通过 `ticketLifetimeMs` 配置。打印出的字段只有：

```json
{
  "endpoint": "/v1/ecosystem/handoff",
  "ticket": "opaque-one-device-ticket",
  "expiresAt": 1794000000000
}
```

App 使用已建立的 Coo 连接认证，POST 此相对路径，携带自己的稳定 `deviceId` 与持久保存的 `operationId`。回应中的 `sessions` 含服务凭据，只保存到端侧私有凭据存储。收到成功回应且保存后清除本地待兑换标记。网络丢失时使用同一 `ticket/deviceId/operationId` 重试，在有效期内得到相同回执；换设备或换 operation 不能再消费。票据过期或 World 重启则提示重新打印/重新认证，不把状态显示为已登录。服务 logout 会同时撤销涉及该服务的待兑换和重试回执。

源码已经增加三种配对设备操作：`ecosystem.read` 固定转发 `GET /v1/ecosystem`，`ecosystem.handoff` 固定转发 `POST /v1/ecosystem/handoff`，`ecosystem.invoke` 固定转发 `POST /v1/ecosystem/invoke`。后者只接受 `starpost/flower-town/bottle`、`GET/POST`、相对服务路径与 JSON 对象，继续使用既有账户、设备、connector 绑定、文字预算和回执；不提供任意外部 URL 代理。文件、二进制和完整网页不走这条 JSON 操作接口。

2026-11-12 本地中转修正：`ecosystem.invoke` 接受可选且合法的 operationId 并原样转发；兼容已安装 Android 的 body:null，转发前视为省略正文。context 和非空 body 仍需是 JSON 对象。操作编号的传递不等于服务端业务自动幂等，中转重取继续使用原 request_id 收据。本次未部署线上。

Android `PublicRelayClient.discover()` 是既有 `refreshPeer()` 的兼容入口。handoff 的中转 request ID 由稳定 `operationId` 派生，重试不会产生新的传输操作；中转会把 `deviceId` 固定为已经认证的设备 ID。公共中转与 World 两端均需更新源代码后再部署，现有线上进程不会自动获得新能力。

## 本次验证

`node --test test/ecosystem-session.test.mjs` 覆盖目录脱敏、四维身份隔离、provider 热替换、原子交换、短期交接、丢包后同操作重试、logout 撤销、存储失败，以及真实本机 HTTP 服务与 Owner RPC 使用相同契约。测试只用合成凭据和临时本机端口，不访问线上认证服务。
