# tern-onlyne

Onlyne v3 messaging for Carly, as a Tern plugin: a Luau window half that exposes the exports and the palette commands, and a Bun companion that owns the protocol node, the SQLite state and the delivery loop.

Carly sends and receives Onlyne messages from her Tern conversation. The companion speaks the `onlyne/3` protocol over HTTP, verifies signed peer traffic, and hands inbound messages to her as pending items.

The Chinese version of this document is `README.zh-CN.md`.

## Requirements

- Tern with plugin support.
- Bun 1.4.3 or newer.
- `@onlyne/lib` and `@onlyne/node-host`, both installed by `bun install`.
- A SystemOne judge endpoint for delivery decisions. The default is a local gateway at `http://127.0.0.1:3425/v1/systemone`.

## Install

```sh
bun install
bun run build          # writes dist/companion.js
tern plugin link .     # or: tern plugin install .
tern plugin reload
```

`host.luau` runs `dist/companion.js` when the bundle exists, and `server/main.ts` otherwise. A checkout therefore runs without a build step.

## Configure

The plugin keeps its configuration in `onlyne.config` inside the plugin's kv store. Set it with the palette command **Onlyne: 配置**, or call `set_config`:

| Key | Meaning | Default |
| --- | --- | --- |
| `node_id` | This node's identity, an absolute URI | required |
| `region` | Protocol membership, an absolute URI | required |
| `bind` | Listen address | `127.0.0.1` |
| `public_url` | Address peers should reach. A local host also names the port this process binds; a proxy host is published verbatim | the bound address |
| `key_scope` | `project` keeps an Ed25519 key on disk, `none` disables signing | `project` |
| `wake` | Wake Carly for messages that owe a reply | `true` |
| `acquisition.policy` | `all`, `segment` or `none`: how far a peer may be acquired without a human | `segment` |
| `acquisition.allow` | Entries `segment` accepts: CIDR blocks or host names, e.g. `["127.0.0.0/8", "::1/128", "localhost"]` | loopback |
| `trust` | Human pre-authorization: `[{node_id, fingerprint}]`, outside the policy | none |
| `systemone.endpoint` | Judge endpoint | `http://127.0.0.1:3425/v1/systemone` |
| `systemone.model` | Judge model | `group/decider` |
| `systemone.headers` | Extra request headers | none |
| `systemone.timeout_ms` | Judge timeout | `30000` |

`set_config` merges the patch and restarts the companion. `peers` is a retired key: a configuration that carries it refuses to start instead of being read as `acquisition`.

`public_url` is judged by its host first. A loopback name, one of this machine's own addresses, or a name resolving to either, is a local bind: its declared port is bound here (a URL without one names 443 or 80), and a taken port falls back to a temporary one with the endpoint rewritten to the address really bound. Anything else is a reverse proxy: the endpoint stays exactly as declared, the process binds `bind` on a temporary port, and the startup log says it does not listen on the advertised port.

Without a `public_url`, the companion remembers the port it bound in `onlyne.config.port` and reuses it on the next start, so an address a peer recorded keeps working. A port that is already taken falls back to a temporary one, and the new port is remembered instead.

## Exports

Carly reaches these as `plugins["onlyne"]`.

| Export | Returns |
| --- | --- |
| `msg(input)` | Sends one message. `delivery_kind` and `msg` are required; `meta` carries `to`, `thread`, `in_reply_to`, `response`, `execution`, `relation` and `mentions`. |
| `pending()` | Unconsumed inbound messages, oldest first, each with its token, sender, thread, sequence, text, delivery plan and the inbound judgment of whether a reply is owed. |
| `consumed(token)` | Confirms one pending item was handled. Returns `{consumed, reason}`; `reason` is `confirmed`, `already_consumed` or `unknown_token`. |
| `status()` | Node id, region, endpoint, peer counts and pending count. `peers_live`, `peers_stale` and `peers_known` separate live addresses, lapsed addresses and every recorded address. |
| `peers()` | Every discovery observation: node, instance, address, source, last seen, expiry, verification time and the last error. |
| `refresh()` | Re-reads every recorded address now. |
| `contact(endpoint)` | Reads one address and records it as a peer. |
| `trust_list()` | Every key exchange row with its phase. |
| `trust_begin(node_id)` | Reads the peer's live key and returns the fingerprint to show. |
| `trust_accept(node_id, fingerprint)` | Commits local approval, sends the signed introduction, or accepts an incoming invitation. |
| `trust_revoke(node_id)` | Drops local approval. |
| `config()` | The `onlyne.config` table. |
| `set_config(patch)` | Merges a patch into `onlyne.config` and restarts the companion. |

