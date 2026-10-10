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
    ui: { view: "list", search: "", status: "all", priority: "all", sort: "created", group: null, collapsed: {}, calYear: 0, calMonth: 0 }
  };
  var editingId = null;
  var modalSubs = [];
  var statusTick = null;

  function buildDoc() { return { version: 1, groups: state.groups, tasks: state.tasks }; }
  function saveAll() {
    if (!Store) return Promise.resolve(false);
    return Store.save(buildDoc(), true).catch(function (e) { reportErr("保存", e); return false; });
  }
  function findTask(id) { for (var i = 0; i < state.tasks.length; i++) { if (state.tasks[i].id === id) return state.tasks[i]; } return null; }
  function findGroup(id) { for (var i = 0; i < state.groups.length; i++) { if (state.groups[i].id === id) return state.groups[i]; } return null; }

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
    renderSidebar();
    if (state.ui.view === "list") renderList();
    else if (state.ui.view === "calendar") renderCalendar();
    else renderBoard();
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

  /* ============ 侧边栏：分组树 ============ */
  function renderSidebar() {
    var tree = $("group-tree"); if (!tree) return;
    tree.innerHTML = "";
    var allCount = state.tasks.length;
    var allItem = h("div", {
      class: "group-item" + (state.ui.group == null ? " active" : ""),
      dataset: { group: "__all__" },
      onClick: function () { state.ui.group = null; render(); }
    }, [
      h("span", { class: "group-chevron" }, "▾"),
      h("span", { class: "group-name" }, "全部任务"),
      h("span", { class: "group-count" }, String(allCount))
    ]);
    tree.appendChild(allItem);

    var sorted = state.groups.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    sorted.forEach(function (g) {
      var count = state.tasks.filter(function (t) { return t.groupId === g.id; }).length;
      var item = h("div", {
        class: "group-item" + (state.ui.group === g.id ? " active" : ""),
        dataset: { group: g.id },
        onClick: function (ev) {
          if (ev.target && ev.target.closest && ev.target.closest(".group-actions")) return;
          state.ui.group = (state.ui.group === g.id) ? null : g.id;
          render();
        }
      }, [
        h("span", { class: "group-chevron" }, "▾"),
        h("span", { class: "group-name", dataset: { rename: g.id } }, g.name),
        h("span", { class: "group-count" }, String(count)),
        h("span", { class: "group-actions" }, [
          h("button", { type: "button", title: "重命名", dataset: { act: "rename", gid: g.id }, onClick: function (ev) { ev.stopPropagation(); startRename(g.id); } }, "✎"),
          h("button", { type: "button", title: "删除", dataset: { act: "del", gid: g.id }, onClick: function (ev) { ev.stopPropagation(); deleteGroup(g.id); } }, "🗑")
        ])
      ]);
      tree.appendChild(item);
    });
    var empty = $("sidebar-empty");
    if (empty) empty.hidden = state.groups.length > 0;
  }

  /* ============ 列表视图 ============ */
  function baseFiltered() {
    var q = state.ui.search.trim().toLowerCase();
    return state.tasks.filter(function (t) {
      if (state.ui.group && t.groupId !== state.ui.group) return false;
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
    var now = Date.now();

    if (state.tasks.length === 0) {
      root.appendChild(emptyState("🗒️", "还没有任何任务", "点击右上角「新建任务」创建你的第一个待办。", true));
      return;
    }
    var list = filteredTasks();
    if (list.length === 0) {
      root.appendChild(emptyState("🔍", "没有匹配的任务", "试着调整搜索词、状态或优先级筛选。", false));
      return;
    }

    var byGroup = {};
    list.forEach(function (t) { (byGroup[t.groupId] = byGroup[t.groupId] || []).push(t); });
    var groupOrder = state.groups.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });

    groupOrder.forEach(function (g) {
      var items = byGroup[g.id];
      if (!items || items.length === 0) return;
      var collapsed = !!state.ui.collapsed[g.id];
      var head = h("div", { class: "group-section-head", dataset: { gid: g.id }, onClick: function () { state.ui.collapsed[g.id] = !collapsed; renderList(); } }, [
        h("span", { class: "group-chevron", style: collapsed ? "transform:rotate(-90deg)" : "" }, "▾"),
        h("span", { class: "gs-title" }, g.name),
        h("span", { class: "gs-count" }, items.length + " 项")
      ]);
      var section = h("div", { class: "group-section" + (collapsed ? " collapsed" : "") }, [head]);
      items.forEach(function (t) { section.appendChild(taskCard(t, now)); });
      root.appendChild(section);
    });
  }

  function taskCard(t, now) {
    var st = taskStatus(t, now);
    var pr = t.priority || "medium";
    var prog = progressOf(t);

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
    var detail = h("div", { class: "task-detail", id: detailId, hidden: true });
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

    var hasDesc = !!(t.description && t.description.trim());
    var expandable = hasDesc || prog.total > 0;
    var rowProps = { class: "task-row1" + (expandable ? " expandable" : "") };
    if (expandable) rowProps.dataset = { toggle: t.id };
    var rowKids = [];
    if (expandable) rowKids.push(h("span", { class: "task-chevron" }, "▸"));
    rowKids.push(h("input", { class: "task-check", type: "checkbox", checked: !!t.done, dataset: { check: t.id } }));
    rowKids.push(h("div", { class: "task-main" }, [
      h("div", { class: "task-title" }, t.title),
      meta,
      progress
    ]));
    var card = h("div", { class: "task-card" + (t.done ? " done" : ""), dataset: { tid: t.id } }, [
      h("div", rowProps, rowKids),
      actions,
      detail
    ]);
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
      var dayTasks = state.tasks.filter(function (t) {
        var k = dayKeyOf(t.dueAt) || dayKeyOf(t.startAt) || dayKeyOf(t.createdAt);
        return k === key;
      });
      var shown = dayTasks.slice(0, 3);
      shown.forEach(function (t) {
        var st = taskStatus(t, d.getTime());
        cellChildren.push(h("button", {
          class: "cal-chip s-" + st, type: "button", dataset: { open: t.id },
          title: t.title
        }, [h("span", { class: "dot", style: "background:var(--st-" + st + ")" }), (t.title || "（无标题）")]));
      });
      if (dayTasks.length > 3) cellChildren.push(h("div", { class: "cal-more" }, "+" + (dayTasks.length - 3) + " 更多"));

      grid.appendChild(h("div", {
        class: "cal-cell" + (isOther ? " other" : "") + (isToday ? " today" : ""),
        dataset: { cell: key },
        onClick: function (ev) {
          if (ev.target && ev.target.closest && ev.target.closest(".cal-chip")) return;
          var ds = ev.currentTarget.dataset;
          var cdate = ds.cell;
          openTaskModal(null, { due: cdate + "T09:00", group: state.ui.group });
        }
      }, cellChildren));
    }
  }

  /* ============ 执行视图（看板） ============ */
  function renderBoard() {
    var root = $("board-content"); if (!root) return;
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
      var body = h("div", { class: "board-col-body" });
      items.forEach(function (t) { body.appendChild(boardCard(t, now)); });
      root.appendChild(h("div", { class: "board-col", dataset: { col: col.key } }, [
        h("div", { class: "board-col-head" }, [
          h("span", { class: "board-col-dot s-" + col.key }),
          h("span", { class: "board-col-title" }, col.label),
          h("span", { class: "board-col-count" }, String(items.length))
        ]),
        body
      ]));
    });
  }

  function boardCard(t, now) {
    var pr = t.priority || "medium";
    var prog = progressOf(t);
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
    }
    kids.push(h("div", { class: "bc-actions" }, [
      h("button", { type: "button", dataset: { act: "toggle", tid: t.id } }, t.done ? "↩ 重开" : "✓ 完成"),
      h("button", { type: "button", dataset: { act: "edit", tid: t.id } }, "编辑"),
      h("button", { type: "button", dataset: { act: "del", tid: t.id } }, "删除")
    ]));
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

  /* ============ 任务弹框 ============ */
  function fillGroupSelect(selectedId) {
    var sel = $("f-group"); if (!sel) return;
    sel.innerHTML = "";
    var sorted = state.groups.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    sorted.forEach(function (g) {
      sel.appendChild(h("option", { value: g.id, selected: g.id === selectedId }, g.name));
    });
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
    if (prefill && prefill.due) setVal("f-due", toLocalInput(prefill.due));
    if (prefill && prefill.group) setVal("f-group", prefill.group);
    renderSubtaskEdits();
    var del = $("btn-delete-task"); if (del) del.hidden = !t;
    var m = $("task-modal"); if (m) m.hidden = false;
    setTimeout(function () { var e = $("f-title"); if (e) e.focus(); }, 30);
  }

  function closeModal() { var m = $("task-modal"); if (m) m.hidden = true; editingId = null; modalSubs = []; }

  function renderSubtaskEdits() {
    var box = $("f-subtasks"); if (!box) return;
    box.innerHTML = "";
    modalSubs.forEach(function (s, idx) {
      var row = h("div", { class: "subtask-edit" }, [
        h("input", { class: "st-check", type: "checkbox", checked: !!s.done, dataset: { sd: idx }, onChange: function (ev) { modalSubs[idx].done = ev.target.checked; } }),
        h("input", { type: "text", class: "input", value: s.title, placeholder: "子任务内容", dataset: { sti: idx }, onInput: function (ev) { modalSubs[idx].title = ev.target.value; } }),
        h("button", { type: "button", class: "ms-toggle" + (s.isMilestone ? " on" : ""), dataset: { sm: idx }, onClick: function () { modalSubs[idx].isMilestone = !modalSubs[idx].isMilestone; renderSubtaskEdits(); } }, s.isMilestone ? "★ 里程碑" : "设为里程碑"),
        h("button", { type: "button", class: "del-sub", dataset: { sx: idx }, onClick: function () { modalSubs.splice(idx, 1); renderSubtaskEdits(); } }, "✕")
      ]);
      box.appendChild(row);
    });
  }

  function saveTask() {
    if (!Store) { toast("存储模块未就绪，保存失败"); return; }
    var title = val("f-title").trim();
    if (!title) { toast("请填写标题"); return; }
    var subs = modalSubs.filter(function (s) { return (s.title || "").trim(); }).map(function (s) {
      return { id: s.id || uid("s"), title: s.title.trim(), done: !!s.done, doneAt: s.doneAt || null, isMilestone: !!s.isMilestone, order: s.order || 0 };
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
    t.done = !t.done;
    t.doneAt = t.done ? nowISO() : null;
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
  function addGroup() {
    promptDialog("新建分组", "请输入分组名称：", "默认分组", "创建", function (name) {
      name = (name || "").trim();
      if (!name) return;
      state.groups.push({ id: uid("g"), name: name, order: state.groups.length });
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
    if (state.groups.length <= 1) { toast("至少保留一个分组"); return; }
    var g = findGroup(gid);
    var remaining = state.groups.filter(function (x) { return x.id !== gid; });
    var moveTo = remaining[0];
    confirmDialog("删除分组", "删除「" + (g ? g.name : "") + "」？其下任务将移到「" + moveTo.name + "」。", "删除", function () {
      state.tasks.forEach(function (t) { if (t.groupId === gid) t.groupId = moveTo.id; });
      state.groups = remaining;
      if (state.ui.group === gid) state.ui.group = null;
      saveAll();
      render();
    });
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
    on("search-input", "input", function (e) { state.ui.search = e.target.value; if (state.ui.view === "list") renderList(); });
    click("btn-add-task", function () { openTaskModal(null); });
    click("btn-add-group", addGroup);
    click("btn-add-group-mini", addGroup);
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
      if (state.ui.view === "list") renderList();
    });
    on("priority-filter", "change", function (e) { state.ui.priority = e.target.value; if (state.ui.view === "list") renderList(); });
    on("sort-select", "change", function (e) { state.ui.sort = e.target.value; if (state.ui.view === "list") renderList(); });

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
        var did = "detail-" + tog.dataset.toggle;
        var d = $(did);
        if (d) { d.hidden = !d.hidden; tog.classList.toggle("expanded", !d.hidden); }
        return;
      }
    });

    // 执行视图（看板）委托
    var bc2 = $("board-content");
    if (bc2) bc2.addEventListener("click", function (ev) {
      var t = ev.target; if (!t) return;
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

    // 日历翻页
    click("cal-prev", function () { shiftMonth(-1); });
    click("cal-next", function () { shiftMonth(1); });
    click("cal-today", function () { var d = new Date(); state.ui.calYear = d.getFullYear(); state.ui.calMonth = d.getMonth(); renderCalendar(); });
    var cg = $("cal-grid");
    if (cg) cg.addEventListener("click", function (ev) {
      var chip = ev.target.closest ? ev.target.closest("[data-open]") : null;
      if (chip && chip.dataset && chip.dataset.open) { openTaskModal(chip.dataset.open); return; }
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
     ["main-board", "btn-view-board", "board"]].forEach(function (e) {
      var view = $(e[0]), btn = $(e[1]), on = e[2] === v;
      if (view) view.hidden = !on;
      if (btn) { btn.classList.toggle("active", on); btn.setAttribute("aria-selected", String(on)); }
    });
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
      else renderBoard();
    }, 30000);
  }

  function bootStorage() {
    if (!Store) { showBootError(new Error("存储模块未加载（storage.js 未成功执行）")); return; }
    Store.init().then(function (res) {
      var data = (res && res.data) || {};
      state.groups = Array.isArray(data.groups) ? data.groups : [];
      state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
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
