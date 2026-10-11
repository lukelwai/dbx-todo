// DBX 待办 Todo —— 原生侧车（Go，纯标准库 + vendor 的官方 SDK）
//
// 侧车 RPC 一览：
//
//	connection/test        —— 校验「待办存储目录」可写
//	connection/connect     —— 接收 storage_dir，建目录
//	connection/disconnect  —— 清空连接态
//	todos/ping             —— 版本 + 目录 + 是否已配置
//	todos/probe            —— 非破坏性可写性探测（前端启动用它替代「存整份快照」）
//	todos/load             —— 读回文档 {data: doc}
//	todos/save             —— 原子写文档（带 rev 并发防护）
//	todos/export           —— 把文档字节交给前端（供宿主「另存为」），不自己写盘
//	todos/import           —— 校验并整体替换文档（导入此前导出的文件）
//	ui/getPrefs            —— 界面偏好（面板宽度等，存插件数据目录）
//	ui/setPrefs            —— 写界面偏好
package main

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"

	dbxpluginsdk "github.com/lwai/todo/dbxsdk"
)

// 必须与 manifest.json 的 id / version 完全一致，否则宿主判定 Sidecar 身份不匹配并丢弃。
// pluginVersion 只是兜底；运行时以包内 manifest.json 的版本为准（见 resolveMetadata）。
const (
	pluginID      = "com.lwai.todo"
	pluginVersion = "0.1.8"
)

type plugin struct {
	mutex       sync.Mutex
	connections map[string]struct{}
}

type RPCError = dbxpluginsdk.PluginError

func badParams(format string, args ...any) *dbxpluginsdk.PluginError {
	return dbxpluginsdk.NewError(-32602, fmt.Sprintf(format, args...))
}
func failed(code int, err error) *dbxpluginsdk.PluginError {
	return dbxpluginsdk.NewError(code, err.Error())
}

