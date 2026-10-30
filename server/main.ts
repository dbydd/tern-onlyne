import { AsyncLocalStorage } from "node:async_hooks";
import { lookup } from "node:dns/promises";
import { appendFileSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import {
	OnlyneError,
	generateKeyMaterial,
	trustPhase,
	type DeliveryPlan,
	type Entry,
	type KeyHook,
	type KeyMaterial,
	type MsgInput,
	type OnlyneNode,
	type Outbound,
	type Thread,
	type ThreadRef,
	type TrustSeed,
} from "@onlyne/lib";
import { AcquisitionStore, readAcquisition, readSeeds, type AcquisitionPolicy } from "./acquisition.ts";
import { CarlyBridge } from "./bridge.ts";
import { CarlyDecider } from "./decider.ts";
import { TrustPipeline, trustRow, type Outcome } from "./handshake.ts";
import { configPath } from "./paths.ts";
import type { JudgeConfig } from "./systemone.ts";
import { advertisedHost, createOnlyneNode } from "./vendor/omp-host/node.ts";
import { ContextRegistry, SqliteStorage } from "./vendor/omp-host/store.ts";
import type { OnlyneConfig } from "./vendor/omp-host/types.ts";

/**
 * Onlyne companion for the Tern plugin. It owns the protocol node, SQLite state and the
 * maintenance loop; the Luau plugin owns the UI, the Carly exports and the admin calls.
 * Tern spawns this process with TERN_PLUGIN_DATA, which is the plugin's data directory.
 */

const dataDir = process.env.ONLYNE_DATA ?? process.env.TERN_PLUGIN_DATA ?? "";
if (dataDir === "") throw new Error("The Onlyne companion needs TERN_PLUGIN_DATA.");
const adminToken = process.env.ONLYNE_ADMIN_TOKEN ?? crypto.randomUUID();

const kvPath = join(dataDir, "kv.json");
const keyPath = join(dataDir, "node-key.json");
const serverPath = join(dataDir, "server.json");
const logPath = join(dataDir, "onlyne.log");

/** The plugin's host half probes /admin/status every 15 seconds; silence means the plugin is gone. */
const HEARTBEAT_TIMEOUT_MS = 60_000;
const HEARTBEAT_CHECK_MS = 15_000;
let lastProbeAt = Date.now();

async function startLog(): Promise<void> {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	try {
		if ((await stat(logPath)).size > 1_000_000) await rename(logPath, `${logPath}.old`);
	} catch {
		// No log yet, or it cannot be rotated; appending continues either way.
	}
}

function log(message: string, fields: Record<string, unknown> = {}): void {
	const line = `${JSON.stringify({ at: new Date().toISOString(), message, ...fields })}\n`;
	void appendFile(logPath, line).catch(() => undefined);
}

/** A configuration this host refuses to run with leaves one line behind before the process ends. */
function failStartup(message: string): never {
	const line = `${JSON.stringify({ at: new Date().toISOString(), message: "onlyne.config.rejected", detail: message })}\n`;
	try {
		appendFileSync(logPath, line);
	} catch {
		// The stderr line carries the same text; a failed write must not mask the reason.
	}
	console.error(JSON.stringify({ message: "onlyne.config.rejected", detail: message }));
	process.exit(1);
}

/**
 * Thread reuse orders candidates by which conversation was touched last, and the library's row
 * carries no such timestamp. The host adds one to the row it already owns — the library reads
 * and writes that row as JSON and spreads unknown fields, so the field survives its updates.
 * A row from before this field exists has none, and the reader falls back to `created_at`.
 */
async function touchThread(thread: ThreadRef, at: string): Promise<void> {
	await storage.transaction(async tx => {
		const slot = `thread/${encodeURIComponent(thread.owner)}/${encodeURIComponent(thread.id)}`;
		const row = await tx.get<Thread & { last_activity_at?: string }>(slot);
		if (row === undefined) return;
		await tx.put(slot, { ...row, last_activity_at: at });
	});
}

/** The thread a send landed in, when its outcome carries a receipt. */
function receiptThread(outcome: unknown): ThreadRef | undefined {
	if (outcome === null || typeof outcome !== "object" || !("receipt" in outcome)) return undefined;
	const receipt = outcome.receipt;
	if (receipt === null || typeof receipt !== "object" || !("thread_ref" in receipt)) return undefined;
	const ref = receipt.thread_ref;
	if (ref === null || typeof ref !== "object" || !("owner" in ref) || !("id" in ref)) return undefined;
	if (typeof ref.owner !== "string" || typeof ref.id !== "string") return undefined;
	return { owner: ref.owner, id: ref.id };
}

/** One row of `threads()`: the library's thread plus the host's activity stamp. */
interface ThreadSummary {
	id: string;
	title: string;
	members: Array<{ node_id: string; state: string }>;
	last_seq: string;
	last_activity_at: string;
	open: boolean;
}

/** Every thread this node owns. The library pages them at 100 rows; reads take the whole list. */
async function ownThreads(): Promise<Array<Thread & { last_activity_at?: string }>> {
	const items: Array<Thread & { last_activity_at?: string }> = [];
	let cursor: string | undefined;
	do {
		const page = await node.threads.list(node.auth, { page_size: 100, ...(cursor === undefined ? {} : { cursor }) });
		items.push(...page.items);
		cursor = page.next_cursor ?? undefined;
	} while (cursor !== undefined);
	return items;
}

/**
 * `threads()`: ordered the way landing orders its candidates — last activity first, id as the
 * tie-break — so the top row is the thread the next send to the same peer would reuse.
 */
async function threadSummaries(): Promise<ThreadSummary[]> {
	const summaries = await Promise.all((await ownThreads()).map(async thread => {
		const described = await node.threads.describe(node.auth, thread.thread_ref).catch(() => undefined);
		return {
			id: thread.thread_ref.id,
			title: thread.title,
			members: (described?.members ?? []).map(member => ({ node_id: member.peer, state: member.state })),
			last_seq: (BigInt(thread.next_seq) - 1n).toString(),
			last_activity_at: thread.last_activity_at ?? thread.created_at,
			open: thread.state === "open",
		};
	}));
	return summaries.sort((left, right) => right.last_activity_at.localeCompare(left.last_activity_at)
		|| right.id.localeCompare(left.id));
}

/**
 * A thread named by the caller: a bare id or title among this node's own threads, an
 * `owner/id` pair, or `{owner, id}`. A bare string that matches nothing is read as this
 * node's own thread id, so a fresh id answers with an empty list instead of an error.
 */
async function resolveThread(input: unknown): Promise<ThreadRef> {
	if (typeof input === "string" && input !== "") {
		const matches = (await ownThreads()).filter(thread => thread.thread_ref.id === input || thread.title === input);
		if (matches.length > 1) throw new OnlyneError("invalid_request", `多个 thread 匹配「${input}」，请用 owner/id 指定`);
		const only = matches[0];
		if (only !== undefined) return only.thread_ref;
		const slash = input.indexOf("/");
		if (slash > 0) return { owner: input.slice(0, slash), id: input.slice(slash + 1) };
		return { owner: config.node.id, id: input };
	}
	if (input !== null && typeof input === "object") {
		const ref = input as { owner?: unknown; id?: unknown };
		if (typeof ref.id === "string" && ref.id !== "") {
			return { owner: typeof ref.owner === "string" && ref.owner !== "" ? ref.owner : config.node.id, id: ref.id };
		}
	}
	throw new OnlyneError("invalid_request", "thread 需要一个 thread id、owner/id 或 {owner, id}");
}

/** The fields a reader needs to place one entry and to quote it. */
function entryView(entry: Entry, plan: DeliveryPlan | undefined) {
	return {
		thread: entry.thread_ref,
		seq: entry.seq,
		id: entry.message.id,
		sender: entry.message.sender,
		text: entry.message.msg,
		at: entry.at,
		plan: plan ?? null,
		relation: entry.message.meta?.relation ?? null,
		in_reply_to: entry.message.meta?.in_reply_to ?? null,
	};
}

/**
 * The delivery plan each entry was sent with, by seq. Neither the entry nor the thread row
 * carries it: the recipient keeps it on the attention row, and the local inbox row survives
 * consumption (only `injected` and `acked` change), so `messages.inbox` still has it. What this
 * node sent is on the outbound record's receipt — `outbound/` is the library's own slot prefix
 * (`client.ts:135`), read here and never written.
 */
async function planIndex(ref: ThreadRef): Promise<Map<string, DeliveryPlan>> {
	const plans = new Map<string, DeliveryPlan>();
	let cursor: string | undefined;
	do {
		const page = await node.messages.inbox(node.auth, { page_size: 100, ...(cursor === undefined ? {} : { cursor }) });
		for (const row of page.items) {
			const { attention } = row;
			if (attention.plan === undefined) continue;
			if (attention.thread_ref.owner !== ref.owner || attention.thread_ref.id !== ref.id) continue;
			plans.set(attention.seq, attention.plan);
		}
		cursor = page.next_cursor ?? undefined;
	} while (cursor !== undefined);
	for (const { value } of await storage.transaction(tx => tx.scan<Outbound>("outbound/"))) {
		const receipt = value.receipt;
		if (receipt === undefined) continue;
		if (receipt.thread_ref.owner !== ref.owner || receipt.thread_ref.id !== ref.id) continue;
		plans.set(receipt.seq, receipt.plan);
	}
	return plans;
}

/** `read()`: entries of one thread, oldest first, with `since_seq` exclusive. */
async function readThread(ref: ThreadRef, since: string | undefined, limit: number) {
	const page = await node.messages.list(node.auth, ref, {
		attention: "thread",
		page_size: limit,
		...(since === undefined ? {} : { since_seq: since }),
	});
	const plans = await planIndex(ref);
	return {
		items: page.items.map(entry => entryView(entry, plans.get(entry.seq))),
		next_cursor: page.next_cursor ?? null,
	};
}

/** `message()`: one entry by position in a thread, or by the sender's message id. */
async function messageView(input: unknown) {
	if (input === null || typeof input !== "object") throw new OnlyneError("invalid_request", "ref 需要 {thread, seq} 或 {sender, id}");
	const ref = input as { thread?: unknown; seq?: unknown; sender?: unknown; id?: unknown };
	if (typeof ref.sender === "string" && ref.sender !== "" && typeof ref.id === "string" && ref.id !== "") {
		const entry = await node.messages.getByRef(node.auth, { sender: ref.sender, id: ref.id }).catch(() => undefined);
		if (entry !== undefined) return entryView(entry, (await planIndex(entry.thread_ref)).get(entry.seq));
		// A message this node sent into a peer-owned thread is not stored as an entry here;
		// the conversation log still holds its body, but not the plan it was sent with.
		const row = await node.history.message(node.auth, { sender: ref.sender, id: ref.id });
		return {
			thread: row.thread_ref ?? null,
			seq: row.seq ?? null,
			id: row.message.id,
			sender: row.message.sender,
			text: row.message.msg,
			at: row.at,
			plan: null,
			relation: row.message.meta?.relation ?? null,
			in_reply_to: row.message.meta?.in_reply_to ?? null,
		};
	}
	if (ref.thread !== undefined && typeof ref.seq === "string" && /^\d+$/.test(ref.seq)) {
		const thread = await resolveThread(ref.thread);
		const before = BigInt(ref.seq) - 1n;
		if (before < 0n) throw new OnlyneError("not_found", `thread ${thread.id} 里没有 seq ${ref.seq}`);
		const page = await node.messages.list(node.auth, thread, { attention: "thread", page_size: 1, since_seq: before.toString() });
		const entry = page.items.find(item => item.seq === ref.seq);
		if (entry === undefined) throw new OnlyneError("not_found", `thread ${thread.id} 里没有 seq ${ref.seq}`);
		return entryView(entry, (await planIndex(thread)).get(entry.seq));
	}
	throw new OnlyneError("invalid_request", "ref 需要 {thread, seq} 或 {sender, id}");
}

await startLog();

interface StoredSettings {
	node_id?: string;
	region?: string;
	bind?: string;
	/** The port this companion last bound, written back on start so the address survives a restart. */
	port?: number;
	public_url?: string;
	key_scope?: "project" | "none";
	systemone?: Partial<JudgeConfig>;
	acquisition?: unknown;
	trust?: unknown;
}

async function readSettings(): Promise<StoredSettings> {
	try {
		const parsed: unknown = JSON.parse(await readFile(kvPath, "utf8"));
		if (parsed === null || typeof parsed !== "object" || !("onlyne.config" in parsed)) return {};
		const value = parsed["onlyne.config"];
		return value !== null && typeof value === "object" ? value as StoredSettings : {};
	} catch {
		return {};
	}
}

/**
 * Writes the port this process actually bound back into `onlyne.config`, so the next start
 * answers on the same address instead of asking the operating system for a new one. The file
 * is the plugin's kv store: every other key is preserved, and a failure is logged rather than
 * failing a companion that is already listening.
 */
async function persistPort(port: number): Promise<void> {
	try {
		const raw: unknown = JSON.parse(await readFile(kvPath, "utf8"));
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
		const root = raw as Record<string, unknown>;
		const current = root["onlyne.config"];
		if (current === null || typeof current !== "object" || Array.isArray(current)) return;
		await writeFile(kvPath, JSON.stringify({
			...root,
			"onlyne.config": { ...(current as Record<string, unknown>), port },
		}), { mode: 0o600 });
		log("onlyne.port.persisted", { port, path: kvPath });
	} catch (error) {
		log("onlyne.port.persist.failed", { port, error: error instanceof Error ? error.message : String(error) });
	}
}

function toConfig(stored: StoredSettings, seeds: TrustSeed[]): OnlyneConfig {
	if (stored.node_id === undefined || stored.region === undefined) {
		throw new OnlyneError("unsupported_delivery", "Onlyne is not configured yet; open the Onlyne settings block in Tern.");
	}
	const keyed = stored.key_scope !== "none";
	const publicUrl = stored.public_url?.trim();
	const port = stored.port;
	return {
		path: configPath(dataDir),
		region: stored.region,
		node: { id: stored.node_id, ...(keyed ? { key_ref: "plugin-data:node-key.json" } : { key_scope: "none" as const }) },
		server: {
			bind: stored.bind ?? "127.0.0.1",
			...(typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}),
			...(publicUrl === undefined || publicUrl === "" ? {} : { public_url: publicUrl }),
		},
		threads: { page_size: 50 },
		...(seeds.length === 0 ? {} : { trust: seeds }),
	};
}

