// main.js —— 端口管理插件（Tier-1，单文件 ESM，禁止任何 import）
// 平台自适应：
//   macOS / Linux：lsof 列端口 + 批量取进程 cwd → 按工作目录名分组（Linux 缺 lsof 时回落 ss -tlnp，仅按进程名分组）
//   Windows：netstat -ano 列端口 + tasklist 补进程名 → 按进程名分组（拿不到 cwd）
//   浏览器：open / xdg-open / cmd /c start；关端口：kill -TERM / taskkill /T /F
// 双语：读 ctx.host.locale 自管 zh-CN / en 字符串表（不依赖宿主 i18n 取词 API）

const REFRESH_MS = 5000;
const EXTERNAL_GROUP = "外部端口";

// ---------- 双语字符串 ----------

const STRINGS = {
  "zh-CN": {
    tabTitle: "端口",
    chipTitle: "端口管理：点击打开端口页签",
    cmdTitle: "打开端口管理",
    cmdKeywords: ["port", "端口", "lsof", "netstat"],
    refresh: "刷新",
    refreshing: "刷新中…",
    wsCount: (n) => n + " 个工作区",
    extCount: (n) => n + " 个外部端口",
    portCount: (n) => n + " 个端口",
    noPorts: "当前没有监听中的 TCP 端口",
    fetchFail: "获取端口列表失败：",
    open: "打开",
    close: "关闭",
    confirmClose: "确认关闭",
    openTip: (port) => "在浏览器打开 http://localhost:" + port,
    killTip: "关闭该端口（结束进程）",
    confirmTip: "再次点击确认关闭",
  },
  en: {
    tabTitle: "Ports",
    chipTitle: "Port manager: click to open the ports tab",
    cmdTitle: "Open Port Manager",
    cmdKeywords: ["port", "ports", "lsof", "netstat"],
    refresh: "Refresh",
    refreshing: "Refreshing…",
    wsCount: (n) => n + " workspaces",
    extCount: (n) => n + " external",
    portCount: (n) => n + " ports",
    noPorts: "No TCP ports currently listening",
    fetchFail: "Failed to get port list: ",
    open: "Open",
    close: "Close",
    confirmClose: "Confirm close",
    openTip: (port) => "Open http://localhost:" + port + " in browser",
    killTip: "Close this port (kill the process)",
    confirmTip: "Click again to confirm",
  },
};

// ---------- 平台探测（结果缓存） ----------

let platformCache = null;

// ---------- 各平台解析器 ----------

function emptyData() {
  return { groups: [], total: 0, external: 0 };
}

function validPort(p) {
  return Number.isInteger(p) && p > 0 && p <= 65535;
}

// lsof LISTEN 输出：列从右往左固定为 NAME (LISTEN)，命令名可能含空格所以不从头切
function parseLsof(stdout) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stdout || "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("COMMAND")) continue;
    const t = line.split(/\s+/);
    if (t.length < 9 || t[t.length - 1] !== "(LISTEN)") continue;
    const name = t[t.length - 2];
    const ci = name.lastIndexOf(":");
    if (ci < 0) continue;
    const port = Number(name.slice(ci + 1));
    const pid = Number(t[1]);
    if (!validPort(port)) continue;
    const key = port + "/" + pid;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, pid, cmd: t[0], addr: name });
  }
  return out;
}

// ss -tlnp：LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1234,fd=3))
function parseSs(stdout) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stdout || "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("LISTEN")) continue;
    const t = line.split(/\s+/);
    if (t.length < 4) continue;
    const addr = t[3];
    const ci = addr.lastIndexOf(":");
    if (ci < 0) continue;
    const port = Number(addr.slice(ci + 1));
    if (!validPort(port)) continue;
    const rest = t.slice(4).join(" ");
    const pids = [...rest.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    const names = [...rest.matchAll(/\(\("([^"]+)"/g)].map((m) => m[1]);
    for (const pid of pids.length ? pids : [0]) {
      const key = port + "/" + pid;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ port, pid, cmd: names[0] || "?", addr });
    }
  }
  return out;
}

// netstat -ano（Windows）：TCP 0.0.0.0:5173 0.0.0.0:0 LISTENING 12345
function parseNetstat(stdout) {
  const out = [];
  const seen = new Set();
  for (const raw of String(stdout || "").split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("TCP")) continue;
    const t = line.split(/\s+/);
    if (t.length < 5 || t[3] !== "LISTENING") continue;
    const addr = t[1];
    const ci = addr.lastIndexOf(":");
    if (ci < 0) continue;
    const port = Number(addr.slice(ci + 1));
    const pid = Number(t[4]);
    if (!validPort(port)) continue;
    const key = port + "/" + pid;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, pid, cmd: "", addr });
  }
  return out;
}

