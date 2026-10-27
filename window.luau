--!strict
-- Onlyne window half: Carly's exports, the pending poller, and the palette commands.
-- The companion process is supervised by host.luau; everything here reaches it over
-- the loopback admin API named by server.json in the plugin data directory.

local CONFIG_KEY = "onlyne.config"
local RESTART_KEY = "onlyne.restart"
local WOKEN_KEY = "onlyne.woken"
local POLL_MS = 8000
local MAX_WOKEN = 200

local pending_items: { any } = {}
local woken: { [string]: boolean } = {}
local woken_order: { string } = {}
local poll: (WindowCx?) -> ()
local started = false

local function info(...)
	tern.log.info("onlyne:", ...)
end

local function server_path(): string
	return tern.plugin.data .. "/server.json"
end

local function read_server(): { port: number, token: string }?
	if not tern.fs.exists(server_path()) then
		return nil
	end
	local ok, value = pcall(function()
		return tern.json.decode(tern.fs.read(server_path(), 65536))
	end)
	if not ok or type(value) ~= "table" then
		return nil
	end
	if type(value.port) ~= "number" or type(value.token) ~= "string" then
		return nil
	end
	return { port = value.port, token = value.token }
end

local function config(): { [string]: any }
	local ok, value = pcall(tern.kv.get, CONFIG_KEY)
	if ok and type(value) == "table" then
		return value
	end
	return {}
end

local function wake_enabled(): boolean
	return config().wake ~= false
end

-- Calls the companion's admin API. `cb` runs once with the decoded body, or nil and a
-- reason. The callback receives the fresh window cx Tern hands the fetch hook.
-- `human` marks a panel action: the companion skips the acquisition policy for it, because
-- the panel is the last gate (RFC 0018 §2). No agent-facing export sets this.
local function admin(path: string, body: any, cb: (any, string?, WindowCx?) -> (), human: boolean?)
	local server = read_server()
	if server == nil then
		cb(nil, "伴生进程没有运行", nil)
		return
	end
	local headers: { [string]: string } = { ["x-onlyne-admin-token"] = server.token, ["content-type"] = "application/json" }
	if human == true then
		headers["x-onlyne-human"] = "1"
	end
	local opts: FetchOptions = {
		method = if body == nil then "GET" else "POST",
		headers = headers,
		timeout_ms = 20000,
	}
	if body ~= nil then
		opts.body = tern.json.encode(body)
	end
	local ok, err = pcall(tern.fetch, "http://127.0.0.1:" .. tostring(server.port) .. path, opts, function(result: FetchResult, cx: WindowCx?)
		if result.error ~= nil then
			cb(nil, result.error, cx)
			return
		end
		local decoded_ok, decoded = pcall(tern.json.decode, result.body)
		if not decoded_ok then
			cb(nil, "伴生进程返回了无法解析的响应", cx)
			return
		end
		cb(decoded, nil, cx)
	end)
	if not ok then
		cb(nil, tostring(err), nil)
	end
end

local function first_line(text: any, limit: number): string
	local value = if type(text) == "string" then text else ""
	value = string.gsub(value, "%s+", " ")
	if #value > limit then
		value = string.sub(value, 1, limit - 3) .. "..."
	end
	return value
end

-- A policy refusal is an error the model must see as one; every other body is a result.
-- A refusal the model must see as one, and the two kinds stay distinct: `policy_denied` is this
-- host declining to act, `forbidden` is the peer having revoked this node (RFC 0018 §6).
local function refusal_error(res: any): string?
	if type(res) ~= "table" or type(res.error) ~= "table" then
		return nil
	end
	if res.error.code == "policy_denied" then
		return tostring(res.error.message or "policy_denied")
	end
	if res.error.code == "forbidden" then
		return "对端拒绝了这次批准：它已撤销本节点。这不是获取策略的拒绝，重新建立关系需要对方先接受本节点。"
	end
	return nil
end

local function merge(base: { [string]: any }, patch: { [string]: any }): { [string]: any }
	local out: { [string]: any } = {}
	for key, value in pairs(base) do
		out[key] = value
	end
	for key, value in pairs(patch) do
		local current = out[key]
		if type(value) == "table" and type(current) == "table" then
			local nested: { [string]: any } = {}
			for nested_key, nested_value in pairs(current) do
				nested[nested_key] = nested_value
			end
			for nested_key, nested_value in pairs(value) do
				nested[nested_key] = nested_value
			end
			out[key] = nested
		else
			out[key] = value
		end
	end
	return out
end

local function bump_restart()
	local current = tern.kv.get(RESTART_KEY)
	tern.kv.set(RESTART_KEY, (if type(current) == "number" then current else 0) + 1)