function judgeConfig(stored: StoredSettings): JudgeConfig {
	return {
		endpoint: stored.systemone?.endpoint ?? "http://127.0.0.1:3425/v1/systemone",
		model: stored.systemone?.model ?? "group/decider",
		headers: stored.systemone?.headers,
		timeout_ms: stored.systemone?.timeout_ms ?? 30_000,
	};
}

async function readKey(): Promise<KeyMaterial | undefined> {
	try {
		const stored: unknown = JSON.parse(await readFile(keyPath, "utf8"));
		if (stored === null || typeof stored !== "object" || !("private_key" in stored) || !("public_key" in stored)) return undefined;
		const privateKey = stored.private_key;
		const publicKey = stored.public_key;
		if (typeof privateKey !== "string" || typeof publicKey !== "string") return undefined;
		return {
			private_key: new Uint8Array(Buffer.from(privateKey, "base64")),
			public_key: new Uint8Array(Buffer.from(publicKey, "base64")),
		};
	} catch {
		return undefined;
	}
}

async function writeKey(material: KeyMaterial): Promise<void> {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	await chmod(dataDir, 0o700);
	await writeFile(keyPath, JSON.stringify({
		private_key: Buffer.from(material.private_key).toString("base64"),
		public_key: Buffer.from(material.public_key).toString("base64"),
	}), { mode: 0o600 });
	await chmod(keyPath, 0o600);
}