// tasklist /fo csv /nh："chrome.exe","1234","Console",...
function parseTasklist(stdout, map) {
  for (const raw of String(stdout || "").split("\n")) {
    const m = raw.match(/^"([^"]*)"\s*,\s*"?(\d+)"?/);
    if (m) map[Number(m[2])] = m[1];
  }
}

// lsof -Fn 格式的 cwd：p<pid> 行后跟（可跳过 f 行）n<路径> 行
function parseCwds(stdout, map) {
  let pid = 0;
  for (const raw of String(stdout || "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n") && pid > 0) {
      map[pid] = line.slice(1);
      pid = 0;
    }
  }
}

function basenameOf(p) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

// ---------- 数据组装 ----------

// 按组名合并端口；同组同端口合并多个 PID
function buildGroups(listeners, hasCwd) {
  const byGroup = new Map();
  let external = 0;
  for (const l of listeners) {
    let gname;
    if (hasCwd) {
      // cwd 为 "/"（launchd 等系统进程）视为外部端口，不算工作区
      gname = l.cwd && l.cwd !== "/" ? basenameOf(l.cwd) : EXTERNAL_GROUP;
      if (gname === EXTERNAL_GROUP) external += 1;
    } else {
      gname = l.cmd || "?";
    }
    let g = byGroup.get(gname);
    if (!g) {
      g = { name: gname, cwd: l.cwd || null, ports: new Map() };
      byGroup.set(gname, g);
    }
    let p = g.ports.get(l.port);
    if (!p) {
      p = { port: l.port, addrs: [], cmds: [], pids: [] };
      g.ports.set(l.port, p);
    }
    if (!p.addrs.includes(l.addr)) p.addrs.push(l.addr);
    if (l.cmd && !p.cmds.includes(l.cmd)) p.cmds.push(l.cmd);
    if (!p.pids.includes(l.pid)) p.pids.push(l.pid);
  }
  const groups = [...byGroup.values()].map((g) => ({
    name: g.name,
    cwd: g.cwd,
    ports: [...g.ports.values()]
      .sort((a, b) => a.port - b.port)
      .map((p) => ({
        port: p.port,
        addr: p.addrs.find((a) => a.startsWith("localhost") || a.startsWith("127.0.0.1")) || p.addrs[0],
        addrs: p.addrs,
        cmd: p.cmds.join(", ") || "?",
        pids: p.pids,
      })),
  }));
  groups.sort((a, b) => {
    if (a.name === EXTERNAL_GROUP) return 1;
    if (b.name === EXTERNAL_GROUP) return -1;
    return a.name.localeCompare(b.name, "zh-Hans");
  });
  return { groups, total: listeners.length, external };
}

// ---------- 组件样式 ----------

const s = {
  wrap: { padding: 12, fontFamily: "ui-sans-serif, -apple-system, sans-serif", fontSize: 13, overflow: "auto", height: "100%", boxSizing: "border-box" },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  count: { color: "var(--text-secondary, #888)", marginRight: 12 },
  btn: { border: "1px solid var(--border-default, #ddd)", background: "transparent", borderRadius: 6, padding: "4px 10px", cursor: "pointer" },
  error: { color: "#c0392b", padding: "8px 0", whiteSpace: "pre-wrap" },
  empty: { color: "var(--text-secondary, #888)", padding: 24, textAlign: "center" },
  group: { marginBottom: 10 },
  groupHead: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 6, background: "var(--background-secondary, rgba(127,127,127,0.08))", fontWeight: 600, cursor: "pointer", userSelect: "none" },
  chevron: { display: "inline-block", width: 14, color: "var(--text-secondary, #888)", transition: "transform 0.15s" },
  groupCount: { marginLeft: "auto", color: "var(--text-secondary, #888)", fontWeight: 400, fontSize: 12 },
  row: { display: "flex", alignItems: "center", gap: 10, padding: "7px 8px", borderBottom: "1px solid var(--border-muted, rgba(127,127,127,0.15))" },
  port: { fontWeight: 700, minWidth: 56, fontVariantNumeric: "tabular-nums" },
  cmd: { color: "var(--text-secondary, #888)", minWidth: 72 },
  addr: { flex: 1, color: "var(--text-secondary, #888)", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12 },
  act: { border: "none", background: "transparent", cursor: "pointer", padding: "2px 6px", borderRadius: 4, fontSize: 12 },
  actOpen: { color: "var(--text-accent, #0969da)" },
  actKill: { color: "#c0392b" },
  chip: { border: "none", background: "transparent", cursor: "pointer", font: "inherit", color: "inherit", display: "inline-flex", alignItems: "center", gap: 4, padding: "0 6px" },
  load: { color: "var(--text-secondary, #888)", fontSize: 12 },
};

