import { createHash } from "node:crypto";
import {
	OnlyneError,
	trustPhase,
	type DeliveryPlan,
	type DiscoveryRecord,
	type Json,
	type KeyIdentity,
	type Message,
	type NotifyEvent,
	type OnlyneNode,
	type ThreadRef,
	type TrustEntry,
	type TrustPhase,
	type TrustSeed,
} from "@onlyne/lib";
import {
	describeVerdict,
	evaluateInbound,
	evaluateOutbound,
	literalAddress,
	type AcquisitionPolicy,
	type AcquisitionStore,
	type AcquireVerdict,
	type AuditActor,
	type Observation,
} from "./acquisition.ts";

/** The one trust notification RFC 0017 §5 sends; the pipeline reacts to nothing else. */
export type TrustNotify = Extract<NotifyEvent, { event: "trust" }>;

/** The local thread every handshake entry lands in: this node's own, members only itself. */
const TRUST_THREAD_ID = "trust-handshake";
const TRUST_THREAD_TITLE = "Onlyne 信任握手";

/** What each stage means, so the agent reads the state instead of inferring it from a word. */
const PHASE_NOTE: Record<TrustPhase, string> = {
	invited: "（对端已批准，本地未批准）",
	requested: "（本节点已批准，等待对端确认）",
	exchanged: "（双方都已批准）",
	revoked: "（已撤销）",
};

/** The arrival address of the request being served, taken from the HTTP connection itself. */
export interface Origin {
	address: string;
	port?: number;
}

export interface TrustPipelineDeps {
	/** The node exists only after the server binds, so it is read late. */
	node(): OnlyneNode;
	nodeId: string;
	policy(): AcquisitionPolicy;
	store: AcquisitionStore;
	/** The main session alias a delivery binds to, so both hosts land in the same place. */
	contextAlias(): string;
	/** The observed arrival address of the request in flight, once per request. */
	origin(): Origin | undefined;
	seeds(): readonly TrustSeed[];
	seedSource(): string;
	/** Whether the discovery layer admits loopback candidates; shown next to the policy. */
	allowLoopback(): boolean;
	/** Settle the pending handshake items a decided node no longer owes (RFC 0018 §3). */
	settle(nodeId: string): Promise<void>;
	log(message: string, fields?: Record<string, unknown>): void;
}

/** Who asked: the agent (policy applies) or the human panel (the last gate; policy does not). */
export type Caller = "agent" | "human";

export type Outcome<T> =
	| { ok: true; value: T }
	| { ok: false; verdict: AcquireVerdict; rule: string };

/** How a delivered item relates to the agent: a todo with actions, or a result to read. */
interface DeliveryFacts {
	phase: TrustPhase;
	conclusion: string;
	rule: string;
	observed?: string;
	declared?: string;
	actionable: boolean;
	rotationFrom?: string;
	detail?: string;
}

/**
 * RFC 0018 §2 and §3 for this host: the policy runs before any local approval is committed,
 * and every trust change an agent must know about is delivered as a session message.
 */
export class TrustPipeline {
	/** One at a time, in arrival order: a delivery may create the next judgement. */
	#chain: Promise<void> = Promise.resolve();
	/** Nodes whose intermediate notifications belong to a host auto-approval in flight. */
	readonly #quiet = new Set<string>();
	/** The local thread exists once per data directory; a second create would be a conflict. */
	#threadRef?: ThreadRef;

	constructor(private readonly deps: TrustPipelineDeps) {}