func (plugin *plugin) Handle(
	_ dbxpluginsdk.RequestContext,
	method string,
	params json.RawMessage,
	_ *dbxpluginsdk.Emitter,
) (any, *dbxpluginsdk.PluginError) {
	if method != "todos/save" && method != "todos/import" {
		absorbParams(params)
	}

	var values map[string]any
	if len(params) > 0 {
		if err := json.Unmarshal(params, &values); err != nil {
			return nil, badParams("Invalid request parameters")
		}
	} else {
		values = map[string]any{}
	}

	switch method {
	case "connection/test":
		where := todoDir()
		if err := os.MkdirAll(where, 0o755); err != nil {
			return map[string]any{"success": false, "message": "无法写入待办存储目录：" + err.Error()}, nil
		}
		if err := os.MkdirAll(todoMetaDir(), 0o755); err != nil {
			return map[string]any{"success": false, "message": "无法写入 .todo 目录：" + err.Error()}, nil
		}
		return map[string]any{
			"success": true,
			"message": "待办 Todo 已就绪，数据将保存在「待办存储目录」下的 .todo/todos.db（SQLite）。",
		}, nil

	case "connection/connect":
		connectionID, pluginError := requestConnectionID(values)
		if pluginError != nil {
			return nil, pluginError
		}
		plugin.mutex.Lock()
		if plugin.connections == nil {
			plugin.connections = map[string]struct{}{}
		}
		plugin.connections[connectionID] = struct{}{}
		plugin.mutex.Unlock()
		oldDir := todoDir()
		if d := connDirFromValues(values); d != "" {
			setDir(d)
		}
		newDir := todoDir()
		_ = os.MkdirAll(todoDir(), 0o755)
		_ = os.MkdirAll(todoMetaDir(), 0o755)
		if oldDir != newDir {
			migrateTodoDir(oldDir, newDir)
		}
		sidecarTrace(fmt.Sprintf("connection/connect id=%s dir=%s configured=%v",
			connectionID, todoDir(), dirConfigured()))
		return map[string]any{
			"success":    true,
			"storageDir": todoDir(),
			"configured": dirConfigured(),
		}, nil

	case "connection/disconnect":
		connectionID, pluginError := requestConnectionID(values)
		if pluginError != nil {
			return nil, pluginError
		}
		plugin.mutex.Lock()
		delete(plugin.connections, connectionID)
		plugin.mutex.Unlock()
		return map[string]any{"success": true}, nil

	case "todos/ping":
		return map[string]any{
			"ok":         true,
			"plugin":     pluginID,
			"version":    resolveMetadata().Version,
			"storageDir": todoDir(),
			"configured": dirConfigured(),
		}, nil

	case "todos/probe":
		// 非破坏性可写性探测：只往 .todo/ 写一个探针文件，不碰索引/数据。
		if err := os.MkdirAll(todoMetaDir(), 0o755); err != nil {
			return map[string]any{"ok": false, "dir": todoDir(), "error": err.Error()}, nil
		}
		probe := filepath.Join(todoMetaDir(), ".write-probe")
		if err := os.WriteFile(probe, []byte(time.Now().Format(time.RFC3339)), 0o644); err != nil {
			return map[string]any{"ok": false, "dir": todoDir(), "error": err.Error()}, nil
		}
		return map[string]any{"ok": true, "dir": todoDir(), "configured": dirConfigured()}, nil

	case "todos/setDir":
		var p struct {
			Dir        string `json:"dir"`
			StorageDir string `json:"storage_dir"`
			Connection struct {
				ID string `json:"id"`
			} `json:"connection"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		dir := firstNonEmpty(p.Dir, p.StorageDir)
		if strings.TrimSpace(dir) == "" {
			return nil, badParams("dir is empty")
		}
		oldDir := todoDir()
		setDir(dir)
		newDir := todoDir()
		_ = os.MkdirAll(todoDir(), 0o755)
		_ = os.MkdirAll(todoMetaDir(), 0o755)
		if oldDir != newDir {
			migrateTodoDir(oldDir, newDir)
		}
		return map[string]any{"ok": true, "path": todoDBPath(), "dir": todoDir()}, nil

	case "todos/load":
		return todosLoad()

	case "todos/save":
		var p struct {
			Rev        json.RawMessage `json:"rev"` // 前端回声的并发版本号
			Data       json.RawMessage `json:"data"`
			StorageDir string          `json:"storage_dir"`
			Dir        string          `json:"dir"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		if dir := firstNonEmpty(p.StorageDir, p.Dir); dir != "" {
			setDir(dir)
		}
		if len(p.Data) == 0 {
			return nil, badParams("missing data")
		}
		return todosSave(p.Rev, p.Data)

	case "todos/export":
		return todosExport()

	case "todos/import":
		var p struct {
			DataBase64 string `json:"dataBase64"`
		}
		if e := json.Unmarshal(params, &p); e != nil {
			return nil, badParams("invalid params: %v", e)
		}
		return todosImport(p.DataBase64)

	case "ui/getPrefs":
		return map[string]any{"prefs": loadPrefs()}, nil

	case "ui/setPrefs":
		return setPrefsHandler(params)

	default:
		return nil, dbxpluginsdk.MethodNotFound(method)
	}
}

func requestConnectionID(values map[string]any) (string, *dbxpluginsdk.PluginError) {
	if connection, _ := values["connection"].(map[string]any); connection != nil {
		if connectionID, _ := connection["id"].(string); connectionID != "" {
			return connectionID, nil
		}
	}
	if connectionID, _ := values["connectionId"].(string); connectionID != "" {
		return connectionID, nil
	}
	return "", badParams("Missing connection id")
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// ---------------- 存储目录 ----------------

var dirMu sync.Mutex
var currentDir string

var dirKeys = map[string]bool{
	"storage_dir": true, "storageDir": true, "storage_path": true, "storagePath": true,
	"todo_dir": true, "todoDir": true,
}

func dataDir() string {
	if d := strings.TrimSpace(os.Getenv("DBX_PLUGIN_DATA_DIR")); d != "" {
		return d
	}
	if d := strings.TrimSpace(os.Getenv("DBX_PLUGIN_SPACE")); d != "" {
		return d
	}
	if base, err := os.UserConfigDir(); err == nil && base != "" {
		return filepath.Join(base, "dbx", "plugins", pluginID)
	}
	return filepath.Join(".", "data")
}

func todoMetaDir() string { return filepath.Join(todoDir(), ".todo") }
func todoDBPath() string  { return filepath.Join(todoMetaDir(), "todos.db") }

func sidecarTrace(msg string) {
	path := filepath.Join(dataDir(), "sidecar-trace.log")
	if st, err := os.Stat(path); err == nil && st.Size() > 64*1024 {
		_ = os.Remove(path)
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer func() { _ = f.Close() }()
	_, _ = fmt.Fprintf(f, "%s  %s\n", time.Now().Format("2006-01-02 15:04:05"), msg)
}

func setDir(d string) {
	d = strings.TrimSpace(d)
	if d == "" {
		return
	}
	dirMu.Lock()
	same := currentDir == d
	currentDir = d
	dirMu.Unlock()
	if same {
		return
	}
	if err := os.MkdirAll(dataDir(), 0o755); err == nil {
		if b, e := json.Marshal(map[string]any{"storage_dir": d}); e == nil {
			_ = os.WriteFile(filepath.Join(dataDir(), "config.json"), b, 0o644)
		}
	}
}

func absorbDir(v any) {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if dirKeys[k] {
				if s, ok := val.(string); ok && strings.TrimSpace(s) != "" {
					setDir(s)
				}
			}
		}
		for _, val := range t {
			absorbDir(val)
		}
	case []any:
		for _, item := range t {
			absorbDir(item)
		}
	}
}

func absorbParams(raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return
	}
	absorbDir(v)
}

