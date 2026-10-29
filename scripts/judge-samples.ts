#!/usr/bin/env bun
// judge-samples.ts — run the real System One judge over a sample set for CarlyDecider
// and record how each surface answers, for prompt tuning. Read-only with respect to
// the repo: nothing here mutates the decider, the library or the SystemOne service.
//
// Usage (from external-integrations/tern-onlyne):
//   bun scripts/judge-samples.ts
//
// The decider reaches the model through server/systemone.ts judge(); there is no stub.
// The script imports CarlyDecider, feeds it synthetic but realistic DeciderDeps, and
// drives the same entry points the host drives: decide() for outbound surfaces and
// decideInbound() for inbound. Wire traffic on the judge endpoint is captured through
// a fetch wrapper, which also retries one time on network failure or 5xx/429.
//
// Scenario expectations are derived from the decider's own question texts. A scenario
// whose answer cannot be derived from its input is `record-only`: the answer is logged,
// never judged, and a throw inside one is part of the observation rather than an error.
// Mismatches are recorded verbatim — this is tuning data, not a patch list. The exit code
// is 0 even with mismatches; only an unreachable endpoint exits 1.

import { mkdirSync, writeFileSync } from "node:fs";
import { CarlyDecider, type DeciderDeps, type InboundDecision } from "../server/decider.ts";
import { judge, type JudgeConfig } from "../server/systemone.ts";
import type { Action, DeliveryPlan, Entry, Member, MessageRef, MsgInput, NodeId, Thread, ThreadRef } from "@onlyne/lib";

const JUDGE: JudgeConfig = {
	endpoint: "http://127.0.0.1:3425/v1/systemone",
	model: "group/decider",
	timeout_ms: 30_000,
};

const RESULTS_PATH = "/tmp/judge-samples/tern-results.json";

// ---------------------------------------------------------------------------
// Synthetic host data: one Carly node, three verified peers, two owned threads.
// ---------------------------------------------------------------------------

const SELF: NodeId = "urn:onlyne:agent:carly";

const PEERS = [
	{ node_id: "urn:onlyne:agent:bob" as NodeId, base_url: "http://127.0.0.1:4001/onlyne/v3" },
	{ node_id: "urn:onlyne:agent:carol" as NodeId, base_url: "http://127.0.0.1:4002/onlyne/v3" },
	{ node_id: "urn:onlyne:agent:dave" as NodeId, base_url: "http://127.0.0.1:4003/onlyne/v3" },
];

const PEER_ID = Object.fromEntries(PEERS.map(peer => [peer.node_id.slice(peer.node_id.lastIndexOf(":") + 1), peer.node_id])) as Record<"bob" | "carol" | "dave", NodeId>;

function member(peer: NodeId): Member {
	return { peer, state: "active", access: ["read", "post"], read_scope: {}, revision: "4" };
}

const THREADS: Array<Thread & { last_activity_at?: string }> = [
	{
		thread_ref: { owner: SELF, id: "migration" },
		title: "数据库迁移",
		state: "open", next_seq: "12", event_seq: "12",
		created_at: "2026-10-20T09:00:00.000Z", closed_at: null,
		last_activity_at: "2026-10-28T02:40:00.000Z",
	},
	{
		thread_ref: { owner: SELF, id: "deploy-review" },
		title: "部署复盘",
		state: "open", next_seq: "7", event_seq: "7",
		created_at: "2026-10-24T11:00:00.000Z", closed_at: null,
		last_activity_at: "2026-10-27T18:15:00.000Z",
	},
];

const THREAD_MEMBERS = new Map<string, Member[]>([
	["migration", [member(PEER_ID.bob), member(PEER_ID.carol)]],
	["deploy-review", [member(PEER_ID.bob), member(PEER_ID.dave)]],
]);

/** One entry already in the migration thread, so a reply reference can locate. */
const KNOWN_MESSAGE = "m-migration-11";

