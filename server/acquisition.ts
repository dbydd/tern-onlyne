import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { Storage, TrustPhase, TrustSeed } from "@onlyne/lib";

/**
 * RFC 0018 §2: the host's peer-acquisition policy. The library never reads it; the only
 * thing it sees is whether `trust.accept` was called at all.
 */

/** RFC 0018 §2: how far a peer may be acquired without a human confirming first. */
export type AcquirePolicy = "all" | "segment" | "none";

export interface AcquisitionPolicy {
	policy: AcquirePolicy;
	/** CIDR blocks; read only when `policy` is `segment`. */
	allow: string[];
}

/**
 * The default delegation: loopback only. Discovery excludes loopback by default, so the two
 * defaults together mean a remote peer is neither discovered nor approved (RFC 0018 §5.1).
 */
export const DEFAULT_ACQUISITION: AcquisitionPolicy = {
	policy: "segment",
	allow: ["127.0.0.0/8", "::1/128"],
};

/**
 * Config keys this host refuses to read. `peers` was the old name for the acquisition table;
 * reading it under the new meaning would silently reinterpret an existing configuration
 * (RFC 0018 §5), so the name stays retired instead.
 */
export const RETIRED_CONFIG_KEYS = ["peers"] as const;

/** Why a verdict came out the way it did; the audit and the message body both carry it. */
export type AcquireReason =
	| "policy_all"
	| "policy_segment"
	| "policy_denied_none"
	| "policy_unobserved"
	| "policy_denied_observed"
	| "policy_denied_declared"
	| "policy_denied_recorded";

/** RFC 0018 §2.1–2.2: what the host observed, what the peer declared, what discovery recorded. */
export interface AcquireInput {
	/** The address this statement's connection arrived from; absent when it was not observed. */
	observed?: string;
	/** The `base_url` the peer wrote into its own statement. */
	declared?: string;
	/** Every discovery address recorded for this node id. */
	recorded?: readonly string[];
}

export interface AcquireVerdict {
	allowed: boolean;
	reason: AcquireReason;
	/** The allow entry the judged address matched, when one did. */
	matched?: string;
	/** The input the refusal names: the address that fell outside the allow set. */
	address?: string;
	/** Why it failed in words, including what a host name resolved to. */
	detail?: string;
}

/** Outbound actions judge the addresses a connection will actually use (RFC 0018 §2.1). */
export interface OutboundInput {
	/** The `base_url` the trust row holds; `peerBase` falls back to it when discovery has no record. */
	declared?: string;
	/** Every discovery address recorded for this node id; `resolve()` re-probes each one. */
	recorded?: readonly string[];
}

export interface Block {
	network: string;
	prefix: number;
	type: "ipv4" | "ipv6";
}

/**
 * The literal address an address or service URL names. A host name has none; it is judged by
 * resolution instead (RFC 0018 §2.1).
 */
function literalHost(value: string): { address: string; type: "ipv4" | "ipv6" } | undefined {
	const trimmed = value.trim();
	const host = trimmed.includes("://") ? urlHost(trimmed) : trimmed;
	if (host === undefined) return undefined;
	const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
	if (mapped !== null) return { address: mapped[1]!, type: "ipv4" };
	const family = isIP(bare);
	if (family === 4) return { address: bare, type: "ipv4" };
	if (family === 6) return { address: bare, type: "ipv6" };
	return undefined;
}

/** The host a service URL names, brackets stripped; undefined when the value is not a URL. */
export function urlHost(value: string): string | undefined {
	try {
		const host = new URL(value).hostname;
		return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	} catch {
		return undefined;
	}
}

/**
 * The literal IP an address or service URL names, or undefined for a host name.
 */
export function literalAddress(value: string): string | undefined {
	return literalHost(value)?.address;
}