`contact`, `trust_begin`, `trust_accept` and `refresh` fail with `policy_denied` and the matched rule when the acquisition policy refuses them. A `forbidden` answer is a different thing: the peer revoked this node, and the export says so instead of blaming the policy.

`msg` does not open a thread per message. An explicit `meta.thread` wins; a reply lands in the thread of the message it answers; anything else continues the most recently created open thread that already holds the target peer. `meta.execution = "new"` is the only request for a separate conversation.

Palette commands: **Onlyne: 状态**, **Onlyne: 发现的对端**, **Onlyne: 握手状态**, **Onlyne: 处理待收消息**, **Onlyne: 获取策略**, **Onlyne: 批准对端（人类）**, **Onlyne: 撤销对端（人类）**, **Onlyne: 重启伴生进程**, **Onlyne: 打开日志**, **Onlyne: 配置**.

## Handshake

A fingerprint must be shown before it is pinned, so the exchange has two stages:

1. `contact(endpoint)` records a peer that discovery has not seen.
2. `trust_begin(node_id)` reads the peer's live key and returns `fingerprint`.
3. `trust_accept(node_id, fingerprint)` commits local approval and sends the signed statement. A key that changed since `trust_begin` fails the call instead of being pinned.
4. The row reaches `exchanged` after the peer approves and answers with its own signature.

Phase meanings: `invited` means their approval waits for yours, `requested` means yours waits for theirs, `exchanged` means both sides approved, `revoked` means approval was dropped. A row that sits at `requested` after `trust_accept` is the normal waiting state.

A verified statement also writes the peer's address into discovery, so an inbound invitation can be accepted without a prior `contact`.

## Peer acquisition policy

The host decides how far a peer may be acquired without a human. The library never reads this policy: the only thing it sees is whether `trust_accept` was called (RFC 0018 §2).

| Policy | Meaning |
| --- | --- |
| `all` | Agent actions and host auto-approval accept any peer. |
| `segment` (default) | Only peers inside `allow`, which defaults to loopback. |
| `none` | The agent may neither initiate nor auto-confirm; approval stays with the human panel. |

The policy runs before `/admin/contact`, `/admin/trust/begin`, `/admin/trust/accept` and `/admin/discovery/refresh` commit anything, and before the host auto-approves an arriving statement. A refusal answers HTTP 403 with `policy_denied` and the policy, allow set, reason and matched rule.

The human panel is the last gate and is not subject to it: the window half sends `x-onlyne-human: 1` on its own commands, and no agent-facing export can set that header.

Auto-approval needs three conditions (RFC 0018 §2.2): the observed source address is inside `allow`, the peer's declared `base_url` is inside `allow`, and every discovery record for that peer is inside `allow`. A denied statement keeps its `invited` row, and nothing is dialed — not the declared address, not a recorded one.

The observed address is recorded when the statement arrives, keyed by `(node_id, fingerprint)`; the verdict at approval time reads that record, never the connection in hand. A declared address proves identity, not location, so it never decides alone.

A declared address whose host is a name rather than a literal is resolved, and every address it resolves to must be allowed; a name that does not resolve is denied, because its location is unproven rather than permitted. An allow entry may itself be a host name, which matches on the name — otherwise a peer bound to `localhost` could never be approved while loopback is the default.

