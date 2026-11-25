# CooDock 对接 FFA Hub

## World 扩展

在 Coo / Cortico 的 CooDock 扩展页打开「FFA Hub · 配对运行端」。发起配对，在浏览器核对短码，选择有权限连接的 FFA bot，回到面板点击「完成配对」。原本的手机直连、iOS 扫码、公网中转、世界聊天、表情库和工作台使用各自原有连接方法。

如需将这个安装接入 CooDock 原有独立会话 worker，先完成公网中转绑定，在 World 配置里为 `ffaWorkerCredentialsFile` 指定当前运行账号私有目录中的**新文件绝对路径**。完成 FFA 配对后点「为独立会话工作台生成凭据」，再把原有 worker 配置的 `tokenFile` 指向该文件，bot 映射使用 FFA 主体 ID。Windows 还需用目录 ACL 限制文件访问。

Hub 管理员在 Hub 中为 bot 选择主运行端。关闭 World 或清除其本机记录不会撤销 Hub 的授权，需要在 Hub 撤销对应安装。使用独立会话与使用星邮专属频道是两条入口，服务端分别检查各自的权限。

## APP 补丁

当前公开仓库提供 World 发行源码。APP 补丁针对已交接的 CooDock 完整工程，Android 基线为 `coo-lite/android` 的 `0.6.0-dev.12`，含之前的共用 Starpost 原生组件。iOS 基线为 `coo-ios` 的 `0.2.2`。在包含这两个目录的完整工程根目录应用补丁。

```shell
git apply --check /path/to/this-repo/integrations/ffa/android.patch
git apply --check /path/to/this-repo/integrations/ffa/ios.patch
git apply /path/to/this-repo/integrations/ffa/android.patch
git apply /path/to/this-repo/integrations/ffa/ios.patch
```

- Android 的「账号与连接」可在系统浏览器注册 FFA。现有 CooDock 对话沿用 Hub 授权的星邮业务会话，在「账号与绑定」可一键发现并绑定 bot、选择归属和解绑。
- iOS 侧栏新增「FFA Hub · 我的 bot」。用系统浏览器完成 CooDock 授权，返回 APP 点「完成登录」，通过一次性 PKCE 流程兑换凭据并存入钥匙串。该入口支持切换已绑定 bot、翻阅专属记录、发送文字和图片、读取并播放服务端语音。「连接 Coo」和原有设备对话继续使用各自的连接与存储。
- 两端通过星邮公开的移动接口转发专属消息。Hub 密码在官方浏览器页面中输入，业务会话以用户授权的星邮号为准，发送来源由服务端标记为 CooDock。

## 回归验证

World 基线测试与配对增量测试可用 Node.js 24 运行 `npm test` 和 `npm run check`。合入 APP 补丁后，使用完整工程的原有 Gradle 和 Xcode 工程构建。安卓请分别构建 companion 和 workbench，核对手机直连、公网 World 及工作台入口和 FFA 页面。在隔离主机与测试 bot 上验证同一星邮号的两端历史、切换账号、撤销授权和旧记录保留。正式 APK 签名与 iOS 签名由原发行流程处理。
