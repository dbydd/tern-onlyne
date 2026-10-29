import {
	OnlyneError,
	type Action,
	type DeliveryPlan,
	type Entry,
	type Json,
	type Member,
	type MessageRef,
	type MsgInput,
	type NodeId,
	type Thread,
	type ThreadRef,
} from "@onlyne/lib";
import { choice, judge, noul, type JudgeConfig, type Question } from "./systemone.ts";

export interface InboundDecision {
	action: "wake" | "fragment";
	insertion?: "steer" | "follow_up";
	/** The model's answer to whether the sender is owed a reply; the host renders it. */
	needsAnswer: boolean;
}

export interface DeciderDeps {
	nodeId: NodeId;
	judge: JudgeConfig;
	/** Verified peers from the library's discovery records. */
	listPeers(): Promise<Array<{ node_id: NodeId; base_url: string }>>;
	/** Threads this node owns. `last_activity_at` is the host's own field on the thread row. */
	listThreads(): Promise<Array<Thread & { last_activity_at?: string }>>;
	listMessages(thread: ThreadRef, cursor?: string): Promise<{ items: Entry[] }>;
	/** Whether this host could deliver a plan with that shape; what a `new` plan needs first. */
	supports(plan: DeliveryPlan): Promise<boolean>;
	/** The thread an already-ordered message lives in, read from this node's own records. */
	locate(ref: MessageRef): Promise<ThreadRef | undefined>;
	/** Members of one thread: landing needs the peer's membership, not a guess. */
	describeThread(ref: ThreadRef): Promise<{ members: Member[] } | undefined>;
	/** Contexts this node publishes for `execution: existing`; Carly is one session. */
	receiverContexts(): Promise<Array<{ alias: string; summary: string; state: string }>>;
}

const INTENTS = ["communicate", "inspect", "manage_thread", "manage_domain", "operate_resource"] as const;
const SCOPES = ["directory", "neighbors", "threads", "inbox", "messages", "message"] as const;
const THREAD_OPS = ["create", "close", "list", "describe", "member_add", "member_remove"] as const;
const DOMAIN_OPS = ["create", "join", "leave", "list", "describe", "discover"] as const;
const RESPONSES = ["none", "async", "await"] as const;
const EXECUTIONS = ["existing", "new"] as const;

/**
 * One judgment sentence per op. The bare operation name gave the judge nothing to tell
 * `join` from `list` or `describe` apart (a live run answered "帮我们加入研发域" with a
 * near-uniform distribution), so each op now says what makes IT the answer.
 */
const OP_CRITERIA: Record<string, string> = {
	create: "Start a new one of this kind: an empty thread, or a fresh domain membership record.",
	close: "End or retire a thread that already exists.",
	list: "Show the existing items without opening any of them.",
	describe: "Show the details of one item: a thread's members, or one membership record.",
	member_add: "Put a peer into an existing thread, so it reads and posts there.",
	member_remove: "Take a peer out of an existing thread.",
	join: "Enter a domain this node is not in yet; the message names or implies which domain to enter.",
	leave: "Withdraw from a domain this node belongs to.",
	discover: "Ask a domain who its members are.",
};

function record(value: unknown): Record<string, Json> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, Json> : undefined;
}

function text(source: Record<string, Json> | undefined, key: string): string | undefined {
	const value = source?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function threadRef(value: Json | undefined): ThreadRef | undefined {
	const source = record(value);
	const owner = text(source, "owner");
	const id = text(source, "id");
	return owner === undefined || id === undefined ? undefined : { owner, id };
}

function messageRef(value: Json | undefined): MessageRef | undefined {
	const source = record(value);
	const sender = text(source, "sender");
	const id = text(source, "id");
	return sender === undefined || id === undefined ? undefined : { sender, id };
}

function oneOf<T extends string>(value: Json | undefined, allowed: readonly T[], field: string): T | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	throw new OnlyneError("invalid_request", `meta.${field} must be one of ${allowed.join(", ")}.`);
}

/**
 * The outbound and inbound decision tree for Carly. Every semantic choice goes through
 * System One; explicit meta fields are honored without a call. The tree follows
 * omp-onlyne's stages (intent, target, plan, scope, thread, domain) with one host
 * difference: Carly has exactly one execution context, so inbound routing is fixed.
 */
export class CarlyDecider {
	constructor(private readonly deps: DeciderDeps) {}