`trust` is a human pre-authorization. A listed `{node_id, fingerprint}` reaches `exchanged` on its statement, outside the policy, and startup writes one human-override audit row per seed and logs its node, fingerprint and source file, so the bypass stays visible.

## Handshake delivery

Trust changes reach Carly as session messages on the same channel as business messages: `response = "none"`, `execution = "existing"`, `plan.context = "carly"`, on the local thread `trust-handshake`, which only this node holds and which sends nothing anywhere (RFC 0018 §3).

- `invited` arrives as a todo and wakes one turn. The body carries the node, fingerprint, declared address, observed address, the policy and the verdict, plus the executable action `trust_accept(node_id, fingerprint)` or `trust_revoke(node_id)`.
- `requested` is delivered and does not wake a turn: the local side has nothing left to do, and the body says it is waiting for the peer. Only `invited` counts as a todo.
- `exchanged` and `revoked` arrive as status updates that ask for nothing.
- An auto-approved exchange delivers one result entry and asks the agent for no action.
- The dedupe key is `(node_id, fingerprint, phase)`: a repeated statement adds no entry, and a proven rotation is a new entry whose body says it is a rotation.
- Policy `none` still delivers, so the agent learns that someone knocked and that it may not approve.

Rejecting an invitation uses `trust_revoke`: the library has no separate reject, so this is the only negative action it offers, not a semantic equivalent. A dedicated reject entry would split the two.

The message is a hint, never protocol state: `trust.list` and the panel remain authoritative.

## Inbound flow

`window.luau` polls `/admin/pending` every 8 seconds and grades each new item:

- A message that owes a reply wakes Carly once, with the line `这是onlyne消息，与原任务一起做。` in front of the summary. She reads the full text with `pending()` and answers with `msg`.
- A message that owes nothing stays in the pending list and in the context summary, and occupies no turn. `plan.response = "none"` and `needs_answer = false` both count as owing nothing.

Entries already woken are keyed by `thread/seq` in `onlyne.woken` (last 200), so a companion restart with fresh tokens does not repeat the same ask. A reply that carries `meta.in_reply_to` settles the item it answers.

## Discovery

`contact()` records an address by hand. A verified trust statement records the peer's address on its own. `refresh()` re-reads every recorded address.

This plugin publishes no mDNS advertisement and browses none. Two companions find each other through `contact()` or through an exchange that already happened.

## Lifecycle

`host.luau` starts the companion, probes `/admin/status` every 15 seconds, and spawns a process after two consecutive failed probes. While a process runs, three consecutive failed probes drop it and the next tick starts another. A process that exits within 10 seconds of starting is retried with a delay that doubles from 5 seconds up to 2 minutes.

The probe is also the companion's liveness signal. Sixty seconds without one and it shuts itself down with `onlyne.companion.orphaned` in the log. The companion is a child of Tern's daemon, and Tern has no plugin-unload hook, so this timeout is what makes the process follow the plugin: closing a window or reloading plugins keeps it, and disabling the plugin stops it within a minute.

`onlyne.restart` forces a restart. **Onlyne: 重启伴生进程** and `set_config` both bump it.

## Admin API

The companion listens on `bind` and answers two route groups. `/onlyne/v3/*` is the protocol. `/admin/*` is the plugin's own API, reachable on loopback with the token from `server.json`:

| Route | Method | Purpose |
| --- | --- | --- |
| `/admin/status` | GET | Node id, region, endpoint, peer counts, pending count. Also the heartbeat. |
| `/admin/discovery` | GET | Every discovery record except this node. |
| `/admin/discovery/refresh` | POST | Re-read every recorded address. |
| `/admin/pending` | GET | Pending inbound items. |
| `/admin/consumed` | POST | Confirm one token. |
| `/admin/contact` | POST | Observe one endpoint. |
| `/admin/trust/list` | GET | Trust rows with phase and approval flags. |
| `/admin/trust/begin` | POST | Read a peer key. |
| `/admin/trust/accept` | POST | Approve a peer. |
| `/admin/trust/revoke` | POST | Drop approval. |
| `/admin/trust/rotate` | POST | Replace this node's key and tell every approved peer. |
| `/admin/acquisition` | GET | Policy, allow set, `allow_loopback`, seeds, invited rows with fingerprint and observed address, trust rows, discovery, candidate count, recent audit rows and the known limitations. |
| `/admin/msg` | POST | Send one message. |