	/** A trust transition committed; the work happens off the library's call stack. */
	notify(event: TrustNotify): void {
		// Judged when the event arrives, not when its turn comes: the intermediate notifications
		// an auto-approval emits belong to that approval and must never become their own entry.
		if (this.#quiet.has(event.entry.node_id)) return;
		this.#chain = this.#chain
			.then(() => this.#handle(event))
			.catch(error => {
				this.deps.log("onlyne.acquisition.failed", {
					event: event.cause, node: event.entry.node_id,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/**
	 * A local approval. The policy runs first for an agent action; a human panel action is the
	 * last gate and is not subject to it (RFC 0018 §2). Both are audited.
	 */
	async approve(nodeId: string, fingerprint: string, actor: Caller): Promise<Outcome<TrustEntry>> {
		const node = this.deps.node();
		const entry = await node.trust.entry(nodeId);
		const recorded = await this.#recorded(nodeId);
		const observed = (await this.deps.store.observation(nodeId, fingerprint))?.address;
		const declared = entry?.base_url ?? "";
		const verdict = actor === "agent" ? await evaluateOutbound(this.deps.policy(), { declared, recorded }) : undefined;
		const rule = verdict === undefined
			? "面板动作是最后一道闸，不受获取策略限制"
			: describeVerdict(this.deps.policy(), verdict);
		await this.#audit({
			kind: "action", actor, node_id: nodeId, fingerprint, declared, observed,
			policy: this.deps.policy().policy, allow: [...this.deps.policy().allow], rule,
			conclusion: verdict === undefined ? "human_override" : verdict.allowed ? "allowed" : "policy_denied",
			...(verdict === undefined ? { overridden: true } : {}),
		});
		if (verdict !== undefined && !verdict.allowed) return { ok: false, verdict, rule };
		let accepted: TrustEntry;
		try {
			accepted = await node.trust.accept(node.auth, nodeId, fingerprint);
		} catch (error) {
			// A peer that revoked this node refuses the statement. That is the peer's decision,
			// not this host's policy, and RFC 0018 §6 requires the two to read differently.
			const code = error instanceof OnlyneError ? error.error.code : "internal";
			await this.#audit({
				kind: "action", actor, node_id: nodeId, fingerprint, declared, observed,
				policy: this.deps.policy().policy, allow: [...this.deps.policy().allow],
				rule: code === "forbidden" ? "对端拒绝了这次批准：它已撤销本节点，不是获取策略的拒绝" : "批准未完成",
				conclusion: code === "forbidden" ? "peer_refused" : "failed",
				detail: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		await this.deps.settle(nodeId);
		return { ok: true, value: accepted };
	}

	/** A discovery probe on the agent's behalf; the address it dials is the one judged. */
	async contact(endpoint: string, actor: Caller): Promise<Outcome<DiscoveryRecord>> {
		const node = this.deps.node();
		const verdict = actor === "agent" ? await evaluateOutbound(this.deps.policy(), { declared: endpoint, recorded: [] }) : undefined;
		const rule = verdict === undefined
			? "面板动作是最后一道闸，不受获取策略限制"
			: describeVerdict(this.deps.policy(), verdict);
		await this.#audit({
			kind: "action", actor, declared: endpoint,
			policy: this.deps.policy().policy, allow: [...this.deps.policy().allow], rule,
			conclusion: verdict === undefined ? "human_override" : verdict.allowed ? "allowed" : "policy_denied",
			...(verdict === undefined ? { overridden: true } : {}),
		});
		if (verdict !== undefined && !verdict.allowed) return { ok: false, verdict, rule };
		const record = await node.discovery.observe(endpoint, "manual");
		return { ok: true, value: record };
	}

	/** Stage one of a handshake reads the peer's live key, which is an outbound request. */
	async begin(nodeId: string, actor: Caller): Promise<Outcome<KeyIdentity>> {
		const node = this.deps.node();
		const entry = await node.trust.entry(nodeId);
		const recorded = await this.#recorded(nodeId);
		const declared = entry?.base_url ?? recorded[0] ?? "";
		const verdict = actor === "agent" ? await evaluateOutbound(this.deps.policy(), { declared, recorded }) : undefined;
		const rule = verdict === undefined
			? "面板动作是最后一道闸，不受获取策略限制"
			: describeVerdict(this.deps.policy(), verdict);
		await this.#audit({
			kind: "action", actor, node_id: nodeId, declared,
			policy: this.deps.policy().policy, allow: [...this.deps.policy().allow], rule,
			conclusion: verdict === undefined ? "human_override" : verdict.allowed ? "allowed" : "policy_denied",
			...(verdict === undefined ? { overridden: true } : {}),
		});
		if (verdict !== undefined && !verdict.allowed) return { ok: false, verdict, rule };
		const identity = await node.trust.inspect(nodeId);
		return { ok: true, value: identity };
	}

	/** Re-probing the whole catalog dials every recorded address, so the policy judges all of them. */
	async refresh(actor: Caller): Promise<Outcome<{ records: number }>> {
		const node = this.deps.node();
		const addresses = (await node.discovery.listRecords())
			.filter(record => record.node_id !== this.deps.nodeId)
			.map(record => record.base_url);
		const verdict = actor === "agent" ? await evaluateOutbound(this.deps.policy(), { recorded: addresses }) : undefined;
		// An empty catalog dials nothing, so `policy_unobserved` is not a refusal here; every
		// other verdict is, including `none`, which refuses the agent the sweep itself.
		const refused = verdict !== undefined && !verdict.allowed
			&& !(verdict.reason === "policy_unobserved" && addresses.length === 0);
		const rule = verdict === undefined
			? "面板动作是最后一道闸，不受获取策略限制"
			: describeVerdict(this.deps.policy(), verdict);
		await this.#audit({
			kind: "action", actor,
			policy: this.deps.policy().policy, allow: [...this.deps.policy().allow], rule,
			conclusion: verdict === undefined ? "human_override" : refused ? "policy_denied" : "allowed",
			detail: `${String(addresses.length)} 条发现记录`,
			...(verdict === undefined ? { overridden: true } : {}),
		});
		if (refused && verdict !== undefined) return { ok: false, verdict, rule };
		await node.discovery.refresh();
		return { ok: true, value: { records: addresses.length } };
	}

