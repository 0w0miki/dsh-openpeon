---
description: "dsh Web 客户端的语音包与浏览器提醒插件：在设置页浏览并安装 OpenPeon 语音包索引里的 CESP 语音包、选定其一，按时机播放声音并显示应用内提醒与可选的原生提醒"
kind: "package-reference"
---

# dsh-openpeon

[English](README.md) | 中文

[OpenPeon CESP v1.0](https://github.com/PeonPing/openpeon) 的非官方客户端，与 PeonPing 无隶属关系。本插件**不打包任何音频** —— 见[许可证](#license)。

## 概述

让会话"出声"：会话状态变化时，你能听到声音、看到提醒。

- 六个时机各有一种声音：会话开始或结束、智能体开始工作或完成、出错、需要你输入。
- 通知系统：应用内显示横幅；你允许的话还会发系统通知。
- 语音包来自 [OpenPeon 语音包索引](https://github.com/PeonPing/registry)（OpenPeon registry），在设置页里浏览并下载，下载后可试听、切换或删除。

## 安装

本插件放在 DSH 检出目录之外：`~/coding/dsh-plugins/dsh-openpeon`，这样上游仓库能保持干净。它完全通过本机 profile 注册：

1. 把包加进 `~/.dsh/profiles/<profile>/package.json`：

   ```json
   "dependencies": { "dsh-openpeon": "file:/Users/xzong/coding/dsh-plugins/dsh-openpeon" }
   ```

2. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里加载它的行：

   ```yaml
   - insert:
       - id: dsh-openpeon
         name: "dsh-openpeon"
         config: {}
   ```

3. 在该 profile 目录里 `pnpm install`，然后回到这里 `pnpm build`。

产物是 `lib/index.js`（Host 侧，只用 Node 内置模块）与 `lib/client.js`（Client 侧，只用 shell 已提供的基线模块），所以不需要发布，也不需要装到 DSH 源码旁边。

-----

## 目录

- [使用](#use-this-package)
- [实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制](#known-limitations-and-deferred-work)
- [许可证](#license)

-----

<a id="use-this-package"></a>
## 使用

打开 **设置 → openpeon**。

1. **挑一个语音包。** 页面会列出你已安装的包，以及索引里提供的 370 个包。可以按名称、作者、标签、语言搜索。目录里每一行展示作者、许可、信任等级、体积与音频数量。*下载* 安装；安装后 *试听* 播放其中一条音频，*使用* 设为当前语音包，*删除* 移除。只有你下载的内容会留在本机。
2. **选择时机。** 六行各自有独立开关和**自己的试听按钮**，不用等事件真的发生就能听到那个时机的声音；提醒关闭时也照样能试听。
3. **打开提醒**（顶部总开关），用滑块调音量。你的选择会记在这个浏览器里。

每种声音对应一个 [CESP v1.0](https://github.com/PeonPing/openpeon) 类别，语音包就是按这些类别名提供音频的。所以第三列就是"想让这个声音响，语音包里必须有哪个类别"：

| 声音 | 什么时候响 | CESP 类别 |
|---|---|---|
| 会话开始 | 出现一个会话 | `session.start` |
| 开始工作 | 智能体开始处理一个回合 | `task.acknowledge` |
| 完成 | 回合结束 —— 你打断它时也会响 | `task.complete` |
| 出错 | 智能体遇到错误 | `task.error` |
| 需要输入 | 有审批或问题在等你回答 | `input.required` |
| 会话结束 | 会话消失 | `session.end` |

语音包不必六个类别都齐 —— 少哪个类别，那个时机就静音，所以如果你在意某个时机，装之前先确认这个包列出了对应类别。

标准里定义了九个类别；另外三个在 DSH 里没有可依附的事件，因此不提供 —— 见[已知限制](#known-limitations-and-deferred-work)。

没安装语音包、或没打开总开关之前，不会有任何声音。浏览器要求先与页面交互过才允许播放音频，所以一个页面上的第一次提醒可能没声音，之后就一直正常。

<a id="understand-the-implementation"></a>
## 实现

本包是一个 Cordis 包，分 Host 侧与 Client 侧：**Host 侧**跑在 harness 进程里，拥有文件、网络与路由；**Client 侧**跑在浏览器里，拥有设置页、横幅与播放。两侧只通过一个 HTTP 前缀 `/openpeon` 对话。

### Host 侧（`src/index.ts` → `src/host/`）

文件：

- `routes.ts` —— 负责请求面
- `registry.ts` —— 获取并缓存索引
- `packs.ts` —— 校验清单与摘要
- `paths.ts` —— 管理 `$DSH_HOME` 布局，并拒绝越界路径
- `http.ts` —— 执行下载

插件注册以下 API 路由：

- 目录路由（`state`、`registry`、`install`、`remove`、`active`）
- 按时机取音频的路由（`sound/<cesp-category>`）
- 试听路由（`preview/<pack>/<file>`）

该前缀上没有任何鉴权：这些读与前端其他非入口静态资源一样开放。三个会改变状态的端点（`install`、`remove`、`active`）额外要求请求来自页面自身来源，因此其他文档无法让你的浏览器去安装或删除语音包。这道检查只约束浏览器：完全不发 `Origin` 的客户端（`curl`、本机脚本）能通过，所以真正把请求限制在本机的是服务的监听地址，而不是这道检查。

插件把文件放在 `$DSH_HOME/dsh-openpeon/`，升级插件不会影响它们：

- `registry.json` —— 全部语音包索引的缓存，附带抓取时间戳。6 小时内有效；过期会重新下载，若下载失败则继续用这份旧副本。
- `state.json` —— 当前选中的语音包，未选中时为 `null`。
- `packs/<name>/` —— 已安装的语音包：它自己的 `openpeon.json`、安装记录与音频。经 jsDelivr CDN 获取，且只下载六个时机真正引用到的文件，因此占用小于标称体积。

保存语音包前会进行完整性校验，不通过就放弃安装：

1. 语音包的 `openpeon.json` 必须与索引为它公布的 SHA-256 哈希一致 —— 这一步不过，音频连下载都不会开始；
2. 每个音频文件必须与 `openpeon.json` 里为它记录的 SHA-256 哈希一致（清单没声明的包跳过此步）。

更新检查比的是 `openpeon.json` 的哈希：索引现在公布的清单哈希与安装时记下的不一致，该包就标为可更新。不看 `version` —— 约七分之一的包，其清单里的 `version` 与索引里的并不一致。

浏览器侧什么都不留：目录、音频、试听三者的响应都是 `no-store`，唯一留下的是 localStorage 里的提醒偏好 `dsh-notifications`。

### Client 侧（`src/client/`）

文件：

- `index.ts` —— 入口：注册本地化命名空间、创建各存储、注入两个 slot 贡献并订阅事件
- `locales.ts` —— 中英文本地化词典
- `notification-store.ts` —— 把偏好持久化到 localStorage 的 `dsh-notifications`
- `NotificationSettingsSection.tsx` —— `openpeon` 设置页，含各时机的试听按钮
- `pack-store.ts` —— 已安装语音包与目录的状态
- `PackPicker.tsx` —— 已安装列表与语音包目录
- `sound-player.ts` —— 单个惰性创建的 `AudioContext`，失败保持静音，队列只保证"取回与起播"的先后而不等播放结束
- `toast-store.ts` —— 替换当前横幅而非堆叠
- `ToastContainer.tsx` —— 渲染该横幅

每个组件旁边配一份同名 `.module.css`。

贡献两个 slot：

- `settings.section` —— 即 `openpeon` 设置页：id `openpeon`、order 100，导航标签取自本地化词典
- `shell.overlay` —— toast 容器，id `notifications-toast`

它注册本地化命名空间，并订阅每个时机背后转发的 Host 事件：

| 转发事件 | CESP 类别 | 模式 |
|---|---|---|
| `approval/request` | `input.required` | waterfall |
| `user-questions/request` | `input.required` | waterfall |
| `api-session/added` | `session.start` | emit |
| `api-session/removed` | `session.end` | emit |
| `api-session/error` | `task.error` | emit |
| `api-session/status`（`running` 为真） | `task.acknowledge` | emit |
| `api-session/status`（`running` 为假） | `task.complete` | emit |

「模式」指 Host 以什么方式派发该事件，它决定监听器对调用方负有什么责任：

- `emit` 监听器是通知：所有监听器都会跑，返回值被忽略；
- `waterfall` 监听器是环绕中间件：它收到一个 `next` 回调，**必须调用 `next()`** 才能把请求传给下游 —— 不调用就直接短路。它承载的是需要答复的请求（审批、提问），所以上面两个监听器都是"先响一声、再 `return next()`"。

`api-session/added` 发布的是**会话摘要**而不是"新建会话"通知 —— 该会话的 agent 就绪后 Host 会再发一次 —— 所以对已经播过声音的会话，重复事件会被忽略。

播放时向 Host 要该时机的**一条**音频；一个包有多条时随机选一条（与 OpenPeon 一致）。浏览器用 `AudioContext.decodeAudioData` 解码，按存储音量经增益节点播放；"完成"的横幅用设计里的成功色调，其余用默认色调。

### 两处关键细节

`http.ts` 用的是 `node:https` 而不是全局 `fetch`：在 IPv6 到 CDN 被黑洞的主机上，undici 会锁定第一个解析到的 AAAA 记录并死在连接超时上，而 Node 自带的客户端会同时尝试两个协议族并成功。这不是风格偏好 —— 换成 `fetch`，这类主机上的安装与目录加载会直接失败。

`src/cesp.ts` 是索引里的点号类别名（`task.complete`）与本插件持久化的连字符 id（`task-complete`）之间唯一的转换表，两侧都读它。关键在这些连字符 id **就是存盘格式**：`dsh-notifications` 里的偏好记录以它们为键，所以改一个 id 不是改名，而是让用户已保存的那个开关读不回来。

<a id="further-exploration"></a>
## 进一步探索

- [CESP — Coding Event Sound Protocol](https://github.com/PeonPing/openpeon)（本插件遵循的标准）
- [OpenPeon 语音包索引](https://github.com/PeonPing/registry)（只存元数据，音频在各包自己的仓库里）
- [Web Audio API — AudioContext.decodeAudioData](https://developer.mozilla.org/en-US/docs/Web/API/AudioContext/decodeAudioData)
- [槽位参考](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/slots.zh.md)

<a id="model-experience"></a>
## 模型体验

无，因为本包只根据它观测到的事件播放声音与显示横幅；语音包、偏好与设置文案都不进入模型请求。

#### KV Cache 影响

无：本包既不组装也不发送提供方请求，因此它的任何行为都不会影响可复用的前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制

- **标准里的九个时机，本插件只提供六个。** `task.progress`、`resource.limit`、`user.spam` 在 DSH 里没有对应事件，而一个永远不会触发的开关只会误导人。要加就得同时加上驱动它的事件 —— 以及相应文件集，因为语音包是按时机下载的。
- **首次使用没有声音。** 安装需要联网，且未选定语音包前不会有任何声音；设置页会明确说明，而不是静默失败。
- **下载依赖 CDN。** 不使用 `github.com` 与 `raw.githubusercontent.com`，全部走 `cdn.jsdelivr.net`。若某个被锁定的 ref 无法由 CDN 提供，安装会以 HTTP 或摘要错误失败，而不会装入未经校验的内容。
- **"完成"的声音在回合被打断时也会响。** 它依附运行状态跃迁，而该信号也覆盖中断；只有专用的完成事件才能让它精确。
- **音量是全局的。** 不能给每个时机单独设音量。
- **提醒正文是纯文本。** 暂无图标、tag、`requireInteraction`；更丰富的展示由应用内横幅承担。
- **语音包是第三方内容。** 目录会在安装前展示信任等级、许可与自动质检等级，但音频按作者原样播放 —— `flagged` 质检等级值得留意。

<a id="license"></a>
## 许可证

MIT —— 见 [LICENSE](LICENSE)。

本插件是 [OpenPeon / CESP v1.0](https://github.com/PeonPing/openpeon) 的**非官方**客户端，与 PeonPing 无隶属关系。该标准本身为 MIT；[语音包索引](https://github.com/PeonPing/registry)未声明许可证，本插件仅在运行时读取它、不再分发它。

本插件**不打包任何音频**。只有在设置页安装某个语音包时，才会从该索引指向的仓库下载，并保留其作者声明的许可。设置页会在安装前显示每个包的许可；再分发你下载到的任何内容之前，请先确认该许可。插件自身不做任何再分发，且音频只向 `127.0.0.1` 提供。