/** A second companion may have replaced server.json; only this process removes its own. */
async function unlinkOwnServer(): Promise<void> {
	try {
		const current: unknown = JSON.parse(await readFile(serverPath, "utf8"));
		if (current !== null && typeof current === "object" && (current as { pid?: unknown }).pid === process.pid) {
			await unlink(serverPath);
		}
	} catch {
		// Already gone, or not ours to read.
	}
}

const keys: KeyHook = Object.assign(
	async () => {
		const existing = await readKey();
		if (existing !== undefined) return existing;
		const created = await generateKeyMaterial();
		await writeKey(created);
		return created;
	},
	{ replace: writeKey },
);

const stored = await readSettings();
let config: OnlyneConfig;
let acquisition: AcquisitionPolicy;
let seeds: TrustSeed[];
try {
	// The policy and the seeds are read before anything binds: a malformed or retired key is a
	// startup error, not a value to guess at (RFC 0018 §2, §5).
	acquisition = readAcquisition(stored);
	seeds = readSeeds(stored);
	config = toConfig(stored, seeds);
} catch (error) {
	failStartup(error instanceof Error ? error.message : String(error));
}
const keyed = stored.key_scope !== "none";
const storage = new SqliteStorage(join(dataDir, "onlyne.db"));
const contexts = new ContextRegistry(storage, config.node.id, "carly");
const acquisitionStore = new AcquisitionStore(storage);
/**
 * The arrival address of the request being served. The library emits its `trust` notification
 * synchronously inside `receive()`, so this context is still the one in force when the host
 * records where the statement came from (RFC 0018 §2.1).
 */
