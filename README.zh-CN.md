# tern-onlyne

给 Carly 的 Onlyne v3 消息插件，由两半组成：Luau 窗口半边提供导出函数与命令面板入口，Bun 伴生进程持有协议节点、SQLite 状态与投递循环。

Carly 在 Tern 对话里收发 Onlyne 消息。伴生进程用 HTTP 讲 `onlyne/3` 协议，校验对端签名，并把收到的消息作为待处理条目交给她。

本文档的英文版是 `README.md`。

## 环境要求

- 支持插件的 Tern。
- Bun 1.4.3 或更新。
- `@onlyne/lib` 与 `@onlyne/node-host`，由 `bun install` 安装。
- 一个 SystemOne 判定端点。默认指向本机网关 `http://127.0.0.1:3425/v1/systemone`。

## 安装

```sh
bun install
bun run build          # 产出 dist/companion.js
tern plugin link .     # 或 tern plugin install .
tern plugin reload
```

`host.luau` 在 bundle 存在时运行 `dist/companion.js`，否则运行 `server/main.ts`，所以检出后不构建也能跑。

## 配置

配置存在插件 kv 的 `onlyne.config`。用命令面板的 **Onlyne: 配置** 修改，或调用 `set_config`：

| 键 | 含义 | 默认值 |
| --- | --- | --- |
| `node_id` | 本节点身份，绝对 URI | 必填 |
| `region` | 协议归属区域，绝对 URI | 必填 |
| `bind` | 监听地址 | `127.0.0.1` |
| `public_url` | 供对端访问的地址 | 绑定地址 |
| `key_scope` | `project` 在磁盘保存 Ed25519 密钥，`none` 关闭签名 | `project` |
| `wake` | 对需要回复的消息唤醒 Carly | `true` |
| `systemone.endpoint` | 判定端点 | `http://127.0.0.1:3425/v1/systemone` |
| `systemone.model` | 判定模型 | `group/decider` |
| `systemone.headers` | 额外请求头 | 无 |
| `systemone.timeout_ms` | 判定超时 | `30000` |

`set_config` 合并补丁后重启伴生进程。

## 导出

Carly 通过 `plugins["onlyne"]` 调用。

| 导出 | 返回 |
| --- | --- |
| `msg(input)` | 发一条消息。`delivery_kind` 与 `msg` 必填；`meta` 可带 `to`、`thread`、`in_reply_to`、`response`、`execution`、`relation`、`mentions`。 |
| `pending()` | 未消费的入站消息，按时间从旧到新，每项带 token、发送方、thread、序号、正文、投递计划，以及是否欠回复的判定。 |
| `consumed(token)` | 核销一条待处理消息，返回 `{consumed, reason}`，`reason` 取 `confirmed`、`already_consumed` 或 `unknown_token`。 |
| `status()` | 节点 id、区域、端点、对端计数与待处理计数。`peers_live`、`peers_stale`、`peers_known` 分别统计在线地址、过期地址与全部记录。 |
| `peers()` | 全部发现记录：节点、实例、地址、来源、最后出现时间、过期时间、验证时间与最近一次错误。 |
| `refresh()` | 立即重新读取全部记录地址。 |
| `contact(endpoint)` | 读取一个地址并登记为对端。 |
| `trust_list()` | 全部密钥交换行及其阶段。 |
| `trust_begin(node_id)` | 读取对端实时公钥，返回待展示的指纹。 |
| `trust_accept(node_id, fingerprint)` | 提交本地批准并发出签名引荐，或接受对方发来的邀请。 |
| `trust_revoke(node_id)` | 撤销本地批准。 |
| `config()` | `onlyne.config` 表。 |
| `set_config(patch)` | 合并补丁并重启伴生进程。 |

命令面板入口：**Onlyne: 状态**、**Onlyne: 发现的对端**、**Onlyne: 握手状态**、**Onlyne: 处理待收消息**、**Onlyne: 重启伴生进程**、**Onlyne: 打开日志**、**Onlyne: 配置**。

## 握手

指纹必须先展示再固定，所以交换分两步：

1. `contact(endpoint)` 登记一个发现目录里还没有的对端。
2. `trust_begin(node_id)` 读取对端实时公钥，返回 `fingerprint`。
3. `trust_accept(node_id, fingerprint)` 提交本地批准并发出签名 statement。密钥自 `trust_begin` 之后发生变化时，这次调用失败，新密钥不会被固定。
4. 对端批准并回送自己的签名后，该行进入 `exchanged`。

阶段含义：`invited` 表示对方等我们批准，`requested` 表示我们等对方批准，`exchanged` 表示双方都已批准，`revoked` 表示批准已撤销。`trust_accept` 之后停在 `requested` 是正常的等待状态。

验签通过的 statement 会顺带把对端地址写入发现目录，所以收到的邀请可以直接批准，不需要事先 `contact`。

## 入站流程

`window.luau` 每 8 秒轮询 `/admin/pending`，并对每条新消息分级：