const deps: DeciderDeps = {
	nodeId: SELF,
	judge: JUDGE,
	listPeers: async () => PEERS,
	listThreads: async () => THREADS,
	listMessages: async (thread: ThreadRef) => ({
		items: [{
			thread_ref: thread,
			seq: "11",
			message: { id: KNOWN_MESSAGE, sender: PEER_ID.bob, delivery_kind: "等你看完给我结论", msg: "回滚脚本演练的结果如何?" },
			authenticated_author: PEER_ID.bob,
			reply_authority: PEER_ID.bob,
			at: "2026-10-28T02:30:00.000Z",
		}],
	}),
	// Test double: the real CarlyBridge refuses `await` and `new`. That refusal is
	// deterministic host policy, not a judge fact, and the plan surface exists to
	// observe the judge's choice — so this host pretends to support every plan.
	supports: async () => true,
	locate: async (ref: MessageRef) => (ref.id === KNOWN_MESSAGE ? { owner: SELF, id: "migration" } : undefined),
	describeThread: async (ref: ThreadRef) => {
		const members = THREAD_MEMBERS.get(ref.id);
		return members === undefined ? undefined : { members };
	},
	receiverContexts: async () => [{ alias: "carly", summary: "Carly's Tern conversation", state: "idle" }],
};

const decider = new CarlyDecider(deps);

function inboundEntry(sender: NodeId, deliveryKind: string, msg: string): Entry {
	return {
		thread_ref: { owner: SELF, id: "migration" },
		seq: "13",
		message: { id: `m-inbound-${crypto.randomUUID().slice(0, 8)}`, sender, delivery_kind: deliveryKind, msg },
		authenticated_author: sender,
		reply_authority: sender,
		at: new Date().toISOString(),
	};
}

// ---------------------------------------------------------------------------
// Wire capture and one-time retry, via a fetch wrapper around the judge endpoint.
// ---------------------------------------------------------------------------

interface Attempt {
	error?: string;
	status?: number;
	ms: number;
}

interface CapturedCall {
	request: unknown;
	answers?: unknown;
	attempts: Attempt[];
	ms: number;
}

let current: CapturedCall[] | undefined;

const realFetch: typeof fetch = globalThis.fetch;
const judgeFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	if (url !== JUDGE.endpoint || init?.method !== "POST" || typeof init.body !== "string") {
		return realFetch(input, init);
	}
	const started = performance.now();
	const captured: CapturedCall = { request: JSON.parse(init.body) as unknown, attempts: [], ms: 0 };
	current?.push(captured);
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		const t0 = performance.now();
		try {
			const response = await realFetch(input, init);
			captured.attempts.push({ status: response.status, ms: Math.round(performance.now() - t0) });
			// A live answer is final; transport failures and refused capacity retry once.
			if (response.status < 500 && response.status !== 429) {
				captured.ms = Math.round(performance.now() - started);
				try {
					captured.answers = (await response.clone().json() as { answers?: unknown }).answers;
				} catch {
					// The body stays unparsed; the caller reports its own error.
				}
				return response;
			}
			lastError = new Error(`HTTP ${String(response.status)}`);
		} catch (error) {
			captured.attempts.push({ error: error instanceof Error ? error.message : String(error), ms: Math.round(performance.now() - t0) });
			lastError = error;
		}
		if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 800));
	}
	captured.ms = Math.round(performance.now() - started);
	throw lastError;
};
(globalThis as { fetch: typeof fetch }).fetch = judgeFetch as typeof fetch;

// ---------------------------------------------------------------------------
// Scenario runner.
// ---------------------------------------------------------------------------

type Outcome = Action | InboundDecision;

interface Scenario {
	surface: string;
	name: string;
	input: Record<string, unknown>;
	/** Flat field expectations on the outcome; null marks a record-only sample. */
	expect: Record<string, unknown> | null;
	run: () => Promise<Outcome>;
}

interface Mismatch {
	field: string;
	expected: unknown;
	actual: unknown;
}

interface Row {
	surface: string;
	name: string;
	input: Record<string, unknown>;
	expect: Record<string, unknown> | null;
	outcome: unknown;
	answers: CapturedCall[];
	status: "pass" | "mismatch" | "record-only" | "error";
	mismatches?: Mismatch[];
	error?: string;
	ms: number;
}

function mismatchesOf(outcome: unknown, expect: Record<string, unknown>): Mismatch[] {
	const actual = outcome as Record<string, unknown>;
	const found: Mismatch[] = [];
	for (const [field, expected] of Object.entries(expect)) {
		if (JSON.stringify(actual[field]) !== JSON.stringify(expected)) {
			found.push({ field, expected, actual: actual[field] });
		}
	}
	return found;
}