const inbound = new AsyncLocalStorage<{ address: string; port: number; seen: boolean }>();

log("onlyne.acquisition.policy", { policy: acquisition.policy, allow: acquisition.allow, allow_loopback: false });
for (const seed of seeds) {
	log("onlyne.acquisition.seed", { node: seed.node_id, fingerprint: seed.fingerprint, source: kvPath });
	await acquisitionStore.audit({
		at: new Date().toISOString(), kind: "seed", actor: "seed",
		node_id: seed.node_id, fingerprint: seed.fingerprint,
		policy: acquisition.policy, allow: [...acquisition.allow],
		rule: "trust_seeds 是人类的预授权，不受获取策略约束",
		conclusion: "seed_authorized", detail: `来源文件 ${kvPath}`, overridden: true,
	});
}

let node!: OnlyneNode;
let pipeline: TrustPipeline | undefined;
/** The panel is the last gate: only its own code sets this header, never an agent export. */
function caller(request: Request): "human" | "agent" {
	return request.headers.get("x-onlyne-human") === "1" ? "human" : "agent";
}

function denial(outcome: Extract<Outcome<never>, { ok: false }>): Record<string, unknown> {
	return {
		code: "policy_denied",
		message: `获取策略拒绝了这个动作：${outcome.rule}`,
		retryable: false,
		details: {
			policy: acquisition.policy, allow: acquisition.allow,
			reason: outcome.verdict.reason, address: outcome.verdict.address ?? null, rule: outcome.rule,
		},
	};
}
const decider = new CarlyDecider({
	nodeId: config.node.id,
	judge: judgeConfig(stored),
	listPeers: async () => {
		const records = await node.discovery.listRecords();
		const now = Date.now();
		const peers = new Map<string, string>();
		for (const record of records) {
			if (record.verified_at !== undefined && Date.parse(record.expires_at) > now && record.node_id !== config.node.id) {
				peers.set(record.node_id, record.base_url);
			}
		}
		try {
			const trustRows = await node.trust.list(node.auth);
			for (const row of trustRows) {
				if (row.node_id !== config.node.id && row.base_url && !peers.has(row.node_id)) {
					const phase = trustPhase(row);
					if (phase === "exchanged" || phase === "requested") {
						peers.set(row.node_id, row.base_url);
					}
				}
			}
		} catch {
			// Trust list unavailable before node initialization
		}
		return [...peers.entries()].map(([node_id, base_url]) => ({ node_id, base_url }));
	},
	listThreads: () => ownThreads(),
	listMessages: (thread, cursor) => node.messages.list(node.auth, thread, { attention: "thread", page_size: 100, cursor }),
	supports: plan => bridge.supports(plan),
	locate: async ref => {
		const entry = await node.messages.getByRef(node.auth, ref).catch(() => undefined);
		if (entry !== undefined) return entry.thread_ref;
		// A message this node sent has no entry of its own; its receipt names the thread.
		const message = await node.history.message(node.auth, ref).catch(() => undefined);
		return message?.thread_ref;
	},
	describeThread: async ref => {
		const described = await node.threads.describe(node.auth, ref).catch(() => undefined);
		return described === undefined ? undefined : { members: described.members };
	},
	receiverContexts: async () => [{ alias: "carly", summary: "Carly's Tern conversation", state: "idle" }],
});