func todoDir() string {
	dirMu.Lock()
	d := currentDir
	dirMu.Unlock()
	if strings.TrimSpace(d) == "" {
		return dataDir()
	}
	return d
}

func dirConfigured() bool {
	dirMu.Lock()
	d := currentDir
	dirMu.Unlock()
	return strings.TrimSpace(d) != ""
}

// migrateTodoDir 把 from 下的 .todo（含 todos.db）整体迁移到 to，仅在 to 还没有
// 数据库时执行，绝不覆盖 to 已有数据。用于「先全局打开写入兜底目录、后建连接」时，
// 把孤儿数据收回到连接自己的 storage_dir，避免数据看起来「丢了」。
func migrateTodoDir(from, to string) {
	if strings.TrimSpace(from) == "" || strings.TrimSpace(to) == "" || from == to {
		return
	}
	fromDB := filepath.Join(from, ".todo", "todos.db")
	if _, err := os.Stat(fromDB); err != nil {
		return // 没有可迁移的数据
	}
	toDB := filepath.Join(to, ".todo", "todos.db")
	if _, err := os.Stat(toDB); err == nil {
		sidecarTrace(fmt.Sprintf("migrate skip: 目标目录已有数据库 from=%s to=%s", from, to))
		return // 目标已有数据，不覆盖
	}
	if err := os.MkdirAll(filepath.Join(to, ".todo"), 0o755); err != nil {
		sidecarTrace(fmt.Sprintf("migrate 失败(建目录): %v", err))
		return
	}
	if err := os.Rename(filepath.Join(from, ".todo"), filepath.Join(to, ".todo")); err != nil {
		sidecarTrace(fmt.Sprintf("migrate 失败(重命名): %v", err))
		return
	}
	sidecarTrace(fmt.Sprintf("migrate ok: %s -> %s", from, to))
}

// loadConfigDir 在侧车启动时把上一次连接写入的 storage_dir 还原进 currentDir。
// setDir 只【写】config.json 从不【读】，导致跨进程重启后 currentDir 回到空，
// 数据库被解析到插件数据目录的兜底位置（空库），连接数据「消失」。
func loadConfigDir() {
	b, err := os.ReadFile(filepath.Join(dataDir(), "config.json"))
	if err != nil {
		return
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return
	}
	if d, ok := m["storage_dir"].(string); ok && strings.TrimSpace(d) != "" {
		dirMu.Lock()
		currentDir = strings.TrimSpace(d)
		dirMu.Unlock()
		sidecarTrace(fmt.Sprintf("loadConfigDir: 还原 storage_dir=%s", currentDir))
	}
}

func connDirFromValues(values map[string]any) string {
	cands := []any{
		values["storage_dir"], values["storageDir"],
		values["config"], values["external_config"], values["connection"],
	}
	for _, c := range cands {
		if c == nil {
			continue
		}
		switch t := c.(type) {
		case string:
			s := strings.TrimSpace(t)
			if s != "" && !strings.ContainsAny(s, "={}:") {
				return s
			}
			if i := strings.Index(t, "storage_dir="); i >= 0 {
				rest := t[i+len("storage_dir="):]
				if e := strings.IndexAny(rest, "&\""); e >= 0 {
					rest = rest[:e]
				}
				if v := strings.TrimSpace(rest); v != "" {
					return v
				}
			}
		case map[string]any:
			for _, k := range []string{"storage_dir", "storageDir", "storage_path", "storagePath", "todo_dir", "todoDir"} {
				if v, ok := t[k].(string); ok && strings.TrimSpace(v) != "" {
					return strings.TrimSpace(v)
				}
			}
		}
	}
	return ""
}