// ---------- 插件入口 ----------

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useCallback } = ctx.react;

  // 工作区解析缓存：进程 cwd → 所属 git 仓库顶层目录（null = 非 git 目录）
  const wsCache = new Map();

  // 双语：宿主 locale 以 zh 开头用中文，否则英文
  const t = String(ctx.host.locale || "").toLowerCase().startsWith("zh")
    ? STRINGS["zh-CN"]
    : STRINGS.en;

  async function run(bin, args, timeoutMs = 8000) {
    return ctx.bridge.invoke("plugin_exec_run", { bin, args, timeoutMs });
  }

  async function detectPlatform() {
    if (platformCache) return platformCache;
    try {
      const res = await run("uname", ["-s"], 3000);
      const s = String(res.stdout || "").trim();
      if (/^(MING|MSYS|CYGWIN)/i.test(s)) platformCache = "win";
      else platformCache = s === "Darwin" ? "mac" : "linux";
    } catch {
      platformCache = "win"; // 无 uname 的环境按 Windows 处理
    }
    return platformCache;
  }

  async function fetchPorts() {
    const platform = await detectPlatform();
    let listeners = [];
    let cwds = {};

    if (platform === "win") {
      const [net, tl] = await Promise.all([
        run("netstat", ["-ano"]),
        run("tasklist", ["/fo", "csv", "/nh"]).catch(() => ({ stdout: "" })),
      ]);
      listeners = parseNetstat(net.stdout);
      const names = {};
      parseTasklist(tl.stdout, names);
      for (const l of listeners) {
        const n = names[l.pid] || "?";
        l.cmd = n.replace(/\.exe$/i, "");
      }
    } else {
      try {
        const res = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "+c0"]);
        listeners = parseLsof(res.stdout);
        const pids = [...new Set(listeners.map((l) => l.pid))].filter((p) => p > 0);
        if (pids.length) {
          try {
            const r2 = await run("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"]);
            parseCwds(r2.stdout, cwds);
          } catch {
            // cwd 解析失败不致命：按进程名分组
          }
        }
        // 工作区自动识别：cwd → git rev-parse 反查仓库顶层目录（AgentDemo/xxx/admin → AgentDemo）
        // 结果按 cwd 缓存，只有新出现的 cwd 才触发 git 调用；非 git 目录回落 basename 分组
        const cwdSet = [...new Set(Object.values(cwds).filter((c) => c && c !== "/"))];
        const resolved = await Promise.all(cwdSet.map(async (c) => {
          if (wsCache.has(c)) return wsCache.get(c);
          let top = null;
          try {
            const r = await run("git", ["-C", c, "rev-parse", "--show-toplevel"], 4000);
            top = String(r.stdout || "").trim() || null;
          } catch {
            top = null; // 无 git / 非 git 仓库 / 超时
          }
          wsCache.set(c, top);
          return top;
        }));
        const topByCwd = {};
        cwdSet.forEach((c, i) => { topByCwd[c] = resolved[i]; });
        for (const l of listeners) {
          const c = cwds[l.pid];
          if (c && c !== "/" && topByCwd[c]) l.cwd = topByCwd[c];
          else l.cwd = c || null;
        }
      } catch (e) {
        if (platform === "mac") throw e;
        // Linux 无 lsof：回落 ss（仅能按进程名分组，pid=0 的行无法关闭）
        const r = await run("ss", ["-tlnp"]);
        listeners = parseSs(r.stdout);
        for (const l of listeners) l.cwd = null;
      }
    }

    const hasCwd = listeners.some((l) => l.cwd);
    return buildGroups(listeners, hasCwd);
  }

  // 折叠状态持久化（key: collapsed -> { 组名: true }）
  function useCollapsed() {
    const [collapsed, setCollapsed] = useState({});
    useEffect(() => {
      let alive = true;
      void ctx.storage.get("collapsed").then((v) => {
        if (alive && v && typeof v === "object") setCollapsed(v);
      });
      return () => { alive = false; };
    }, []);
    const toggle = useCallback((name) => {
      setCollapsed((prev) => {
        const next = { ...prev, [name]: !prev[name] };
        void ctx.storage.set("collapsed", next);
        return next;
      });
    }, []);
    return [collapsed, toggle];
  }

  function usePorts() {
    const [state, setState] = useState({ loading: true, error: null, data: emptyData() });
    const refresh = useCallback(async () => {
      try {
        const data = await fetchPorts();
        setState({ loading: false, error: null, data });
      } catch (e) {
        setState({ loading: false, error: String((e && e.message) || e), data: emptyData() });
      }
    }, []);
    useEffect(() => {
      void refresh();
      const t = setInterval(() => void refresh(), REFRESH_MS);
      return () => clearInterval(t);
    }, [refresh]);
    return { ...state, refresh };
  }

  function useConfirmTimeout() {
    const [confirming, setConfirming] = useState(false);
    useEffect(() => {
      if (!confirming) return undefined;
      const t = setTimeout(() => setConfirming(false), 3000);
      return () => clearTimeout(t);
    }, [confirming]);
    return [confirming, setConfirming];
  }

  async function openInBrowser(port) {
    const url = "http://localhost:" + port;
    const platform = await detectPlatform();
    try {
      if (platform === "mac") await run("open", [url]);
      else if (platform === "linux") await run("xdg-open", [url]);
      else await run("cmd", ["/c", "start", "", url]);
    } catch {
      // 打开失败静默：浏览器可能是极简安装，用户可手动复制地址
    }
  }

  async function killPort(p) {
    const platform = await detectPlatform();
    if (platform === "win") {
      const args = ["/T", "/F"];
      for (const pid of p.pids) args.push("/PID", String(pid));
      await run("taskkill", args);
    } else {
      await run("kill", ["-TERM"].concat(p.pids.filter((x) => x > 0).map(String)));
    }
  }

  function PortRow({ p, onKilled }) {
    const [confirming, setConfirming] = useConfirmTimeout();
    const canKill = p.pids.some((x) => x > 0);
    const kill = async () => {
      if (!canKill) return;
      if (!confirming) {
        setConfirming(true);
        return;
      }
      try {
        await killPort(p);
      } catch {
        // 进程可能已退出，刷新即可见
      }
      onKilled();
    };
    return h("div", { style: s.row },
      h("span", { style: s.port }, String(p.port)),
      h("span", { style: s.cmd }, p.cmd),
      h("span", { style: s.addr }, p.addrs.join("  ")),
      h("button", { style: { ...s.act, ...s.actOpen }, onClick: () => void openInBrowser(p.port), title: t.openTip(p.port) }, t.open),
      canKill && h("button", {
        style: { ...s.act, ...s.actKill, fontWeight: confirming ? 700 : 400 },
        onClick: () => void kill(),
        title: confirming ? t.confirmTip : t.killTip,
      }, confirming ? t.confirmClose : t.close));
  }

  function GroupSection({ g, collapsed, onToggle, onKilled }) {
    const isCollapsed = !!collapsed[g.name];
    return h("div", { style: s.group },
      h("div", { style: s.groupHead, onClick: () => onToggle(g.name), title: g.cwd || g.name },
        h("span", { style: { ...s.chevron, transform: isCollapsed ? "none" : "rotate(90deg)" } }, "▶"),
        h("span", null, g.name),
        h("span", { style: s.groupCount }, t.portCount(g.ports.length))),
      !isCollapsed && g.ports.map((p) => h(PortRow, { key: p.port, p, onKilled })));
  }

  function PortsCenter() {
    const { loading, error, data, refresh } = usePorts();
    const [collapsed, toggle] = useCollapsed();
    const wsCount = data.groups.filter((g) => g.name !== EXTERNAL_GROUP).length;
    return h("div", { style: s.wrap },
      h("div", { style: s.header },
        h("div", null,
          h("span", { style: s.count }, t.wsCount(wsCount)),
          h("span", { style: s.count }, t.extCount(data.external)),
          loading && h("span", { style: s.load }, t.refreshing)),
        h("button", { style: s.btn, onClick: () => void refresh() }, t.refresh)),
      error && h("div", { style: s.error }, t.fetchFail + error),
      !error && !loading && data.total === 0 && h("div", { style: s.empty }, t.noPorts),
      data.groups.map((g) => h(GroupSection, {
        key: g.name, g, collapsed, onToggle: toggle, onKilled: () => void refresh(),
      })));
  }

  function PortsChip() {
    const { data } = usePorts();
    return h("button", {
      style: s.chip,
      onClick: () => ctx.ui.openCenterTab("ports"),
      title: t.chipTitle,
    }, "⚡ " + data.total);
  }

  const disposeTab = ctx.ui.registerCenterTab({
    key: "ports",
    title: () => t.tabTitle,
    component: PortsCenter,
  });
  const disposeChip = ctx.ui.registerStatusBarItem({
    key: "ports",
    component: PortsChip,
    zone: "end",
  });
  const disposeCmd = ctx.ui.registerCommand({
    key: "open-port-manager",
    title: () => t.cmdTitle,
    keywords: () => t.cmdKeywords,
    run: () => ctx.ui.openCenterTab("ports"),
  });

  return () => {
    disposeCmd();
    disposeChip();
    disposeTab();
  };
}