end

local function load_woken()
	local ok, list = pcall(tern.kv.get, WOKEN_KEY)
	if not ok or type(list) ~= "table" then
		return
	end
	for _, token in list do
		if type(token) == "string" then
			woken[token] = true
			woken_order[#woken_order + 1] = token
		end
	end
end

local function mark_woken(tokens: { string })
	for _, token in tokens do
		if not woken[token] then
			woken[token] = true
			woken_order[#woken_order + 1] = token
		end
	end
	while #woken_order > MAX_WOKEN do
		local old = table.remove(woken_order, 1)
		if old ~= nil then
			woken[old] = nil
		end
	end
	tern.kv.set(WOKEN_KEY, tern.json.array(woken_order))
end

-- The sender's explicit decisions are part of the message, so they are rendered, not dropped.
local function item_facts(item: any): string
	local parts: { string } = {}
	local plan = item.plan
	if type(plan) == "table" then
		local context = if type(plan.context) == "string" and plan.context ~= "" then " context=" .. plan.context else ""
		parts[#parts + 1] = string.format("计划 response=%s execution=%s%s", tostring(plan.response), tostring(plan.execution), context)
	end
	local targets = item.targets
	if type(targets) == "table" and #targets > 0 then
		local names: { string } = {}
		for _, target in targets do
			if type(target) == "string" then
				names[#names + 1] = target
			end
		end
		if #names > 0 then
			parts[#parts + 1] = "目标 " .. table.concat(names, ", ")
		end
	end
	if type(item.relation) == "string" then
		parts[#parts + 1] = "关系 " .. item.relation
	end
	if type(item.needs_answer) == "boolean" then
		parts[#parts + 1] = if item.needs_answer then "判断 需要回复" else "判断 无需回复"
	end
	return table.concat(parts, "；")
end

local function item_summary(item: any): string
	local parts: { string } = {}
	local trust = item.trust
	if type(trust) == "table" then
		parts[#parts + 1] = string.format("信任 %s", tostring(trust.phase))
		if trust.actionable == true then
			parts[#parts + 1] = "需要动作"
		end
	end
	local plan = item.plan
	if type(plan) == "table" then
		parts[#parts + 1] = string.format("%s/%s", tostring(plan.response), tostring(plan.execution))
	end
	if type(item.needs_answer) == "boolean" and not item.needs_answer then
		parts[#parts + 1] = "无需回复"
	end
	return table.concat(parts, " ")
end

local function wake_prompt(items: { any }): string
	local lines = {
		"这是onlyne消息，与原任务一起做。",
		string.format("Onlyne 收到 %d 条新消息。", #items),
	}
	local trust_items = 0
	for index, item in items do
		if index > 5 then
			break
		end
		local trust = item.trust
		if type(trust) == "table" then
			trust_items += 1
			lines[#lines + 1] = string.format("- 信任握手 %s：节点 %s，指纹 %s，结论 %s，%s",
				tostring(trust.phase), tostring(trust.node_id), tostring(trust.fingerprint), tostring(trust.conclusion),
				if trust.actionable == true then "需要动作" else "只需知悉")
		else
			local thread = item.thread
			local where = if type(thread) == "table" then tostring(thread.owner) .. "/" .. tostring(thread.id) else "?"
			lines[#lines + 1] = string.format("- 来自 %s（thread %s, seq %s）：%s", tostring(item.sender), where, tostring(item.seq), first_line(item.text, 120))
			local facts = item_facts(item)
			if facts ~= "" then
				lines[#lines + 1] = "  " .. facts
			end
		end
	end
	lines[#lines + 1] = '先调用 await(plugins["onlyne"].pending()) 读取完整内容。回复时调用 await(plugins["onlyne"].msg({delivery_kind="chat", msg="…", meta={to="<sender>", thread={owner="…", id="…"}, in_reply_to={sender="<sender>", id="<message_id>"}}}))，发送成功后调用 await(plugins["onlyne"].consumed("<token>"))。发送方与 thread 一律取自 pending 的结果，不要编造。'
	if trust_items > 0 then
		lines[#lines + 1] = "其中带 trust 字段的条目是信任握手，不是业务消息：批准调用 await(plugins[\"onlyne\"].trust_accept(node_id, fingerprint))，拒绝调用 await(plugins[\"onlyne\"].trust_revoke(node_id))；正文里写明不需要动作的条目只读即可。"
	end
	return table.concat(lines, "\n")
end

-- The companion's token changes when it restarts, so the dedupe key is the entry itself.
local function entry_key(item: any): string?
	local thread = item.thread
	if type(thread) ~= "table" or type(thread.owner) ~= "string" or type(thread.id) ~= "string" then
		return nil
	end
	return thread.owner .. "/" .. thread.id .. "/" .. tostring(item.seq)
end

local function register_exports()
	tern.carly.export("msg", {
		sig = "msg(input: {delivery_kind: string, msg: string, meta: table?}) -> table",
		doc = "Send one Onlyne message through this node. input is the library MsgInput: delivery_kind and msg are required; meta may carry to, thread, in_reply_to, response, execution, relation and mentions. Returns the admission outcome, or {error} when the decision or delivery failed.",
	}, function(input: any, _cx: WindowCx, call: ExportCall)
		if type(input) ~= "table" or type(input.delivery_kind) ~= "string" or type(input.msg) ~= "string" then
			call:fail("msg needs delivery_kind and msg")
			return call:wait(1000)
		end
		admin("/admin/msg", input, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				call:reply(res)
			end
		end)
		return call:wait(120000)
	end)

	tern.carly.export("pending", {
		sig = "pending() -> {items: {{token: string, sender: string, message_id: string, thread: {owner: string, id: string}, seq: string, text: string, at: string, plan: {response: string, execution: string, context: string?}?, targets: {string}, relation: string?, needs_answer: boolean?}}}",
		doc = "Unconsumed inbound Onlyne messages, oldest first. Each item carries the token to report after handling, the message id to answer, the sender's delivery plan, the addressees it named, its relation, and the inbound judgment of whether a reply is owed.",
	}, function(_cx: WindowCx, call: ExportCall)
		admin("/admin/pending", nil, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
				return
			end
			if type(res) == "table" and type(res.items) == "table" then
				pending_items = res.items
			end
			call:reply(res)
		end)
		return call:wait(20000)
	end)

	tern.carly.export("consumed", {
		sig = "consumed(token: string) -> {consumed: boolean, reason: string}",
		doc = "Confirm that Carly read and handled the pending item with this token. consumed=false is not a failure: reason=already_consumed means the reply's meta.in_reply_to settled the item first (the normal case), and unknown_token means this companion never issued that token, for example after a restart. Only reason=confirmed means this call did the settling.",
	}, function(token: any, _cx: WindowCx, call: ExportCall)
		if type(token) ~= "string" then
			call:fail("consumed needs the token string")
			return call:wait(1000)
		end
		admin("/admin/consumed", { token = token }, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
				return
			end
			-- The context provider reads this list, so a settled item must leave it here:
			-- otherwise the next turn is told about mail Carly already answered.
			local kept: { any } = {}
			for _, item in pending_items do
				if type(item) ~= "table" or item.token ~= token then
					kept[#kept + 1] = item
				end
			end
			pending_items = kept
			call:reply(res)
		end)
		return call:wait(20000)
	end)

	tern.carly.export("status", {
		sig = "status() -> {node_id: string, region: string, endpoint: string, peers: number, peers_live: number, peers_stale: number, peers_known: number, pending: number}",
		doc = "This node's id, region, endpoint and how many peers and pending messages it holds. peers repeats peers_live; peers_stale counts verified rows whose freshness window has lapsed and peers_known counts every row.",
	}, function(_cx: WindowCx, call: ExportCall)
		admin("/admin/status", nil, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				call:reply(res)
			end
		end)
		return call:wait(10000)
	end)

	tern.carly.export("contact", {
		sig = "contact(endpoint: string) -> {ok: boolean}",
		doc = "Discover another Onlyne node by its base endpoint (for example http://127.0.0.1:PORT/onlyne/v3) and record it as a peer. The host's acquisition policy may refuse this call with policy_denied and the rule it matched; a human at the panel is not subject to it.",
	}, function(endpoint: any, _cx: WindowCx, call: ExportCall)
		if type(endpoint) ~= "string" or endpoint == "" then
			call:fail("contact needs an endpoint URL")
			return call:wait(1000)
		end
		admin("/admin/contact", { endpoint = endpoint }, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				local denied = refusal_error(res)
				if denied ~= nil then
					call:fail(denied)
				else
					call:reply(res)
				end
			end
		end)
		return call:wait(20000)
	end)

	tern.carly.export("trust_list", {
		sig = "trust_list() -> {items: {{node_id: string, fingerprint: string, phase: string, base_url: string}}}",
		doc = "Every key exchange row: phase is invited (their approval waits for yours), requested (yours committed; waiting for theirs - normal pending state after trust_accept), exchanged (both sides approved) or revoked.",
	}, function(_cx: WindowCx, call: ExportCall)
		admin("/admin/trust/list", nil, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				call:reply(res)
			end
		end)
		return call:wait(20000)
	end)

	tern.carly.export("trust_begin", {
		sig = "trust_begin(node_id: string) -> {node_id: string, fingerprint: string, public_key: string}",
		doc = "Stage one of a handshake: reads the peer's live key and returns the fingerprint to show. Add the peer with contact() first when it is not discovered yet.",
	}, function(node_id: any, _cx: WindowCx, call: ExportCall)
		if type(node_id) ~= "string" or node_id == "" then
			call:fail("trust_begin needs a node id")
			return call:wait(1000)
		end
		admin("/admin/trust/begin", { node_id = node_id }, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				local denied = refusal_error(res)
				if denied ~= nil then
					call:fail(denied)
				else
					call:reply(res)
				end
			end
		end)
		return call:wait(20000)
	end)

	tern.carly.export("trust_accept", {
		sig = "trust_accept(node_id: string, fingerprint: string) -> {ok: boolean, entry: table}",
		doc = "Commit local approval for a peer and send the signed introduction. The fingerprint must repeat the one trust_begin returned; a changed key fails instead of being pinned. This also accepts an incoming invitation (phase invited) using the fingerprint from trust_list. Note: after local approval, the phase becomes requested until the peer also approves and returns its signature (exchanged).",
	}, function(node_id: any, fingerprint: any, _cx: WindowCx, call: ExportCall)
		if type(node_id) ~= "string" or node_id == "" or type(fingerprint) ~= "string" or fingerprint == "" then
			call:fail("trust_accept needs node_id and fingerprint")
			return call:wait(1000)
		end
		admin("/admin/trust/accept", { node_id = node_id, fingerprint = fingerprint }, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				local denied = refusal_error(res)
				if denied ~= nil then
					call:fail(denied)
				else
					call:reply(res)
				end
			end
		end)
		return call:wait(30000)
	end)

	tern.carly.export("peers", {
		sig = "peers() -> {items: {{node_id: string, instance_id: string, base_url: string, source: string, last_seen: string, expires_at: string, verified_at: string?, error: table?}}}",
		doc = "Every discovery observation this node holds, including verified, fresh and expired rows. Use refresh() to re-check recorded addresses.",
	}, function(_cx: WindowCx, call: ExportCall)
		admin("/admin/discovery", nil, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				call:reply(res)
			end
		end)
		return call:wait(20000)
	end)

	tern.carly.export("threads", {
		sig = "threads() -> {items: {{id: string, title: string, members: {{node_id: string, state: string}}, last_seq: string, last_activity_at: string, open: boolean}}}",
		doc = "Every thread this node owns, most recently active first - the order the next send to the same peer reuses. last_seq is the highest seq in the thread (0 when empty); members carries each peer's membership state; last_activity_at falls back to the thread's creation time on rows written before this field existed.",
	}, function(_cx: WindowCx, call: ExportCall)
		admin("/admin/threads", nil, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				call:reply(res)
			end
		end)
		return call:wait(20000)
	end)

	tern.carly.export("read", {
		sig = "read(thread: string|table, options: {since_seq: string?, limit: number?}?) -> {items: {{thread: {owner: string, id: string}, seq: string, id: string, sender: string, text: string, at: string, plan: {response: string, execution: string, context: string?}?, relation: string?, in_reply_to: {sender: string, id: string}?}}, next_cursor: string?}",
		doc = "Entries of one thread, oldest first. thread is a thread id or title of this node, owner/id, or {owner, id}; since_seq is exclusive and limit defaults to 100. plan is the delivery plan the message was sent with, or null when the local records no longer hold it; relation and in_reply_to are what the sender wrote. next_cursor continues a longer thread.",
	}, function(thread: any, options: any, _cx: WindowCx, call: ExportCall)
		local body: { [string]: any } = { thread = thread }
		if type(options) == "table" then
			body.since_seq = options.since_seq
			body.limit = options.limit
		end
		admin("/admin/read", body, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				call:reply(res)
			end
		end)
		return call:wait(20000)
	end)

	tern.carly.export("message", {
		sig = "message(ref: {thread: string|table, seq: string} | {sender: string, id: string}) -> {message: {thread: {owner: string, id: string}?, seq: string?, id: string, sender: string, text: string, at: string, plan: table?, relation: string?, in_reply_to: {sender: string, id: string}?}}",
		doc = "One entry in full, for checking a reference: by position in a thread, or by the sender's message id. Same fields as read() items. A message this node sent into a peer's thread comes from the conversation log, so its plan is null and thread/seq may be absent.",
	}, function(ref: any, _cx: WindowCx, call: ExportCall)
		admin("/admin/message", { ref = ref }, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				call:reply(res)
			end
		end)
		return call:wait(20000)
	end)

	tern.carly.export("refresh", {
		sig = "refresh() -> {ok: boolean}",
		doc = "Re-check every recorded address in the discovery catalog now. The acquisition policy refuses this call when any recorded address is outside the allow set, because the sweep dials all of them.",
	}, function(_cx: WindowCx, call: ExportCall)
		admin("/admin/discovery/refresh", {}, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				local denied = refusal_error(res)
				if denied ~= nil then
					call:fail(denied)
				else
					call:reply(res)
				end
			end
		end)
		return call:wait(30000)
	end)

	tern.carly.export("trust_revoke", {
		sig = "trust_revoke(node_id: string) -> {ok: boolean}",
		doc = "Drop local approval for a peer. A revoked peer needs a new handshake and local approval before its signed traffic is accepted again.",
	}, function(node_id: any, _cx: WindowCx, call: ExportCall)
		if type(node_id) ~= "string" or node_id == "" then
			call:fail("trust_revoke needs a node id")
			return call:wait(1000)
		end
		admin("/admin/trust/revoke", { node_id = node_id }, function(res, err)
			if call.cancelled then
				return
			end
			if err ~= nil then
				call:fail(err)
			else
				call:reply(res)
			end
		end)
		return call:wait(20000)
	end)

	tern.carly.export("config", {
		sig = "config() -> table",
		doc = "The Onlyne configuration in this plugin's kv store (onlyne.config).",
	}, function(_cx: WindowCx, _call: ExportCall)
		return config()
	end)

	tern.carly.export("set_config", {
		sig = "set_config(patch: table) -> table",
		doc = "Merge patch into onlyne.config and restart the companion. Keys: node_id, region, bind, public_url, key_scope, wake, acquisition {policy, allow}, trust [{node_id, fingerprint}], systemone {endpoint, model, headers, timeout_ms}. `peers` is retired and refuses to start.",
	}, function(patch: any, _cx: WindowCx, _call: ExportCall)
		if type(patch) ~= "table" then
			return { error = "set_config needs a table patch" }
		end
		local merged = merge(config(), patch)
		tern.kv.set(CONFIG_KEY, merged)
		bump_restart()
		return merged
	end)
end

local function refresh_pending(cx: WindowCx?)
	admin("/admin/pending", nil, function(res, err, fcx)
		if err == nil and type(res) == "table" and type(res.items) == "table" then
			pending_items = res.items
			local fresh: { any } = {}
			local fresh_to_wake: { any } = {}
			local keys: { string } = {}
			for _, item in pending_items do
				local key = if type(item) == "table" then entry_key(item) else nil
				if key ~= nil and not woken[key] then
					fresh[#fresh + 1] = item
					keys[#keys + 1] = key
					local needs_wake = false
					if type(item) == "table" then
						local plan = item.plan
						local quiet = type(plan) == "table" and plan.response == "none"
						-- The sender's plan decides: `none` means no turn is owed. The inbound
						-- judgment only overrides it upward, and an actionable handshake always
						-- owes one (RFC 0018 §3). A `false` judgment is not a reason to stay
						-- silent when the sender asked for a reply.
						local trust = item.trust
						needs_wake = item.needs_answer == true
							or not quiet
							or (type(trust) == "table" and trust.actionable == true)
					end
					if needs_wake then
						fresh_to_wake[#fresh_to_wake + 1] = item
					end
				end
			end
			if #fresh > 0 then
				-- Only an item that actually reached Carly may be marked woken: marking a quiet
				-- item here would bury it before any turn ever named it.
				if #fresh_to_wake > 0 then
					local wake_keys: { string } = {}
					for _, item in fresh_to_wake do
						local key = entry_key(item)
						if key ~= nil then
							wake_keys[#wake_keys + 1] = key
						end
					end
					mark_woken(wake_keys)
				end
				if #fresh_to_wake > 0 and wake_enabled() then
					if fcx ~= nil then
						local ok, err = pcall(function()
							fcx:ask_carly(wake_prompt(fresh_to_wake))
						end)
						if not ok then
							tern.log.warn("onlyne: ask_carly failed", tostring(err))
						end
					else
						local ok, err = pcall(function()
							tern.carly.schedule({
								title = "Onlyne Inbound",
								when = "in 1s",
								prompt = wake_prompt(fresh_to_wake),
							})
						end)
						if not ok then
							tern.log.warn("onlyne: schedule wake failed", tostring(err))
						end
					end
				end
			end
		end
		tern.timer(POLL_MS, poll)
	end)
end

poll = function(cx: WindowCx?)
	refresh_pending(cx)
end

local function ask(cx: WindowCx, opts: PromptOptions, cb: (string, WindowCx) -> ())
	cx:prompt(opts):next(function(value: string?, _err: string?, next_cx: WindowCx?)
		if next_cx ~= nil and value ~= nil and value ~= "" then
			cb(value, next_cx)
		end
	end)
end

local function register_commands()
	tern.command({
		id = "status",
		title = "Onlyne: 状态",
		group = "Onlyne",
		run = function(cx: WindowCx)
			admin("/admin/status", nil, function(res, err, fcx)
				if fcx == nil then
					return
				end
				if err ~= nil then
					fcx:toast("error", "Onlyne 伴生进程没有运行", err)
					return
				end
				fcx:toast("info", "Onlyne " .. tostring(res.node_id), string.format("%s · 对端 %d · 待收 %d", tostring(res.endpoint), res.peers or 0, res.pending or 0))
			end)
		end,
	})

	tern.command({
		id = "peers",
		title = "Onlyne: 发现的对端",
		group = "Onlyne",
		run = function(cx: WindowCx)
			admin("/admin/discovery", nil, function(res, err, fcx)
				if fcx == nil then
					return
				end
				if err ~= nil then
					fcx:toast("error", "Onlyne 伴生进程没有运行", err)
					return
				end
				local items = if type(res) == "table" and type(res.items) == "table" then res.items else {}
				if #items == 0 then
					fcx:toast("info", "Onlyne 对端发现", "尚未发现任何对端，可用 contact() 手动添加")
					return
				end
				local lines: { string } = {}
				for index, row in items do
					if index > 6 then
						lines[#lines + 1] = string.format("... 还有 %d 个对端", #items - 6)
						break
					end
					lines[#lines + 1] = string.format("- %s (%s) · %s", tostring(row.node_id), if row.verified_at ~= nil then "已验证" else "未验证", tostring(row.base_url))
				end
				fcx:toast("info", string.format("Onlyne 对端 (%d)", #items), table.concat(lines, "\n"))
			end)
		end,
	})

	tern.command({
		id = "trust",
		title = "Onlyne: 握手状态",
		group = "Onlyne",
		run = function(cx: WindowCx)
			admin("/admin/trust/list", nil, function(res, err, fcx)
				if fcx == nil then
					return
				end
				if err ~= nil then
					fcx:toast("error", "Onlyne 伴生进程没有运行", err)
					return
				end
				local items = if type(res) == "table" and type(res.items) == "table" then res.items else {}
				if #items == 0 then
					fcx:toast("info", "Onlyne 握手", "还没有对端密钥记录")
					return
				end
				local lines: { string } = {}
				for index, row in items do
					if index > 5 then
						break
					end
					lines[#lines + 1] = string.format("%s %s 指纹 %s 声明 %s 观测 %s",
						tostring(row.node_id), tostring(row.phase), tostring(row.fingerprint),
						tostring(row.base_url), tostring(row.observed or "未记录"))
				end
				fcx:toast("info", "Onlyne 握手", table.concat(lines, "\n"))
			end)
		end,
	})

	tern.command({
		id = "wake",
		title = "Onlyne: 处理待收消息",
		group = "Onlyne",
		run = function(cx: WindowCx)
			admin("/admin/pending", nil, function(res, err, fcx)
				if fcx == nil then
					return
				end
				if err ~= nil then
					fcx:toast("error", "Onlyne 伴生进程没有运行", err)
					return
				end
				local items = if type(res) == "table" and type(res.items) == "table" then res.items else {}
				if #items == 0 then
					fcx:toast("info", "Onlyne", "没有待处理消息")
					return
				end
				pending_items = items
				fcx:ask_carly(wake_prompt(items))
			end)
		end,
	})

	tern.command({
		id = "restart",
		title = "Onlyne: 重启伴生进程",
		group = "Onlyne",
		run = function(cx: WindowCx)
			bump_restart()
			cx:toast("info", "Onlyne", "伴生进程会在下一次检查时重启")
		end,
	})

	tern.command({
		id = "log",
		title = "Onlyne: 打开日志",
		group = "Onlyne",
		run = function(cx: WindowCx)
			local path = tern.plugin.data .. "/onlyne.log"
			if not tern.fs.exists(path) then
				cx:toast("info", "Onlyne", "还没有日志")
				return
			end
			cx:open(path)
		end,
	})

	tern.command({
		id = "configure",
		title = "Onlyne: 配置",
		group = "Onlyne",
		run = function(cx: WindowCx)
			local current = config()
			local systemone = if type(current.systemone) == "table" then current.systemone else {}
			ask(cx, {
				value = if type(current.node_id) == "string" then current.node_id else "",
				placeholder = "节点 id（urn:onlyne:agent:…）",
				icon = "at-sign",
				action = "下一步",
			}, function(node_id, cx1)
				ask(cx1, {
					value = if type(current.region) == "string" then current.region else "",
					placeholder = "区域 id（urn:onlyne:region:…）",
					icon = "map",
					action = "下一步",
				}, function(region, cx2)
					ask(cx2, {
						value = if type(systemone.endpoint) == "string" then systemone.endpoint else "http://127.0.0.1:3425/v1/systemone",
						placeholder = "System One 端点",
						icon = "sparkles",
						action = "保存",
					}, function(endpoint, cx3)
						local patch = { node_id = node_id, region = region, systemone = { endpoint = endpoint } }
						local merged = merge(config(), patch)
						tern.kv.set(CONFIG_KEY, merged)
						bump_restart()
						cx3:toast("success", "Onlyne 配置已保存", "伴生进程会在下一次检查时重启")
					end)
				end)
			end)
		end,
	})

	tern.command({
		id = "acquisition",
		title = "Onlyne: 获取策略",
		group = "Onlyne",
		run = function(cx: WindowCx)
			admin("/admin/acquisition", nil, function(res, err, fcx)
				if fcx == nil then
					return
				end
				if err ~= nil then
					fcx:toast("error", "Onlyne 伴生进程没有运行", err)
					return
				end
				local policy = if type(res.policy) == "string" then res.policy else "?"
				local allow = if type(res.allow) == "table" then table.concat(res.allow, ", ") else ""
				local invited = if type(res.invited) == "table" then #res.invited else 0
				local seeds = if type(res.seeds) == "table" then #res.seeds else 0
				local candidates = if type(res.candidates) == "number" then res.candidates else 0
				local lines = {
					string.format("获取策略：%s", policy),
					string.format("允许集合：%s", allow),
					string.format("发现层回环：%s（plugins.allow_loopback 与获取策略各管一项，默认相反）", if res.allow_loopback == true then "允许" else "排除"),
					string.format("待批准 invited：%d · 发现候选：%d · 种子：%d", invited, candidates, seeds),
				}
				local limitations = if type(res.limitations) == "table" then res.limitations else {}
				for index, line in limitations do
					if index > 2 then
						break
					end
					lines[#lines + 1] = "限制：" .. tostring(line)
				end
				fcx:toast("info", "Onlyne 获取策略", table.concat(lines, "\n"))
				ask(fcx, { value = policy, placeholder = "all | segment | none（留空不改）", icon = "shield", action = "下一步" }, function(chosen, cx1)
					ask(cx1, { value = allow, placeholder = "允许集合，逗号分隔（留空不改）", icon = "list", action = "保存" }, function(entries, cx2)
						local patch: { [string]: any } = {}
						if chosen == "all" or chosen == "segment" or chosen == "none" then
							patch.policy = chosen
						elseif chosen ~= "" and chosen ~= policy then
							cx2:toast("error", "Onlyne 获取策略", "策略只能是 all、segment 或 none")
							return
						end
						if entries ~= "" and entries ~= allow then
							local list: { string } = {}
							for part in string.gmatch(entries, "[^,%s]+") do
								list[#list + 1] = part
							end
							if #list > 0 then
								patch.allow = tern.json.array(list)
							end
						end
						if next(patch) == nil then
							cx2:toast("info", "Onlyne 获取策略", "没有改动")
							return
						end
						tern.kv.set(CONFIG_KEY, merge(config(), { acquisition = patch }))
						bump_restart()
						cx2:toast("success", "Onlyne 获取策略已保存", "伴生进程会在下一次检查时重启；放宽不补批历史被拒的行，收紧不撤销已有关系")
					end)
				end)
			end)
		end,
	})

	tern.command({
		id = "approve_peer",
		title = "Onlyne: 批准对端（人类）",
		group = "Onlyne",
		run = function(cx: WindowCx)
			admin("/admin/acquisition", nil, function(res, err, fcx)
				if fcx == nil then
					return
				end
				if err ~= nil then
					fcx:toast("error", "Onlyne 伴生进程没有运行", err)
					return
				end
				local invited = if type(res.invited) == "table" then res.invited else {}
				if #invited == 0 then
					fcx:toast("info", "Onlyne 批准对端", "没有待批准的 invited 行")
					return
				end
				local lines: { string } = {}
				for index, row in invited do
					if index > 5 then
						break
					end
					lines[#lines + 1] = string.format("%s 指纹 %s 声明 %s 观测 %s",
						tostring(row.node_id), tostring(row.fingerprint), tostring(row.base_url), tostring(row.observed or "未记录"))
				end
				fcx:toast("info", string.format("Onlyne 待批准 (%d)", #invited), table.concat(lines, "\n"))
				ask(fcx, { value = tostring(invited[1].node_id), placeholder = "对端 node_id", icon = "at-sign", action = "下一步" }, function(node_id, cx1)
					local fingerprint: string? = nil
					for _, row in invited do
						if tostring(row.node_id) == node_id then
							fingerprint = tostring(row.fingerprint)
						end
					end
					if fingerprint == nil then
						cx1:toast("error", "Onlyne 批准对端", "这个 node_id 没有待批准的记录")
						return
					end
					ask(cx1, { value = fingerprint, placeholder = "指纹（必须与待批准记录一致）", icon = "fingerprint", action = "确认批准" }, function(shown, cx2)
						if shown ~= fingerprint then
							cx2:toast("error", "Onlyne 批准对端", "指纹与待批准记录不一致，未提交")
							return
						end
						admin("/admin/trust/accept", { node_id = node_id, fingerprint = shown }, function(result, failure, final_cx)
							if final_cx == nil then
								return
							end
							if failure ~= nil then
								final_cx:toast("error", "Onlyne 批准对端", failure)
								return
							end
							if type(result) == "table" and type(result.error) == "table" then
								final_cx:toast("error", "Onlyne 批准对端", tostring(result.error.message or result.error.code))
								return
							end
							final_cx:toast("success", "Onlyne 批准对端", string.format("%s 已批准（人类动作，已记审计）", node_id))
						end, true)
					end)
				end)
			end)
		end,
	})

	tern.command({
		id = "revoke_peer",
		title = "Onlyne: 撤销对端（人类）",
		group = "Onlyne",
		run = function(cx: WindowCx)
			admin("/admin/trust/list", nil, function(res, err, fcx)
				if fcx == nil then
					return
				end
				if err ~= nil then
					fcx:toast("error", "Onlyne 伴生进程没有运行", err)
					return
				end
				local items = if type(res) == "table" and type(res.items) == "table" then res.items else {}
				if #items == 0 then
					fcx:toast("info", "Onlyne 撤销对端", "还没有对端密钥记录")
					return
				end
				local lines: { string } = {}
				for index, row in items do
					if index > 5 then
						break
					end
					lines[#lines + 1] = string.format("%s %s", tostring(row.node_id), tostring(row.phase))
				end
				fcx:toast("info", "Onlyne 撤销对端", table.concat(lines, "\n"))
				ask(fcx, { value = tostring(items[1].node_id), placeholder = "要撤销的 node_id", icon = "at-sign", action = "撤销" }, function(node_id, cx1)
					admin("/admin/trust/revoke", { node_id = node_id }, function(result, failure, final_cx)
						if final_cx == nil then
							return
						end
						if failure ~= nil then
							final_cx:toast("error", "Onlyne 撤销对端", failure)
							return
						end
						if type(result) == "table" and type(result.error) == "table" then
							final_cx:toast("error", "Onlyne 撤销对端", tostring(result.error.message or result.error.code))
							return
						end
						final_cx:toast("success", "Onlyne 撤销对端", string.format("%s 已撤销；它需要重新握手并由人类批准", node_id))
					end, true)
				end)
			end)
		end,
	})
end

tern.carly.context(function(_cx: WindowCx): string?
	if #pending_items == 0 then
		return nil
	end
	local sample = ""
	local trust_todos = 0
	for index, item in pending_items do
		if type(item.trust) == "table" and item.trust.actionable == true then
			trust_todos += 1
		end
		if index > 3 then
			break
		end
		local summary = item_summary(item)
		local facts = if summary ~= "" then "（" .. summary .. "）" else ""
		local from = if type(item.trust) == "table" then "信任 " .. tostring(item.trust.node_id) else tostring(item.sender)
		sample = sample .. string.format("%s%s%s: %s", if index == 1 then "" else " | ", from, facts, first_line(item.text, 80))
	end
	local todo = if trust_todos > 0 then string.format("其中 %d 条信任握手等待批准或拒绝。", trust_todos) else ""
	local text = string.format("Onlyne 有 %d 条未读消息。%s%s。用 await(plugins[\"onlyne\"].pending()) 取全文。", #pending_items, todo, sample)
	if #text > 400 then
		text = string.sub(text, 1, 397) .. "..."
	end
	return text
end)

load_woken()
register_exports()
register_commands()

local function start(cx: WindowCx?)
	if started then
		return
	end
	started = true
	info("window started")
	poll(cx)
end

tern.on("window_start", start)
start(nil)
