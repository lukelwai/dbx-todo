/*
 * 待办 Todo —— 存储层（严格按 DBX 官方插件 SDK 的桥接语义实现）
 * ==========================================================================
 *
 * 官方 SDK 定义的 window.dbxPlugin 形状：
 *
 *   window.dbxPlugin = {
 *     ready,                    // Promise<工作台上下文>  ← resolve 的是【纯数据】，不是 API！
 *     get context(),            // 同步读工作台上下文
 *     get locale(), get theme(), get capabilities(),
 *     invoke(method, params, { timeoutMs }),   // 调【侧车】（后端）
 *     request(method, params),                 // 调【宿主】（host.getContext ...）
 *     notify(...), onContext(fn), onInit(fn), ...
 *   }
 *
 * 三条硬规则：
 *   1. API 对象永远是 window.dbxPlugin 本身。绝不能把 ready 的结果当宿主对象用。
 *   2. 侧车 RPC 走 dbxPlugin.invoke(method, params, { timeoutMs })；
 *      宿主方法走 dbxPlugin.request(method, params)。两者不可混用。
 *   3. 前端不碰磁盘（sandbox iframe opaque origin），唯一落盘通道是
 *      invoke() → Go 侧车 → .todo/todos.db。绝不在 localStorage 静默退化。
 *
 * 存储目录三层保险（与 dbx-md-notes 同范式）：
 *   a) connection/connect 把 storage_dir 交给侧车；
 *   b) 侧车持久化到 <DBX_PLUGIN_DATA_DIR>/config.json；
 *   c) 前端若从工作台上下文读到 storage_dir，额外 invoke("todos/setDir") 兜底。
 */
