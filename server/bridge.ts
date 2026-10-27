import {
	type DeliveryPlan,
	type Entry,
	type Message,
	type NotifyEvent,
	type Runtime,
	type TraceEvent,
} from "@onlyne/lib";
import type { CarlyDecider } from "./decider.ts";

export interface PendingInbound {
	token: string;
	thread: { owner: string; id: string };
	seq: string;
	sender: string;
	/** The entry's own message id, so a reply can name what it answers. */
	message_id: string;
	text: string;
	at: string;
	/** The delivery plan the sender chose; rendered to Carly, never dropped. */
	plan?: { response: string; execution: string; context?: string };
	/** The addressees the message named explicitly; empty means it reached this node directly. */
	targets: string[];
	relation?: string;
	/** The inbound judgment: does the sender wait for an answer? */
	needs_answer?: boolean;
}

export interface BridgeDeps {
	decider: CarlyDecider;
	/** Confirm consumption once Carly has provably read the entry (she answered it). */
	confirm(entry: Entry, context: string): Promise<void>;
	observe?(url: string, source: string, expectedNode?: string): Promise<void>;
	log(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Runtime for Carly's single session. Submission is `cx:ask_carly`: it opens a turn but
 * carries no receipt, so injection never claims consumption. The plugin collects pending
 * entries, asks Carly, and either reports the token back after a reply proves she read it
 * or leaves the entry owed.
 */
export class CarlyBridge implements Runtime {
	readonly #pending = new Map<string, { entry: Entry; item: PendingInbound }>();
	readonly #byRef = new Map<string, Entry>();
	/** Tokens already settled, so a repeated consumed() says why instead of looking like a failure. */
	readonly #settled = new Map<string, "reply" | "token">();

	constructor(private readonly deps: BridgeDeps) {}

	supports(plan: DeliveryPlan): Promise<boolean> {
		return Promise.resolve(plan.response !== "await" && plan.execution !== "new");
	}

	trace(event: TraceEvent): void {
		const fields = { ...event } as Record<string, unknown>;
		const name = String(fields.event);
		delete fields.event;
		this.deps.log(`onlyne.${name}`, fields);
	}

	async inject(entry: Entry, _context?: string, plan?: DeliveryPlan): Promise<{ context: string; consumed: boolean; outcome: "queued" }> {
		const key = `${entry.thread_ref.owner}/${entry.thread_ref.id}/${entry.seq}`;
		let item: PendingInbound;
		const existing = this.#pending.get(key);
		if (existing !== undefined) {
			item = existing.item;
		} else {
			let needsAnswer: boolean | undefined;
			try {
				needsAnswer = (await this.deps.decider.decideInbound(entry, plan)).needsAnswer;
			} catch (error) {
				this.deps.log("onlyne.delivery.failed", {
					entry: key,
					error: error instanceof Error ? error.message : String(error),
				});
				throw error;
			}
			item = {
				token: `onlyne-${crypto.randomUUID()}`,
				thread: entry.thread_ref,
				seq: entry.seq,
				sender: entry.authenticated_author,
				message_id: entry.message.id,
				text: entry.message.msg,
				at: entry.at,
				...(plan === undefined ? {} : {
					plan: {
						response: plan.response,
						execution: plan.execution,
						...(plan.context === undefined ? {} : { context: plan.context }),
					},
				}),
				targets: (entry.message.meta?.mentions ?? []).filter((value): value is string => typeof value === "string"),
				...(entry.message.meta?.relation === undefined ? {} : { relation: entry.message.meta.relation }),
				...(needsAnswer === undefined ? {} : { needs_answer: needsAnswer }),
			};
			this.#pending.set(key, { entry, item });
			this.#byRef.set(`${entry.message.sender}/${entry.message.id}`, entry);
			this.deps.log("onlyne.delivery.queued", { entry: key, sender: item.sender });
		}
		const consumed = plan?.response === "none" || item.needs_answer === false;
		return { context: "carly", consumed, outcome: "queued" };
	}

	notify(event: NotifyEvent): void {
		if (event.event === "trust") {
			this.deps.log("onlyne.notify", {
				event: "trust", cause: event.cause, phase: event.phase,
				node: event.entry.node_id, fingerprint: event.entry.fingerprint,
			});
			if (event.entry.base_url) {
				void this.deps.observe?.(event.entry.base_url, "trust-statement", event.entry.node_id);
			}
			return;
		}
		if (event.event === "inbound") {
			this.deps.log("onlyne.notify", { event: "inbound", sender: event.sender, thread: event.thread, seq: event.seq });
			return;
		}
		this.deps.log("onlyne.notify", { event: "work-pending", pending: event.pending });
	}

	/** Entries waiting for Carly, oldest first. */
	pending(): PendingInbound[] {
		return [...this.#pending.values()].map(value => value.item);
	}

	/**
	 * The plugin observed Carly answer this entry: record the consumption honestly.
	 * `false` is not a failure: `already_consumed` means the reply's in_reply_to settled it
	 * first, and `unknown_token` means this companion never issued that token.
	 */
	async consumed(token: string): Promise<{ consumed: boolean; reason: "confirmed" | "already_consumed" | "unknown_token" }> {
		for (const [key, value] of this.#pending) {
			if (value.item.token !== token) continue;
			this.#pending.delete(key);
			this.#settle(token, "token");
			await this.deps.confirm(value.entry, "carly");
			return { consumed: true, reason: "confirmed" };
		}
		if (this.#settled.has(token)) return { consumed: false, reason: "already_consumed" };
		return { consumed: false, reason: "unknown_token" };
	}

	#settle(token: string, via: "reply" | "token"): void {
		this.#settled.set(token, via);
		while (this.#settled.size > 1000) {
			const oldest = this.#settled.keys().next().value;
			if (oldest === undefined) break;
			this.#settled.delete(oldest);
		}
	}

	/**
	 * A reply proves Carly read the message it answers. That is the only receipt this
	 * host can observe, so it is the only place a delivery becomes consumed.
	 */
	async observeOutbound(input: { meta?: Record<string, unknown> }): Promise<void> {
		const reply = input.meta?.in_reply_to;
		if (reply === null || typeof reply !== "object") return;
		const sender = (reply as { sender?: unknown }).sender;
		const id = (reply as { id?: unknown }).id;
		if (typeof sender !== "string" || typeof id !== "string") return;
		const entry = this.#byRef.get(`${sender}/${id}`);
		if (entry === undefined) return;
		const key = `${entry.thread_ref.owner}/${entry.thread_ref.id}/${entry.seq}`;
		const value = this.#pending.get(key);
		if (value === undefined) return;
		this.#pending.delete(key);
		this.#settle(value.item.token, "reply");
		await this.deps.confirm(entry, "carly");
	}

	/** The entry a message answers, for callers that want to report it. */
	entryForReply(input: Message): Entry | undefined {
		const reply = input.meta?.in_reply_to;
		return reply === undefined ? undefined : this.#byRef.get(`${reply.sender}/${reply.id}`);
	}
}
