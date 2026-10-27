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
| `public_url` | 供对端访问的地址。主机是本机时，它的端口就是本进程绑定的端口；主机是代理时按声明原样公布 | 绑定地址 |
| `key_scope` | `project` 在磁盘保存 Ed25519 密钥，`none` 关闭签名 | `project` |
| `wake` | 对需要回复的消息唤醒 Carly | `true` |
| `acquisition.policy` | `all`、`segment` 或 `none`：对端可以不经人类被获取到哪一步 | `segment` |
| `acquisition.allow` | `segment` 接受的条目：CIDR 段或主机名，例如 `["127.0.0.0/8", "::1/128", "localhost"]` | 回环 |
| `trust` | 人类预授权：`[{node_id, fingerprint}]`，不受策略约束 | 无 |
| `systemone.endpoint` | 判定端点 | `http://127.0.0.1:3425/v1/systemone` |
| `systemone.model` | 判定模型 | `group/decider` |
| `systemone.headers` | 额外请求头 | 无 |
| `systemone.timeout_ms` | 判定超时 | `30000` |

`set_config` 合并补丁后重启伴生进程。`peers` 是退役键：配置里出现它时伴生进程直接拒绝启动，不会被当成 `acquisition` 读取。

`public_url` 先看主机。回环名、本机某个地址，或解析到这两者的名字，都算本机绑定：它声明的端口在这里绑定（不带端口时按 443 或 80），端口被占用就回落临时端口，endpoint 改写成实际绑定的地址。其余情况按反向代理处理：endpoint 保持声明原样，进程只在 `bind` 上用临时端口监听，启动日志写明「不监听该端口」。

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

获取策略拒绝时，`contact`、`trust_begin`、`trust_accept` 与 `refresh` 以 `policy_denied` 和命中的规则失败。`forbidden` 是另一回事：对端撤销了本节点，导出会直接说明，不把它算成策略拒绝。

`msg` 不会一条消息开一个 thread。显式给的 `meta.thread` 优先；回复落在被引用消息所在的 thread；其余情况沿用本节点拥有、成员已含目标对端的最近一个未关闭 thread。`meta.execution = "new"` 是唯一要求另开一段对话的写法。

命令面板入口：**Onlyne: 状态**、**Onlyne: 发现的对端**、**Onlyne: 握手状态**、**Onlyne: 处理待收消息**、**Onlyne: 获取策略**、**Onlyne: 批准对端（人类）**、**Onlyne: 撤销对端（人类）**、**Onlyne: 重启伴生进程**、**Onlyne: 打开日志**、**Onlyne: 配置**。

## 握手

指纹必须先展示再固定，所以交换分两步：

1. `contact(endpoint)` 登记一个发现目录里还没有的对端。
2. `trust_begin(node_id)` 读取对端实时公钥，返回 `fingerprint`。
3. `trust_accept(node_id, fingerprint)` 提交本地批准并发出签名 statement。密钥自 `trust_begin` 之后发生变化时，这次调用失败，新密钥不会被固定。
4. 对端批准并回送自己的签名后，该行进入 `exchanged`。

阶段含义：`invited` 表示对方等我们批准，`requested` 表示我们等对方批准，`exchanged` 表示双方都已批准，`revoked` 表示批准已撤销。`trust_accept` 之后停在 `requested` 是正常的等待状态。

验签通过的 statement 会顺带把对端地址写入发现目录，所以收到的邀请可以直接批准，不需要事先 `contact`。

## 对端获取策略

宿主决定对端可以不经人类被获取到哪一步。库不读这份策略，它只看到 `trust_accept` 有没有被调用（RFC 0018 §2）。

| 取值 | 含义 |
| --- | --- |
| `all` | agent 动作与宿主自动确认接受任意对端。 |
| `segment`（默认） | 只接受落在 `allow` 内的对端，默认集合是回环。 |
| `none` | agent 既不发起也不自动确认，批准留给人类面板。 |

求值点在 `/admin/contact`、`/admin/trust/begin`、`/admin/trust/accept`、`/admin/discovery/refresh` 提交任何东西之前，也在宿主自动批准到达的陈述之前。拒绝时返回 HTTP 403 与 `policy_denied`，带上策略、允许集合、原因与命中的规则。

