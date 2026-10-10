# -*- coding: utf-8 -*-
"""静态校验前端 DOM 引用（与 _buildpkg.js 内建的自检同规则，方便单独快速跑）。

规则：
  1) app.js 里出现 `$("x").` —— 对 getElementById 结果直接取属性。x 不存在时是
     `Cannot set properties of null`，而它通常位于绑定/boot 开头，会把整个
     界面连坐搞死（mdnotes 的历史事故：所有按钮失效 + 数据从不落盘）。
     待办插件已改用 val(id)/setVal(id,v) 与 click()/on() 安全绑定，但仍要守住。
  2) `click("x", fn)` / `on("x", ev, fn)` 是安全绑定；缺失元素只告警不致命。
  3) index.html 里被注释掉的 id 会被单独列出（最容易被漏掉的一类）。
  4) 同名函数声明会被后声明的覆盖，先声明的那个静默失效 —— 必须静态兜住。
  5) 关键元素清单（CRITICAL）必须都在 index.html 真实存在。
"""
import re, io, os, sys

BASE = os.path.dirname(os.path.abspath(__file__))
html = io.open(os.path.join(BASE, "ui/index.html"), encoding="utf-8").read()
js = io.open(os.path.join(BASE, "ui/app.js"), encoding="utf-8").read()

html_live = re.sub(r"<!--.*?-->", "", html, flags=re.S)
live_ids = set(re.findall(r'\bid="([^"]+)"', html_live))
commented_ids = sorted(set(re.findall(r'\bid="([^"]+)"', html)) - live_ids)

# 扫描前去掉注释：注释里会引用历史错误代码，不能当真
js_code = re.sub(r"/\*.*?\*/", "", js, flags=re.S)
js_code = re.sub(r"^[ \t]*//.*$", "", js_code, flags=re.M)

# ① 悬空属性访问
bad = []
for m in re.finditer(r'\$\("([^"]+)"\)\s*\.', js_code):
    rid = m.group(1)
    if rid not in live_ids:
        bad.append((rid, '直接对 $("id") 取属性（会抛 TypeError）', js_code[:m.start()].count("\n") + 1))

print("HTML 可用 id (%d)" % len(live_ids))
if commented_ids:
    print("被注释掉的 id: %s" % ", ".join(commented_ids))
print()
if bad:
    print("!! 不安全引用（必须修）:")
    for rid, why, ln in bad:
        print("   - #%-16s %s  (app.js 行 %d)" % (rid, why, ln))
    sys.exit(1)
print("OK：没有对缺失元素取属性的代码。")

# ② 同名函数声明覆盖
sigs = {}
for m in re.finditer(r'^  function (\w+)\s*\(', js_code, flags=re.M):
    sigs.setdefault(m.group(1), []).append(js_code[:m.start()].count("\n") + 1)
dupes = {k: v for k, v in sigs.items() if len(v) > 1}
if dupes:
    print("!! 重复的函数声明（后者会覆盖前者，必须改名）:")
    for name, lines in dupes.items():
        print("   - %s  定义于 app.js 行 %s" % (name, ", ".join(str(x) for x in lines)))
    sys.exit(1)
print("OK：没有重复的函数声明。")

# ⑤ 关键元素清单（待办插件：工具栏、分组树、双视图、弹框、状态条、导入入口）
CRITICAL = [
    "app", "search-input", "btn-view-list", "btn-view-calendar", "btn-add-task",
    "btn-more", "more-menu", "btn-add-group", "btn-import", "btn-export",
    "group-tree", "main-list", "list-content", "main-calendar", "cal-grid",
    "store-status", "store-text", "task-modal", "task-form", "f-title", "f-group",
    "f-priority", "f-start", "f-due", "btn-add-sub", "f-subtasks", "btn-save-task",
    "toast", "file-input",
]
missing = [c for c in CRITICAL if c not in live_ids]
if missing:
    print("!! index.html 缺关键元素: %s" % ", ".join(missing))
    sys.exit(1)
print("OK：关键元素齐备。")
