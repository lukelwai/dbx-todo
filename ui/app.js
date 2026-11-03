/*
 * 待办 Todo —— 前端逻辑
 * ==========================================================================
 * 设计铁律（来自 dbx-md-notes 事故沉淀）：
 *   1. 绝不用 $("id").属性 = ... 直接赋值（元素缺失 → TypeError → 启动连坐死）。
 *      一律走 click(id,fn) / on(id,ev,fn) 安全绑定 + 页面级 error 兜底。
 *   2. 永远不要把 $("字面量") 直接接属性访问——打包脚本会扫描并拒绝。
 *      读取用 val(id)，写入用 setVal(id,v)，它们内部把 id 当变量传。
 *   3. 所有数据落盘只走 window.TodoStore（storage.js → 侧车 → .todo/todos.db）。
 * ==========================================================================
 */
(function () {
  "use strict";

  /* ============ 功能开关（必须与 index.html 一致，打包脚本会校验）============ */
  var SHOW_DIAG_BAR = false;   // 置顶诊断条（默认关）
  var ENABLE_IMPORT = true;    // 导入功能（默认开）

  /* ============ 安全 DOM 助手 ============ */
  function $(id) { return document.getElementById(id); }
  function val(id) { var e = $(id); return e ? e.value : ""; }
  function setVal(id, v) { var e = $(id); if (e) e.value = (v == null ? "" : v); }
  function click(id, fn) {
    var e = $(id);
    if (!e) { console.warn("[bind] 缺少 #" + id); return; }
    e.addEventListener("click", function (ev) { try { fn(ev); } catch (err) { reportErr("点击 #" + id, err); } });
  }
  function on(id, ev, fn) {
    var e = $(id);
    if (!e) { console.warn("[bind] 缺少 #" + id); return; }
    e.addEventListener(ev, function (e2) { try { fn(e2); } catch (err) { reportErr("事件 #" + id + " " + ev, err); } });
  }
  function h(tag, props, children) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v === null || v === undefined || v === false) return;
      if (k === "class") e.className = v;
      else if (k === "style") e.setAttribute("style", v);
      else if (k === "dataset") Object.keys(v).forEach(function (d) { e.dataset[d] = v[d]; });
      else if (k.indexOf("on") === 0 && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === "html") e.innerHTML = v;
      else if (v === true) e.setAttribute(k, "");
      else e.setAttribute(k, v);
    });
    if (children != null) {
      var arr = Array.isArray(children) ? children : [children];
      arr.forEach(function (c) {
        if (c == null || c === false) return;
        e.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
      });
    }
    return e;
  }

  /* ============ 全局错误兜底 ============ */
  function reportErr(where, err) {
    console.error("[待办] " + where + ":", err);
    toast("操作出错：" + (err && err.message ? err.message : String(err)));
  }
  window.addEventListener("error", function (e) { console.error("[待办] 页面错误:", e.error || e.message); });
  window.addEventListener("unhandledrejection", function (e) { console.error("[待办] 未捕获 Promise:", e.reason); });

  /* ============ 小工具 ============ */
  function uid(p) { return (p || "id") + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function nowISO() { return new Date().toISOString(); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function toLocalInput(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fmtDate(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function fmtDateTime(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return fmtDate(s) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function dayKeyOf(s) {
    if (!s) return "";
    var d = new Date(s);
    if (isNaN(d.getTime())) return "";
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $("toast"); if (!t) return;
    t.textContent = msg; t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ============ 状态 ============ */
  var Store = window.TodoStore && window.TodoStore.storage;
  var state = {
    groups: [],
    tasks: [],
    records: [],
    tags: [],
    ui: {
      view: "list", search: "", status: "all", priority: "all", sort: "created", group: null,
      collapsed: {}, openTasks: {}, boardCollapsed: {}, boardOpen: {}, calYear: 0, calMonth: 0,
      groupExpanded: {}, recordTagFilter: [], listPage: 1, recPage: 1, pageSize: 30
    }
  };
  var calByDay = {};   // 日历：dayKey -> { tasks:[...], records:[...] }（供「查看全部」弹框读取）
  var editingId = null;
  var modalSubs = [];
  var statusTick = null;

  function buildDoc() { return { version: 1, groups: state.groups, tasks: state.tasks, records: state.records, tags: state.tags, boardCollapsed: state.ui.boardCollapsed }; }
  function saveAll() {
    if (!Store) return Promise.resolve(false);
    return Store.save(buildDoc(), true).catch(function (e) { reportErr("保存", e); return false; });
  }
  function findTask(id) { for (var i = 0; i < state.tasks.length; i++) { if (state.tasks[i].id === id) return state.tasks[i]; } return null; }
  function findGroup(id) { for (var i = 0; i < state.groups.length; i++) { if (state.groups[i].id === id) return state.groups[i]; } return null; }

  // ---- 分组树辅助（多层级文件夹） ----
  function childGroups(parentId) {
    return state.groups.filter(function (g) { return (g.parentId || "") === parentId; })
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
  }
  function rootGroups() { return childGroups(""); }
  function descendantGroupIds(id) {
    var out = {}; out[id] = true;
    var stack = [id];
    while (stack.length) {
      var cur = stack.pop();
      childGroups(cur).forEach(function (c) { if (!out[c.id]) { out[c.id] = true; stack.push(c.id); } });
    }
    return out;
  }
  function groupIsEmpty(gid) {
    var hasTasks = state.tasks.some(function (t) { return t.groupId === gid; });
    var hasKids = state.groups.some(function (g) { return (g.parentId || "") === gid; });
    return !hasTasks && !hasKids;
  }
  function groupTotalCount(gid) {
    var ids = descendantGroupIds(gid);
    var n = 0;
    for (var i = 0; i < state.tasks.length; i++) { if (ids[state.tasks[i].groupId]) n++; }
    return n;
  }
  function normalizeGroups() {
    state.groups.forEach(function (g) {
      if (g.parentId === undefined || g.parentId === null) g.parentId = "";
      if (g.order === undefined || g.order === null) g.order = 0;
    });
  }

  /* ============ 状态 / 进度计算 ============ */
  var STATUS_LABEL = { notstarted: "未开始", doing: "进行中", overdue: "已逾期", done: "已完成" };
  var PRIORITY_LABEL = { high: "高", medium: "中", low: "低" };
  var PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

  function taskStatus(t, now) {
    if (t.done) return "done";
    var due = t.dueAt ? new Date(t.dueAt) : null;
    var start = t.startAt ? new Date(t.startAt) : null;
    if (due && !isNaN(due.getTime()) && now > due.getTime()) return "overdue";
    if (start && !isNaN(start.getTime()) && now < start.getTime()) return "notstarted";
    return "doing";
  }
  function progressOf(t) {
    var subs = t.subtasks || [];
    var total = subs.length;
    if (total === 0) return { pct: t.done ? 100 : 0, done: t.done ? 1 : 0, total: 0, msDone: t.done ? 1 : 0, msTotal: t.done ? 1 : 0 };
    var done = 0, msDone = 0;
    subs.forEach(function (s) { if (s.done) done++; if (s.isMilestone && s.done) msDone++; });
    return { pct: Math.round((done / total) * 100), done: done, total: total, msDone: msDone, msTotal: subs.filter(function (s) { return s.isMilestone; }).length };
  }

  /* ============ 渲染入口 ============ */
  function applyTheme() {
    var t = "light";
    try {
      if (window.dbxPlugin && window.dbxPlugin.theme) {
        var th = window.dbxPlugin.theme;
        if (typeof th === "function") th = th();
        t = (th === "dark") ? "dark" : "light";
      }
    } catch (e) { /* 忽略 */ }
    document.body.dataset.theme = t;
  }
  function render() {
    applyTheme();
    if (state.ui.view === "record") {
      renderTagPanel();
      renderRecords();
    } else {
      renderSidebar();
      if (state.ui.view === "calendar") renderTagPanel();   // 日历也含记录，需渲染标签面板（可见 + 可筛选）
      if (state.ui.view === "list") renderList();
      else if (state.ui.view === "calendar") renderCalendar();
      else renderBoard();
    }
    renderStoreText();
  }

  function renderStoreText() {
    var el = $("store-text"); if (!el) return;
    if (!Store) { el.textContent = "存储：模块未加载"; return; }
    var s = Store.status();
    var backend = s.backend === "sidecar" ? "侧车（已落盘）" : (s.backend === "memory" ? "内存（未连接，仅预览）" : s.backend);
    var dir = s.storageDir ? " · " + s.storageDir : " · 未配置目录";
    el.textContent = "存储：" + backend + dir + (s.rev ? " · rev " + s.rev : "");
  }

  /* ============ 侧边栏：分组树（多层级文件夹） ============ */
  function renderSidebar() {
    var tree = $("group-tree"); if (!tree) return;
    tree.innerHTML = "";
    var allItem = h("div", {
      class: "group-item" + (state.ui.group == null ? " active" : ""),
      dataset: { group: "__all__" },
      onClick: function () { state.ui.group = null; state.ui.listPage = 1; render(); }
    }, [
      h("span", { class: "group-chevron group-chevron-static" }, ""),
      h("span", { class: "group-name" }, "全部任务"),
      h("span", { class: "group-count" }, String(state.tasks.length))
    ]);
    tree.appendChild(allItem);
    rootGroups().forEach(function (g) { renderGroupNode(tree, g, 0); });
    var empty = $("sidebar-empty");
    if (empty) empty.hidden = state.groups.length > 0;
  }

  function renderGroupNode(tree, g, depth) {
    var kids = childGroups(g.id);
    var hasKids = kids.length > 0;
    var expanded = state.ui.groupExpanded[g.id] !== false; // 默认展开
    var item = h("div", {
      class: "group-item" + (state.ui.group === g.id ? " active" : ""),
      style: "padding-left:" + (8 + depth * 16) + "px",
      dataset: { group: g.id },
      onClick: function (ev) {
        if (ev.target && ev.target.closest && ev.target.closest(".group-actions")) return;
        if (ev.target && ev.target.closest && ev.target.closest(".group-toggle")) return;
        state.ui.group = (state.ui.group === g.id) ? null : g.id;
        state.ui.listPage = 1;
        render();
      }
    }, [
      hasKids
        ? h("span", { class: "group-chevron group-toggle", onClick: function (ev) { ev.stopPropagation(); state.ui.groupExpanded[g.id] = !expanded; renderSidebar(); } }, expanded ? "▾" : "▸")
        : h("span", { class: "group-chevron group-chevron-static" }, "·"),
      h("span", { class: "group-name", dataset: { rename: g.id } }, g.name),
      h("span", { class: "group-count" }, String(groupTotalCount(g.id))),
      h("span", { class: "group-actions" }, [
        h("button", { type: "button", title: "新建子文件夹", dataset: { act: "add", gid: g.id }, onClick: function (ev) { ev.stopPropagation(); addGroup(g.id); } }, "＋"),
        h("button", { type: "button", title: "重命名", dataset: { act: "rename", gid: g.id }, onClick: function (ev) { ev.stopPropagation(); startRename(g.id); } }, "✎"),
        h("button", { type: "button", title: "删除", dataset: { act: "del", gid: g.id }, onClick: function (ev) { ev.stopPropagation(); deleteGroup(g.id); } }, "🗑")
      ])
    ]);
    tree.appendChild(item);
    if (hasKids && expanded) kids.forEach(function (c) { renderGroupNode(tree, c, depth + 1); });
  }

  /* ============ 侧边栏：记录标签筛选 ============ */
  var TAG_COLORS = ["#4f8cff", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4", "#ec4899", "#84cc16"];

  function tagById(id) {
    for (var i = 0; i < state.tags.length; i++) { if (state.tags[i].id === id) return state.tags[i]; }
    return null;
  }

  function createTag(name) {
    name = (name || "").trim();
    if (!name) return null;
    var color = TAG_COLORS[state.tags.length % TAG_COLORS.length];
    var t = { id: uid("t"), name: name, color: color, order: state.tags.length };
    state.tags.push(t);
    saveAll();
    return t;
  }

  function deleteTag(id) {
    state.tags = state.tags.filter(function (t) { return t.id !== id; });
    state.records.forEach(function (r) {
      if (Array.isArray(r.tagIds)) r.tagIds = r.tagIds.filter(function (x) { return x !== id; });
    });
    state.ui.recordTagFilter = state.ui.recordTagFilter.filter(function (x) { return x !== id; });
    saveAll();
    state.ui.recPage = 1;
    render();
  }

  function toggleRecordTagFilter(id) {
    var arr = state.ui.recordTagFilter;
    var i = arr.indexOf(id);
    if (i >= 0) arr.splice(i, 1); else arr.push(id);
    state.ui.recPage = 1;
    render();
  }

  function renderTagPanel() {
    var root = $("tag-filter"); if (!root) return;
    root.innerHTML = "";
    // 全部（清除筛选）
    root.appendChild(h("div", {
      class: "tag-item" + (state.ui.recordTagFilter.length === 0 ? " active" : ""),
      dataset: { tagfilter: "__all__" },
      onClick: function () { state.ui.recordTagFilter = []; state.ui.recPage = 1; render(); }
    }, [
      h("span", { class: "tag-dot", style: "background:#9aa0a6" }),
      h("span", { class: "tag-name" }, "全部"),
      h("span", { class: "tag-count" }, String(state.records.length))
    ]));
    if (state.tags.length === 0) {
      root.appendChild(h("div", { class: "tag-empty" }, "还没有标签，点上方 + 新建。"));
    }
    state.tags.forEach(function (t) {
      var count = state.records.filter(function (r) { return Array.isArray(r.tagIds) && r.tagIds.indexOf(t.id) >= 0; }).length;
      var selected = state.ui.recordTagFilter.indexOf(t.id) >= 0;
      root.appendChild(h("div", {
        class: "tag-item" + (selected ? " active" : ""),
        dataset: { tagfilter: t.id },
        onClick: function (ev) {
          if (ev.target && ev.target.closest && ev.target.closest(".tag-del")) return;
          toggleRecordTagFilter(t.id);
        }
      }, [
        h("span", { class: "tag-dot", style: "background:" + (t.color || "#4f8cff") }),
        h("span", { class: "tag-name" }, t.name),
        h("span", { class: "tag-count" }, String(count)),
        h("button", { type: "button", class: "tag-del", title: "删除标签", dataset: { deltag: t.id }, onClick: function (ev) {
          ev.stopPropagation();
          confirmDialog("删除标签", "删除标签「" + t.name + "」？已打在该标签的记录会解除关联（记录本身保留）。", "删除", function () { deleteTag(t.id); });
        } }, "✕")
      ]));
    });
  }

  /* ============ 列表视图 ============ */
  function baseFiltered() {
    var q = state.ui.search.trim().toLowerCase();
    var gset = state.ui.group ? descendantGroupIds(state.ui.group) : null;
    return state.tasks.filter(function (t) {
      if (gset && !gset[t.groupId]) return false;
      if (state.ui.priority !== "all" && t.priority !== state.ui.priority) return false;
      if (q) {
        var hay = (t.title + " " + (t.description || "")).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function filteredTasks() {
    var now = Date.now();
    var list = baseFiltered();
    if (state.ui.status !== "all") {
      list = list.filter(function (t) { return taskStatus(t, now) === state.ui.status; });
    }
    list.sort(function (a, b) {
      if (state.ui.sort === "due") {
        var da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
        var db = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
        if (da !== db) return da - db;
      } else if (state.ui.sort === "priority") {
        var pa = PRIORITY_RANK[a.priority] != null ? PRIORITY_RANK[a.priority] : 9;
        var pb = PRIORITY_RANK[b.priority] != null ? PRIORITY_RANK[b.priority] : 9;
        if (pa !== pb) return pa - pb;
      } else if (state.ui.sort === "title") {
        var r = (a.title || "").localeCompare(b.title || "", "zh-CN");
        if (r !== 0) return r;
      } else {
        var ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        var cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        if (ca !== cb) return cb - ca;
      }
      return (a.createdAt || "").localeCompare(b.createdAt || "");
    });
    return list;
  }

  function renderList() {
    var root = $("list-content"); if (!root) return;
    root.innerHTML = "";
    if (state.tasks.length === 0) {
      root.appendChild(emptyState("🗒️", "还没有任何任务", "点击右上角「新建任务」创建你的第一个待办。", true));
      return;
    }
    var now = Date.now();
    var list = filteredTasks();
    if (list.length === 0) {
      root.appendChild(emptyState("🔍", "没有匹配的任务", "试着调整搜索词、状态或优先级筛选。", false));
      return;
    }
    var size = state.ui.pageSize;
    var totalPages = Math.max(1, Math.ceil(list.length / size));
    if (state.ui.listPage > totalPages) state.ui.listPage = totalPages;
    if (state.ui.listPage < 1) state.ui.listPage = 1;
    var start = (state.ui.listPage - 1) * size;
    list.slice(start, start + size).forEach(function (t) {
      var g = findGroup(t.groupId);
      root.appendChild(taskCard(t, now, g ? g.name : "（未分组）"));
    });
    root.appendChild(renderPager(list.length, state.ui.listPage, size,
      function (p) { state.ui.listPage = p; renderList(); },
      function (s) { state.ui.pageSize = s; state.ui.listPage = 1; renderList(); }));
  }

  function renderListSection(g, depth, now, list) {
    var items = list.filter(function (t) { return t.groupId === g.id; });
    var collapsed = !!state.ui.collapsed[g.id];
    var head = h("div", { class: "group-section-head", style: "padding-left:" + (8 + depth * 14) + "px", dataset: { gid: g.id }, onClick: function () { state.ui.collapsed[g.id] = !collapsed; renderList(); } }, [
      h("span", { class: "group-chevron", style: collapsed ? "transform:rotate(-90deg)" : "" }, "▾"),
      h("span", { class: "gs-title" }, g.name),
      h("span", { class: "gs-count" }, items.length + " 项")
    ]);
    var section = h("div", { class: "group-section" + (collapsed ? " collapsed" : "") }, [head]);
    if (!collapsed) {
      items.forEach(function (t) { section.appendChild(taskCard(t, now)); });
      childGroups(g.id).forEach(function (c) { section.appendChild(renderListSection(c, depth + 1, now, list)); });
    }
    return section;
  }

  function taskCard(t, now, groupName) {
    var st = taskStatus(t, now);
    var pr = t.priority || "medium";
    var prog = progressOf(t);
    var open = !!state.ui.openTasks[t.id];

    var meta = h("div", { class: "task-meta" }, [
      h("span", { class: "badge st st-" + st }, STATUS_LABEL[st]),
      h("span", { class: "badge pr pr-" + pr }, PRIORITY_LABEL[pr]),
      (t.startAt ? h("span", { class: "task-date" }, "起 " + fmtDateTime(t.startAt)) : null),
      (t.dueAt ? h("span", { class: "task-date" }, "止 " + fmtDateTime(t.dueAt)) : null)
    ]);

    var progress = null;
    if (prog.total > 0) {
      progress = h("div", { class: "task-progress" }, [
        h("div", { class: "progress-track" }, [h("div", { class: "progress-fill", style: "width:" + prog.pct + "%" })]),
        h("div", { class: "progress-label" }, [
          h("span", null, "完成度 " + prog.pct + "%（" + prog.done + "/" + prog.total + "）"),
          (prog.msTotal > 0 ? h("span", { class: "ms-flag" }, "★ 里程碑 " + prog.msDone + "/" + prog.msTotal) : null)
        ])
      ]);
    }

    var actions = h("div", { class: "task-actions" }, [
      h("button", { type: "button", dataset: { act: "toggle", tid: t.id } }, t.done ? "↩ 标记未完成" : "✓ 完成"),
      h("button", { type: "button", dataset: { act: "edit", tid: t.id } }, "编辑"),
      h("button", { type: "button", dataset: { act: "del", tid: t.id } }, "删除")
    ]);

    var detailId = "detail-" + t.id;
    var detail = h("div", { class: "task-detail", id: detailId, hidden: !open });
    detail.appendChild(h("div", { class: "task-desc" }, t.description || "（无描述）"));
    if (prog.total > 0) {
      var sl = h("div", { class: "subtask-list" });
      (t.subtasks || []).forEach(function (s) {
        sl.appendChild(h("div", { class: "subtask-item" + (s.done ? " done" : "") }, [
          h("input", { class: "st-check", type: "checkbox", checked: !!s.done, dataset: { stid: t.id, sub: s.id } }),
          h("span", { class: "st-title" }, s.title),
          (s.isMilestone ? h("span", { class: "ms-tag" }, "★ 里程碑") : null)
        ]));
      });
      detail.appendChild(sl);
    }
    if (t.doneNote) {
      detail.appendChild(h("div", { class: "task-donenote" }, [
        h("span", { class: "dn-label" }, "完成备注："),
        h("span", { class: "dn-text" }, t.doneNote)
      ]));
    }

    var hasDesc = !!(t.description && t.description.trim());
    var expandable = hasDesc || prog.total > 0;
    var rowProps = { class: "task-row1" + (expandable ? " expandable" : "") + (open ? " expanded" : "") };
    if (expandable) rowProps.dataset = { toggle: t.id };
    var rowKids = [];
    if (expandable) rowKids.push(h("span", { class: "task-chevron" }, "▸"));
    rowKids.push(h("input", { class: "task-check", type: "checkbox", checked: !!t.done, dataset: { check: t.id } }));
    rowKids.push(h("div", { class: "task-main" }, [
      h("div", { class: "task-title" }, t.title),
      meta,
      progress
    ]));
    var cardKids = [];
    if (groupName) cardKids.push(h("div", { class: "task-group-tag" }, groupName));
    cardKids.push(h("div", rowProps, rowKids), actions, detail);
    var card = h("div", { class: "task-card" + (t.done ? " done" : ""), dataset: { tid: t.id } }, cardKids);
    return card;
  }

  /* ============ 日历视图 ============ */
  function renderCalendar() {
    var title = $("cal-title"); if (!title) return;
    var weekdays = $("cal-weekdays");
    if (weekdays && weekdays.children.length === 0) {
      ["日", "一", "二", "三", "四", "五", "六"].forEach(function (w) { weekdays.appendChild(h("div", null, w)); });
    }
    var y = state.ui.calYear, m = state.ui.calMonth;
    title.textContent = y + " 年 " + (m + 1) + " 月";

    var first = new Date(y, m, 1);
    var startDow = first.getDay();
    var gridStart = new Date(y, m, 1 - startDow);
    var todayKey = dayKeyOf(nowISO());

    var grid = $("cal-grid");
    grid.innerHTML = "";
    for (var i = 0; i < 42; i++) {
      var d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      var key = dayKeyOf(d.toISOString());
      var isOther = d.getMonth() !== m;
      var isToday = key === todayKey;

      var cellChildren = [h("div", { class: "cal-daynum" }, String(d.getDate()))];
      var all = baseFiltered();
      var dayTasks = all.filter(function (t) {
        var k = dayKeyOf(t.dueAt) || dayKeyOf(t.startAt) || dayKeyOf(t.createdAt);
        return k === key;
      });
      var recFilter = state.ui.recordTagFilter;
      var dayRecs = state.records.filter(function (r) {
        if (dayKeyOf(r.date) !== key) return false;
        if (recFilter.length > 0) {
          var ids = r.tagIds || [];
          return recFilter.some(function (f) { return ids.indexOf(f) >= 0; });   // 与记录视图一致的 OR 语义
        }
        return true;
      });
      calByDay[key] = { tasks: dayTasks, records: dayRecs };
      var chipsWrap = h("div", { class: "cal-chips" });
      var combined = [];
      dayTasks.forEach(function (t) { combined.push({ kind: "task", data: t }); });
      dayRecs.forEach(function (r) { combined.push({ kind: "record", data: r }); });
      combined.slice(0, 3).forEach(function (c) {
        if (c.kind === "task") {
          var t = c.data; var st = taskStatus(t, d.getTime());
          chipsWrap.appendChild(h("button", {
            class: "cal-chip s-" + st, type: "button", dataset: { open: t.id }, title: t.title
          }, [h("span", { class: "dot", style: "background:var(--st-" + st + ")" }), (t.title || "（无标题）")]));
        } else {
          var r = c.data;
          chipsWrap.appendChild(h("button", {
            class: "cal-chip rec", type: "button", dataset: { openrec: r.id }, title: r.title
          }, [h("span", { class: "dot rec-dot" }), (r.title || "（无标题）")]));
        }
      });
      cellChildren.push(chipsWrap);
      if (combined.length > 3) cellChildren.push(h("button", {
        class: "cal-more-btn", type: "button", dataset: { allday: key }, title: "查看全部"
      }, "+" + (combined.length - 3) + " 更多"));

      grid.appendChild(h("div", {
        class: "cal-cell" + (isOther ? " other" : "") + (isToday ? " today" : ""),
        dataset: { cell: key },
        onClick: function (ev) {
          if (ev.target && ev.target.closest) {
            if (ev.target.closest(".cal-chip")) return;     // 任务 chip 交给网格委托处理
            if (ev.target.closest("[data-allday]")) return; // 查看全部交给网格委托处理
          }
          var ds = ev.currentTarget.dataset;
          var cdate = ds.cell;
          openTaskModal(null, { due: cdate + "T09:00", group: state.ui.group });
        }
      }, cellChildren));
    }
  }

  /* ============ 日历「查看全部」弹框 ============ */
  function openDayModal(key) {
    var day = calByDay[key] || { tasks: [], records: [] };
    var tasks = day.tasks || [];
    var records = day.records || [];
    var d = new Date(key + "T00:00:00");
    var week = isNaN(d.getTime()) ? "" : "（" + ["日", "一", "二", "三", "四", "五", "六"][d.getDay()] + "）";
    var title = "当日内容 · " + fmtDate(key) + week;
    var body = h("div", { class: "day-modal-list" });
    var now = Date.now();
    if (tasks.length === 0 && records.length === 0) {
      body.appendChild(h("div", { class: "day-modal-empty" }, "这一天没有任务或记录"));
    } else {
      if (tasks.length > 0) {
        body.appendChild(h("div", { class: "day-modal-sec-title" }, "任务"));
        tasks.forEach(function (t) {
          var st = taskStatus(t, now);
          body.appendChild(h("button", {
            class: "day-modal-row" + (t.done ? " done" : ""), type: "button", dataset: { open: t.id }
          }, [
            h("span", { class: "dot", style: "background:var(--st-" + st + ")" }),
            h("span", { class: "dm-title" }, t.title || "（无标题）"),
            h("span", { class: "badge st st-" + st }, STATUS_LABEL[st])
          ]));
        });
      }
      if (records.length > 0) {
        body.appendChild(h("div", { class: "day-modal-sec-title" }, "记录"));
        records.forEach(function (r) {
          body.appendChild(h("button", {
            class: "day-modal-row rec", type: "button", dataset: { openrec: r.id }
          }, [
            h("span", { class: "dot rec-dot" }),
            h("span", { class: "dm-title" }, r.title || "（无标题）"),
            h("span", { class: "badge rec-badge" }, "记录")
          ]));
        });
      }
    }
    var box = overlayBox([
      h("div", { class: "modal-card", style: "width:min(440px,92vw)" }, [
        h("div", { class: "modal-head" }, [
          h("h2", null, title),
          h("button", { class: "icon-btn", type: "button", dataset: { close: "1" } }, "✕")
        ]),
        h("div", { class: "modal-body" }, [body])
      ])
    ]);
    body.addEventListener("click", function (ev) {
      var recRow = ev.target.closest ? ev.target.closest("[data-openrec]") : null;
      if (recRow && recRow.dataset && recRow.dataset.openrec) { removeBox(box); openRecordModal(recRow.dataset.openrec); return; }
      var row = ev.target.closest ? ev.target.closest("[data-open]") : null;
      if (row && row.dataset && row.dataset.open) { removeBox(box); openTaskModal(row.dataset.open); }
    });
  }

  /* ============ 执行视图（看板） ============ */
  function renderBoard() {
    var root = $("board-content"); if (!root) return;
    var savedTop = root.scrollTop;
    var savedCols = {};
    var _bodies = root.querySelectorAll(".board-col-body");
    for (var _i = 0; _i < _bodies.length; _i++) {
      var _col = _bodies[_i].parentNode;
      var _ck = _col && _col.dataset ? _col.dataset.col : null;
      if (_ck != null) savedCols[_ck] = _bodies[_i].scrollTop;
    }
    if (document.activeElement && document.activeElement !== document.body && root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    root.innerHTML = "";
    if (state.tasks.length === 0) {
      root.appendChild(emptyState("🗒️", "还没有任何任务", "点击右上角「新建任务」创建你的第一个待办。", true));
      return;
    }
    var list = baseFiltered();
    if (list.length === 0) {
      root.appendChild(emptyState("🔍", "没有匹配的任务", "试着调整搜索词或优先级筛选。", false));
      return;
    }
    var cols = [
      { key: "notstarted", label: "未开始" },
      { key: "doing", label: "进行中" },
      { key: "overdue", label: "已逾期" },
      { key: "done", label: "已完成" }
    ];
    var now = Date.now();
    cols.forEach(function (col) {
      var items = list.filter(function (t) { return taskStatus(t, now) === col.key; });
      items.sort(function (a, b) {
        var pa = PRIORITY_RANK[a.priority] != null ? PRIORITY_RANK[a.priority] : 9;
        var pb = PRIORITY_RANK[b.priority] != null ? PRIORITY_RANK[b.priority] : 9;
        if (pa !== pb) return pa - pb;
        var da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
        var db = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
        return da - db;
      });
      var collapsed = !!state.ui.boardCollapsed[col.key];
      var body = h("div", { class: "board-col-body" });
      items.forEach(function (t) { body.appendChild(boardCard(t, now)); });
      root.appendChild(h("div", { class: "board-col" + (collapsed ? " collapsed" : ""), dataset: { col: col.key } }, [
        h("div", { class: "board-col-head" }, [
          h("span", { class: "board-col-dot s-" + col.key }),
          h("span", { class: "board-col-title" }, col.label),
          h("span", { class: "board-col-count" }, String(items.length)),
          h("button", { type: "button", class: "bc-col-collapse-btn", dataset: { bccollapse: col.key }, title: collapsed ? "展开列" : "收起列" }, collapsed ? "»" : "«")
        ]),
        body
      ]));
    });
    root.scrollTop = savedTop;
    var _newBodies = root.querySelectorAll(".board-col-body");
    for (var _j = 0; _j < _newBodies.length; _j++) {
      var _nc = _newBodies[_j].parentNode;
      var _nk = _nc && _nc.dataset ? _nc.dataset.col : null;
      if (_nk != null && savedCols[_nk] != null) _newBodies[_j].scrollTop = savedCols[_nk];
    }
  }

  function boardCard(t, now) {
    var pr = t.priority || "medium";
    var prog = progressOf(t);
    var openSubs = !!state.ui.boardOpen[t.id];
    var kids = [
      h("div", { class: "bc-top" }, [
        h("span", { class: "bc-pri", style: "color:var(--pr-" + pr + ")" }, PRIORITY_LABEL[pr]),
        (t.dueAt ? h("span", { class: "bc-due" }, "止 " + fmtDate(t.dueAt)) : null)
      ]),
      h("div", { class: "bc-title", dataset: { open: t.id } }, t.title),
      (t.description ? h("div", { class: "bc-desc" }, t.description) : null)
    ];
    if (prog.total > 0) {
      kids.push(h("div", { class: "bc-progress" }, [
        h("div", { class: "progress-track" }, [h("div", { class: "progress-fill", style: "width:" + prog.pct + "%" })]),
        h("div", { class: "bc-prog-label" }, prog.done + "/" + prog.total + " 子任务" + (prog.msTotal > 0 ? " · ★" + prog.msDone + "/" + prog.msTotal : ""))
      ]));
      kids.push(h("button", { type: "button", class: "bc-sub-toggle", dataset: { bcsub: t.id } },
        (openSubs ? "▾ " : "▸ ") + "子任务 " + prog.done + "/" + prog.total));
      if (openSubs) {
        kids.push(h("div", { class: "bc-subs" }, (t.subtasks || []).map(function (s) {
          return h("label", { class: "bc-sub" + (s.done ? " done" : "") }, [
            h("input", { class: "st-check", type: "checkbox", checked: !!s.done, dataset: { stid: t.id, sub: s.id } }),
            h("span", { class: "st-title" }, s.title),
            (s.isMilestone ? h("span", { class: "ms-tag" }, "★ 里程碑") : null)
          ]);
        })));
      }
    }
      kids.push(h("div", { class: "bc-actions" }, [
        h("button", { type: "button", dataset: { act: "toggle", tid: t.id } }, t.done ? "↩ 重开" : "✓ 完成"),
        h("button", { type: "button", dataset: { act: "edit", tid: t.id } }, "编辑"),
        h("button", { type: "button", dataset: { act: "del", tid: t.id } }, "删除")
      ]));
    if (t.done && t.doneNote) {
      kids.push(h("div", { class: "bc-donenote" }, "备注：" + t.doneNote));
    }
    return h("div", { class: "board-card" + (t.done ? " done" : "") }, kids);
  }

  /* ============ 空状态 ============ */
  function emptyState(emoji, title, sub, withBtn) {
    var kids = [
      h("div", { class: "emoji" }, emoji),
      h("div", { class: "et-title" }, title),
      h("div", { class: "et-sub" }, sub)
    ];
    if (withBtn) kids.push(h("button", { class: "primary", type: "button", onClick: function () { openTaskModal(null); } }, "+ 新建任务"));
    return h("div", { class: "empty-state" }, kids);
  }

  /* ============ 记录视图（碎片内容） ============ */
  /* ============ 通用分页器 ============ */
  var PAGE_SIZES = [20, 30, 50, 100];
  function renderPager(total, page, size, onPage, onSize) {
    var totalPages = Math.max(1, Math.ceil(total / size));
    if (page > totalPages) page = totalPages;
    if (page < 1) page = 1;
    var bar = h("div", { class: "pager" });
    bar.appendChild(h("span", { class: "pager-info" }, "共 " + total + " 条 · 第 " + page + " / " + totalPages + " 页"));

    var prev = h("button", { type: "button", class: "pager-btn", disabled: page <= 1, onClick: function () { if (page > 1) onPage(page - 1); } }, "‹ 上一页");
    var next = h("button", { type: "button", class: "pager-btn", disabled: page >= totalPages, onClick: function () { if (page < totalPages) onPage(page + 1); } }, "下一页 ›");
    bar.appendChild(prev);
    bar.appendChild(next);

    var sel = h("select", { class: "pager-size", title: "每页条数", onChange: function (e) { onSize(parseInt(e.target.value, 10) || 30); } });
    PAGE_SIZES.forEach(function (s) {
      sel.appendChild(h("option", { value: s, selected: s === size }, "每页 " + s));
    });
    bar.appendChild(sel);
    return bar;
  }

  function renderRecords() {
    var root = $("records-content"); if (!root) return;
    root.innerHTML = "";
    var filter = state.ui.recordTagFilter;
    var list = state.records;
    if (filter.length > 0) {
      list = list.filter(function (r) {
        var ids = r.tagIds || [];
        return filter.some(function (f) { return ids.indexOf(f) >= 0; });
      });
    }
    if (list.length === 0) {
      root.appendChild(emptyState("📝", "还没有任何记录", filter.length > 0 ? "当前标签下没有记录，换个标签或清除筛选试试。" : "点击上方「新建记录」记下一条碎片内容（标题 + 内容 + 日期）。", false));
      return;
    }
    var sorted = list.slice().sort(function (a, b) {
      var da = a.date || "", db = b.date || "";
      if (da !== db) return da < db ? 1 : -1;          // 日期倒序（近的在上）
      return (a.updatedAt || "").localeCompare(b.updatedAt || "");
    });
    var size = state.ui.pageSize;
    var totalPages = Math.max(1, Math.ceil(sorted.length / size));
    if (state.ui.recPage > totalPages) state.ui.recPage = totalPages;
    if (state.ui.recPage < 1) state.ui.recPage = 1;
    var start = (state.ui.recPage - 1) * size;
    sorted.slice(start, start + size).forEach(function (r) {
      var tagChips = null;
      var ids = r.tagIds || [];
      if (ids.length > 0) {
        tagChips = h("div", { class: "rec-tags" }, ids.map(function (tid) {
          var tg = tagById(tid);
          if (!tg) return null;
          return h("span", { class: "rec-tag", style: "background:" + (tg.color || "#4f8cff") + "22;color:" + (tg.color || "#4f8cff") + ";border-color:" + (tg.color || "#4f8cff") + "55" }, tg.name);
        }));
      }
      root.appendChild(h("div", { class: "rec-card", dataset: { rid: r.id } }, [
        h("div", { class: "rec-head" }, [
          h("span", { class: "rec-date" }, r.date || "（无日期）"),
          h("span", { class: "rec-title" }, r.title || "（无标题）")
        ]),
        (r.content ? h("div", { class: "rec-content" }, r.content) : null),
        tagChips,
        h("div", { class: "rec-actions" }, [
          h("button", { type: "button", dataset: { act: "editrec", rid: r.id } }, "编辑"),
          h("button", { type: "button", dataset: { act: "delrec", rid: r.id } }, "删除")
        ])
      ]));
    });
    root.appendChild(renderPager(sorted.length, state.ui.recPage, size,
      function (p) { state.ui.recPage = p; renderRecords(); },
      function (s) { state.ui.pageSize = s; state.ui.recPage = 1; renderRecords(); }));
  }

  function openRecordModal(id) {
    var r = null;
    for (var i = 0; i < state.records.length; i++) { if (state.records[i].id === id) { r = state.records[i]; break; } }
    var titleInput = h("input", { class: "input", type: "text", maxlength: "200", placeholder: "例如：会议纪要要点" });
    var contentInput = h("textarea", { class: "textarea", rows: "5", maxlength: "8000", placeholder: "碎片内容…" });
    var dateInput = h("input", { class: "input", type: "date" });
    var today = nowISO().slice(0, 10);
    titleInput.value = r ? r.title : "";
    contentInput.value = r ? r.content : "";
    dateInput.value = r ? (r.date || today) : today;
    var selTags = r ? (r.tagIds || []).slice() : [];

    var tagPick = h("div", { class: "tag-pick" });
    function renderTagPick() {
      tagPick.innerHTML = "";
      if (state.tags.length === 0) {
        tagPick.appendChild(h("span", { class: "tag-pick-empty" }, "暂无标签，点右侧「+ 新建」添加"));
      }
      state.tags.forEach(function (t) {
        var on = selTags.indexOf(t.id) >= 0;
        tagPick.appendChild(h("button", {
          type: "button", class: "tag-chip" + (on ? " on" : ""),
          style: on ? ("background:" + (t.color || "#4f8cff") + "22;border-color:" + (t.color || "#4f8cff") + ";color:" + (t.color || "#4f8cff")) : "",
          dataset: { picktag: t.id },
          onClick: function () {
            var idx = selTags.indexOf(t.id);
            if (idx >= 0) selTags.splice(idx, 1); else selTags.push(t.id);
            renderTagPick();
          }
        }, t.name));
      });
      tagPick.appendChild(h("button", { type: "button", class: "tag-chip tag-new", onClick: function () {
        promptDialog("新建标签", "标签名称：", "", "创建", function (name) {
          name = (name || "").trim();
          if (!name) return;
          if (state.tags.some(function (t) { return t.name === name; })) { toast("已存在同名标签"); return; }
          var t = createTag(name);
          if (t) { selTags.push(t.id); renderTagPick(); }
        });
      } }, "+ 新建"));
    }
    renderTagPick();

    var box = overlayBox([
      h("div", { class: "modal-card", style: "width:min(520px,92vw)" }, [
        h("div", { class: "modal-head" }, [
          h("h2", null, r ? "编辑记录" : "新建记录"),
          h("button", { class: "icon-btn", type: "button", dataset: { close: "1" } }, "✕")
        ]),
        h("div", { class: "modal-body" }, [
          h("label", { class: "field" }, [h("span", { class: "field-label", html: "标题 <em>*</em>" }), titleInput]),
          h("label", { class: "field" }, [h("span", { class: "field-label" }, "日期"), dateInput]),
          h("label", { class: "field" }, [h("span", { class: "field-label" }, "内容"), contentInput]),
          h("div", { class: "field" }, [
            h("span", { class: "field-label" }, "标签（可多选）"),
            tagPick
          ]),
          h("div", { class: "modal-foot" }, [
            h("span", { class: "foot-spacer" }),
            h("button", { class: "ghost", type: "button", onClick: function () { removeBox(box); } }, "取消"),
            h("button", { class: "primary", type: "button", onClick: function () {
              var tt = (titleInput.value || "").trim();
              if (!tt) { toast("请填写标题"); return; }
              var now = nowISO();
              if (r) {
                r.title = tt; r.content = (contentInput.value || "").trim(); r.date = dateInput.value || today; r.tagIds = selTags.slice(); r.updatedAt = now;
              } else {
                state.records.push({ id: uid("r"), title: tt, content: (contentInput.value || "").trim(), date: dateInput.value || today, tagIds: selTags.slice(), createdAt: now, updatedAt: now });
              }
              removeBox(box); saveAll(); render(); toast(r ? "已更新" : "已保存");
            } }, "保存")
          ])
        ])
      ])
    ]);
    setTimeout(function () { if (titleInput.focus) titleInput.focus(); }, 30);
  }

  function deleteRecord(id) {
    confirmDialog("删除记录", "确定删除这条记录吗？此操作不可撤销。", "删除", function () {
      state.records = state.records.filter(function (x) { return x.id !== id; });
      saveAll();
      render();
    });
  }

  /* ============ 任务弹框 ============ */
  function fillGroupSelect(selectedId) {
    var sel = $("f-group"); if (!sel) return;
    sel.innerHTML = "";
    function addOptions(list, depth) {
      list.forEach(function (g) {
        var pad = depth > 0 ? new Array(depth + 1).join("　") : "";
        sel.appendChild(h("option", { value: g.id, selected: g.id === selectedId }, pad + g.name));
        var kids = childGroups(g.id);
        if (kids.length) addOptions(kids, depth + 1);
      });
    }
    addOptions(rootGroups(), 0);
  }

  function openTaskModal(id, prefill) {
    editingId = id || null;
    var t = id ? findTask(id) : null;
    modalSubs = t ? (t.subtasks || []).map(function (s) { return Object.assign({}, s); }) : [];
    var titleEl = $("modal-title"); if (titleEl) titleEl.textContent = t ? "编辑任务" : "新建任务";
    setVal("f-title", t ? t.title : "");
    setVal("f-desc", t ? t.description : "");
    setVal("f-priority", t ? (t.priority || "medium") : "medium");
    fillGroupSelect(t ? t.groupId : (state.ui.group || (state.groups[0] && state.groups[0].id) || ""));
    setVal("f-start", t && t.startAt ? toLocalInput(t.startAt) : "");
    setVal("f-due", t && t.dueAt ? toLocalInput(t.dueAt) : "");
    setVal("f-donenote", t ? (t.doneNote || "") : "");
    if (prefill && prefill.due) setVal("f-due", toLocalInput(prefill.due));
    if (prefill && prefill.group) setVal("f-group", prefill.group);
    var del = $("btn-delete-task"); if (del) del.hidden = !t;
    var m = $("task-modal"); if (m) m.hidden = false;
    // 必须在弹框可见后再渲染子任务编辑器：弹框隐藏时 textarea 无布局，autoGrow 测到的 scrollHeight 为 0，
    // 会导致长内容被压成一行裁掉；显示后再渲染即可正确自适应高度。
    renderSubtaskEdits();
    setTimeout(function () { var e = $("f-title"); if (e) e.focus(); }, 30);
  }

  function closeModal() { var m = $("task-modal"); if (m) m.hidden = true; editingId = null; modalSubs = []; }

  function moveSub(idx, dir) {
    var j = idx + dir;
    if (j < 0 || j >= modalSubs.length) return;
    var tmp = modalSubs[idx]; modalSubs[idx] = modalSubs[j]; modalSubs[j] = tmp;
    renderSubtaskEdits();
  }

  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = "auto";
    var max = 200, hgt = ta.scrollHeight;
    ta.style.height = (hgt > max ? max : hgt) + "px";
    ta.style.overflowY = hgt > max ? "auto" : "hidden";
  }

  function renderSubtaskEdits() {
    var box = $("f-subtasks"); if (!box) return;
    box.innerHTML = "";
    modalSubs.forEach(function (s, idx) {
      var up = h("button", { type: "button", class: "st-move", title: "上移", onClick: function () { moveSub(idx, -1); } }, "↑");
      var dn = h("button", { type: "button", class: "st-move", title: "下移", onClick: function () { moveSub(idx, 1); } }, "↓");
      if (idx === 0) up.disabled = true;
      if (idx === modalSubs.length - 1) dn.disabled = true;
      var ta = h("textarea", { class: "input st-text", rows: "1", placeholder: "子任务内容", dataset: { sti: idx }, onInput: function (ev) { modalSubs[idx].title = ev.target.value; autoGrow(ev.target); } });
      ta.value = s.title || "";
      var row = h("div", { class: "subtask-edit" }, [
        h("input", { class: "st-check", type: "checkbox", checked: !!s.done, dataset: { sd: idx }, onChange: function (ev) { modalSubs[idx].done = ev.target.checked; } }),
        ta,
        h("div", { class: "st-moves" }, [up, dn]),
        h("button", { type: "button", class: "ms-toggle" + (s.isMilestone ? " on" : ""), dataset: { sm: idx }, onClick: function () { modalSubs[idx].isMilestone = !modalSubs[idx].isMilestone; renderSubtaskEdits(); } }, s.isMilestone ? "★ 里程碑" : "设为里程碑"),
        h("button", { type: "button", class: "del-sub", dataset: { sx: idx }, onClick: function () { modalSubs.splice(idx, 1); renderSubtaskEdits(); } }, "✕")
      ]);
      box.appendChild(row);
      autoGrow(ta);
    });
  }

  function saveTask() {
    if (!Store) { toast("存储模块未就绪，保存失败"); return; }
    var title = val("f-title").trim();
    if (!title) { toast("请填写标题"); return; }
    var subs = modalSubs.filter(function (s) { return (s.title || "").trim(); }).map(function (s, i) {
      return { id: s.id || uid("s"), title: s.title.trim(), done: !!s.done, doneAt: s.doneAt || null, isMilestone: !!s.isMilestone, order: i };
    });
    var groupId = val("f-group") || (state.groups[0] && state.groups[0].id) || "";
    var startV = val("f-start"), dueV = val("f-due");
    var now = nowISO();
    if (!groupId) { toast("请先创建一个分组"); return; }

    if (editingId) {
      var t = findTask(editingId);
      if (t) {
        t.title = title; t.description = val("f-desc").trim(); t.priority = val("f-priority") || "medium";
        t.groupId = groupId; t.startAt = startV ? startV : null; t.dueAt = dueV ? dueV : null;
        t.doneNote = val("f-donenote").trim() || null;
        t.subtasks = subs; t.updatedAt = now;
      }
    } else {
      state.tasks.push({
        id: uid("t"), groupId: groupId, title: title, description: val("f-desc").trim(),
        priority: val("f-priority") || "medium", startAt: startV ? startV : null, dueAt: dueV ? dueV : null,
        done: false, doneAt: null, createdAt: now, updatedAt: now, subtasks: subs
      });
    }
    closeModal();
    saveAll();
    render();
    toast("已保存");
  }

  function deleteTask(id) {
    confirmDialog("删除任务", "确定删除该任务吗？此操作不可撤销。", "删除", function () {
      state.tasks = state.tasks.filter(function (t) { return t.id !== id; });
      saveAll();
      render();
    });
  }

  function toggleTaskDone(id) {
    var t = findTask(id); if (!t) return;
    if (!t.done) { openDoneNoteModal(id); return; }   // 完成时弹出可选备注（有些任务看似完成还有后续）
    t.done = false; t.doneAt = null;
    saveAll();
    render();
  }

  function openDoneNoteModal(id) {
    var t = findTask(id); if (!t) return;
    var ta = h("textarea", { class: "textarea", rows: "3", maxlength: "2000", placeholder: "例如：已交付，但还需补充上线文档 / 跟进客户反馈…" });
    ta.value = t.doneNote || "";
    var box = overlayBox([
      h("div", { class: "modal-card", style: "width:min(460px,92vw)" }, [
        h("div", { class: "modal-head" }, [
          h("h2", null, "完成任务备注（可选）"),
          h("button", { class: "icon-btn", type: "button", dataset: { close: "1" } }, "✕")
        ]),
        h("div", { class: "modal-body" }, [
          h("div", { class: "rec-for" }, "任务：" + (t.title || "（无标题）")),
          h("label", { class: "field" }, [h("span", { class: "field-label" }, "完成备注"), ta]),
          h("div", { class: "modal-foot" }, [
            h("button", { class: "ghost", type: "button", onClick: function () { removeBox(box); } }, "取消"),
            h("button", { class: "ghost", type: "button", onClick: function () { finishWithNote(t, ""); removeBox(box); } }, "跳过（直接完成）"),
            h("button", { class: "primary", type: "button", onClick: function () { finishWithNote(t, ta.value); removeBox(box); } }, "保存备注并完成")
          ])
        ])
      ])
    ]);
  }

  function finishWithNote(t, note) {
    var n = (note || "").trim();
    t.done = true;
    t.doneAt = nowISO();
    t.doneNote = n || (t.doneNote || null);   // 跳过时保留已有备注
    saveAll();
    render();
  }

  function toggleSubtask(taskId, subId) {
    var t = findTask(taskId); if (!t || !t.subtasks) return;
    var s = null;
    for (var i = 0; i < t.subtasks.length; i++) { if (t.subtasks[i].id === subId) { s = t.subtasks[i]; break; } }
    if (!s) return;
    s.done = !s.done;
    s.doneAt = s.done ? nowISO() : null;
    saveAll();
    render();
  }

  /* ============ 分组操作 ============ */
  function addGroup(parentId) {
    // 只有真实分组 id 才算父分组；click()/on() 可能把事件对象传进来。
    if (typeof parentId !== "string") { parentId = ""; }
    var isChild = !!parentId;
    promptDialog(isChild ? "新建子文件夹" : "新建分组", isChild ? "请输入子文件夹名称：" : "请输入分组名称：", isChild ? "新子文件夹" : "默认分组", "创建", function (name) {
      name = (name || "").trim();
      if (!name) return;
      var order = childGroups(parentId || "").length;
      state.groups.push({ id: uid("g"), name: name, order: order, parentId: parentId || "" });
      if (isChild) state.ui.groupExpanded[parentId] = true;
      saveAll();
      render();
    });
  }

  function startRename(gid) {
    var g = findGroup(gid); if (!g) return;
    promptDialog("重命名分组", "请输入新的分组名称：", g.name, "保存", function (name) {
      name = (name || "").trim();
      if (!name) return;
      g.name = name;
      saveAll();
      render();
    });
  }

  function deleteGroup(gid) {
    var g = findGroup(gid); if (!g) return;
    if (state.groups.length <= 1) { toast("至少保留一个分组"); return; }
    if (!groupIsEmpty(gid)) { toast("文件夹非空，请先清空其中的任务与子文件夹"); return; }
    state.groups = state.groups.filter(function (x) { return x.id !== gid; });
    if (state.ui.group === gid) state.ui.group = null;
    if (state.ui.groupExpanded[gid]) delete state.ui.groupExpanded[gid];
    saveAll();
    render();
  }

  /* ============ 导入 / 导出 ============ */
  function doExport() {
    if (!Store) { toast("存储模块未就绪"); return; }
    Store.invoke("todos/export").then(function (pl) {
      var b64 = pl && pl.dataBase64;
      if (!b64) { toast("导出失败：未拿到数据"); return; }
      var bytes = base64ToBytes(b64);
      var fname = (pl && pl.fileName) || ("todo-backup-" + fmtDate(nowISO()) + ".json");
      if (Store.hasHostSave && Store.hasHostSave()) {
        Store.saveFile(fname, "application/json", bytes).then(function (r) {
          if (r && r.ok) toast("已导出：" + fname);
          else if (r && r.canceled) toast("已取消导出");
          else fallbackDownload(fname, bytes);
        });
      } else {
        fallbackDownload(fname, bytes);
      }
    }).catch(function (e) { reportErr("导出", e); });
  }

  function fallbackDownload(fname, bytes) {
    try {
      var blob = new Blob([bytes], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = fname; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); document.body.removeChild(a); }, 1000);
      toast("已触发浏览器下载（若被拦截，请在设置中允许）");
    } catch (e) { toast("下载失败，请改用宿主支持的浏览器"); }
  }

  function base64ToBytes(b64) {
    var bin = atob(String(b64 || "").replace(/\s+/g, ""));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
    return out;
  }

  function bytesToBase64(u8) {
    var bin = "";
    for (var i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
    return btoa(bin);
  }

  function doImport(file) {
    if (!Store) { toast("存储模块未就绪"); return; }
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || "").replace(/^\uFEFF/, "");
      var b64;
      try {
        // 兼容「包裹格式」{dataBase64:"..."}；导出的备份是裸 JSON 文档，走 else 分支。
        var parsed = JSON.parse(text);
        b64 = parsed && typeof parsed.dataBase64 === "string" && parsed.dataBase64
          ? parsed.dataBase64
          : bytesToBase64(new TextEncoder().encode(text));
      } catch (e) {
        b64 = bytesToBase64(new TextEncoder().encode(text));
      }
      Store.invoke("todos/import", { dataBase64: b64 }).then(function (pl) {
        if (!pl || !pl.ok) { toast("导入失败"); return; }
        return Store.reload().then(function (r) {
          var data = (r && r.data) || {};
          state.groups = Array.isArray(data.groups) ? data.groups : [];
          state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
          state.records = Array.isArray(data.records) ? data.records : [];
          state.tags = Array.isArray(data.tags) ? data.tags : [];
          state.ui.boardCollapsed = (data.boardCollapsed && typeof data.boardCollapsed === "object") ? data.boardCollapsed : {};
          state.records.forEach(function (r) { if (!Array.isArray(r.tagIds)) r.tagIds = []; });
          normalizeGroups();
          normalizeTasks();
          render();
          toast("导入成功：分组 " + (pl.groups || state.groups.length) + " / 任务 " + (pl.tasks || state.tasks.length));
        });
      }).catch(function (e) { reportErr("导入", e); });
    };
    reader.onerror = function () { toast("读取文件失败"); };
    reader.readAsText(file);
  }

  function normalizeTasks() {
    if (state.groups.length === 0) state.groups.push({ id: uid("g"), name: "默认分组", order: 0 });
    var ids = {};
    state.groups.forEach(function (g) { ids[g.id] = true; });
    var fallback = state.groups[0].id;
    state.tasks.forEach(function (t) { if (!ids[t.groupId]) t.groupId = fallback; });
  }

  /* ============ 自定义确认 / 输入弹框（不依赖可能被沙箱禁用的原生 dialog）============ */
  function overlayBox(children) {
    var box = h("div", { class: "modal" }, [h("div", { class: "modal-backdrop", dataset: { close: "1" } })].concat(children));
    var appEl = $("app");
    if (appEl) appEl.appendChild(box);
    box.addEventListener("click", function (ev) {
      if (ev.target && ev.target.dataset && ev.target.dataset.close === "1") removeBox(box);
    });
    return box;
  }
  function removeBox(box) { if (box && box.parentNode) box.parentNode.removeChild(box); }

  function confirmDialog(title, msg, yesLabel, onYes) {
    var box = overlayBox([
      h("div", { class: "modal-card", style: "width:min(420px,92vw)" }, [
        h("div", { class: "modal-head" }, [h("h2", null, title)]),
        h("div", { class: "modal-body" }, [
          h("div", null, msg),
          h("div", { class: "modal-foot" }, [
            h("span", { class: "foot-spacer" }),
            h("button", { class: "ghost", type: "button", onClick: function () { removeBox(box); } }, "取消"),
            h("button", { class: "danger", type: "button", onClick: function () { removeBox(box); onYes(); } }, yesLabel)
          ])
        ])
      ])
    ]);
  }

  function promptDialog(title, msg, defVal, yesLabel, onOk) {
    var input = h("input", { class: "input", type: "text", value: defVal || "" });
    var box = overlayBox([
      h("div", { class: "modal-card", style: "width:min(420px,92vw)" }, [
        h("div", { class: "modal-head" }, [h("h2", null, title)]),
        h("div", { class: "modal-body" }, [
          h("label", { class: "field" }, [h("span", { class: "field-label" }, msg), input]),
          h("div", { class: "modal-foot" }, [
            h("span", { class: "foot-spacer" }),
            h("button", { class: "ghost", type: "button", onClick: function () { removeBox(box); } }, "取消"),
            h("button", { class: "primary", type: "button", onClick: function () { var v = input.value; removeBox(box); onOk(v); } }, yesLabel)
          ])
        ])
      ])
    ]);
    setTimeout(function () { input.focus(); input.select(); }, 30);
  }

  /* ============ 事件绑定 ============ */
  function wireEvents() {
    click("btn-view-list", function () { switchView("list"); });
    click("btn-view-calendar", function () { switchView("calendar"); });
    click("btn-view-board", function () { switchView("board"); });
    click("btn-view-record", function () { switchView("record"); });
    click("btn-add-record", function () { openRecordModal(null); });
    on("search-input", "input", function (e) { state.ui.search = e.target.value; state.ui.listPage = 1; if (state.ui.view === "list") renderList(); });
    click("btn-add-task", function () { openTaskModal(null); });
    // click() 会把事件对象作为第一个实参传给回调，这里必须用闭包隔掉，
    // 否则 addGroup(parentId) 收到的是 MouseEvent。
    click("btn-add-group", function () { addGroup(); });
    click("btn-add-group-mini", function () { addGroup(); });
    click("btn-add-tag-mini", function () {
      promptDialog("新建标签", "标签名称：", "", "创建", function (name) {
        name = (name || "").trim();
        if (!name) return;
        if (state.tags.some(function (t) { return t.name === name; })) { toast("已存在同名标签"); return; }
        createTag(name);
        render();
      });
    });
    click("btn-export", doExport);
    click("btn-import", function () { var fi = $("file-input"); if (fi) fi.click(); });
    on("file-input", "change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) doImport(f);
      e.target.value = "";
    });

    // 更多菜单开关
    click("btn-more", function (ev) {
      var m = $("more-menu"); if (!m) return;
      m.hidden = !m.hidden;
      var btn = $("btn-more"); if (btn) btn.setAttribute("aria-expanded", String(!m.hidden));
      ev.stopPropagation();
    });
    document.addEventListener("click", function (ev) {
      var m = $("more-menu"); if (!m || m.hidden) return;
      if (ev.target && ev.target.closest && ev.target.closest("#btn-more")) return;
      if (ev.target.closest("#more-menu")) return;
      m.hidden = true;
    });

    // 状态过滤 chips（事件委托）
    var chips = $("status-chips");
    if (chips) chips.addEventListener("click", function (ev) {
      var b = ev.target.closest(".chip"); if (!b) return;
      state.ui.status = b.dataset.status || "all";
      Array.prototype.forEach.call(chips.querySelectorAll(".chip"), function (c) { c.classList.toggle("active", c === b); });
      state.ui.listPage = 1;
      if (state.ui.view === "list") renderList();
    });
    on("priority-filter", "change", function (e) { state.ui.priority = e.target.value; state.ui.listPage = 1; if (state.ui.view === "list") renderList(); });
    on("sort-select", "change", function (e) { state.ui.sort = e.target.value; state.ui.listPage = 1; if (state.ui.view === "list") renderList(); });

    // 列表内容委托
    var lc = $("list-content");
    if (lc) lc.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t) return;
      if (t.dataset && t.dataset.check) { toggleTaskDone(t.dataset.check); return; }
      var st = t.dataset && t.dataset.stid ? t : (t.closest ? t.closest("[data-stid]") : null);
      if (st && st.dataset && st.dataset.stid) { toggleSubtask(st.dataset.stid, st.dataset.sub); return; }
      var act = t.dataset && t.dataset.act ? t : (t.closest ? t.closest("[data-act]") : null);
      if (act && act.dataset && act.dataset.act) {
        var a = act.dataset.act;
        if (a === "toggle") toggleTaskDone(act.dataset.tid);
        else if (a === "edit") openTaskModal(act.dataset.tid);
        else if (a === "del") deleteTask(act.dataset.tid);
        return;
      }
      var tog = t.dataset && t.dataset.toggle ? t : (t.closest ? t.closest("[data-toggle]") : null);
      if (tog && tog.dataset && tog.dataset.toggle) {
        var ttd = tog.dataset.toggle;
        state.ui.openTasks[ttd] = !state.ui.openTasks[ttd];
        renderList();
        return;
      }
    });

    // 执行视图（看板）委托
    var bc2 = $("board-content");
    if (bc2) bc2.addEventListener("click", function (ev) {
      var t = ev.target; if (!t) return;
      var bc = t.dataset && t.dataset.bccollapse ? t : (t.closest ? t.closest("[data-bccollapse]") : null);
      if (bc && bc.dataset && bc.dataset.bccollapse) {
        var cid = bc.dataset.bccollapse;
        state.ui.boardCollapsed[cid] = !state.ui.boardCollapsed[cid];
        renderBoard();
        saveAll();
        return;
      }
      var subToggle = t.dataset && t.dataset.bcsub ? t : (t.closest ? t.closest("[data-bcsub]") : null);
      if (subToggle && subToggle.dataset && subToggle.dataset.bcsub) {
        var sid = subToggle.dataset.bcsub;
        state.ui.boardOpen[sid] = !state.ui.boardOpen[sid];
        renderBoard();
        return;
      }
      var act = t.dataset && t.dataset.act ? t : (t.closest ? t.closest("[data-act]") : null);
      if (act && act.dataset && act.dataset.act) {
        var a = act.dataset.act;
        if (a === "toggle") toggleTaskDone(act.dataset.tid);
        else if (a === "edit") openTaskModal(act.dataset.tid);
        else if (a === "del") deleteTask(act.dataset.tid);
        return;
      }
      var op = t.dataset && t.dataset.open ? t : (t.closest ? t.closest("[data-open]") : null);
      if (op && op.dataset && op.dataset.open) { openTaskModal(op.dataset.open); }
    });
    if (bc2) bc2.addEventListener("change", function (ev) {
      var cb = ev.target.closest ? ev.target.closest("input[data-stid]") : null;
      if (cb && cb.dataset && cb.dataset.stid) { toggleSubtask(cb.dataset.stid, cb.dataset.sub); }
    });

    // 日历翻页
    click("cal-prev", function () { shiftMonth(-1); });
    click("cal-next", function () { shiftMonth(1); });
    click("cal-today", function () { var d = new Date(); state.ui.calYear = d.getFullYear(); state.ui.calMonth = d.getMonth(); renderCalendar(); });
    var cg = $("cal-grid");
    if (cg) cg.addEventListener("click", function (ev) {
      var moreBtn = ev.target.closest ? ev.target.closest("[data-allday]") : null;
      if (moreBtn && moreBtn.dataset && moreBtn.dataset.allday) { openDayModal(moreBtn.dataset.allday); return; }
      var recChip = ev.target.closest ? ev.target.closest("[data-openrec]") : null;
      if (recChip && recChip.dataset && recChip.dataset.openrec) { openRecordModal(recChip.dataset.openrec); return; }
      var chip = ev.target.closest ? ev.target.closest("[data-open]") : null;
      if (chip && chip.dataset && chip.dataset.open) { openTaskModal(chip.dataset.open); return; }
    });

    // 记录列表委托
    var rc = $("records-content");
    if (rc) rc.addEventListener("click", function (ev) {
      var act = ev.target.dataset && ev.target.dataset.act ? ev.target : (ev.target.closest ? ev.target.closest("[data-act]") : null);
      if (act && act.dataset && act.dataset.act) {
        var a = act.dataset.act;
        if (a === "editrec") openRecordModal(act.dataset.rid);
        else if (a === "delrec") deleteRecord(act.dataset.rid);
      }
    });

    // 弹框
    click("btn-close-modal", closeModal);
    click("btn-cancel-task", closeModal);
    var form = $("task-form");
    if (form) form.addEventListener("submit", function (ev) { ev.preventDefault(); saveTask(); });
    click("btn-save-task", function () { saveTask(); });
    click("btn-delete-task", function () { if (editingId) deleteTask(editingId); });
    click("btn-add-sub", function () { modalSubs.push({ id: uid("s"), title: "", done: false, isMilestone: false, order: modalSubs.length }); renderSubtaskEdits(); });
  }

  function switchView(v) {
    state.ui.view = v;
    [["main-list", "btn-view-list", "list"],
     ["main-calendar", "btn-view-calendar", "calendar"],
     ["main-board", "btn-view-board", "board"],
     ["main-records", "btn-view-record", "record"]].forEach(function (e) {
      var view = $(e[0]), btn = $(e[1]), on = e[2] === v;
      if (view) view.hidden = !on;
      if (btn) { btn.classList.toggle("active", on); btn.setAttribute("aria-selected", String(on)); }
    });
    // 日历同时含任务（按分组筛选）与记录（按标签筛选），故两栏都显示；记录视图无分组概念只显标签栏。
    var isRecord = v === "record";
    var isCalendar = v === "calendar";
    var gs = $("group-section"), ts = $("tag-section");
    if (gs) gs.hidden = isRecord;
    if (ts) ts.hidden = !isRecord && !isCalendar;
    render();
  }

  function shiftMonth(delta) {
    var m = state.ui.calMonth + delta;
    var y = state.ui.calYear;
    if (m < 0) { m = 11; y--; } else if (m > 11) { m = 0; y++; }
    state.ui.calYear = y; state.ui.calMonth = m;
    renderCalendar();
  }

  /* ============ 启动 ============ */
  function startStatusTimer() {
    if (statusTick) clearInterval(statusTick);
    statusTick = setInterval(function () {
      // 每 30s 刷新一次状态（逾期/进行中随时间变化）；弹框打开时不重排，避免打断输入。
      var m = $("task-modal");
      if (m && !m.hidden) return;
      if (state.ui.view === "list") renderList();
      else if (state.ui.view === "calendar") renderCalendar();
      else if (state.ui.view === "record") renderRecords();
      else renderBoard();
    }, 30000);
  }

  function bootStorage() {
    if (!Store) { showBootError(new Error("存储模块未加载（storage.js 未成功执行）")); return; }
    Store.init().then(function (res) {
      var data = (res && res.data) || {};
      state.groups = Array.isArray(data.groups) ? data.groups : [];
      state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
      state.records = Array.isArray(data.records) ? data.records : [];
      state.tags = Array.isArray(data.tags) ? data.tags : [];
      state.ui.boardCollapsed = (data.boardCollapsed && typeof data.boardCollapsed === "object") ? data.boardCollapsed : {};
      state.records.forEach(function (r) { if (!Array.isArray(r.tagIds)) r.tagIds = []; });
      normalizeGroups();
      if (state.groups.length === 0) {
        state.groups.push({ id: uid("g"), name: "默认分组", order: 0 });
        saveAll();
      }
      normalizeTasks();
      var d = new Date();
      state.ui.calYear = d.getFullYear();
      state.ui.calMonth = d.getMonth();
      render();
      startStatusTimer();
    }).catch(function (e) { reportErr("初始化存储", e); render(); });
  }

  function showBootError(e) {
    var app = $("app");
    if (app) app.insertAdjacentHTML("afterbegin",
      '<div class="boot-error"><h3>待办插件启动失败</h3><pre>' + String(e && e.stack ? e.stack : e) + '</pre></div>');
  }

  function boot() {
    try {
      applyTheme();
      wireEvents();
      bootStorage();
    } catch (e) { showBootError(e); }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