人类面板是最后一道闸，不受策略限制：窗口半边给自己的命令带 `x-onlyne-human: 1`，面向 agent 的导出无法设置这个头。

自动批准要同时满足三个条件（RFC 0018 §2.2）：观测来源地址在 `allow` 内、对端声明的 `base_url` 在 `allow` 内、该对端名下每一条发现记录都在 `allow` 内。被拒的陈述保留原 `invited` 行，并且什么都不拨：声明地址不拨，发现记录里的地址也不拨。

观测地址在陈述到达时按 `(node_id, fingerprint)` 记录，批准时读的是这条记录，不是手上这次连接。声明地址只证明身份，不证明位置，所以它从不单独决定。

声明地址的主机部分是主机名而不是 IP 字面量时，先解析再判定：解析出的每个地址都必须在允许集合内；解析不出来的直接拒绝，因为它的位置是未被证明，而不是被允许。允许集合的条目本身可以是主机名，按名字命中——否则 `bind = "localhost"` 的对端在「回环默认放行」下反而永远批不了。

`trust` 是人类的预授权。列出的 `{node_id, fingerprint}` 在陈述到达时直接到 `exchanged`，不受策略约束；启动时为每个种子写一条人类超控审计，并输出它的节点、指纹与来源文件，让这条绕过路径可见。

## 握手投递

信任变化与业务消息走同一条通道进入 Carly 的会话：`response = "none"`、`execution = "existing"`、`plan.context = "carly"`，落在只有本节点持有的本地 thread `trust-handshake` 上，不向任何地方发送（RFC 0018 §3）。

- `invited` 作为待办到达并唤起一轮。正文带节点、指纹、声明地址、观测地址、策略与判定，以及可执行动作 `trust_accept(node_id, fingerprint)` 或 `trust_revoke(node_id)`。
- `requested` 照常投递，但不唤起一轮：本地已经没有可做的事，正文写明在等对端。只有 `invited` 计为待办。
- `exchanged` 与 `revoked` 作为状态更新到达，不索取动作。
- 策略自动批准的交换只投递一条结果，不要求 agent 做任何事。
- 去重键是 `(node_id, fingerprint, phase)`：重复陈述不产生新条目，有证明的轮换是新条目，且正文写明它是轮换。
- 策略为 `none` 时仍然投递，让 agent 知道有人敲门、而自己没有批准权。

拒绝邀请用 `trust_revoke`：库没有独立的 reject，这是它当前唯一的否定动作，不是语义等价物；库加入 reject 入口后再把两者分开。

这条消息是提示，不是协议事实：`trust.list` 与面板仍然是权威。

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
| `/admin/trust/rotate` | POST | 更换本节点密钥并通知每个已批准的对端。 |
| `/admin/acquisition` | GET | 策略、允许集合、`allow_loopback`、种子、带指纹与观测地址的 invited 行、信任行、发现记录、候选数、最近的审计行与已知限制。 |
| `/admin/msg` | POST | 发一条消息。 |

每个管理调用都可以带 `x-onlyne-human: 1`。它标记面板动作：跳过获取策略，并在审计里记一条人类超控。面向 agent 的导出从不发送它。

## 数据与密钥

全部数据在插件数据目录，macOS 上是 `~/Library/Application Support/Tern/plugin-data/onlyne/`：

| 文件 | 内容 |
| --- | --- |
| `kv.json` | `onlyne.config`、`onlyne.restart`、`onlyne.woken`。 |
| `onlyne.db` | SQLite：thread、消息、发现、收件、发件、判定、上下文，以及宿主自己的 `acquisition/` 行（观测、审计、已投递键）。 |
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
- 观测地址是 TCP 连接的来源，反向代理后面看到的是代理，不是客户端。
- 声明的主机名会先解析再判定：解析出的每个地址都要在允许集合内，解析不出来即拒绝。跨主机的地址判定细则仍未定义。
- 伴生进程只提供明文 HTTP，所以回环之外的对端需要一个 TLS 前置，用 `public_url` 公布前置的地址。
- 本宿主的 `allow_loopback` 固定为假且不可配置，因此回环对端在 `segment` 下可以被自动批准，但不会出现在发现候选里。

## 许可

MIT，见 `LICENSE`。