// ---------------- 文档（分组 / 任务 / 子任务） ----------------

// TodoGroup 是分组。
type TodoGroup struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Order int    `json:"order"`
}

// TodoSub 是子任务 / 里程碑节点。
type TodoSub struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Done        bool   `json:"done"`
	DoneAt      string `json:"doneAt,omitempty"`
	IsMilestone bool   `json:"isMilestone"`
	Order       int    `json:"order"`
}

// TodoTask 是任务。
type TodoTask struct {
	ID          string    `json:"id"`
	GroupID     string    `json:"groupId"`
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Priority    string    `json:"priority"` // low | normal | high | urgent
	StartAt     *string   `json:"startAt"`  // ISO 或 null
	DueAt       *string   `json:"dueAt"`
	Done        bool      `json:"done"`
	DoneAt      *string   `json:"doneAt"`
	CreatedAt   string    `json:"createdAt"`
	UpdatedAt   string    `json:"updatedAt"`
	Subtasks    []TodoSub `json:"subtasks"`
}

// TodoDoc 是前端收发的整体文档（_rev 是内部并发版本号，不参与展示）。
// 底层存储是 SQLite 关系表（groups / tasks / subtasks / meta），本结构体只是
// 它们之间的「组装视图」——既保留前端熟悉的单文档协议，又方便后续直接基于表扩展。
type TodoDoc struct {
	Rev     int         `json:"_rev"`
	Version int         `json:"version"`
	Groups  []TodoGroup `json:"groups"`
	Tasks   []TodoTask  `json:"tasks"`
}

// openDB 打开（必要时创建）SQLite 数据库并执行迁移。返回值 created 表示
// 本次调用是否新建了数据库文件，用于向前端标记首次运行（firstRun）。
//
// Windows 实测（打包探针环境）首次建库偶发 SQLITE_READONLY，疑似杀软/索引器
// 短暂锁住刚创建的 .db 文件所致：busy_timeout 缓解锁竞争，migrate 失败重试一次
// 覆盖瞬态；错误信息带库路径与语句序号，便于远程定位。
// 全局单例连接：所有 RPC 复用同一 *sql.DB（SetMaxOpenConns(1) 串行化查询），
// 避免「每次请求新建连接 + defer Close」在 Windows 上引发的 self-lock（SQLITE_BUSY）。
var (
	gDBMu sync.Mutex
	gDB   *sql.DB
)