/** One `[acquisition] allow` block: `network/prefix`, with an IPv6 host optionally bracketed. */
export function parseAllowBlock(value: string): Block | undefined {
	const trimmed = value.trim();
	const slash = trimmed.lastIndexOf("/");
	if (slash <= 0) return undefined;
	const prefix = Number(trimmed.slice(slash + 1));
	if (!Number.isInteger(prefix) || prefix < 0) return undefined;
	const network = literalHost(trimmed.slice(0, slash));
	if (network === undefined) return undefined;
	if (prefix > (network.type === "ipv4" ? 32 : 128)) return undefined;
	return { network: network.address, prefix, type: network.type };
}

/**
 * One allow entry: a `network/prefix` block, or a host name that matches on its own
 * (RFC 0018 §2.1 — otherwise a peer bound to `localhost` could never be approved).
 */
export type AllowEntry =
	| { kind: "block"; raw: string; block: Block }
	| { kind: "host"; raw: string; host: string };

const HOST_NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export function parseAllowEntry(value: string): AllowEntry | undefined {
	const trimmed = value.trim();
	if (trimmed.includes("/")) {
		const block = parseAllowBlock(trimmed);
		return block === undefined ? undefined : { kind: "block", raw: trimmed, block };
	}
	// A bare address is a typo for a block, not a name: it names no host to compare against.
	if (literalHost(trimmed) !== undefined || !HOST_NAME.test(trimmed)) return undefined;
	return { kind: "host", raw: trimmed, host: trimmed.toLowerCase() };
}

export interface AddressMatch {
	ok: boolean;
	rule?: string;
	detail?: string;
}

/**
 * RFC 0018 §2.1: an address or service URL against the allow set. A literal is compared to
 * every block, and to the addresses a host-name entry resolves to. A host name is matched by
 * name, else resolved: every address it resolves to must be allowed, and a name that does not
 * resolve is denied — the peer's location is then unproven, not permitted.
 */
export class AddressJudge {
	readonly #resolved = new Map<string, Promise<string[] | undefined>>();

	constructor(private readonly entries: readonly AllowEntry[]) {}

	#resolve(host: string): Promise<string[] | undefined> {
		const cached = this.#resolved.get(host);
		if (cached !== undefined) return cached;
		const pending = lookup(host, { all: true, verbatim: true })
			.then(rows => (rows.length === 0 ? undefined : rows.map(row => row.address)))
			.catch(() => undefined);
		this.#resolved.set(host, pending);
		return pending;
	}

	async #literalIn(address: string, type: "ipv4" | "ipv6"): Promise<string | undefined> {
		for (const entry of this.entries) {
			if (entry.kind === "block") {
				if (entry.block.type !== type) continue;
				const blocks = new BlockList();
				blocks.addSubnet(entry.block.network, entry.block.prefix, entry.block.type);
				if (blocks.check(address, entry.block.type)) return entry.raw;
				continue;
			}
			if ((await this.#resolve(entry.host))?.includes(address) === true) return entry.raw;
		}
		return undefined;
	}

	async match(value: string): Promise<AddressMatch> {
		const target = literalHost(value);
		if (target !== undefined) {
			const rule = await this.#literalIn(target.address, target.type);
			return rule === undefined
				? { ok: false, detail: `${target.address} 不在允许集合内` }
				: { ok: true, rule };
		}
		const host = (urlHost(value) ?? value.trim()).toLowerCase();
		for (const entry of this.entries) {
			if (entry.kind === "host" && entry.host === host) return { ok: true, rule: entry.raw };
		}
		const addresses = await this.#resolve(host);
		if (addresses === undefined) return { ok: false, detail: `主机名 ${host} 无法解析` };
		for (const address of addresses) {
			const literal = literalHost(address);
			if (literal === undefined || await this.#literalIn(literal.address, literal.type) === undefined) {
				return { ok: false, detail: `主机名 ${host} 解析到 ${address}，不在允许集合内` };
			}
		}
		return { ok: true, rule: `${host} → ${addresses.join(", ")}` };
	}
}

function judgeOf(policy: AcquisitionPolicy): AddressJudge {
	return new AddressJudge(policy.allow
		.map(entry => parseAllowEntry(entry))
		.filter((entry): entry is AllowEntry => entry !== undefined));
}