const bridge = new CarlyBridge({
	decider,
	confirm: async (entry, context) => {
		await node.client.confirmConsumption(entry, context, "fragment");
	},
	trust: event => pipeline?.notify(event),
	touch: touchThread,
	log,
});

let endpoint = "";
// The fetch handler reads the arrival address off this server, so the binding has to be
// annotated: a `const` that references itself would have no inferred type at all.
/** The port a configured `public_url` names; a URL without one names its scheme's default. */
function publicPort(url: string): number {
	const parsed = new URL(url);
	if (parsed.port !== "") return Number(parsed.port);
	return parsed.protocol === "https:" ? 443 : 80;
}

/**
 * Whether this machine can answer on that host at all. A loopback name, a literal of one of
 * this machine's own addresses, or a name that resolves to either, is a local bind; everything
 * else is a reverse proxy's declaration, and its port belongs to the proxy.
 */
async function locallyBindable(host: string): Promise<boolean> {
	const literal = host.replace(/^\[|\]$/g, "");
	if (literal === "::1" || literal === "::" || literal === "0.0.0.0" || literal.startsWith("127.")) return true;
	const mine = new Set<string>();
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) mine.add(address.address);
	}
	if (mine.has(literal)) return true;
	const resolved = await lookup(literal, { all: true }).catch(() => []);
	return resolved.some(row => row.address === "::1" || row.address.startsWith("127.") || mine.has(row.address));
}