func openDB() (*sql.DB, bool, error) {
	gDBMu.Lock()
	defer gDBMu.Unlock()
	if gDB != nil {
		if err := gDB.Ping(); err == nil {
			return gDB, false, nil
		}
		_ = gDB.Close()
		gDB = nil
	}
	dir := todoMetaDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, false, fmt.Errorf("创建 .todo 目录失败：%w", err)
	}
	p := todoDBPath()
	created := false
	if _, statErr := os.Stat(p); statErr != nil {
		created = true
	}
	db, err := sql.Open("sqlite", p+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, false, fmt.Errorf("打开数据库失败：%w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetConnMaxLifetime(0)
	var migErr error
	for attempt := 0; attempt < 2; attempt++ {
		if migErr = migrateDB(db); migErr == nil {
			break
		}
		_ = db.Close()
		if attempt == 0 {
			time.Sleep(150 * time.Millisecond)
			db, err = sql.Open("sqlite", p+"?_pragma=busy_timeout(5000)")
			if err != nil {
				return nil, false, fmt.Errorf("重开数据库失败：%w", err)
			}
			db.SetMaxOpenConns(1)
			db.SetConnMaxLifetime(0)
		}
	}
	if migErr != nil {
		_ = db.Close()
		return nil, false, fmt.Errorf("%w（库路径：%s）", migErr, p)
	}
	gDB = db
	return gDB, created, nil
}

func migrateDB(db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`,
		`CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, ord INTEGER NOT NULL DEFAULT 0)`,
		`CREATE TABLE IF NOT EXISTS tasks (
			id TEXT PRIMARY KEY,
			group_id TEXT,
			title TEXT NOT NULL,
			description TEXT,
			priority TEXT,
			start_at TEXT,
			due_at TEXT,
			done INTEGER NOT NULL DEFAULT 0,
			done_at TEXT,
			created_at TEXT,
			updated_at TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS subtasks (
			id TEXT PRIMARY KEY,
			task_id TEXT NOT NULL,
			title TEXT NOT NULL,
			done INTEGER NOT NULL DEFAULT 0,
			done_at TEXT,
			is_milestone INTEGER NOT NULL DEFAULT 0,
			ord INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id)`,
		`CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id)`,
	}
	for i, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return fmt.Errorf("migrate[%d/%d]: %w", i+1, len(stmts), err)
		}
	}
	_, _ = db.Exec(`INSERT OR IGNORE INTO meta(key,value) VALUES('rev','0'),('version','1')`)
	return nil
}

// ns 把 *string 转成 database/sql 可识别的 NULL/值（nil 或空串都当 NULL）。
func ns(p *string) any {
	if p == nil {
		return nil
	}
	s := *p
	if s == "" {
		return nil
	}
	return s
}

// nullStrToPtr 把 sql.NullString 转成 *string（NULL → nil，方便填回模型字段）。
func nullStrToPtr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

// nullStr 空串 → NULL，否则原值（用于普通可空文本列）。
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func emptyDoc() TodoDoc {
	return TodoDoc{Version: 1, Groups: []TodoGroup{}, Tasks: []TodoTask{}}
}

// loadDoc 从关系表组装出整体文档。created=true 表示数据库刚创建（首次运行）。
func loadDoc() (TodoDoc, bool, error) {
	db, created, err := openDB()
	if err != nil {
		return emptyDoc(), false, err
	}

	d := emptyDoc()
	if err := db.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='rev'`).Scan(&d.Rev); err != nil {
		return emptyDoc(), created, fmt.Errorf("读取版本号失败：%w", err)
	}
	if err := db.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='version'`).Scan(&d.Version); err != nil {
		d.Version = 1
	}

	gRows, err := db.Query(`SELECT id, name, ord FROM groups ORDER BY ord, id`)
	if err != nil {
		return emptyDoc(), created, err
	}
	for gRows.Next() {
		var g TodoGroup
		if err := gRows.Scan(&g.ID, &g.Name, &g.Order); err != nil {
			gRows.Close()
			return emptyDoc(), created, err
		}
		d.Groups = append(d.Groups, g)
	}
	gRows.Close()

	// 先把子任务按所属任务分组，再挂到任务上（子任务表与任务表解耦存储，方便后续扩展）。
	subByTask := map[string][]TodoSub{}
	sRows, err := db.Query(`SELECT id, task_id, title, done, done_at, is_milestone, ord FROM subtasks ORDER BY ord, id`)
	if err != nil {
		return emptyDoc(), created, err
	}
	for sRows.Next() {
		var s TodoSub
		var taskID string
		var done, ms int
		var dat sql.NullString
		if err := sRows.Scan(&s.ID, &taskID, &s.Title, &done, &dat, &ms, &s.Order); err != nil {
			sRows.Close()
			return emptyDoc(), created, err
		}
		s.Done = done != 0
		s.IsMilestone = ms != 0
		s.DoneAt = dat.String
		subByTask[taskID] = append(subByTask[taskID], s)
	}
	sRows.Close()

	tRows, err := db.Query(`SELECT id, group_id, title, description, priority, start_at, due_at, done, done_at, created_at, updated_at FROM tasks ORDER BY updated_at, id`)
	if err != nil {
		return emptyDoc(), created, err
	}
	for tRows.Next() {
		var t TodoTask
		var gid, desc, prio sql.NullString
		var sa, da, dat, ca, ua sql.NullString
		var done int
		if err := tRows.Scan(&t.ID, &gid, &t.Title, &desc, &prio, &sa, &da, &done, &dat, &ca, &ua); err != nil {
			tRows.Close()
			return emptyDoc(), created, err
		}
		t.GroupID = gid.String
		t.Description = desc.String
		t.Priority = prio.String
		t.StartAt = nullStrToPtr(sa)
		t.DueAt = nullStrToPtr(da)
		t.Done = done != 0
		t.DoneAt = nullStrToPtr(dat)
		t.CreatedAt = ca.String
		t.UpdatedAt = ua.String
		t.Subtasks = subByTask[t.ID]
		if t.Subtasks == nil {
			t.Subtasks = []TodoSub{}
		}
		d.Tasks = append(d.Tasks, t)
	}
	tRows.Close()

	return d, created, nil
}

// saveDocToDB 把整体文档整体替换写入三张关系表（事务），返回递增后的 rev。
// 并发防护：事务内读取的 rev 即提交基线，另一并发写入者被 SQLite 串行化，
// 不会出现「旧快照覆盖新数据」（前端侧的 rev 回声检查在 todosSave 里）。
func saveDocToDB(d TodoDoc) (int, error) {
	db, _, err := openDB()
	if err != nil {
		return 0, err
	}

	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	var curRev int
	if err := tx.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='rev'`).Scan(&curRev); err != nil {
		tx.Rollback()
		return 0, err
	}
	if _, err := tx.Exec(`DELETE FROM subtasks`); err != nil {
		tx.Rollback()
		return 0, err
	}
	if _, err := tx.Exec(`DELETE FROM tasks`); err != nil {
		tx.Rollback()
		return 0, err
	}
	if _, err := tx.Exec(`DELETE FROM groups`); err != nil {
		tx.Rollback()
		return 0, err
	}

	gStmt, err := tx.Prepare(`INSERT INTO groups(id, name, ord) VALUES(?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return 0, err
	}
	defer gStmt.Close()
	for _, g := range d.Groups {
		if _, err := gStmt.Exec(g.ID, g.Name, g.Order); err != nil {
			tx.Rollback()
			return 0, err
		}
	}

	tStmt, err := tx.Prepare(`INSERT INTO tasks(id, group_id, title, description, priority, start_at, due_at, done, done_at, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return 0, err
	}
	defer tStmt.Close()
	for _, t := range d.Tasks {
		if _, err := tStmt.Exec(
			t.ID, nullStr(t.GroupID), t.Title, nullStr(t.Description), nullStr(t.Priority),
			ns(t.StartAt), ns(t.DueAt), boolInt(t.Done), ns(t.DoneAt),
			nullStr(t.CreatedAt), nullStr(t.UpdatedAt),
		); err != nil {
			tx.Rollback()
			return 0, err
		}
	}

	sStmt, err := tx.Prepare(`INSERT INTO subtasks(id, task_id, title, done, done_at, is_milestone, ord) VALUES(?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return 0, err
	}
	defer sStmt.Close()
	for ti := range d.Tasks {
		for _, s := range d.Tasks[ti].Subtasks {
			if _, err := sStmt.Exec(s.ID, d.Tasks[ti].ID, s.Title, boolInt(s.Done), nullStr(s.DoneAt), boolInt(s.IsMilestone), s.Order); err != nil {
				tx.Rollback()
				return 0, err
			}
		}
	}

	newRev := curRev + 1
	if _, err := tx.Exec(`UPDATE meta SET value=? WHERE key='rev'`, newRev); err != nil {
		tx.Rollback()
		return 0, err
	}
	if _, err := tx.Exec(`UPDATE meta SET value='1' WHERE key='version'`); err != nil {
		tx.Rollback()
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return newRev, nil
}

// currentRev 读取当前 rev（不依赖前端传入），用于并发防护比对与导入递增。
func currentRev() (int, error) {
	db, _, err := openDB()
	if err != nil {
		return 0, err
	}
	var rev int
	if err := db.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='rev'`).Scan(&rev); err != nil {
		return 0, err
	}
	return rev, nil
}