/**
 * RFC 0018 §2.2: whether an arriving statement may be approved without a human confirming.
 *
 * The observed address decides, and it is the one recorded when the statement arrived — a
 * declared `base_url` proves identity, never location. The declared address is still checked
 * because the trust row stores it and `peerBase` falls back to it, and every recorded address
 * is checked because `resolve()` re-probes all of them before it connects.
 */
export async function evaluateInbound(policy: AcquisitionPolicy, input: AcquireInput): Promise<AcquireVerdict> {
	if (policy.policy === "none") return { allowed: false, reason: "policy_denied_none" };
	if (policy.policy === "all") return { allowed: true, reason: "policy_all" };
	if (input.observed === undefined) return { allowed: false, reason: "policy_unobserved" };
	const judge = judgeOf(policy);
	const observed = await judge.match(input.observed);
	if (!observed.ok) {
		return { allowed: false, reason: "policy_denied_observed", address: input.observed, ...(observed.detail === undefined ? {} : { detail: observed.detail }) };
	}
	if (input.declared !== undefined) {
		const declared = await judge.match(input.declared);
		if (!declared.ok) {
			return {
				allowed: false, reason: "policy_denied_declared",
				...(observed.rule === undefined ? {} : { matched: observed.rule }),
				address: input.declared,
				...(declared.detail === undefined ? {} : { detail: declared.detail }),
			};
		}
	}
	for (const address of input.recorded ?? []) {
		const recorded = await judge.match(address);
		if (!recorded.ok) {
			return {
				allowed: false, reason: "policy_denied_recorded",
				...(observed.rule === undefined ? {} : { matched: observed.rule }),
				address,
				...(recorded.detail === undefined ? {} : { detail: recorded.detail }),
			};
		}
	}
	return { allowed: true, reason: "policy_segment", ...(observed.rule === undefined ? {} : { matched: observed.rule }) };
}

/**
 * RFC 0018 §2.1: whether an outbound action (an agent-initiated `contact`, `trust/begin`,
 * `trust/accept` or a discovery sweep) may dial on the agent's behalf.
 *
 * The recorded addresses are checked before anything is dialed, never by calling `resolve()`:
 * resolving would probe exactly the addresses this judgement has not cleared yet. When no
 * record exists, the only address a connection can use is the declared `base_url`.
 */
export async function evaluateOutbound(policy: AcquisitionPolicy, input: OutboundInput): Promise<AcquireVerdict> {
	if (policy.policy === "none") return { allowed: false, reason: "policy_denied_none" };
	if (policy.policy === "all") return { allowed: true, reason: "policy_all" };
	const judge = judgeOf(policy);
	for (const address of input.recorded ?? []) {
		const recorded = await judge.match(address);
		if (!recorded.ok) {
			return { allowed: false, reason: "policy_denied_recorded", address, ...(recorded.detail === undefined ? {} : { detail: recorded.detail }) };
		}
	}
	const declared = input.declared === undefined || input.declared === "" ? undefined : input.declared;
	if (declared === undefined) {
		// Nothing recorded and nothing declared: there is no address to judge, so nothing may be dialed.
		if ((input.recorded ?? []).length === 0) return { allowed: false, reason: "policy_unobserved" };
		return { allowed: true, reason: "policy_segment" };
	}
	const matched = await judge.match(declared);
	if (!matched.ok) {
		return { allowed: false, reason: "policy_denied_declared", address: declared, ...(matched.detail === undefined ? {} : { detail: matched.detail }) };
	}
	return { allowed: true, reason: "policy_segment", ...(matched.rule === undefined ? {} : { matched: matched.rule }) };
}