let server!: Server<undefined>;
const publicUrl = config.server.public_url;
let wanted = 0;
let proxied = false;
if (publicUrl !== undefined) {
	let parsed: URL;
	try {
		parsed = new URL(publicUrl);
	} catch {
		failStartup(`onlyne.config.public_url is not an absolute URL: ${publicUrl}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		failStartup(`onlyne.config.public_url must be http or https, got ${parsed.protocol}`);
	}
	// The host decides first: a proxy host would otherwise send this process looking for 443.
	if (await locallyBindable(parsed.hostname)) wanted = publicPort(publicUrl);
	else proxied = true;
}
// A proxy declaration owns the published address, so its local port stays ephemeral. Every
// other start reuses the port this companion bound last time.
if (wanted === 0 && !proxied) wanted = config.server.port ?? 0;

const listening = (port: number) => Bun.serve({
	hostname: config.server.bind,
	port,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/onlyne/")) {
			const ip = server.requestIP(request);
			if (ip === null || ip === undefined) return node.fetch(request);
			return inbound.run({ address: ip.address, port: ip.port, seen: false }, () => node.fetch(request));
		}
		if (!url.pathname.startsWith("/admin/")) return new Response("Not found", { status: 404 });
		if (request.headers.get("x-onlyne-admin-token") !== adminToken) return json({ error: "unauthorized" }, 401);
		try {
			if (url.pathname === "/admin/status") {
				lastProbeAt = Date.now();
				const records = await node.discovery.listRecords();
				const now = Date.now();
				const peers_live = records.filter(r => r.verified_at !== undefined && Date.parse(r.expires_at) > now && r.node_id !== config.node.id).length;
				const peers_stale = records.filter(r => r.verified_at !== undefined && Date.parse(r.expires_at) <= now && r.node_id !== config.node.id).length;
				const peers_known = records.filter(r => r.node_id !== config.node.id).length;
				return json({
					node_id: config.node.id, region: config.region, endpoint,
					peers: peers_live, peers_live, peers_stale, peers_known,
					pending: bridge.pending().length,
				});
			}
			if (url.pathname === "/admin/discovery") {
				const records = await node.discovery.listRecords();
				return json({ items: records.filter(r => r.node_id !== config.node.id) });
			}
			if (url.pathname === "/admin/discovery/refresh" && request.method === "POST") {
				const outcome = await pipeline!.refresh(caller(request));
				if (!outcome.ok) return json({ error: denial(outcome) }, 403);
				return json({ ok: true, records: outcome.value.records });
			}
			if (url.pathname === "/admin/pending") return json({ items: bridge.pending() });
			if (url.pathname === "/admin/consumed" && request.method === "POST") {
				const body = await request.json() as { token?: unknown };
				if (typeof body.token !== "string") return json({ error: "token required" }, 400);
				return json(await bridge.consumed(body.token));
			}
			if (url.pathname === "/admin/contact" && request.method === "POST") {
				const body = await request.json() as { endpoint?: unknown };
				if (typeof body.endpoint !== "string") return json({ error: "endpoint required" }, 400);
				const outcome = await pipeline!.contact(body.endpoint, caller(request));
				if (!outcome.ok) return json({ error: denial(outcome) }, 403);
				return json({ ok: true });
			}
			if (url.pathname === "/admin/acquisition") return json(await pipeline!.panel());
			if (url.pathname === "/admin/trust/list") {
				const rows = await node.trust.list(node.auth);
				const observed = new Map((await acquisitionStore.observations())
					.map(row => [`${row.node_id}\u0000${row.fingerprint}`, row]));
				return json({ items: rows.map(row => trustRow(row, observed.get(`${row.node_id}\u0000${row.fingerprint}`))) });
			}
			if (url.pathname === "/admin/trust/begin" && request.method === "POST") {
				const body = await request.json() as { node_id?: unknown };
				if (typeof body.node_id !== "string" || body.node_id === "") return json({ error: "node_id required" }, 400);
				const outcome = await pipeline!.begin(body.node_id, caller(request));
				if (!outcome.ok) return json({ error: denial(outcome) }, 403);
				return json({ node_id: outcome.value.node_id, fingerprint: outcome.value.fingerprint, public_key: outcome.value.public_key });
			}
			if (url.pathname === "/admin/trust/accept" && request.method === "POST") {
				const body = await request.json() as { node_id?: unknown; fingerprint?: unknown };
				if (typeof body.node_id !== "string" || body.node_id === "" || typeof body.fingerprint !== "string" || body.fingerprint === "") {
					return json({ error: "node_id and fingerprint required" }, 400);
				}
				const outcome = await pipeline!.approve(body.node_id, body.fingerprint, caller(request));
				if (!outcome.ok) return json({ error: denial(outcome) }, 403);
				return json({ ok: true, entry: trustRow(outcome.value) });
			}
			if (url.pathname === "/admin/trust/revoke" && request.method === "POST") {
				const body = await request.json() as { node_id?: unknown };
				if (typeof body.node_id !== "string" || body.node_id === "") return json({ error: "node_id required" }, 400);
				await pipeline!.revoke(body.node_id, caller(request));
				return json({ ok: true });
			}
			if (url.pathname === "/admin/trust/rotate" && request.method === "POST") {
				// The key swap itself is neither inbound nor outbound acquisition, so no policy
				// judgement applies; the statements it owes the peers are what reach them.
				const identity = await node.trust.rotate(node.auth);
				await acquisitionStore.audit({
					at: new Date().toISOString(), kind: "action", actor: caller(request),
					fingerprint: identity.fingerprint,
					policy: acquisition.policy, allow: [...acquisition.allow],
					rule: "本节点密钥轮换", conclusion: "rotated",
				});
				return json({ ok: true, fingerprint: identity.fingerprint, public_key: identity.public_key });
			}
			// Reads: no decision, no policy, no judge. They answer what this node already stores.
			if (url.pathname === "/admin/threads") return json({ items: await threadSummaries() });
			if (url.pathname === "/admin/read" && request.method === "POST") {
				const body = await request.json() as { thread?: unknown; since_seq?: unknown; limit?: unknown };
				const thread = await resolveThread(body.thread);
				const since = typeof body.since_seq === "string" && /^\d+$/.test(body.since_seq) ? body.since_seq : undefined;
				const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(Math.floor(body.limit), 200) : 100;
				return json(await readThread(thread, since, limit));
			}
			if (url.pathname === "/admin/message" && request.method === "POST") {
				const body = await request.json() as { ref?: unknown };
				return json({ message: await messageView(body.ref) });
			}
			if (url.pathname === "/admin/msg" && request.method === "POST") {
				const body = await request.json() as MsgInput;
				if (typeof body.delivery_kind !== "string" || typeof body.msg !== "string") return json({ error: "delivery_kind and msg required" }, 400);
				const outcome = await node.client.msg(body);
				// Consumption follows a send the peer accepted, never one that failed on the way.
				await bridge.observeOutbound({ meta: body.meta });
				const landed = receiptThread(outcome);
				if (landed !== undefined) await touchThread(landed, new Date().toISOString());
				return json({ ok: true, outcome });
			}
			return json({ error: "not found" }, 404);
		} catch (error) {
			const failure = error instanceof OnlyneError ? error.error : { code: "internal", message: error instanceof Error ? error.message : String(error), retryable: false };
			return json({ error: failure }, 200);
		}
	},
});

// A configured port keeps the address stable across restarts; a taken port falls back to an
// ephemeral one rather than leaving the node unbound, and says so in the log.
try {
	server = listening(wanted);
} catch (error) {
	if (wanted === 0) throw error;
	log("onlyne.port.unavailable", { port: wanted, error: error instanceof Error ? error.message : String(error) });
	server = listening(0);
}
const boundPort = server.port;
if (!proxied && boundPort !== undefined && boundPort !== config.server.port) await persistPort(boundPort);

const host = advertisedHost(config.server.bind);
// A peer stores whatever address the introduction carried, so the endpoint must name the port
// this process actually bound: a `public_url` whose port was taken would otherwise be a lie.
const bound = `http://${host.includes(":") ? `[${host}]` : host}:${server.port}/onlyne/v3`;
if (publicUrl !== undefined && (proxied || wanted === server.port)) {
	// A proxy declaration is published verbatim: rewriting it to the local bind would hand peers
	// an address only this machine can reach.
	endpoint = publicUrl;
	if (proxied) {
		log("onlyne.server.proxy", {
			public_url: publicUrl, local_port: server.port,
			detail: "public_url 是代理声明，本进程不监听该端口",
		});
	}
} else {
	endpoint = bound;
}
await contexts.ensureMain();
node = createOnlyneNode({
	config, endpoint, instanceId: crypto.randomUUID(), storage, contexts, runtime: bridge,
	...(keyed ? { keys } : {}),
	clock: {
		setTimer: (ms, run) => setTimeout(run, ms),
		clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
	},
	decide: input => decider.decide(input),
});
pipeline = new TrustPipeline({
	node: () => node,
	nodeId: config.node.id,
	policy: () => acquisition,
	store: acquisitionStore,
	contextAlias: () => "carly",
	origin: () => {
		const store = inbound.getStore();
		// One arrival per request: the first notification is the inbound statement; anything
		// later in the same call stack (an auto-approval's own reply) is not a new arrival.
		if (store === undefined || store.seen) return undefined;
		store.seen = true;
		return { address: store.address, port: store.port };
	},
	seeds: () => seeds,
	seedSource: () => kvPath,
	allowLoopback: () => false,
	settle: async nodeId => {
		await bridge.settleTrust(nodeId);
	},
	log,
});
node.client.runMaintenance();
await writeFile(serverPath, JSON.stringify({ port: server.port, endpoint, pid: process.pid, token: adminToken }), { mode: 0o600 });
log("onlyne.companion.ready", { endpoint, node: config.node.id, region: config.region, keyed });
console.error(JSON.stringify({ message: "onlyne.companion.ready", endpoint, node: config.node.id }));

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

let stopping = false;
const shutdown = async (): Promise<void> => {
	if (stopping) return;
	stopping = true;
	log("onlyne.companion.stopping");
	try {
		node.client.stopMaintenance();
		await node.client.maintain();
	} catch {
		// Shutdown continues; a failed final pass leaves durable state for the next start.
	}
	await unlinkOwnServer();
	server.stop(true);
	storage.close();
	process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

// The plugin owns this process: its host half probes /admin/status every 15 seconds, so a
// minute of silence means the plugin was disabled or unloaded and this companion is an orphan.
setInterval(() => {
	const silent = Date.now() - lastProbeAt;
	if (silent <= HEARTBEAT_TIMEOUT_MS) return;
	log("onlyne.companion.orphaned", { silent_ms: silent });
	void shutdown();
}, HEARTBEAT_CHECK_MS).unref();