func todosLoad() (any, *dbxpluginsdk.PluginError) {
	d, created, err := loadDoc()
	if err != nil {
		return nil, failed(-32002, fmt.Errorf("读取待办数据失败：%w", err))
	}
	doc := map[string]any{
		"version": d.Version,
		"groups":  d.Groups,
		"tasks":   d.Tasks,
	}
	// 首次运行（数据库刚创建）给前端一个空壳，让它去 seed 一个默认分组。
	if created {
		doc["groups"] = []TodoGroup{}
		doc["tasks"] = []TodoTask{}
	}
	return map[string]any{
		"data":       doc,
		"rev":        d.Rev,
		"path":       todoDBPath(),
		"dir":        todoDir(),
		"ok":         true,
		"configured": dirConfigured(),
		"firstRun":   created,
	}, nil
}

// todosSave：带 rev 并发防护的原子写。incomingRev 是前端回声的版本号；
// 若与当前不一致 → 拒绝并回传最新 rev，让前端重放（绝不直接覆盖对方数据）。
func todosSave(incomingRevRaw json.RawMessage, dataRaw json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	curRev, err := currentRev()
	if err != nil {
		return nil, failed(-32002, fmt.Errorf("读取待办数据失败：%w", err))
	}
	var incomingRev int
	if len(incomingRevRaw) > 0 {
		_ = json.Unmarshal(incomingRevRaw, &incomingRev)
	}
	if incomingRev != curRev {
		return map[string]any{
			"ok":       false,
			"conflict": true,
			"newRev":   curRev,
			"message":  "数据已被其它会话修改，请刷新后重试",
		}, dbxpluginsdk.NewError(-32020, "数据已被其它会话修改，请刷新后重试")
	}

	var incoming TodoDoc
	if err := json.Unmarshal(dataRaw, &incoming); err != nil {
		return nil, badParams("文档格式错误：%v", err)
	}
	if incoming.Groups == nil {
		incoming.Groups = []TodoGroup{}
	}
	if incoming.Tasks == nil {
		incoming.Tasks = []TodoTask{}
	}
	// 基本校验：任务归属已知分组（缺失分组时归到第一个）。
	groupIDs := map[string]bool{}
	for _, g := range incoming.Groups {
		groupIDs[g.ID] = true
	}
	for i := range incoming.Tasks {
		if !groupIDs[incoming.Tasks[i].GroupID] && len(incoming.Groups) > 0 {
			incoming.Tasks[i].GroupID = incoming.Groups[0].ID
		}
		if incoming.Tasks[i].Subtasks == nil {
			incoming.Tasks[i].Subtasks = []TodoSub{}
		}
	}
	incoming.Version = 1
	newRev, serr := saveDocToDB(incoming)
	if serr != nil {
		return nil, failed(-32002, fmt.Errorf("保存失败：%w", serr))
	}
	sidecarTrace(fmt.Sprintf("todos/save ok dir=%s rev=%d groups=%d tasks=%d",
		todoDir(), newRev, len(incoming.Groups), len(incoming.Tasks)))
	return map[string]any{"ok": true, "rev": newRev, "path": todoDBPath(), "dir": todoDir()}, nil
}