async function runScenario(scenario: Scenario): Promise<Row> {
	const calls: CapturedCall[] = [];
	current = calls;
	const t0 = performance.now();
	let outcome: Outcome | undefined;
	let error: string | undefined;
	try {
		outcome = await scenario.run();
	} catch (caught) {
		error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
	}
	current = undefined;
	const ms = Math.round(performance.now() - t0);
	const base = { surface: scenario.surface, name: scenario.name, input: scenario.input, expect: scenario.expect, outcome, answers: calls, ms };
	if (scenario.expect === null) return { ...base, status: "record-only", ...(error === undefined ? {} : { error }) };
	if (error !== undefined) return { ...base, status: "error", error };
	const mismatches = mismatchesOf(outcome, scenario.expect);
	return mismatches.length === 0 ? { ...base, status: "pass" } : { ...base, status: "mismatch", mismatches };
}

// ---------------------------------------------------------------------------
// The sample set, in surface order.
// ---------------------------------------------------------------------------

function send(input: MsgInput): () => Promise<Outcome> {
	return () => decider.decide(input);
}

function receive(sender: NodeId, deliveryKind: string, msg: string): () => Promise<Outcome> {
	// The bridge passes the sender's plan through; a sender that named no plan leaves
	// it undefined, and the judged question is the same either way.
	return () => decider.decideInbound(inboundEntry(sender, deliveryKind, msg));
}

