--!strict
-- Onlyne host half: supervises the companion process. The companion owns the protocol
-- node, the SQLite state and the maintenance loop; the window half reaches it over its
-- loopback admin API. This half only starts it, watches it, and restarts it when the
-- window asks for a reload (kv key `onlyne.restart` changes).

local CONFIG_KEY = "onlyne.config"
local RESTART_KEY = "onlyne.restart"
local PROBE_MS = 15000
local GRACE_MS = 20000

local spawned = false
local spawned_at = 0
local failures = 0
local idle_failures = 0
local retry_at = 0
local retry_delay = 5000
local last_restart: any = nil

local function info(...)
	tern.log.info("onlyne:", ...)
end

local function warn(...)
	tern.log.warn("onlyne:", ...)
end

local function data_dir(): string
	return tern.plugin.data
end

local function server_path(): string
	return data_dir() .. "/server.json"
end

local function read_server(): { port: number, token: string, pid: number }?
	if not tern.fs.exists(server_path()) then
		return nil
	end
	local ok, value = pcall(function()
		return tern.json.decode(tern.fs.read(server_path(), 65536))
	end)
	if not ok or type(value) ~= "table" then
		return nil
	end
	local port, token, pid = value.port, value.token, value.pid
	if type(port) ~= "number" or type(token) ~= "string" then
		return nil
	end
	return { port = port, token = token, pid = if type(pid) == "number" then pid else 0 }
end

local function config(): { [string]: any }?
	local ok, value = pcall(tern.kv.get, CONFIG_KEY)
	if not ok or type(value) ~= "table" then
		return nil
	end
	if type(value.node_id) ~= "string" or type(value.region) ~= "string" then
		return nil
	end
	return value
end

local function bun_binary(): string
	local home = tern.getenv("HOME") or ""
	local candidates = { home .. "/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun" }
	for _, path in candidates do
		if string.sub(path, 1, 1) == "/" and tern.fs.exists(path) then
			return path
		end
	end
	return "bun"
end

local function companion_entry(): string
	local bundled = tern.plugin.dir .. "/dist/companion.js"
	if tern.fs.exists(bundled) then
		return bundled
	end
	return tern.plugin.dir .. "/server/main.ts"
end

local function spawn()
	if spawned or config() == nil then
		return
	end
	if tern.now() < retry_at then
		return
	end
	spawned = true
	spawned_at = tern.now()
	failures = 0
	idle_failures = 0
	local argv = { bun_binary(), companion_entry() }
	info("starting companion", argv[1], argv[2])
	local ok, err = pcall(tern.process.run, argv, {
		cwd = tern.plugin.dir,
		env = { ONLYNE_DATA = data_dir() },
	}, function(result: ProcessResult)
		spawned = false
		local uptime = tern.now() - spawned_at
		retry_delay = if uptime < 10000 then math.min(retry_delay * 2, 120000) else 5000
		retry_at = tern.now() + retry_delay
		warn("companion exited", result.status, "uptime_ms", math.floor(uptime), "retry_ms", retry_delay)
	end)
	if not ok then
		spawned = false
		warn("companion failed to start", tostring(err))
	end
end

local function probe(cb: (boolean) -> ())
	local server = read_server()
	if server == nil then
		cb(false)
		return
	end
	tern.fetch("http://127.0.0.1:" .. tostring(server.port) .. "/admin/status", {
		headers = { ["x-onlyne-admin-token"] = server.token },
		timeout_ms = 2000,
	}, function(result: FetchResult)
		cb(result.error == nil and result.status == 200)
	end)
end

local function stop_companion()
	local server = read_server()
	if server == nil or server.pid <= 0 then
		return
	end
	info("stopping companion", server.pid)
	pcall(tern.process.run, { "/bin/kill", tostring(server.pid) }, function(_result: ProcessResult) end)
end

local function tick(_cx: WindowCx?)
	local restart = tern.kv.get(RESTART_KEY)
	if type(restart) == "number" and restart ~= last_restart then
		last_restart = restart
		stop_companion()
		spawned = false
		retry_at = 0
		retry_delay = 5000
	end
	if spawned then
		-- A fresh child needs time to bind before a failed probe counts against it.
		if tern.now() - spawned_at > GRACE_MS then
			probe(function(up)
				if up then
					failures = 0
				else
					failures += 1
					if failures >= 3 then
						failures = 0
						spawned = false
						warn("companion stopped answering; restarting")
					end
				end
			end)
		end
	else
		probe(function(up)
			if up then
				idle_failures = 0
			else
				idle_failures += 1
			end
			-- One failed probe can be a companion that is still binding; two in a row is gone.
			if idle_failures >= 2 then
				spawn()
			end
		end)
	end
	tern.timer(PROBE_MS, tick)
end

local ok, initial = pcall(tern.kv.get, RESTART_KEY)
last_restart = if ok then initial else nil
if config() == nil then
	warn("onlyne.config is missing; set a node id and region, then run the plugin again")
end
tick(nil)