func todosExport() (any, *dbxpluginsdk.PluginError) {
	d, _, err := loadDoc()
	if err != nil {
		return nil, failed(-32004, fmt.Errorf("读取待办数据失败：%w", err))
	}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return nil, failed(-32004, fmt.Errorf("序列化失败：%w", err))
	}
	fileName := fmt.Sprintf("todo-backup-%s.json", time.Now().Format("20060102-150405"))
	return map[string]any{
		"ok":         true,
		"fileName":   fileName,
		"dataBase64": base64.StdEncoding.EncodeToString(b),
		"bytes":      len(b),
		"count":      len(d.Tasks),
		"groups":     len(d.Groups),
	}, nil
}

func todosImport(dataBase64 string) (any, *dbxpluginsdk.PluginError) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(dataBase64))
	if err != nil {
		return nil, badParams("导入内容不是合法 base64：%v", err)
	}
	var d TodoDoc
	if err := json.Unmarshal(raw, &d); err != nil {
		return nil, badParams("导入的不是待办备份文件：%v", err)
	}
	if d.Groups == nil {
		d.Groups = []TodoGroup{}
	}
	if d.Tasks == nil {
		d.Tasks = []TodoTask{}
	}
	for i := range d.Tasks {
		if d.Tasks[i].Subtasks == nil {
			d.Tasks[i].Subtasks = []TodoSub{}
		}
	}
	// 导入 = 整体替换文档（语义同「恢复」）。saveDocToDB 会在当前 rev 基础上递增，
	// 保证下一次保存不会因旧 rev 冲突；导入是用户主动覆盖，不经前端 rev 回声检查。
	d.Version = 1
	newRev, serr := saveDocToDB(d)
	if serr != nil {
		return nil, failed(-32006, fmt.Errorf("导入失败：%w", serr))
	}
	sidecarTrace(fmt.Sprintf("todos/import ok dir=%s groups=%d tasks=%d", todoDir(), len(d.Groups), len(d.Tasks)))
	return map[string]any{
		"ok":     true,
		"rev":    newRev,
		"groups": len(d.Groups),
		"tasks":  len(d.Tasks),
		"path":   todoDBPath(),
	}, nil
}