/** The judgement as one line, for the audit row and the message body. */
export function describeVerdict(policy: AcquisitionPolicy, verdict: AcquireVerdict): string {
	const allow = policy.allow.join(", ");
	const base = (() => {
		if (verdict.reason === "policy_all") return "policy=all：任意对端自动批准";
		if (verdict.reason === "policy_denied_none") return `policy=none：agent 与宿主都不得自动确认（允许集合 ${allow} 仅面板使用）`;
		if (verdict.reason === "policy_unobserved") return `policy=segment：没有可判定的地址，拒绝自动批准（允许 ${allow}）`;
		if (verdict.reason === "policy_denied_observed") return `policy=segment：观测来源地址 ${verdict.address ?? "?"} 不在允许集合内（允许 ${allow}）`;
		if (verdict.reason === "policy_denied_declared") return `policy=segment：声明地址 ${verdict.address ?? "?"} 不在允许集合内（允许 ${allow}）`;
		if (verdict.reason === "policy_denied_recorded") return `policy=segment：发现记录地址 ${verdict.address ?? "?"} 不在允许集合内（允许 ${allow}）`;
		return `policy=segment：命中允许条目 ${verdict.matched ?? "?"}`;
	})();
	return verdict.detail === undefined ? base : `${base}（${verdict.detail}）`;
}

/** One statement-arrival observation, keyed by (node_id, fingerprint) (RFC 0018 §2.1). */
export interface Observation {
	node_id: string;
	fingerprint: string;
	/** The address the connection arrived from, taken from the HTTP request itself. */
	address: string;
	port?: number;
	/** What the statement declared next to it, for the mismatch audit. */
	declared?: string;
	at: string;
}

export type AuditKind = "statement" | "action" | "seed";
export type AuditActor = "host" | "agent" | "human" | "seed";

/** One auditable acquisition fact: the inputs, the rule that matched, the conclusion. */
export interface AuditRow {
	at: string;
	kind: AuditKind;
	actor: AuditActor;
	node_id?: string;
	fingerprint?: string;
	phase?: TrustPhase;
	/** The peer's own claim, and the address the connection really came from. */
	declared?: string;
	observed?: string;
	/** The policy in force at the moment of the judgement. */
	policy: string;
	allow: string[];
	/** The rule that decided, in words. */
	rule: string;
	/** What was done about it. */
	conclusion: string;
	detail?: string;
	/** True when a human decision overrode the policy rather than acting inside it. */
	overridden?: boolean;
}

function fail(message: string): never {
	throw new Error(message);
}

/**
 * The configured policy, or the documented default. A malformed value is a startup error:
 * silently falling back would run a policy nobody asked for.
 */
export function readAcquisition(raw: object): AcquisitionPolicy {
	for (const key of RETIRED_CONFIG_KEYS) {
		if (key in raw && raw[key] !== undefined) {
			fail(`onlyne.config.${key} is retired and MUST NOT be read; it was replaced by onlyne.config.acquisition { policy, allow }.`);
		}
	}
	if (!("acquisition" in raw) || raw.acquisition === undefined) {
		return { policy: DEFAULT_ACQUISITION.policy, allow: [...DEFAULT_ACQUISITION.allow] };
	}
	const value = raw.acquisition;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		fail("onlyne.config.acquisition must be an object with policy and allow.");
	}
	const policy = "policy" in value ? value.policy : undefined;
	if (policy !== undefined && policy !== "all" && policy !== "segment" && policy !== "none") {
		fail(`onlyne.config.acquisition.policy must be all, segment or none, got ${JSON.stringify(policy)}.`);
	}
	let allow = [...DEFAULT_ACQUISITION.allow];
	const configured = "allow" in value ? value.allow : undefined;
	if (configured !== undefined) {
		if (!Array.isArray(configured) || configured.length === 0 || configured.some(entry => typeof entry !== "string" || entry.trim() === "")) {
			fail("onlyne.config.acquisition.allow must be a non-empty array of network/prefix blocks or host names.");
		}
		allow = configured.map(entry => entry.trim());
		for (const entry of allow) {
			if (parseAllowEntry(entry) === undefined) {
				fail(`onlyne.config.acquisition.allow entry ${JSON.stringify(entry)} is neither a network/prefix block nor a host name.`);
			}
		}
	}
	return { policy: policy ?? DEFAULT_ACQUISITION.policy, allow };
}