	/** A revocation ends local approval; it needs no policy, but it is audited either way. */
	async revoke(nodeId: string, actor: Caller): Promise<void> {
		const node = this.deps.node();
		const entry = await node.trust.entry(nodeId);
		await this.#audit({
			kind: "action", actor, node_id: nodeId, fingerprint: entry?.fingerprint, declared: entry?.base_url,
			policy: this.deps.policy().policy, allow: [...this.deps.policy().allow],
			rule: "撤销不需要策略判定",
			conclusion: actor === "human" ? "human_override" : "revoked",
			...(actor === "human" ? { overridden: true } : {}),
		});
		await node.trust.revoke(node.auth, nodeId);
		await this.deps.settle(nodeId);
	}

	/** Everything the panel renders: the policy in force, who waits, and why. */
	async panel(): Promise<Record<string, unknown>> {
		const node = this.deps.node();
		const policy = this.deps.policy();
		const observations = new Map((await this.deps.store.observations())
			.map(observation => [`${observation.node_id}\u0000${observation.fingerprint}`, observation]));
		const rows = await node.trust.list(node.auth);
		const records = await node.discovery.listRecords();
		const identity = await node.keys.describe();
		return {
			policy: policy.policy,
			allow: policy.allow,
			allow_loopback: this.deps.allowLoopback(),
			...(identity === undefined ? {} : { identity }),
			seeds: this.deps.seeds().map(seed => ({ ...seed, source: this.deps.seedSource() })),
			trust: rows.map(entry => trustRow(entry, observations.get(`${entry.node_id}\u0000${entry.fingerprint}`))),
			invited: rows.filter(entry => trustPhase(entry) === "invited").map(entry => trustRow(entry, observations.get(`${entry.node_id}\u0000${entry.fingerprint}`))),
			discovery: records.filter(record => record.node_id !== this.deps.nodeId),
			candidates: (await node.discovery.list()).items.length,
			audits: await this.deps.store.audits(50),
			limitations: [
				"反向代理后的真实来源地址看不到：观测地址是 TCP 连接的来源，不是代理链里的客户端地址。",
				"DNS 与实际连接目标可能不一致：出站只按 resolve() 返回的地址判定，不做解析。",
				"跨主机的地址判定细则未定：允许集合只按 CIDR 字面量比对，主机名一律不匹配。",
			],
		};
	}

	// ---- internals ----------------------------------------------------------------

	async #handle(event: TrustNotify): Promise<void> {
		const node = this.deps.node();
		const entry = event.entry;
		const nodeId = entry.node_id;
		// A local key swap tells the peers nothing the agent must read: the peers' own answers
		// arrive as their statements.
		if (event.cause === "rotation") return;
		const policy = this.deps.policy();
		const origin = this.deps.origin();
		const at = new Date().toISOString();
		if (origin !== undefined) {
			await this.deps.store.recordObservation({
				node_id: nodeId, fingerprint: entry.fingerprint, address: origin.address,
				...(origin.port === undefined ? {} : { port: origin.port }),
				...(entry.base_url === "" ? {} : { declared: entry.base_url }), at,
			});
			const declaredAddress = entry.base_url === "" ? undefined : literalAddress(entry.base_url);
			if (declaredAddress !== origin.address) {
				await this.#audit({
					kind: "statement", actor: "host", node_id: nodeId, fingerprint: entry.fingerprint, phase: event.phase,
					declared: entry.base_url, observed: origin.address,
					policy: policy.policy, allow: [...policy.allow],
					rule: "声明地址与观测地址不一致，按观测地址判定",
					conclusion: "observation_mismatch",
					detail: `声明 ${declaredAddress ?? entry.base_url}，观测 ${origin.address}`,
				});
			}
		}
		const stored = origin === undefined ? await this.deps.store.observation(nodeId, entry.fingerprint) : undefined;
		const observedAddress = origin?.address ?? stored?.address;
		const seeded = this.deps.seeds().some(seed => seed.node_id === nodeId && seed.fingerprint === entry.fingerprint);
		const rotationFrom = event.previous !== undefined && event.previous.fingerprint !== entry.fingerprint
			? event.previous.fingerprint
			: entry.history?.at(-1);
		const rotation = rotationFrom === undefined ? {} : { rotationFrom };

		// A decision this host already took (an agent or a human approving or revoking) is not a
		// policy judgement, and it was audited by the action that caused it.
		if (event.cause !== "peer-statement") {
			if (entry.base_url !== "" && entry.local_approved) await this.#probe(node, entry);
			await this.#deliver(entry, {
				phase: event.phase, conclusion: "status", rule: "本地动作：批准或撤销由 agent 或人类做出，策略未参与本次判定",
				observed: observedAddress, declared: entry.base_url, actionable: false, ...rotation,
			});
			return;
		}

		const recorded = await this.#recorded(nodeId);
		const verdict = await evaluateInbound(policy, { observed: observedAddress, declared: entry.base_url, recorded });
		const rule = describeVerdict(policy, verdict);

		if (event.phase === "invited") {
			if (verdict.allowed) {
				await this.#probe(node, entry);
				await this.#audit({
					kind: "statement", actor: "host", node_id: nodeId, fingerprint: entry.fingerprint, phase: event.phase,
					declared: entry.base_url, observed: observedAddress,
					policy: policy.policy, allow: [...policy.allow], rule,
					conclusion: "auto_approved", detail: "策略委派：宿主代替人类确认",
				});
				let outcome = "已提交并收到对端确认";
				this.#quiet.add(nodeId);
				try {
					await node.trust.accept(node.auth, nodeId, entry.fingerprint);
				} catch (error) {
					outcome = `提交未完成：${error instanceof Error ? error.message : String(error)}`;
				} finally {
					this.#quiet.delete(nodeId);
				}
				if (outcome !== "已提交并收到对端确认") {
					await this.#audit({
						kind: "statement", actor: "host", node_id: nodeId, fingerprint: entry.fingerprint, phase: event.phase,
						declared: entry.base_url, observed: observedAddress,
						policy: policy.policy, allow: [...policy.allow], rule,
						conclusion: "auto_approved", detail: outcome,
					});
				}
				const after = (await node.trust.entry(nodeId)) ?? entry;
				await this.#deliver(after, {
					phase: trustPhase(after), conclusion: "auto_approved", rule,
					observed: observedAddress, declared: after.base_url, actionable: false,
					...rotation, detail: outcome,
				});
				return;
			}
			await this.#audit({
				kind: "statement", actor: "host", node_id: nodeId, fingerprint: entry.fingerprint, phase: event.phase,
				declared: entry.base_url, observed: observedAddress,
				policy: policy.policy, allow: [...policy.allow], rule,
				conclusion: "policy_denied", detail: "保留原行，未发起出站请求",
			});
			await this.#deliver(entry, {
				phase: event.phase, conclusion: "policy_denied", rule,
				observed: observedAddress, declared: entry.base_url, actionable: true,
				...rotation,
			});
			return;
		}

		// A row the host already knows about. Refreshing its recorded address is what keeps
		// `resolve()` working, and it is only done for a peer this node or a human admitted.
		if (verdict.allowed || seeded || entry.local_approved) await this.#probe(node, entry);
		await this.#audit({
			kind: "statement", actor: "host", node_id: nodeId, fingerprint: entry.fingerprint, phase: event.phase,
			declared: entry.base_url, observed: observedAddress,
			policy: policy.policy, allow: [...policy.allow], rule,
			conclusion: seeded ? "seed_preauthorized" : "status",
			detail: seeded ? "已配置种子：人类预授权，不受策略约束" : `状态 ${event.phase}`,
		});
		await this.#deliver(entry, {
			phase: event.phase,
			conclusion: seeded ? "seed_preauthorized" : "status",
			rule,
			observed: observedAddress, declared: entry.base_url, actionable: false,
			...rotation,
		});
	}

	/** The declared address enters the discovery catalog only where the policy allows dialing it. */
	async #probe(node: OnlyneNode, entry: TrustEntry): Promise<void> {
		if (entry.base_url === "") return;
		await node.discovery.observe(entry.base_url, "trust-statement", entry.node_id).catch((error: unknown) => {
			this.deps.log("onlyne.acquisition.probe.failed", {
				node: entry.node_id, url: entry.base_url,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	async #recorded(nodeId: string): Promise<string[]> {
		return (await this.deps.node().discovery.listRecords())
			.filter(record => record.node_id === nodeId)
			.map(record => record.base_url);
	}

	/**
	 * RFC 0018 §3: one handshake entry, on this node's own local thread, delivered through the
	 * same channel as business messages. The identity is derived from (node_id, fingerprint,
	 * phase), so a repeated statement — or a repeated maintenance pass — finds the recorded
	 * receipt instead of appending a second entry.
	 */
	async #deliver(entry: TrustEntry, facts: DeliveryFacts): Promise<void> {
		const node = this.deps.node();
		const digest = createHash("sha256")
			.update(`${entry.node_id}\u0000${entry.fingerprint}\u0000${facts.phase}`)
			.digest("hex")
			.slice(0, 32);
		if (await this.deps.store.delivered(digest)) {
			this.deps.log("onlyne.acquisition.delivered.duplicate", {
				node: entry.node_id, fingerprint: entry.fingerprint, phase: facts.phase,
			});
			return;
		}
		const text = this.#text(entry, facts);
		const message: Message = {
			id: `trust-${digest}`,
			sender: this.deps.nodeId,
			delivery_kind: "trust",
			msg: text,
			meta: {
				thread: await this.#thread(),
				mentions: [this.deps.nodeId],
				data: {
					trust: {
						node_id: entry.node_id,
						fingerprint: entry.fingerprint,
						phase: facts.phase,
						policy: this.deps.policy().policy,
						rule: facts.rule,
						conclusion: facts.conclusion,
						actionable: facts.actionable,
						declared: facts.declared ?? entry.base_url,
						observed: facts.observed ?? null,
						rotation_from: facts.rotationFrom ?? null,
					} satisfies Record<string, Json>,
				},
			},
		};
		const plan: DeliveryPlan = { response: "none", execution: "existing", context: this.deps.contextAlias() };
		try {
			await node.messages.admit(node.auth, {
				idempotency_key: `trust/${digest}`,
				retry_until: new Date(Date.now() + 86_400_000).toISOString(),
				message,
				target_endpoint: this.deps.nodeId,
				plan,
			});
		} catch (error) {
			// A crash between admitting and marking the key leaves the recorded receipt behind;
			// the retry is the same delivery, not a failure.
			if (error instanceof OnlyneError && error.error.code === "id_conflict") {
				this.deps.log("onlyne.acquisition.delivered.duplicate", {
					node: entry.node_id, fingerprint: entry.fingerprint, phase: facts.phase, reason: "idempotency",
				});
				return;
			}
			throw error;
		}
		await this.deps.store.markDelivered(digest, {
			node_id: entry.node_id, fingerprint: entry.fingerprint, phase: facts.phase, at: new Date().toISOString(),
		});
		this.deps.log("onlyne.acquisition.delivered", {
			node: entry.node_id, fingerprint: entry.fingerprint, phase: facts.phase, conclusion: facts.conclusion,
		});
	}

	/** The local thread: this node's own, no members, nothing sent anywhere. */
	async #thread(): Promise<ThreadRef> {
		if (this.#threadRef !== undefined) return this.#threadRef;
		const node = this.deps.node();
		const ref: ThreadRef = { owner: this.deps.nodeId, id: TRUST_THREAD_ID };
		try {
			await node.threads.describe(node.auth, ref);
		} catch {
			await node.threads.create(node.auth, {
				idempotency_key: crypto.randomUUID(),
				retry_until: new Date(Date.now() + 86_400_000).toISOString(),
				title: TRUST_THREAD_TITLE,
				id: TRUST_THREAD_ID,
			});
		}
		this.#threadRef = ref;
		return ref;
	}

	/** What the agent reads: the class of entry first, then the facts, then any action. */
	#text(entry: TrustEntry, facts: DeliveryFacts): string {
		const policy = this.deps.policy();
		const head = facts.rotationFrom !== undefined
			? `Onlyne 信任握手：密钥轮换（不是首次接触，指纹由 ${facts.rotationFrom} 变为 ${entry.fingerprint}）`
			: facts.actionable
				? "Onlyne 信任握手：对端请求建立关系，等待决策（需要动作）"
				: "Onlyne 信任握手：状态更新（结果通知，不需要动作）";
		const lines = [
			head,
			`节点：${entry.node_id}`,
			`指纹：${entry.fingerprint}`,
			`声明地址：${facts.declared ?? entry.base_url}`,
			`观测来源：${facts.observed ?? "未取到（本次不是入站连接）"}`,
			`获取策略：${policy.policy}，允许集合 ${policy.allow.join(", ")}`,
			`策略判定：${facts.conclusion} —— ${facts.rule}`,
			`状态：${facts.phase}${PHASE_NOTE[facts.phase]}`,
		];
		if (facts.detail !== undefined && facts.conclusion === "auto_approved") {
			lines.push(`结果：${facts.detail}`);
		}
		if (facts.actionable) {
			if (policy.policy === "none") {
				lines.push("策略为 none：agent 不得批准，只能查看；批准留给人类面板。");
			}
			lines.push(`动作：批准调用 await(plugins["onlyne"].trust_accept("${entry.node_id}", "${entry.fingerprint}"))；`
				+ `拒绝调用 await(plugins["onlyne"].trust_revoke("${entry.node_id}"))。`);
			lines.push("不处理即保持现状；同一条陈述重复送达不会产生新条目。");
		} else {
			lines.push("本条只是状态，不需要动作。");
		}
		return lines.join("\n");
	}

	async #audit(row: {
		kind: "statement" | "action" | "seed";
		actor: AuditActor;
		node_id?: string;
		fingerprint?: string;
		phase?: TrustPhase;
		declared?: string;
		observed?: string;
		policy: string;
		allow: string[];
		rule: string;
		conclusion: string;
		detail?: string;
		overridden?: boolean;
	}): Promise<void> {
		const at = new Date().toISOString();
		await this.deps.store.audit({
			at, kind: row.kind, actor: row.actor,
			...(row.node_id === undefined ? {} : { node_id: row.node_id }),
			...(row.fingerprint === undefined ? {} : { fingerprint: row.fingerprint }),
			...(row.phase === undefined ? {} : { phase: row.phase }),
			...(row.declared === undefined ? {} : { declared: row.declared }),
			...(row.observed === undefined ? {} : { observed: row.observed }),
			policy: row.policy, allow: [...row.allow], rule: row.rule, conclusion: row.conclusion,
			...(row.detail === undefined ? {} : { detail: row.detail }),
			...(row.overridden === undefined ? {} : { overridden: row.overridden }),
		});
		this.deps.log("onlyne.acquisition.audit", {
			kind: row.kind, actor: row.actor, node: row.node_id, fingerprint: row.fingerprint,
			policy: row.policy, rule: row.rule, conclusion: row.conclusion, at,
		});
	}
}

/** One trust row as the panel and the admin API render it, with the observed address beside it. */
export function trustRow(entry: TrustEntry, observed?: Observation): Record<string, unknown> {
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
		observed: observed?.address ?? null,
		observed_at: observed?.at ?? null,
	};
}