Every admin call may carry `x-onlyne-human: 1`. It marks a panel action: the acquisition policy is skipped and the audit records a human override. The agent-facing exports never send it.

## Data and secrets

Everything lives in the plugin data directory, `~/Library/Application Support/Tern/plugin-data/onlyne/` on macOS:

| File | Contents |
| --- | --- |
| `kv.json` | `onlyne.config`, `onlyne.restart`, `onlyne.woken`. |
| `onlyne.db` | SQLite: threads, messages, discovery, inbox, outbox, decisions, contexts, and the host's own `acquisition/` rows (observations, audit, delivered keys). |
| `node-key.json` | The node's Ed25519 key material, mode `0600`. |
| `server.json` | Companion port, endpoint, pid and admin token, mode `0600`. |
| `onlyne.log` | JSON log, rotated at 1 MB. |
| `.onlyne/config.toml` | The library's project configuration path. |

The admin API answers on loopback with the token from `server.json`. The node key stays on disk because the companion is a child of Tern's daemon and cannot reach `tern.secrets`. `key_scope = "none"` skips the key file and restricts the node to a loopback bind.

Inbound message text reaches Carly's prompt as untrusted input.

## Development

```sh
bun install
bun run check     # tsc --noEmit over server/
bun run build     # bundle dist/companion.js
bun run check:vendor   # report drift against packages/omp-onlyne/src
bun scripts/judge-samples.ts   # real-judge samples against the System One endpoint
tern plugin types .   # regenerate tern.d.luau for luau-lsp
```

`tern plugin reload` reloads both halves. The companion survives the reload and is reattached through `server.json`.

## Vendored host wiring

`server/vendor/omp-host/` carries six files copied from the Onlyne monorepo at `packages/omp-onlyne/src/`: `node.ts`, `store.ts`, `types.ts`, `host-text.ts`, `bridge-text.ts` and `acquire.ts`. They build the protocol node for a host, implement SQLite storage and the context registry, and carry the acquisition policy the configuration types name.

The copy lets this repository build against the published `@onlyne/lib` and `@onlyne/node-host` packages alone. A change to those six files in the monorepo has to be copied here, and a change here has to be copied back.

Each vendored file starts with a `// vendored from packages/omp-onlyne/src/<file>@<commit> (<date>)` line recording the monorepo commit it was copied at. `bun run check:vendor` compares all six against their upstream sources with comments stripped, so the annotations and upstream reference comments do not count, and prints one line per file: `same`, or `drifted` with `+N` upstream-only lines and `-N` vendor-only lines. It only reports and always exits 0; pass `--strict` to exit 1 on any drift. Run it from a checkout that has `packages/omp-onlyne/src/` as a sibling of `external-integrations/`.

`server/paths.ts` holds the one path convention the plugin still needs from `packages/omp-onlyne/src/config.ts`.

## Limitations

- One execution context, `carly`. Subagent sessions share it.
- Discovery is manual contact plus signed statements. No mDNS.
- The reply judgment needs the SystemOne judge. A sender that sets `response = "none"` skips the judge.
- Remote peers need HTTPS and a published URL. Loopback peers use plain HTTP.
- The library's candidate exchange skips loopback addresses unless the host passes `allow_loopback`.
- The observed address is the TCP source. Behind a reverse proxy it is the proxy, not the client.
- A declared host name is resolved before it is judged: every resolved address must be in the allow set, and a name that does not resolve is denied. Cross-host address rules stay undefined.
- This companion serves plain HTTP, so a peer outside loopback needs a TLS front; set `public_url` to the address that front publishes.
- `allow_loopback` is false here and not configurable, so a loopback peer is auto-approved under `segment` but never appears as a discovery candidate.

## License

MIT. See `LICENSE`.
