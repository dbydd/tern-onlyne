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
| `public_url` | Address peers should reach | the bound address |
| `key_scope` | `project` keeps an Ed25519 key on disk, `none` disables signing | `project` |
| `wake` | Wake Carly for messages that owe a reply | `true` |
| `systemone.endpoint` | Judge endpoint | `http://127.0.0.1:3425/v1/systemone` |
| `systemone.model` | Judge model | `group/decider` |
| `systemone.headers` | Extra request headers | none |
| `systemone.timeout_ms` | Judge timeout | `30000` |

`set_config` merges the patch and restarts the companion.

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

Palette commands: **Onlyne: 状态**, **Onlyne: 发现的对端**, **Onlyne: 握手状态**, **Onlyne: 处理待收消息**, **Onlyne: 重启伴生进程**, **Onlyne: 打开日志**, **Onlyne: 配置**.

## Handshake

A fingerprint must be shown before it is pinned, so the exchange has two stages:

1. `contact(endpoint)` records a peer that discovery has not seen.
2. `trust_begin(node_id)` reads the peer's live key and returns `fingerprint`.
3. `trust_accept(node_id, fingerprint)` commits local approval and sends the signed statement. A key that changed since `trust_begin` fails the call instead of being pinned.
4. The row reaches `exchanged` after the peer approves and answers with its own signature.

Phase meanings: `invited` means their approval waits for yours, `requested` means yours waits for theirs, `exchanged` means both sides approved, `revoked` means approval was dropped. A row that sits at `requested` after `trust_accept` is the normal waiting state.

A verified statement also writes the peer's address into discovery, so an inbound invitation can be accepted without a prior `contact`.

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
| `/admin/msg` | POST | Send one message. |

## Data and secrets

Everything lives in the plugin data directory, `~/Library/Application Support/Tern/plugin-data/onlyne/` on macOS:

| File | Contents |
| --- | --- |
| `kv.json` | `onlyne.config`, `onlyne.restart`, `onlyne.woken`. |
| `onlyne.db` | SQLite: threads, messages, discovery, inbox, outbox, decisions, contexts. |
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
tern plugin types .   # regenerate tern.d.luau for luau-lsp
```

`tern plugin reload` reloads both halves. The companion survives the reload and is reattached through `server.json`.

## Vendored host wiring

`server/vendor/omp-host/` carries five files copied from the Onlyne monorepo at `packages/omp-onlyne/src/`: `node.ts`, `store.ts`, `types.ts`, `host-text.ts` and `bridge-text.ts`. They build the protocol node for a host and implement SQLite storage and the context registry.

The copy lets this repository build against the published `@onlyne/lib` and `@onlyne/node-host` packages alone. A change to those five files in the monorepo has to be copied here, and a change here has to be copied back.

`server/paths.ts` holds the one path convention the plugin still needs from `packages/omp-onlyne/src/config.ts`.

## Limitations

- One execution context, `carly`. Subagent sessions share it.
- Discovery is manual contact plus signed statements. No mDNS.
- The reply judgment needs the SystemOne judge. A sender that sets `response = "none"` skips the judge.
- Remote peers need HTTPS and a published URL. Loopback peers use plain HTTP.
- The library's candidate exchange skips loopback addresses unless the host passes `allow_loopback`.

## License

MIT. See `LICENSE`.