(function () {
  "use strict";

  var TD = window.TodoStore = window.TodoStore || {};

  var RPC_TIMEOUT = 30000;
  var READY_TIMEOUT = 8000;
  var CTX_TIMEOUT = 2500;
  var PING_TIMEOUT = 6000;
  var BRIDGE_TIMEOUT = 8000;
  var BRIDGE_PAYLOAD_LIMIT = 1.9 * 1024 * 1024; // 宿主上限 2 MiB，留余量
  var SAVE_DEBOUNCE = 400;

  /* ============ 诊断日志（页面级错误兜底 + 看门狗共用） ============ */

  var UI_VERSION = "0.1.3";   // 打包脚本会校验它与 manifest.version 一致
  var T0 = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  function since() {
    var t = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
    return t - T0;
  }

  var diag = [];
  var diagListeners = [];

  function note(step, ok, detail) {
    diag.push({
      at: Date.now(),
      t: since(),
      ok: (ok === true || ok === false) ? ok : null,
      step: step,
      detail: detail ? String(detail).slice(0, 500) : ""
    });
    if (diag.length > 150) { diag.shift(); }
    for (var i = 0; i < diagListeners.length; i++) {
      try { diagListeners[i](); } catch (e) { /* ignore */ }
    }
  }

  function onDiag(fn) { if (typeof fn === "function") { diagListeners.push(fn); } }

  function diagLines() {
    return diag.map(function (d) {
      var mark = d.ok === true ? "[ OK ]" : (d.ok === false ? "[FAIL]" : "[ .. ]");
      return "+" + (d.t / 1000).toFixed(3) + "s " + mark + " " + d.step
        + (d.detail ? "  ->  " + d.detail : "");
    });
  }

  function errText(e) {
    if (!e) { return "未知错误"; }
    if (typeof e === "string") { return e; }
    if (e.message) { return String(e.message); }
    if (e.error) { return String(e.error); }
    try { return JSON.stringify(e).slice(0, 300); } catch (e2) { return String(e); }
  }

  function isSandboxed() {
    // 沙箱 iframe 是 opaque origin：window.origin 为字符串 "null"；
    // 个别宿主直接抛异常，那更说明在受限环境里。
    try { return String(window.origin) === "null"; } catch (e) { return true; }
  }

  function envSnapshot() {
    var a = null, keys = [], origin = "?";
    try { a = window.dbxPlugin; } catch (e) { a = null; }
    try { origin = String(window.origin); } catch (e) { origin = "?"; }
    try { keys = a ? Object.keys(a).slice(0, 30) : []; } catch (e) { keys = []; }
    return "origin=" + origin
      + " · sandboxed=" + isSandboxed()
      + " · typeof window.dbxPlugin=" + (a ? typeof a : "undefined")
      + " · invoke=" + (a ? typeof a.invoke : "-")
      + " · request=" + (a ? typeof a.request : "-")
      + " · ready=" + (a && a.ready ? typeof a.ready.then : "-")
      + " · keys=[" + keys.join(",") + "]"
      + " · readyState=" + document.readyState;
  }

  function report() {
    var st = status;
    var L = [];
    L.push("=== DBX 待办 Todo · 存储诊断报告 ===");
    L.push("时间：" + new Date().toLocaleString("zh-CN"));
    L.push("UI 版本：" + UI_VERSION);
    L.push("页面：" + (function () { try { return String(location.href); } catch (e) { return "?"; } })());
    L.push("UA：" + navigator.userAgent);
    L.push("");
    L.push("--- 环境 ---");
    L.push(envSnapshot());
    L.push("");
    L.push("--- 状态 ---");
    L.push("backend=" + st.backend + " · persistent=" + st.persistent + " · ok=" + st.ok
      + " · available=" + st.available);
    L.push("hostAvailable=" + st.hostAvailable + " · sidecarAvailable=" + st.sidecarAvailable);
    L.push("connectionId=" + (st.connectionId || "(空)"));
    L.push("storageDir=" + (st.storageDir || "(空)") + " · dirConfigured=" + st.dirConfigured);
    L.push("sidecarError=" + (st.sidecarError || "(无)"));
    L.push("lastError=" + (st.lastError || "(无)"));
    L.push("payloadBytes=" + st.payloadBytes + " · lastSavedAt="
      + (st.lastSavedAt ? new Date(st.lastSavedAt).toLocaleString("zh-CN") : "(尚无)"));
    L.push("");
    L.push("--- 诊断日志（" + diag.length + " 条，最早在上）---");
    L.push(diagLines().join("\n") || "(无)");
    return L.join("\n");
  }

  note("存储模块加载完成（等待 UI 调用 init）", null, "UI 版本 " + UI_VERSION);

  /* ============================ 状态 ============================ */

  var listeners = [];
  var status = {
    backend: "unknown",
    persistent: false,
    available: false,
    ok: true,
    lastError: "",
    lastSavedAt: 0,
    hostAvailable: false,
    sidecarAvailable: false,
    sidecarError: "",
    connectionId: "",
    storageDir: "",
    dirConfigured: false,
    backupOnly: false,
    payloadBytes: 0,
    rev: 0
  };

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](status); } catch (e) { /* ignore */ }
    }
  }
  function setStatus(patch) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) { status[k] = patch[k]; }
    }
    emit();
  }

  /* ============================ 小工具 ============================ */

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function withTimeout(promise, ms, msg) {
    var timer = null;
    var gate = new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error(msg + "（" + ms + "ms 未响应）")); }, ms);
    });
    function clear() { if (timer) { clearTimeout(timer); timer = null; } }
    return Promise.race([Promise.resolve(promise), gate]).then(
      function (v) { clear(); return v; },
      function (e) { clear(); throw e; }
    );
  }

  function settle(promise) {
    return Promise.resolve(promise).then(
      function (v) { return { ok: true, value: v }; },
      function (e) { return { ok: false, error: e }; }
    );
  }

  function nonEmptyStr(v) {
    return (typeof v === "string" && v.trim()) ? v.trim() : "";
  }

  /* ====================== 宿主桥接获取 ====================== */

  var api = null;
  var apiReady = false;

  function waitBridge(ms) {
    if (api) { return Promise.resolve(api); }
    var deadline = Date.now() + ms;
    return (function poll() {
      if (window.dbxPlugin && typeof window.dbxPlugin === "object") {
        api = window.dbxPlugin;
        return Promise.resolve(api);
      }
      if (Date.now() >= deadline) { return Promise.resolve(null); }
      return delay(25).then(poll);
    })();
  }

  function waitReady(a) {
    if (apiReady) { return Promise.resolve(true); }
    var ready = (a && a.ready && typeof a.ready.then === "function") ? a.ready : Promise.resolve();
    return settle(withTimeout(ready, READY_TIMEOUT, "等待宿主 dbxPlugin.ready")).then(function (r) {
      apiReady = r.ok;
      note("宿主桥接 ready（dbxPlugin.ready）", r.ok, r.ok ? "已收到宿主 init 消息" : errText(r.error));
      return r.ok;
    });
  }

  function readContext(a) {
    var sync = null;
    try { sync = a && a.context; } catch (e) { sync = null; }
    if (sync && typeof sync === "object" && Object.keys(sync).length) {
      note("工作台上下文（同步 dbxPlugin.context）", true, describeCtx(sync));
      return Promise.resolve(sync);
    }
    if (a && typeof a.request === "function") {
      return settle(withTimeout(a.request("host.getContext", {}), CTX_TIMEOUT, "请求 host.getContext"))
        .then(function (r) {
          var ctx = (r.ok && r.value && typeof r.value === "object") ? r.value : {};
          var has = Object.keys(ctx).length > 0;
          note("工作台上下文（兜底 host.getContext）", r.ok && has,
            r.ok ? describeCtx(ctx) : errText(r.error));
          return ctx;
        });
    }
    note("工作台上下文", false, "宿主既未提供同步 context，也无 request 方法");
    return Promise.resolve({});
  }

  function describeCtx(ctx) {
    var keys = Object.keys(ctx || {});
    return "字段 [" + keys.slice(0, 8).join(", ") + (keys.length > 8 ? ", …" : "") + "]";
  }

  var DIR_KEYS = ["storage_dir", "storageDir", "storage_path", "storagePath", "todo_dir", "todoDir"];
  function extractPath(obj, keys, depth) {
    if (!obj || typeof obj !== "object" || depth > 4) { return ""; }
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (nonEmptyStr(v)) { return nonEmptyStr(v); }
    }
    var names = Object.keys(obj);
    for (var j = 0; j < names.length; j++) {
      var child = obj[names[j]];
      if (child && typeof child === "object") {
        var found = extractPath(child, keys, depth + 1);
        if (found) { return found; }
      }
    }
    return "";
  }

  function extractContext(ctx) {
    var connectionId = "";
    var storageDir = "";
    try {
      connectionId = nonEmptyStr(ctx.connectionId)
        || nonEmptyStr(ctx.connection && ctx.connection.id)
        || "";
      var ec = ctx.external_config || (ctx.connection && ctx.connection.external_config);
      if (ec) {
        for (var i = 0; i < DIR_KEYS.length; i++) {
          storageDir = nonEmptyStr(ec[DIR_KEYS[i]]);
          if (storageDir) { break; }
        }
      }
      if (!storageDir) { storageDir = extractPath(ctx, DIR_KEYS, 0); }
    } catch (e) { /* ignore */ }
    return { connectionId: connectionId, storageDir: storageDir };
  }

  /* ====================== 侧车通道（唯一真实持久化） ====================== */

  var client = null;
  var currentRev = 0;   // 侧车文档并发版本号（_rev）。load 时写入，save 时回声回去。

  function rpcRaw(method, params, timeoutMs) {
    if (!client || !client.api || typeof client.api.invoke !== "function") {
      return Promise.reject(new Error("侧车通道未就绪（宿主未提供 dbxPlugin.invoke）"));
    }
    var payload = {};
    if (client.connectionId) { payload.connectionId = client.connectionId; }
    for (var k in (params || {})) {
      if (Object.prototype.hasOwnProperty.call(params, k)) { payload[k] = params[k]; }
    }
    var out;
    try {
      out = client.api.invoke(method, payload, { timeoutMs: timeoutMs || RPC_TIMEOUT });
    } catch (e) {
      return Promise.reject(new Error(method + " 调用失败：" + errText(e)));
    }
    return Promise.resolve(out);
  }

  function rpc(method, params, timeoutMs) {
    var started = since();
    var ms = function () { return (since() - started).toFixed(0) + "ms"; };
    return rpcRaw(method, params, timeoutMs).then(function (res) {
      if (res && typeof res === "object" && res.error && !res.ok && !res.data && !res.path && !res.dir) {
        note("侧车调用 " + method, false, ms() + " · " + errText(res.error));
        throw new Error(errText(res.error));
      }
      var out = res;
      if (res && typeof res === "object" && res.result !== undefined
        && res.ok === undefined && res.data === undefined && res.path === undefined && res.dir === undefined) {
        out = res.result;
      }
      note("侧车调用 " + method, true, ms());
      return out;
    }, function (err) {
      note("侧车调用 " + method, false, ms() + " · " + errText(err));
      throw err;
    });
  }

  /* ============================ 当前后端 ============================ */

  var current = null;
  var flushTimer = null;
  var pendingData = null;

  function memoryBackend() {
    var mem = null;
    return {
      name: "memory",
      persistent: false,
      available: function () { return true; },
      read: function () { return mem; },
      write: function (data) { mem = data; return true; }
    };
  }

  function readCurrent() {
    if (!current) { current = memoryBackend(); }
    var read = null;
    try { read = current.read(); } catch (e) { read = null; }
    return Promise.resolve(read).then(function (d) {
      if (d && d.data !== undefined) {
        return {
          data: (d.data && typeof d.data === "object") ? d.data : null,
          backend: current.name,
          persistent: current.persistent,
          firstRun: !(d.data && d.data.groups)
        };
      }
      return {
        data: d || null,
        backend: current.name,
        persistent: current.persistent,
        firstRun: !d
      };
    }).catch(function (err) {
      setStatus({ ok: false, lastError: errText(err) });
      note("读取待办数据", false, errText(err));
      return { data: null, backend: current ? current.name : "memory", persistent: false, firstRun: true };
    });
  }

  /* ============================ 初始化 ============================ */

  function failHard(reason) {
    setStatus({
      backend: "none", persistent: false, available: false, ok: false,
      sidecarAvailable: false, sidecarError: reason, lastError: reason,
      backupOnly: true
    });
    current = memoryBackend();
    client = null;
  }

  var initCalled = false;
  var initStartedAt = 0;

  function init() {
    initCalled = true;
    initStartedAt = since();
    note("=== 存储初始化开始 ===", null, UI_VERSION + " @ " + new Date().toLocaleTimeString("zh-CN"));
    note("环境快照", null, envSnapshot());
    return waitBridge(BRIDGE_TIMEOUT).then(function (a) {
      note("等 window.dbxPlugin 注入", !!a, (since() - initStartedAt).toFixed(0) + "ms"
        + (a ? " · 已拿到" : " · 超时 " + BRIDGE_TIMEOUT + "ms"));
      if (!a) {
        var msg = "宿主未注入 window.dbxPlugin（当前不在 DBX 插件工作台内）";
        note("获取 dbxPlugin 桥接", false, msg);
        setStatus({ hostAvailable: false });
        failHard(msg);
        return fallbackResult(msg);
      }
      note("获取 dbxPlugin 桥接", true, "已有 invoke=" + (typeof a.invoke) + " request=" + (typeof a.request));
      setStatus({ hostAvailable: true });

      return waitReady(a).then(function () {
        return readContext(a);
      }).then(function (ctx) {
        var info = extractContext(ctx);
        setStatus({
          connectionId: info.connectionId,
          storageDir: info.storageDir
        });
        note("解析连接上下文", !!info.connectionId || !!info.storageDir,
          "connectionId=" + (info.connectionId || "（无）") + " storage_dir=" + (info.storageDir || "（无，侧车侧自持）"));

        client = { api: a, connectionId: info.connectionId, storageDir: info.storageDir };

        if (typeof a.onContext === "function") {
          try {
            a.onContext(function (next) {
              var nx = extractContext(next || {});
              if (nx.connectionId) { status.connectionId = nx.connectionId; }
              if (nx.storageDir) { status.storageDir = nx.storageDir; }
              if (client) {
                client.connectionId = nx.connectionId || client.connectionId;
                client.storageDir = nx.storageDir || client.storageDir;
              }
              emit();
            });
          } catch (e) { /* 老宿主无 onContext，忽略 */ }
        }

        return settle(withTimeout(rpc("todos/ping", {}, PING_TIMEOUT), PING_TIMEOUT + 500, "侧车握手 todos/ping"))
          .then(function (r) {
            if (!r.ok) {
              var why = "侧车不可用：" + errText(r.error);
              note("侧车握手 todos/ping", false, errText(r.error));
              failHard(why);
              return fallbackResult(why);
            }
            var pl = r.value || {};
            note("侧车握手 todos/ping", true,
              "version=" + (pl.version || "?") + " dir=" + (pl.dir || "（未回报）")
              + " configured=" + (pl.configured === true));

            current = sidecarBackend();
            setStatus({
              backend: "sidecar", persistent: true, available: true, ok: true,
              lastError: "", sidecarAvailable: true, sidecarError: "",
              backupOnly: false,
              storageDir: nonEmptyStr(pl.dir) || status.storageDir,
              dirConfigured: pl.configured === true
            });

            if (info.storageDir) {
              settle(rpc("todos/setDir", { dir: info.storageDir }, PING_TIMEOUT)).then(function (s) {
                note("同步存储目录到侧车 todos/setDir", s.ok,
                  s.ok ? ((s.value && s.value.dir) || info.storageDir) : errText(s.error));
                if (s.ok && s.value) {
                  setStatus({
                    storageDir: nonEmptyStr(s.value.dir) || status.storageDir
                  });
                }
              });
            }

            return readCurrent().then(function (r) {
              r.connectionId = status.connectionId;
              r.storageDir = status.storageDir;
              note("读取待办 todos/load", true,
                "分组数=" + ((r.data && r.data.groups && r.data.groups.length) || 0)
                + " 任务数=" + ((r.data && r.data.tasks && r.data.tasks.length) || 0)
                + " firstRun=" + r.firstRun);
              return r;
            });
          });
      });
    }).catch(function (err) {
      var msg = "存储初始化异常：" + errText(err);
      note("存储初始化", false, errText(err));
      failHard(msg);
      return fallbackResult(msg);
    });
  }

  function fallbackResult(reason) {
    return readCurrent().then(function (r) {
      r.connectionId = status.connectionId;
      r.storageDir = "";
      r.backupOnly = true;
      r.error = reason;
      return r;
    });
  }

  /* ====================== 侧车后端实现 ====================== */

  function jsonBytes(v) {
    try { return new Blob([JSON.stringify(v)]).size; }
    catch (e) {
      try { return JSON.stringify(v).length; } catch (e2) { return 0; }
    }
  }

  function sidecarBackend() {
    return {
      name: "sidecar",
      persistent: true,
      available: function () { return true; },
      read: function () {
        return rpc("todos/load", {}, RPC_TIMEOUT).then(function (pl) {
          if (!pl || typeof pl !== "object") { return null; }
          if (typeof pl.rev === "number") { currentRev = pl.rev; }
          setStatus({
            storageDir: nonEmptyStr(pl.dir) || status.storageDir,
            dirConfigured: pl.configured === true,
            rev: (typeof pl.rev === "number") ? pl.rev : status.rev
          });
          return { data: pl.data || null };
        });
      },
      write: function (data) {
        var bytes = jsonBytes(data);
        setStatus({ payloadBytes: bytes });
        if (bytes > BRIDGE_PAYLOAD_LIMIT) {
          var over = "待办数据整体大小 " + Math.round(bytes / 1024) + " KB 超过宿主桥接单次上限（2 MB）。"
            + "请拆分或精简内容后重试。";
          note("todos/save 负载检查", false, over);
          return Promise.reject(new Error(over));
        }
        var extra = { data: data, rev: currentRev };
        if (client && client.storageDir) { extra.storage_dir = client.storageDir; }
        return attemptSave(extra, 0);
      }
    };
  }

  /* ====================== 保存重试：处理 _rev 并发冲突 ======================
   * 单会话（一个前端 + 一个侧车）正常流程不会冲突：每次 load 拿到 rev、save 回声回去、
   * 侧车递增 rev 并回传，前端再更新 currentRev。只有在前端手里的 rev 落后于磁盘
   * （例如被其它进程改过）时才会出现 conflict。此时刷新服务器最新 rev 后重试一次，
   * 既避免单会话下「二次保存必失败」，也保证多会话时不会静默覆盖对方数据。
   */

  function refreshRev() {
    return rpcRaw("todos/load", {}, RPC_TIMEOUT).then(function (res) {
      var pl = (res && res.result !== undefined) ? res.result : res;
      if (pl && typeof pl === "object" && typeof pl.rev === "number") { currentRev = pl.rev; }
      return pl;
    }).catch(function () { return null; });
  }

  function attemptSave(extra, tries) {
    return rpc("todos/save", extra, RPC_TIMEOUT).then(function (pl) {
      if (pl && typeof pl === "object") {
        if (typeof pl.rev === "number") { currentRev = pl.rev; }
        setStatus({
          storageDir: nonEmptyStr(pl.dir) || status.storageDir,
          dirConfigured: true,
          rev: (typeof pl.rev === "number") ? pl.rev : status.rev
        });
      }
      note("todos/save", true, Math.round(jsonBytes(extra.data) / 1024) + " KB");
      return true;
    }).catch(function (err) {
      if (tries < 1) {
        note("todos/save 失败，刷新 rev 后重试一次", false, errText(err));
        return refreshRev().then(function () {
          extra.rev = currentRev;
          return attemptSave(extra, tries + 1);
        });
      }
      note("todos/save", false, errText(err));
      throw err;
    });
  }

  /* ================== 宿主「另存为」：让用户自己选目录 ==================
   * 前端跑在 opaque origin 的 sandbox iframe 里，blob 下载会被宿主无声取消，
   * 因此导出/备份一律走宿主 host.saveFile（原生保存对话框）。
   * 传输用 ArrayBuffer（上限 512 MiB），但 request 参数 JSON 上限 2 MiB，
   * 故传 base64 时守住 MAX_UPSTREAM_BYTES。
   */

  var MAX_UPSTREAM_BYTES = 1500 * 1000;

  function base64ToBytes(b64) {
    var bin = atob(String(b64 || "").replace(/\s+/g, ""));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i) & 0xff; }
    return out;
  }

  function toExactBuffer(v) {
    if (v instanceof ArrayBuffer) { return v; }
    var u8;
    if (typeof v === "string") { u8 = base64ToBytes(v); }
    else if (v instanceof Uint8Array) { u8 = v; }
    else { u8 = new Uint8Array(v || 0); }
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) { return u8.buffer; }
    var copy = new Uint8Array(u8.byteLength);
    copy.set(u8);
    return copy.buffer;
  }

  function hasHostSave() {
    return !!(api && typeof api.saveFile === "function");
  }

  function hostSaveFile(fileName, contentType, bytes) {
    if (!hasHostSave()) {
      note("宿主 saveFile", false, "当前宿主没有 saveFile 能力，无法弹出保存对话框");
      return Promise.resolve({ ok: false, canceled: false, path: "", error: "当前 DBX 宿主不支持「另存为」对话框" });
    }
    var buf, size = 0;
    try {
      buf = toExactBuffer(bytes);
      size = buf.byteLength;
    } catch (e) {
      note("宿主 saveFile", false, "字节准备失败：" + errText(e));
      return Promise.resolve({ ok: false, canceled: false, path: "", error: errText(e) });
    }
    var opts = { fileName: fileName, contentType: contentType };
    return Promise.resolve(api.saveFile(opts, buf)).then(function (res) {
      if (res === null || res === undefined) {
        note("宿主 saveFile", null, "用户取消了保存：" + fileName);
        return { ok: false, canceled: true, path: "", error: "已取消" };
      }
      var p = (res && typeof res.path === "string") ? res.path : "";
      note("宿主 saveFile", true, fileName + "（" + size + " B）-> " + (p || "(宿主未回传路径)"));
      return { ok: true, canceled: false, path: p, error: "" };
    }).catch(function (e) {
      note("宿主 saveFile", false, fileName + "：" + errText(e));
      return { ok: false, canceled: false, path: "", error: errText(e) };
    });
  }

  /* ============================ 对外 API ============================ */

  var Store = {
    VERSION: UI_VERSION,

    onStatus: function (fn) {
      if (typeof fn === "function") { listeners.push(fn); }
      return function () { listeners = listeners.filter(function (x) { return x !== fn; }); };
    },

    onDiag: onDiag,
    log: function (step, ok, detail) { note(step, ok, detail); },
    report: report,
    env: envSnapshot,

    status: function () {
      var copy = {};
      for (var k in status) {
        if (Object.prototype.hasOwnProperty.call(status, k)) { copy[k] = status[k]; }
      }
      copy.diag = diagLines();
      return copy;
    },

    init: init,

    reload: function () {
      return readCurrent().then(function (r) {
        r.connectionId = status.connectionId;
        r.storageDir = status.storageDir;
        return r;
      });
    },

    invoke: function (method, params) {
      return rpc(method, params, RPC_TIMEOUT);
    },

    getPrefs: function () {
      return rpc("ui/getPrefs", {}, RPC_TIMEOUT)
        .then(function (r) { return (r && r.prefs) || {}; })
        .catch(function () { return {}; });
    },

    setPrefs: function (prefs) {
      return rpc("ui/setPrefs", { prefs: prefs || {} }, RPC_TIMEOUT).catch(function () { return null; });
    },

    hasHostSave: hasHostSave,
    saveFile: hostSaveFile,
    MAX_UPSTREAM_BYTES: MAX_UPSTREAM_BYTES,

    save: function (data, debounce) {
      if (debounce) {
        pendingData = data;
        if (flushTimer) { clearTimeout(flushTimer); }
        flushTimer = setTimeout(function () { Store.flush(); }, SAVE_DEBOUNCE);
        return Promise.resolve(true);
      }
      return Store.writeNow(data);
    },

    writeNow: function (data) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      pendingData = null;
      if (!current) { current = memoryBackend(); }
      var target = current;
      return Promise.resolve().then(function () {
        return target.write(data);
      }).then(function () {
        setStatus({
          ok: true, lastError: "", lastSavedAt: Date.now(),
          backend: target.name, persistent: target.persistent,
          available: target.name !== "memory",
          backupOnly: target.name === "memory"
        });
        return true;
      }).catch(function (err) {
        if (target.name === "sidecar") {
          return settle(withTimeout(rpc("todos/ping", {}, PING_TIMEOUT), PING_TIMEOUT + 500, "重连侧车"))
            .then(function (r) {
              if (r.ok) { return target.write(data); }
              throw err;
            }).then(function () {
              setStatus({ ok: true, lastError: "", lastSavedAt: Date.now() });
              return true;
            }).catch(function (again) {
              var msg = errText(again || err);
              setStatus({ ok: false, lastError: msg, sidecarAvailable: false, sidecarError: msg });
              note("todos/save", false, msg);
              return false;
            });
        }
        var m = errText(err);
        setStatus({ ok: false, lastError: m });
        note("写入待办", false, m);
        return false;
      });
    },

    flush: function () {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (pendingData) {
        var d = pendingData;
        pendingData = null;
        return Store.writeNow(d);
      }
      return Promise.resolve(true);
    },

    readFileAsText: function (file) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve(String(r.result)); };
        r.onerror = function () { reject(r.error || new Error("读取文件失败")); };
        r.readAsText(file);
      });
    },

    readFileAsBase64: function (file) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () {
          var u8 = new Uint8Array(r.result);
          var s = "";
          for (var i = 0; i < u8.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
          }
          resolve(btoa(s));
        };
        r.onerror = function () { reject(r.error || new Error("读取文件失败")); };
        r.readAsArrayBuffer(file);
      });
    },

    diagLines: diagLines
  };

  /* ====================== 看门狗：拿不到结果也要留下证据 ====================== */
  var WATCHDOG_MARKS = [4000, 10000, 20000];
  WATCHDOG_MARKS.forEach(function (ms) {
    setTimeout(function () {
      try {
        if (!initCalled) {
          note("看门狗 +" + (ms / 1000) + "s", false,
            "存储模块已加载 " + (ms / 1000) + " 秒，但 init() 从未被调用 "
            + "→ UI 启动在更早的位置中断（往下看是否有「前端启动中断 / 页面 JS 错误」）");
        } else if (status.backend === "unknown") {
          note("看门狗 +" + (ms / 1000) + "s", false,
            "存储初始化仍未出结果（backend 仍为 unknown），最后一条日志即卡住的位置");
        }
      } catch (e) { /* ignore */ }
    }, ms);
  });

  window.addEventListener("pagehide", function () { Store.flush(); });
  window.addEventListener("beforeunload", function () { Store.flush(); });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") { Store.flush(); }
  });

  TD.storage = Store;
})();
