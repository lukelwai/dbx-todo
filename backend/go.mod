// DBX 待办 Todo 插件 —— 侧车（Go，纯标准库 + 官方 SDK + modernc.org/sqlite）
//
// 数据存储方案：
//   - 用户数据（分组 / 任务 / 子任务 / 里程碑）落盘在连接配置里填写的
//     「待办存储目录」下的 `.todo/todos.db`，使用 SQLite（纯 Go 实现，
//     modernc.org/sqlite，无 cgo，可三平台交叉编译）。
//   - 库内为关系表：groups / tasks / subtasks / meta(rev)。子任务与任务解耦存储，
//     方便后续直接基于表扩展（加列、加索引、跨表查询、统计等）。
//   - 前端协议保持「整体文档」模型（load 返回 {data,rev}，save 接收整体 data）；
//     侧车内部把文档拆解写入三张表、load 时再组装回文档，两者互转。
//   - 前端跑在 sandboxed iframe 里没有任何磁盘权限；唯一的落盘通道是
//     dbxPlugin.invoke(...) → 本进程写磁盘。前端不碰磁盘、不碰 localStorage。
//   - 并发防护用 meta 表里的单调递增 `_rev`：前端回声 rev，不匹配则拒绝并回传
//     最新 rev 让前端重放，避免多实例「旧快照覆盖新数据」；导入是用户主动覆盖，
//     不经前端 rev 回声检查，直接在当前 rev 基础上递增。

module github.com/lwai/todo

go 1.21

require modernc.org/sqlite v1.34.4

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/google/uuid v1.6.0 // indirect
	github.com/hashicorp/golang-lru/v2 v2.0.7 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/ncruces/go-strftime v0.1.9 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/sys v0.22.0 // indirect
	modernc.org/gc/v3 v3.0.0-20240107210532-573471604cb6 // indirect
	modernc.org/libc v1.55.3 // indirect
	modernc.org/mathutil v1.6.0 // indirect
	modernc.org/memory v1.8.0 // indirect
	modernc.org/strutil v1.2.0 // indirect
	modernc.org/token v1.1.0 // indirect
)