	async decide(input: MsgInput): Promise<Action> {
		const action = await this.#route(input);
		if (action.kind !== "send") return action;
		const mentioned = action.mentions === undefined
			? action
			: { ...action, mentions: await this.#mentionIds(action.mentions) };
		return this.#land(mentioned);
	}

	/**
	 * One spelling for every mention, whichever route produced the action: `@all` stays as it is,
	 * and a name becomes the `@`-prefixed node id the library matches against.
	 */
	async #mentionIds(mentions: readonly string[]): Promise<string[]> {
		return Promise.all(mentions.map(async item => item === "@all"
			? "@all"
			: item.startsWith("@") ? `@${await this.#peerId(item.slice(1))}` : await this.#peerId(item)));
	}

	/** The decision tree. It never picks a thread: that is `#land`'s deterministic job. */
	async #route(input: MsgInput): Promise<Action> {
		const meta = input.meta ?? {};
		const explicit = this.#explicit(meta);
		if (explicit !== undefined) return explicit;
		const intent = await this.#intent(input);
		if (intent === "communicate") return this.#communicate(input, meta);
		if (intent === "inspect") return this.#inspect(input, meta);
		if (intent === "manage_thread") return this.#thread(input, meta);
		if (intent === "manage_domain") return this.#domain(input, meta);
		const resource = record(meta.resource);
		const operation = text(meta, "operation");
		if (resource === undefined || operation === undefined) {
			throw new OnlyneError("invalid_request", "A resource action needs meta.resource and meta.operation.");
		}
		const owner = text(resource, "owner");
		const id = text(resource, "id");
		if (owner === undefined || id === undefined) throw new OnlyneError("invalid_request", "meta.resource needs owner and id.");
		return { kind: "resource", resource: { owner, id }, operation, ...(meta.data === undefined ? {} : { data: meta.data }) };
	}

	/**
	 * RFC 0016 §5: where a message lands is a fact this node's own records already answer, so it
	 * is resolved here instead of asked. An explicit `meta.thread` wins; a reply lands in the
	 * thread of the message it answers; anything else continues the most recently created open
	 * thread that already holds the peer. `execution: new` is the only request for a new thread —
	 * without it a send must not open one thread per message.
	 */
	async #land(action: Extract<Action, { kind: "send" }>): Promise<Action> {
		if (action.thread !== undefined) return action;
		if (action.execution === "new") {
			// The thread would be opened before the delivery is attempted, so a plan this host
			// must refuse would leave an empty conversation nobody joined. Ask first.
			if (!(await this.deps.supports({ response: action.response, execution: action.execution }))) {
				throw new OnlyneError("unsupported_delivery", "This host cannot deliver a `new` execution context, so it opened no thread.");
			}
			return action;
		}
		if (action.in_reply_to !== undefined) {
			const located = await this.deps.locate(action.in_reply_to);
			if (located !== undefined) return { ...action, thread: located };
		}
		const recent = await this.#recentThreadWith(action.to);
		return recent === undefined ? action : { ...action, thread: recent };
	}