- 欠回复的消息唤醒 Carly 一次，摘要前带一行 `这是onlyne消息，与原任务一起做。`。她用 `pending()` 取全文，用 `msg` 回复。
- 不欠回复的消息留在待处理列表和上下文摘要里，不占对话轮次。`plan.response = "none"` 与 `needs_answer = false` 都算不欠回复。

已唤醒的条目按 `thread/seq` 记在 `onlyne.woken`（保留最近 200 条），伴生进程重启换 token 后不会重复唤醒。带 `meta.in_reply_to` 的回复会核销它所回答的那条消息。

## 发现

`contact()` 手动登记地址。验签通过的信任 statement 自动登记对端地址。`refresh()` 重新读取全部记录地址。

本插件不发布 mDNS 广播，也不浏览广播。两个伴生进程通过 `contact()` 或已经完成的信任交换互相找到。

## 生命周期

`host.luau` 启动伴生进程，每 15 秒探测一次 `/admin/status`，连续两次探测失败后拉起进程。进程在跑时连续三次探测失败会被放弃，下一次检查再拉起一个。启动后 10 秒内退出的进程按 5 秒起步、上限 2 分钟的退避重试。

这次探测同时是伴生进程的存活信号。60 秒没有探测，它自己写 `onlyne.companion.orphaned` 并退出。伴生进程是 Tern daemon 的子进程，而 Tern 没有插件卸载钩子，所以这个超时让进程跟随插件：关闭窗口或重载插件时它继续运行，禁用插件后一分钟内退出。

`onlyne.restart` 触发重启。**Onlyne: 重启伴生进程** 与 `set_config` 都会递增它。

## 管理接口

伴生进程监听 `bind`，提供两组路由。`/onlyne/v3/*` 是协议。`/admin/*` 是插件自己的接口，走 loopback 并校验 `server.json` 里的 token：

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/admin/status` | GET | 节点 id、区域、端点、对端计数、待处理计数，同时作为心跳。 |
| `/admin/discovery` | GET | 除本节点外的全部发现记录。 |
| `/admin/discovery/refresh` | POST | 重新读取全部记录地址。 |
| `/admin/pending` | GET | 待处理入站条目。 |
| `/admin/consumed` | POST | 核销一个 token。 |
| `/admin/contact` | POST | 观察一个端点。 |
| `/admin/trust/list` | GET | 信任行及其阶段与批准标志。 |
| `/admin/trust/begin` | POST | 读取对端公钥。 |
| `/admin/trust/accept` | POST | 批准对端。 |
| `/admin/trust/revoke` | POST | 撤销批准。 |
| `/admin/msg` | POST | 发一条消息。 |

## 数据与密钥

全部数据在插件数据目录，macOS 上是 `~/Library/Application Support/Tern/plugin-data/onlyne/`：

| 文件 | 内容 |
| --- | --- |
| `kv.json` | `onlyne.config`、`onlyne.restart`、`onlyne.woken`。 |
| `onlyne.db` | SQLite：thread、消息、发现、收件、发件、判定、上下文。 |
| `node-key.json` | 节点 Ed25519 密钥材料，权限 `0600`。 |
| `server.json` | 伴生进程端口、端点、pid 与管理 token，权限 `0600`。 |
| `onlyne.log` | JSON 日志，超过 1 MB 轮转。 |
| `.onlyne/config.toml` | 库读取的项目配置路径。 |

管理接口只应答 loopback 并校验 `server.json` 的 token。节点密钥放在磁盘上，因为伴生进程是 Tern daemon 的子进程，取不到 `tern.secrets`。`key_scope = "none"` 不生成密钥文件，同时把节点限制在 loopback 绑定。

入站消息正文会进入 Carly 的提示词，按不可信输入处理。

## 开发

```sh
bun install
bun run check     # 对 server/ 跑 tsc --noEmit
bun run build     # 打包 dist/companion.js
tern plugin types .   # 重新生成 tern.d.luau，供 luau-lsp 使用
```

`tern plugin reload` 重载两半。伴生进程在重载后继续运行，通过 `server.json` 重新接管。

## 内联的主机接线

`server/vendor/omp-host/` 存放五个从 Onlyne 仓库 `packages/omp-onlyne/src/` 复制的文件：`node.ts`、`store.ts`、`types.ts`、`host-text.ts`、`bridge-text.ts`。它们负责为宿主构建协议节点，并实现 SQLite 存储与上下文注册表。

有了这份副本，本仓库只依赖已发布的 `@onlyne/lib` 与 `@onlyne/node-host` 就能构建。上游这五个文件有改动时要同步到这里，这边有改动时也要同步回去。

`server/paths.ts` 保留插件仍然需要的一个路径约定，来源是 `packages/omp-onlyne/src/config.ts`。

## 已知限制

- 只有一个执行上下文 `carly`，子会话共用它。
- 发现靠手动 contact 与签名 statement，没有 mDNS。
- 回复判定需要 SystemOne 判定端点。发送方声明 `response = "none"` 时跳过判定。
- 远程对端需要 HTTPS 与可公布地址，loopback 对端走明文 HTTP。
- 库的候选交换默认跳过 loopback 地址，宿主需要传 `allow_loopback` 才纳入。

## 许可

MIT，见 `LICENSE`。