// ---------------- UI 偏好（<dataDir>/prefs.json，不进待办数据目录） ----------------

var prefKeys = map[string]bool{"sidebarWidth": true, "lastView": true, "lastGroup": true, "theme": true}

func prefsPath() string { return filepath.Join(dataDir(), "prefs.json") }

func clampPrefWidth(v int) int {
	if v < 200 {
		return 200
	}
	if v > 560 {
		return 560
	}
	return v
}

func prefInt(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case json.Number:
		if n, err := t.Int64(); err == nil {
			return int(n), true
		}
	}
	return 0, false
}

func sanitizePrefs(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		if !prefKeys[k] {
			continue
		}
		switch k {
		case "sidebarWidth":
			n, ok := prefInt(v)
			if !ok {
				continue
			}
			out[k] = clampPrefWidth(n)
		case "lastView", "lastGroup", "theme":
			if s, ok := v.(string); ok {
				out[k] = s
			}
		}
	}
	return out
}

func loadPrefs() map[string]any {
	out := map[string]any{}
	b, err := os.ReadFile(prefsPath())
	if err != nil {
		return out
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return out
	}
	return sanitizePrefs(m)
}

func setPrefsHandler(raw json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	var p struct {
		Prefs map[string]any `json:"prefs"`
	}
	if e := json.Unmarshal(raw, &p); e != nil {
		return nil, badParams("invalid params: %v", e)
	}
	cur := loadPrefs()
	for k, v := range p.Prefs {
		if prefKeys[k] {
			cur[k] = v
		}
	}
	cur = sanitizePrefs(cur)
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		return nil, failed(-32012, fmt.Errorf("无法写入界面偏好：%v", err))
	}
	b, err := json.MarshalIndent(cur, "", "  ")
	if err != nil {
		return nil, failed(-32012, fmt.Errorf("无法写入界面偏好：%v", err))
	}
	if err := writeAtomic(prefsPath(), append(b, '\n')); err != nil {
		return nil, failed(-32012, fmt.Errorf("无法写入界面偏好：%v", err))
	}
	return map[string]any{"prefs": cur}, nil
}

func newID(prefix string) string {
	return prefix + DateNowNano() + strconv.FormatUint(uint64(rand.Uint32()), 36)
}

func DateNowNano() string {
	return strconv.FormatInt(time.Now().UnixNano(), 36)
}

// ---------------- 原子写（tmp 名唯一，避免多实例互相覆盖半成品） ----------------

var tmpSeq uint64

func writeAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.%d.tmp", path, os.Getpid(), atomic.AddUint64(&tmpSeq, 1))
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// ---------------- 元信息（启动时向宿主宣告的身份） ----------------

func resolveMetadata() dbxpluginsdk.Metadata {
	caps := []string{"connections", "todos"}
	fallback := dbxpluginsdk.Metadata{ID: pluginID, Version: pluginVersion, Capabilities: caps}
	exe, err := os.Executable()
	if err != nil {
		return fallback
	}
	dir := filepath.Dir(exe)
	for i := 0; i < 6; i++ {
		data, readErr := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if readErr == nil {
			var m struct {
				ID      string `json:"id"`
				Version string `json:"version"`
			}
			if json.Unmarshal(data, &m) == nil && m.ID == pluginID && strings.TrimSpace(m.Version) != "" {
				fallback.Version = strings.TrimSpace(m.Version)
			}
			return fallback
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return fallback
}

func main() {
	_ = os.MkdirAll(dataDir(), 0o755)
	loadConfigDir()
	_ = os.MkdirAll(todoMetaDir(), 0o755)
	cwd, _ := os.Getwd()
	sidecarTrace(fmt.Sprintf("start pid=%d dataDir=%s configured=%v dir=%s cwd=%s",
		os.Getpid(), dataDir(), dirConfigured(), todoDir(), cwd))

	metadata := resolveMetadata()
	server := dbxpluginsdk.NewServer(metadata, &plugin{connections: map[string]struct{}{}})
	if err := server.Serve(); err != nil {
		fmt.Fprintf(os.Stderr, "[todo] %v\n", err)
		os.Exit(1)
	}
}
