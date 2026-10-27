import { appendFile, chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	OnlyneError,
	generateKeyMaterial,
	trustPhase,
	type KeyHook,
	type KeyMaterial,
	type MsgInput,
	type OnlyneNode,
	type Thread,
	type TrustEntry,
} from "@onlyne/lib";
import { CarlyBridge } from "./bridge.ts";
import { CarlyDecider } from "./decider.ts";
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

await startLog();

interface StoredSettings {
	node_id?: string;
	region?: string;
	bind?: string;
	public_url?: string;
	key_scope?: "project" | "none";
	systemone?: Partial<JudgeConfig>;
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

function toConfig(stored: StoredSettings): OnlyneConfig {
	if (stored.node_id === undefined || stored.region === undefined) {
		throw new OnlyneError("unsupported_delivery", "Onlyne is not configured yet; open the Onlyne settings block in Tern.");
	}
	const keyed = stored.key_scope !== "none";
	return {
		path: configPath(dataDir),
		region: stored.region,
		node: { id: stored.node_id, ...(keyed ? { key_ref: "plugin-data:node-key.json" } : { key_scope: "none" as const }) },
		server: { bind: stored.bind ?? "127.0.0.1", ...(stored.public_url === undefined || stored.public_url === "" ? {} : { public_url: stored.public_url }) },
		threads: { page_size: 50 },
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
const config = toConfig(stored);
const keyed = stored.key_scope !== "none";
const storage = new SqliteStorage(join(dataDir, "onlyne.db"));
const contexts = new ContextRegistry(storage, config.node.id, "carly");

let node!: OnlyneNode;
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
	listThreads: async () => {
		const threads: Thread[] = [];
		let cursor: string | undefined;
		do {
			const page = await node.threads.list(node.auth, { page_size: 100, cursor });
			threads.push(...page.items);
			cursor = page.next_cursor ?? undefined;
		} while (cursor !== undefined);
		return threads;
	},
	listMessages: (thread, cursor) => node.messages.list(node.auth, thread, { attention: "thread", page_size: 100, cursor }),
	receiverContexts: async () => [{ alias: "carly", summary: "Carly's Tern conversation", state: "idle" }],
});

const bridge = new CarlyBridge({
	decider,
	confirm: async (entry, context) => {
		await node.client.confirmConsumption(entry, context, "fragment");
	},
	observe: async (url, source, expectedNode) => {
		await node.discovery.observe(url, source, expectedNode).catch(() => undefined);
	},
	log,
});

let endpoint = "";
const server = Bun.serve({
	hostname: config.server.bind,
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/onlyne/")) return node.fetch(request);
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
				await node.discovery.refresh();
				return json({ ok: true });
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
				await node.discovery.observe(body.endpoint, "manual");
				return json({ ok: true });
			}
			if (url.pathname === "/admin/trust/list") {
				const rows = await node.trust.list(node.auth);
				return json({ items: rows.map(trustRow) });
			}
			if (url.pathname === "/admin/trust/begin" && request.method === "POST") {
				const body = await request.json() as { node_id?: unknown };
				if (typeof body.node_id !== "string" || body.node_id === "") return json({ error: "node_id required" }, 400);
				const identity = await node.trust.inspect(body.node_id);
				return json({ node_id: identity.node_id, fingerprint: identity.fingerprint, public_key: identity.public_key });
			}
			if (url.pathname === "/admin/trust/accept" && request.method === "POST") {
				const body = await request.json() as { node_id?: unknown; fingerprint?: unknown };
				if (typeof body.node_id !== "string" || body.node_id === "" || typeof body.fingerprint !== "string" || body.fingerprint === "") {
					return json({ error: "node_id and fingerprint required" }, 400);
				}
				const entry = await node.trust.accept(node.auth, body.node_id, body.fingerprint);
				return json({ ok: true, entry: trustRow(entry) });
			}
			if (url.pathname === "/admin/trust/revoke" && request.method === "POST") {
				const body = await request.json() as { node_id?: unknown };
				if (typeof body.node_id !== "string" || body.node_id === "") return json({ error: "node_id required" }, 400);
				await node.trust.revoke(node.auth, body.node_id);
				return json({ ok: true });
			}
			if (url.pathname === "/admin/msg" && request.method === "POST") {
				const body = await request.json() as MsgInput;
				if (typeof body.delivery_kind !== "string" || typeof body.msg !== "string") return json({ error: "delivery_kind and msg required" }, 400);
				const outcome = await node.client.msg(body);
				// Consumption follows a send the peer accepted, never one that failed on the way.
				await bridge.observeOutbound({ meta: body.meta });
				return json({ ok: true, outcome });
			}
			return json({ error: "not found" }, 404);
		} catch (error) {
			const failure = error instanceof OnlyneError ? error.error : { code: "internal", message: error instanceof Error ? error.message : String(error), retryable: false };
			return json({ error: failure }, 200);
		}
	},
});

const host = advertisedHost(config.server.bind);
endpoint = `http://${host.includes(":") ? `[${host}]` : host}:${server.port}/onlyne/v3`;
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
node.client.runMaintenance();
await writeFile(serverPath, JSON.stringify({ port: server.port, endpoint, pid: process.pid, token: adminToken }), { mode: 0o600 });
log("onlyne.companion.ready", { endpoint, node: config.node.id, region: config.region, keyed });
console.error(JSON.stringify({ message: "onlyne.companion.ready", endpoint, node: config.node.id }));

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function trustRow(entry: TrustEntry): Record<string, unknown> {
	return {
		node_id: entry.node_id,
		fingerprint: entry.fingerprint,
		public_key: entry.public_key,
		base_url: entry.base_url,
		phase: trustPhase(entry),
		local_approved: entry.local_approved,
		remote_approved: entry.remote_approved,
		first_seen: entry.first_seen,
		last_checked: entry.last_checked,
	};
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