const SCENARIOS: Scenario[] = [
	// --- intent: five intents, one unambiguous input each ---------------------
	{
		surface: "intent", name: "communicate",
		input: { delivery_kind: "进度同步", msg: "把这条进度同步给 bob:第三批表已经迁完了,回滚脚本也备好了。" },
		expect: { kind: "send" },
		run: send({ delivery_kind: "进度同步", msg: "把这条进度同步给 bob:第三批表已经迁完了,回滚脚本也备好了。" }),
	},
	{
		surface: "intent", name: "inspect",
		input: { delivery_kind: "本地查询", msg: "看看我收件箱里有什么新东西。" },
		expect: { kind: "read" },
		run: send({ delivery_kind: "本地查询", msg: "看看我收件箱里有什么新东西。" }),
	},
	{
		surface: "intent", name: "manage_thread",
		input: { delivery_kind: "线程操作", msg: "把 bob 拉进部署复盘那个线程。", meta: { member: PEER_ID.bob } },
		expect: { kind: "thread" },
		run: send({ delivery_kind: "线程操作", msg: "把 bob 拉进部署复盘那个线程。", meta: { member: PEER_ID.bob } }),
	},
	{
		surface: "intent", name: "manage_domain",
		input: { delivery_kind: "域操作", msg: "我们退出市场部那个域吧。", meta: { domain_id: "urn:onlyne:domain:marketing" } },
		expect: { kind: "domain" },
		run: send({ delivery_kind: "域操作", msg: "我们退出市场部那个域吧。", meta: { domain_id: "urn:onlyne:domain:marketing" } }),
	},
	{
		surface: "intent", name: "operate_resource",
		input: {
			delivery_kind: "资源操作",
			msg: "对 dave 的搜索索引执行一次重建,把新闻全文都重新切一遍。",
			meta: { resource: { owner: PEER_ID.dave, id: "search-index" }, operation: "rebuild" },
		},
		expect: { kind: "resource" },
		run: send({
			delivery_kind: "资源操作",
			msg: "对 dave 的搜索索引执行一次重建,把新闻全文都重新切一遍。",
			meta: { resource: { owner: PEER_ID.dave, id: "search-index" }, operation: "rebuild" },
		}),
	},

	// --- target: a named peer resolves; an unnamed send is observed only ------
	{
		surface: "target", name: "named-peer",
		input: { delivery_kind: "帮我问个事", msg: "carol 那边的模型评测跑完了吗?帮我问问她。" },
		expect: { kind: "send", to: PEER_ID.carol },
		run: send({ delivery_kind: "帮我问个事", msg: "carol 那边的模型评测跑完了吗?帮我问问她。" }),
	},
	{
		surface: "target", name: "unnamed-peer",
		input: { delivery_kind: "群发小结", msg: "把这个月的工作小结发出去吧。" },
		// No peer is named, so no expectation is derivable from the text.
		expect: null,
		run: send({ delivery_kind: "群发小结", msg: "把这个月的工作小结发出去吧。" }),
	},

	// --- plan: response tiers and execution choices ---------------------------
	// No meta.to here: #explicit would short-circuit and #plan would never run.
	{
		surface: "plan", name: "response-none",
		input: { delivery_kind: "进度通报", msg: "版本 2.3 已经全量上线,错误率回到正常水位,一切正常,不用回复。" },
		expect: { response: "none" },
		run: send({ delivery_kind: "进度通报", msg: "版本 2.3 已经全量上线,错误率回到正常水位,一切正常,不用回复。" }),
	},
	{
		surface: "plan", name: "response-async",
		input: { delivery_kind: "帮我查个数据", msg: "查一下生产库当前的连接数发我,我先把手头的报表做完,晚点再看你的结果。" },
		expect: { response: "async" },
		run: send({ delivery_kind: "帮我查个数据", msg: "查一下生产库当前的连接数发我,我先把手头的报表做完,晚点再看你的结果。" }),
	},
	{
		surface: "plan", name: "response-await",
		input: { delivery_kind: "等你的结论再继续", msg: "确认一下生产库昨晚的备份是否成功,我必须拿到这个结论才能开始今晚的升级。" },
		expect: { response: "await" },
		run: send({ delivery_kind: "等你的结论再继续", msg: "确认一下生产库昨晚的备份是否成功,我必须拿到这个结论才能开始今晚的升级。" }),
	},
	{
		// A peer-directed new task: exercises the execution surface. A bare "开新任务" with no
		// addressee sits on the communicate/manage_thread boundary and is recorded separately.
		surface: "plan", name: "execution-new",
		input: { delivery_kind: "派个新活", msg: "dave,单独开一个新任务:调研边缘计算的落地案例,和手头的迁移工作分开推进。" },
		expect: { execution: "new" },
		run: send({ delivery_kind: "派个新活", msg: "dave,单独开一个新任务:调研边缘计算的落地案例,和手头的迁移工作分开推进。" }),
	},
	{
		surface: "plan", name: "execution-existing",
		input: { delivery_kind: "继续手头的工作", msg: "接着我们正在做的数据库迁移,把第三批表也迁完。" },
		expect: { execution: "existing" },
		run: send({ delivery_kind: "继续手头的工作", msg: "接着我们正在做的数据库迁移,把第三批表也迁完。" }),
	},
	{
		// Record-only: no addressee, so "开新任务" may read as communicate or as creating a
		// task thread; create then requires meta.title and the host refuses. Kept to observe.
		surface: "plan", name: "bare-new-task",
		input: { delivery_kind: "开个新事项", msg: "单独开一个新任务:调研边缘计算的落地案例,和手头的迁移工作分开推进。" },
		expect: null,
		run: send({ delivery_kind: "开个新事项", msg: "单独开一个新任务:调研边缘计算的落地案例,和手头的迁移工作分开推进。" }),
	},

	// --- inbound: decideInbound; the judged quantity is needsAnswer -----------
	// This decider fixes action to wake and insertion to follow_up, so the steer /
	// wake / fragment splits other hosts express land on needsAnswer alone.
	{
		surface: "inbound", name: "question",
		input: { sender: "bob", delivery_kind: "等你看完给我结论", msg: "迁移第三批表的回滚脚本准备好了吗?今晚要用。" },
		expect: { needsAnswer: true },
		run: receive(PEER_ID.bob, "等你看完给我结论", "迁移第三批表的回滚脚本准备好了吗?今晚要用。"),
	},
	{
		surface: "inbound", name: "notice",
		input: { sender: "carol", delivery_kind: "通报进度", msg: "评测平台的通知:昨晚的回归测试全部通过,通过率 100%。" },
		expect: { needsAnswer: false },
		run: receive(PEER_ID.carol, "通报进度", "评测平台的通知:昨晚的回归测试全部通过,通过率 100%。"),
	},
	{
		surface: "inbound", name: "urgent-correction",
		input: { sender: "dave", delivery_kind: "紧急修正", msg: "紧急:刚才发你的配置里数据库端口写错了,是 5433 不是 5432,立刻改掉重跑。" },
		expect: { needsAnswer: true },
		run: receive(PEER_ID.dave, "紧急修正", "紧急:刚才发你的配置里数据库端口写错了,是 5433 不是 5432,立刻改掉重跑。"),
	},
	{
		surface: "inbound", name: "can-wait-supplement",
		input: { sender: "carol", delivery_kind: "补充材料,不急", msg: "等手头的事忙完,把周报里加上 GPU 成本那一节再发我,今天之内就行。" },
		expect: { needsAnswer: true },
		run: receive(PEER_ID.carol, "补充材料,不急", "等手头的事忙完,把周报里加上 GPU 成本那一节再发我,今天之内就行。"),
	},
	{
		surface: "inbound", name: "greeting-idle",
		input: { sender: "bob", delivery_kind: "打个招呼", msg: "你好,我是 bob,负责数据平台,以后我们对接多些,多多关照。" },
		expect: { needsAnswer: false },
		run: receive(PEER_ID.bob, "打个招呼", "你好,我是 bob,负责数据平台,以后我们对接多些,多多关照。"),
	},
	{
		surface: "inbound", name: "mid-run-directive",
		input: { sender: "dave", delivery_kind: "运行中调整", msg: "对了,迁移的时候用 staging 库试跑,别直接碰生产库。" },
		// A directive this node must act on needs an answer: the criteria say so explicitly.
		expect: { needsAnswer: true },
		run: receive(PEER_ID.dave, "运行中调整", "对了,迁移的时候用 staging 库试跑,别直接碰生产库。"),
	},
	{
		surface: "inbound", name: "heavy-task",
		input: { sender: "bob", delivery_kind: "重任务委托", msg: "请把 docs 目录下 60 篇文档全部翻译成英文,周五前给我全部成品。" },
		expect: { needsAnswer: true },
		run: receive(PEER_ID.bob, "重任务委托", "请把 docs 目录下 60 篇文档全部翻译成英文,周五前给我全部成品。"),
	},
	{
		surface: "inbound", name: "vague",
		input: { sender: "bob", delivery_kind: "随口一说", msg: "嗯,行吧。" },
		// Deliberately ambiguous between an acknowledgment and a decision owed.
		expect: null,
		run: receive(PEER_ID.bob, "随口一说", "嗯,行吧。"),
	},

	// --- scope and op: the decider's remaining judged call points -------------
	// #land and #sendThread are deterministic and out of scope. What is left is
	// the inspect scope and the thread/domain operation the message names.
	{
		surface: "scope-op", name: "scope-messages",
		input: { delivery_kind: "本地查询", msg: "把部署复盘线程里的消息从头到尾翻出来给我看看。" },
		expect: { kind: "read", scope: "messages" },
		run: send({ delivery_kind: "本地查询", msg: "把部署复盘线程里的消息从头到尾翻出来给我看看。" }),
	},
	{
		surface: "scope-op", name: "op-domain-join",
		input: { delivery_kind: "域操作", msg: "帮我们加入研发域,以后算力调度走那边。", meta: { domain_id: "urn:onlyne:domain:dev" } },
		expect: { kind: "domain", op: "join" },
		run: send({ delivery_kind: "域操作", msg: "帮我们加入研发域,以后算力调度走那边。", meta: { domain_id: "urn:onlyne:domain:dev" } }),
	},
];

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