/** The configured seeds (RFC 0018 §2.3): a human pre-authorization the policy does not govern. */
export function readSeeds(raw: object): TrustSeed[] {
	if (!("trust" in raw) || raw.trust === undefined) return [];
	const value = raw.trust;
	if (!Array.isArray(value)) fail("onlyne.config.trust must be an array of { node_id, fingerprint } entries.");
	return value.map(entry => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
			fail("onlyne.config.trust entries must be objects with node_id and fingerprint.");
		}
		const nodeId = "node_id" in entry ? entry.node_id : undefined;
		const fingerprint = "fingerprint" in entry ? entry.fingerprint : undefined;
		if (typeof nodeId !== "string" || nodeId === "" || typeof fingerprint !== "string" || !/^[0-9a-f]{16}$/.test(fingerprint)) {
			fail(`onlyne.config.trust entry ${JSON.stringify(entry)} needs a node_id and a 16-character lowercase hex fingerprint.`);
		}
		return { node_id: nodeId, fingerprint };
	});
}

const OBSERVATION_PREFIX = "acquisition/observation/";
const AUDIT_PREFIX = "acquisition/audit/";
const AUDIT_KEEP = 500;
const DELIVERED_PREFIX = "acquisition/delivered/";
const DELIVERED_KEEP = 500;

/**
 * The host's own acquisition state: where each statement arrived from, and what was decided
 * about it. It lives beside the library's rows under its own prefix; the library never reads it.
 */
export class AcquisitionStore {
	constructor(private readonly storage: Storage) {}

	/** RFC 0018 §2.1: the arrival address, keyed by the identity the statement proved. */
	async recordObservation(observation: Observation): Promise<void> {
		await this.storage.transaction(async tx => {
			await tx.put(`${OBSERVATION_PREFIX}${encodeURIComponent(observation.node_id)}/${observation.fingerprint}`, observation);
		});
	}

	async observation(nodeId: string, fingerprint: string): Promise<Observation | undefined> {
		return this.storage.transaction(tx =>
			tx.get<Observation>(`${OBSERVATION_PREFIX}${encodeURIComponent(nodeId)}/${fingerprint}`));
	}

	/** Every recorded arrival, newest first; the panel lists the invited rows against these. */
	async observations(): Promise<Observation[]> {
		return this.storage.transaction(async tx =>
			(await tx.scan<Observation>(OBSERVATION_PREFIX)).map(row => row.value).sort((a, b) => b.at.localeCompare(a.at)));
	}

	async audit(row: AuditRow): Promise<void> {
		await this.storage.transaction(async tx => {
			await tx.put(`${AUDIT_PREFIX}${row.at}-${crypto.randomUUID()}`, row);
			const rows = await tx.scan<AuditRow>(AUDIT_PREFIX);
			if (rows.length <= AUDIT_KEEP) return;
			for (const stale of rows.sort((a, b) => a.key.localeCompare(b.key)).slice(0, rows.length - AUDIT_KEEP)) {
				await tx.delete(stale.key);
			}
		});
	}

	/** Newest first, capped by `limit`. */
	async audits(limit = 50): Promise<AuditRow[]> {
		return this.storage.transaction(async tx =>
			(await tx.scan<AuditRow>(AUDIT_PREFIX)).map(row => row.value).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit));
	}

	/**
	 * RFC 0018 §3: the dedupe key is (node_id, fingerprint, phase). Once an entry for that key
	 * exists, no later event may append another — not even one whose wording changed, which the
	 * library would otherwise reject as an idempotency conflict.
	 */
	async delivered(digest: string): Promise<boolean> {
		return this.storage.transaction(async tx => await tx.get(`${DELIVERED_PREFIX}${digest}`) !== undefined);
	}

	async markDelivered(digest: string, row: { node_id: string; fingerprint: string; phase: string; at: string }): Promise<void> {
		await this.storage.transaction(async tx => {
			await tx.put(`${DELIVERED_PREFIX}${digest}`, row);
			const rows = await tx.scan(DELIVERED_PREFIX);
			if (rows.length <= DELIVERED_KEEP) return;
			for (const stale of rows.sort((a, b) => a.key.localeCompare(b.key)).slice(0, rows.length - DELIVERED_KEEP)) {
				await tx.delete(stale.key);
			}
		});
	}
}