	/**
	 * The most recently active open thread this node owns whose active members already include
	 * `peer`. A row written before `last_activity_at` existed falls back to its creation time.
	 */
	async #recentThreadWith(peer: NodeId): Promise<ThreadRef | undefined> {
		const candidates = (await this.deps.listThreads())
			.filter(thread => thread.state === "open" && thread.thread_ref.owner === this.deps.nodeId)
			.sort((left, right) => (right.last_activity_at ?? right.created_at).localeCompare(left.last_activity_at ?? left.created_at)
				|| right.thread_ref.id.localeCompare(left.thread_ref.id));
		for (const thread of candidates) {
			const described = await this.deps.describeThread(thread.thread_ref);
			if (described?.members.some(member => member.peer === peer && member.state === "active") === true) {
				return thread.thread_ref;
			}
		}
		return undefined;
	}

	/** Stable meta fields route without a judgment; everything semantic asks the model. */
	#explicit(meta: Record<string, Json>): Action | undefined {
		const op = text(meta, "op");
		if (meta.to !== undefined) {
			const to = text(meta, "to");
			if (to === undefined) throw new OnlyneError("invalid_request", "meta.to must be a node id.");
			const response = oneOf(meta.response, RESPONSES, "response");
			const execution = oneOf(meta.execution, EXECUTIONS, "execution");
			return {
				kind: "send", to,
				...(threadRef(meta.thread) === undefined ? {} : { thread: threadRef(meta.thread) }),
				...(messageRef(meta.in_reply_to) === undefined ? {} : { in_reply_to: messageRef(meta.in_reply_to) }),
				...(oneOf(meta.relation, ["reply", "followup"] as const, "relation") === undefined ? {} : { relation: oneOf(meta.relation, ["reply", "followup"] as const, "relation") }),
				...(Array.isArray(meta.mentions) ? { mentions: meta.mentions.filter((value): value is string => typeof value === "string") } : {}),
				response: response ?? "async", execution: execution ?? "existing",
			};
		}
		if (op !== undefined && (THREAD_OPS as readonly string[]).includes(op)) {
			return { kind: "thread", op: op as Action extends { kind: "thread"; op: infer O } ? O : never,
				...(threadRef(meta.thread) === undefined ? {} : { thread: threadRef(meta.thread) }),
				...(text(meta, "title") === undefined ? {} : { title: text(meta, "title") }),
				...(text(meta, "member") === undefined ? {} : { to: text(meta, "member") }) };
		}
		if (op !== undefined && (DOMAIN_OPS as readonly string[]).includes(op)) {
			return { kind: "domain", op: op as "create" | "join" | "leave" | "list" | "describe" | "discover",
				...(text(meta, "domain_id") === undefined ? {} : { domain_id: text(meta, "domain_id") }) };
		}
		return undefined;
	}

	async #intent(input: MsgInput): Promise<(typeof INTENTS)[number]> {
		const answers = await judge(this.deps.judge,
			{ focus: { delivery_kind: input.delivery_kind, msg: input.msg, meta: input.meta ?? null } },
			{
				intent: {
					type: "choice",
					instructions: "Choose the one action this message asks for. communicate: deliver a message, reply or progress note to another agent. inspect: look up local or network state. manage_thread: create, close, describe or change members of a thread. manage_domain: manage this node's domain membership. operate_resource: operate a resource the message names explicitly.",
					criteria: {
						communicate: "The message is meant for another agent or node: delivering, replying, asking, reporting, or starting a new task or topic with one.",
						inspect: "The message asks to see node-level state: who is online, the inbox, a thread's messages, one message, or delivery evidence.",
						manage_thread: "The message operates on thread records themselves: list, describe, create, close, add or remove a member. Starting a new task or conversation with a peer is communicate, not this.",
						manage_domain: "The message changes or reads this node's domain membership.",
						operate_resource: "meta.resource names an external resource to operate.",
					},
				},
			});
		const intent = choice(answers, "intent", INTENTS);
		if (intent === undefined) throw new OnlyneError("decision_unavailable", "The decision did not choose an outbound intent.");
		return intent;
	}

	async #communicate(input: MsgInput, meta: Record<string, Json>): Promise<Action> {
		const reply = await this.#replyRef(meta);
		const relation = oneOf(meta.relation, ["reply", "followup"] as const, "relation") ?? (reply === undefined ? undefined : "reply");
		if (relation !== undefined && reply === undefined) throw new OnlyneError("invalid_request", "A relation needs meta.in_reply_to.");
		const to = await this.#target(input, meta, reply);
		const thread = await this.#sendThread(meta, to);
		const response = oneOf(meta.response, RESPONSES, "response");
		const execution = oneOf(meta.execution, EXECUTIONS, "execution");
		const plan = response !== undefined && execution !== undefined
			? { response, execution }
			: await this.#plan(input, relation !== undefined);
		return {
			kind: "send", to,
			...(thread === undefined ? {} : { thread }),
			...(reply === undefined ? {} : { in_reply_to: reply }),
			...(relation === undefined ? {} : { relation }),
			response: plan.response, execution: plan.execution,
		};
	}

	/**
	 * The reply reference with its sender normalized: `carly` and the full urn name one node,
	 * and the ref travels with the resolved id so the peer's own records match it. A sender no
	 * known source can resolve stays as written — a reply to an original this node cannot see
	 * goes through the reply authority, and the receiver resolves the landing from its record.
	 */
	async #replyRef(meta: Record<string, Json>): Promise<MessageRef | undefined> {
		const ref = messageRef(meta.in_reply_to);
		if (ref === undefined) return undefined;
		return { ...ref, sender: await this.#peerId(ref.sender).catch(() => ref.sender) };
	}

	/**
	 * Resolve a spelled target to a node id against the same set every lookup answers from:
	 * this node, each peer trust keeps, and each peer discovery reports. Identity outlives a
	 * discovery record; whether the address works is the transport's `unavailable`, never a
	 * reason to claim no such node exists.
	 */
	async #peerId(alias: string): Promise<NodeId> {
		const ids = [this.deps.nodeId, ...(await this.deps.listPeers()).map(peer => peer.node_id)];
		if (alias === "self") return this.deps.nodeId;
		const unique = [...new Set(ids)];
		if (unique.includes(alias)) return alias;
		const matches = unique.filter(id => id.slice(id.lastIndexOf(":") + 1) === alias);
		if (matches.length === 1) return matches[0]!;
		if (matches.length > 1) throw new OnlyneError("ambiguous_target", `${alias} names more than one known node: ${matches.join(", ")}.`);
		throw new OnlyneError("not_found", `No known node is named ${alias}. Known: ${unique.join(", ")}.`);
	}

	async #target(input: MsgInput, meta: Record<string, Json>, reply: MessageRef | undefined): Promise<NodeId> {
		if (reply !== undefined) return reply.sender;
		const explicit = text(meta, "to");
		if (explicit !== undefined) return this.#peerId(explicit);
		const peers = await this.deps.listPeers();
		if (peers.length === 0) throw new OnlyneError("not_found", "No peer is known yet; discover or add one first.");
		if (peers.length === 1) return peers[0]!.node_id;
		const answers = await judge(this.deps.judge,
			{ focus: { delivery_kind: input.delivery_kind, msg: input.msg, meta: meta }, peers: peers.map(peer => ({ node_id: peer.node_id, base_url: peer.base_url })) },
			{
				target: {
					type: "choice",
					instructions: "Choose the peer this message addresses.",
					criteria: Object.fromEntries(peers.map(peer => [peer.node_id, peer.base_url])),
				},
			});
		const chosen = choice(answers, "target", peers.map(peer => peer.node_id));
		if (chosen === undefined) throw new OnlyneError("decision_unavailable", "The decision did not choose a target.");
		return chosen;
	}

	async #sendThread(meta: Record<string, Json>, to: NodeId): Promise<ThreadRef | undefined> {
		const value = meta.thread;
		if (value === undefined) return undefined;
		const ref = threadRef(value);
		if (ref !== undefined) return ref;
		if (typeof value !== "string" || value.length === 0) throw new OnlyneError("invalid_request", "meta.thread must be a thread id, alias or {owner,id}.");
		const threads = await this.deps.listThreads();
		const matches = threads.filter(thread => thread.thread_ref.id === value || thread.title === value);
		if (matches.length > 1) throw new OnlyneError("ambiguous_target", `More than one local thread is named ${value}.`);
		if (matches.length === 1) return matches[0]!.thread_ref;
		// One slash grammar: the owner is the part before the LAST slash, safe for urn owners.
		const slash = value.lastIndexOf("/");
		if (slash > 0 && slash < value.length - 1) return { owner: value.slice(0, slash), id: value.slice(slash + 1) };
		return { owner: to, id: value };
	}

	async #plan(input: MsgInput, isReply: boolean): Promise<{ response: "none" | "async" | "await"; execution: "existing" | "new" }> {
		const questions: Record<string, Question> = {
			response: {
				type: "choice",
				instructions: "Two facts decide: does the receiver have to act, and can the sender continue without the answer?",
				criteria: {
					none: "The receiver need not act at all: a notice, a status update, '不用回'.",
					async: "The receiver must act, but the sender keeps working and picks the answer up later.",
					await: "The receiver must act and the sender's next step cannot start without the answer.",
				},
			},
			execution: {
				type: "choice",
				instructions: "Should the receiver handle this in an existing execution context or in a new one?",
				criteria: {
					existing: isReply ? "The message continues work the receiver already knows." : "The message belongs to work already running.",
					new: "The message starts independent work.",
				},
			},
		};
		const answers = await judge(this.deps.judge,
			{ focus: { delivery_kind: input.delivery_kind, msg: input.msg, meta: input.meta ?? null }, relation: isReply ? "reply" : "new" },
			questions);
		const response = choice(answers, "response", RESPONSES);
		const execution = choice(answers, "execution", EXECUTIONS);
		if (response === undefined || execution === undefined) {
			throw new OnlyneError("decision_unavailable", "The decision did not choose a delivery plan.");
		}
		return { response, execution };
	}

	async #inspect(input: MsgInput, meta: Record<string, Json>): Promise<Action> {
		const explicit = oneOf(meta.scope, SCOPES, "scope");
		const scope = explicit ?? await this.#scope(input);
		const thread = threadRef(meta.thread);
		const message = messageRef(meta.message);
		return {
			kind: "read", scope,
			...(thread === undefined ? {} : { thread }),
			...(message === undefined ? {} : { message }),
			...(text(meta, "seq") === undefined ? {} : { seq: text(meta, "seq") }),
			...(text(meta, "cursor") === undefined ? {} : { cursor: text(meta, "cursor") }),
			...(typeof meta.page_size === "number" ? { page_size: meta.page_size } : {}),
			...(meta.attention === "inbox" || meta.attention === "thread" ? { attention: meta.attention } : {}),
		};
	}

	async #scope(input: MsgInput): Promise<(typeof SCOPES)[number]> {
		const answers = await judge(this.deps.judge,
			{ focus: { delivery_kind: input.delivery_kind, msg: input.msg, meta: input.meta ?? null } },
			{
				scope: {
					type: "choice",
					instructions: "Choose what to read.",
					criteria: {
						directory: "The discovery directory of known peers.",
						neighbors: "Known nodes with their trust state.",
						threads: "The local thread registry.",
						inbox: "Unconsumed inbound messages.",
						messages: "The messages of one thread.",
						message: "One message.",
					},
				},
			});
		const scope = choice(answers, "scope", SCOPES);
		if (scope === undefined) throw new OnlyneError("decision_unavailable", "The decision did not choose a read scope.");
		return scope;
	}

	async #thread(input: MsgInput, meta: Record<string, Json>): Promise<Action> {
		const op = oneOf(meta.op, THREAD_OPS, "op") ?? await this.#op("thread", THREAD_OPS, input);
		const thread = threadRef(meta.thread);
		const member = text(meta, "member");
		const title = text(meta, "title");
		if ((op === "member_add" || op === "member_remove") && member === undefined) {
			throw new OnlyneError("invalid_request", `A thread ${op} needs meta.member.`);
		}
		if (op === "create" && title === undefined) throw new OnlyneError("invalid_request", "A thread create needs meta.title.");
		return { kind: "thread", op,
			...(thread === undefined ? {} : { thread }),
			...(member === undefined ? {} : { to: member }),
			...(title === undefined ? {} : { title }) };
	}

	async #domain(input: MsgInput, meta: Record<string, Json>): Promise<Action> {
		const op = oneOf(meta.op, DOMAIN_OPS, "op") ?? await this.#op("domain", DOMAIN_OPS, input);
		const domain = text(meta, "domain_id");
		if (op !== "create" && op !== "list" && domain === undefined) throw new OnlyneError("invalid_request", `A domain ${op} needs meta.domain_id.`);
		return { kind: "domain", op, ...(domain === undefined ? {} : { domain_id: domain }) };
	}

	async #op<T extends string>(kind: "thread" | "domain", allowed: readonly T[], input: MsgInput): Promise<T> {
		const answers = await judge(this.deps.judge,
			{ focus: { kind, delivery_kind: input.delivery_kind, msg: input.msg, meta: input.meta ?? null } },
			{
				op: {
					type: "choice",
					instructions: `Choose the ${kind} operation this message asks for.`,
					criteria: Object.fromEntries(allowed.map(value => [value, OP_CRITERIA[value] ?? value])),
				},
			});
		const op = choice(answers, "op", allowed);
		if (op === undefined) throw new OnlyneError("decision_unavailable", `The decision did not choose a ${kind} operation.`);
		return op;
	}

	/**
	 * Carly has one execution context. The question is only whether the message owes an
	 * answer; the insertion mode is a follow-up either way so a running turn keeps going.
	 */
	async decideInbound(entry: Entry, _plan?: DeliveryPlan): Promise<InboundDecision> {
		if (_plan?.response === "none") {
			return { action: "wake", insertion: "follow_up", needsAnswer: false };
		}
		const answers = await judge(this.deps.judge,
			{
				focus: {
					node: this.deps.nodeId,
					incoming: {
						sender: entry.authenticated_author,
						delivery_kind: entry.message.delivery_kind,
						msg: entry.message.msg,
						relation: entry.message.meta?.relation ?? null,
					},
				},
			},
			{
				needs_answer: {
					type: "noul",
					instructions: "Does this message need a response from this node to be complete? A question, a request or work whose result must be reported back, a decision owed to the sender, or an instruction or correction this node must act on needs one. A notice, greeting, status update or relay does not.",
					criteria: { true: "The sender is waiting for information or a decision, or expects this node to act on an instruction and follow through.", false: "Nothing is owed back." },
				},
			});
		const needsAnswer = noul(answers, "needs_answer");
		if (needsAnswer === undefined) throw new OnlyneError("decision_unavailable", "The decision did not answer the reply obligation.");
		return { action: "wake", insertion: "follow_up", needsAnswer };
	}
}