const SURFACES = ["intent", "target", "plan", "inbound", "scope-op"];

function noulValues(row: Row): number[] {
	const values: number[] = [];
	for (const call of row.answers) {
		const answers = call.answers as Record<string, { noul?: unknown }> | undefined;
		const value = answers?.needs_answer?.noul;
		if (typeof value === "number") values.push(value);
	}
	return values;
}

async function main(): Promise<void> {
	// Reachability probe: one trivial judgment before anything else runs.
	const probeStart = performance.now();
	try {
		await judge(JUDGE, { focus: { probe: true } }, {
			ready: { type: "noul", instructions: "Connectivity probe. Answer immediately.", criteria: { true: "reachable", false: "unreachable" } },
		});
	} catch (error) {
		console.error(`judge-samples: the System One endpoint is unreachable: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	const probeMs = Math.round(performance.now() - probeStart);
	console.log(`judge-samples: endpoint reachable (${JUDGE.endpoint}, model ${JUDGE.model}, probe ${String(probeMs)} ms)`);

	const rows: Row[] = [];
	for (const scenario of SCENARIOS) {
		const row = await runScenario(scenario);
		rows.push(row);
		const noul = noulValues(row).map(value => value.toFixed(3)).join(",");
		const suffix = row.status === "error" ? ` error=${row.error ?? ""}` : "";
		console.log(`  [${row.surface}/${row.name}] ${row.status} ${String(row.ms)} ms${noul === "" ? "" : ` noul=${noul}`}${suffix}`);
	}

	// Per-surface pass rates over the judged samples (pass + mismatch).
	const lines: string[] = [];
	const header = ["surface", "total", "pass", "mismatch", "record-only", "error", "rate"];
	lines.push(header.join("\t"));
	let judged = 0;
	let passed = 0;
	for (const surface of SURFACES) {
		const subset = rows.filter(row => row.surface === surface);
		const counts = {
			total: subset.length,
			pass: subset.filter(row => row.status === "pass").length,
			mismatch: subset.filter(row => row.status === "mismatch").length,
			"record-only": subset.filter(row => row.status === "record-only").length,
			error: subset.filter(row => row.status === "error").length,
		};
		const rate = counts.pass + counts.mismatch === 0
			? "n/a"
			: `${((counts.pass / (counts.pass + counts.mismatch)) * 100).toFixed(1)}%`;
		lines.push([surface, counts.total, counts.pass, counts.mismatch, counts["record-only"], counts.error, rate].join("\t"));
		judged += counts.pass + counts.mismatch;
		passed += counts.pass;
	}
	const overallRate = judged === 0 ? "n/a" : `${((passed / judged) * 100).toFixed(1)}%`;
	lines.push(["overall", rows.length, passed, judged - passed, rows.filter(row => row.status === "record-only").length, rows.filter(row => row.status === "error").length, overallRate].join("\t"));
	console.log(`\n${lines.join("\n")}`);

	// Mismatches verbatim, then record-only observations.
	const mismatched = rows.filter(row => row.status === "mismatch");
	if (mismatched.length > 0) {
		console.log("\nmismatches:");
		for (const row of mismatched) {
			console.log(`  ${row.surface}/${row.name}`);
			console.log(`    expect:  ${JSON.stringify(row.expect)}`);
			console.log(`    outcome: ${JSON.stringify(row.outcome)}`);
			console.log(`    answers: ${JSON.stringify(row.answers.map(call => call.answers))}`);
		}
	}
	const recorded = rows.filter(row => row.status === "record-only");
	if (recorded.length > 0) {
		console.log("\nrecord-only:");
		for (const row of recorded) {
			console.log(`  ${row.surface}/${row.name}`);
			console.log(`    outcome: ${JSON.stringify(row.outcome)}`);
			if (row.error !== undefined) console.log(`    error: ${row.error}`);
			console.log(`    answers: ${JSON.stringify(row.answers.map(call => call.answers))}`);
		}
	}
	const failed = rows.filter(row => row.status === "error");
	if (failed.length > 0) {
		console.log("\nerrors:");
		for (const row of failed) console.log(`  ${row.surface}/${row.name}: ${row.error ?? ""}`);
	}

	// noul (needsAnswer) summary for the inbound surface.
	const inbound = rows.filter(row => row.surface === "inbound");
	console.log("\nnoul (needsAnswer) raw values:");
	for (const row of inbound) {
		console.log(`  ${row.name}: [${noulValues(row).map(value => value.toFixed(3)).join(", ") || "none"}] expect=${JSON.stringify(row.expect)}`);
	}

	mkdirSync("/tmp/judge-samples", { recursive: true });
	const report = {
		at: new Date().toISOString(),
		endpoint: JUDGE.endpoint,
		model: JUDGE.model,
		probe_ms: probeMs,
		totals: {
			scenarios: rows.length,
			pass: rows.filter(row => row.status === "pass").length,
			mismatch: rows.filter(row => row.status === "mismatch").length,
			"record-only": rows.filter(row => row.status === "record-only").length,
			error: rows.filter(row => row.status === "error").length,
		},
		rows,
	};
	writeFileSync(RESULTS_PATH, `${JSON.stringify(report, null, "\t")}\n`);
	console.log(`\njudge-samples: results written to ${RESULTS_PATH}`);
}

await main();
