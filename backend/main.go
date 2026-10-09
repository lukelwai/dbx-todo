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

	dbxpluginsdk "github.com/lwai/todo/dbxsdk"
)

// 必须与 manifest.json 的 id / version 完全一致，否则宿主判定 Sidecar 身份不匹配并丢弃。
// pluginVersion 只是兜底；运行时以包内 manifest.json 的版本为准（见 resolveMetadata）。
const (
	pluginID      = "com.lwai.todo"
	pluginVersion = "0.1.2"
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
			"message": "待办 Todo 已就绪，数据将保存在「待办存储目录」下的 .todo/todos.json。",
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
		if d := connDirFromValues(values); d != "" {
			setDir(d)
		}
		_ = os.MkdirAll(todoDir(), 0o755)
		_ = os.MkdirAll(todoMetaDir(), 0o755)
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
		setDir(dir)
		_ = os.MkdirAll(todoDir(), 0o755)
		_ = os.MkdirAll(todoMetaDir(), 0o755)
		return map[string]any{"ok": true, "path": todoPath(), "dir": todoDir()}, nil

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
func todoPath() string    { return filepath.Join(todoMetaDir(), "todos.json") }

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

// TodoDoc 是落盘文档（_rev 是内部并发版本号，不参与展示）。
type TodoDoc struct {
	Rev     int         `json:"_rev"`
	Version int         `json:"version"`
	Groups  []TodoGroup `json:"groups"`
	Tasks   []TodoTask  `json:"tasks"`
}

func loadDoc() (TodoDoc, error) {
	b, err := os.ReadFile(todoPath())
	if err != nil {
		return TodoDoc{Version: 1, Groups: []TodoGroup{}, Tasks: []TodoTask{}}, err
	}
	var d TodoDoc
	if err := json.Unmarshal(b, &d); err != nil {
		return TodoDoc{Version: 1, Groups: []TodoGroup{}, Tasks: []TodoTask{}}, err
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
	return d, nil
}

func saveDoc(d TodoDoc) error {
	if d.Version == 0 {
		d.Version = 1
	}
	b, err := json.MarshalIndent(d, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(todoPath(), b)
}

func todosLoad() (any, *dbxpluginsdk.PluginError) {
	_ = os.MkdirAll(todoMetaDir(), 0o755)
	d, err := loadDoc()
	if err != nil && !os.IsNotExist(err) {
		return nil, failed(-32002, fmt.Errorf("读取待办数据失败：%w", err))
	}
	firstRun := os.IsNotExist(err)
	doc := map[string]any{
		"version": d.Version,
		"groups":  d.Groups,
		"tasks":   d.Tasks,
	}
	// 首次运行（没有文件）给前端一个空壳，让它去 seed 一个默认分组。
	if firstRun {
		doc["groups"] = []TodoGroup{}
		doc["tasks"] = []TodoTask{}
	}
	return map[string]any{
		"data":       doc,
		"rev":        d.Rev,
		"path":       todoPath(),
		"dir":        todoDir(),
		"ok":         true,
		"configured": dirConfigured(),
		"firstRun":   firstRun,
	}, nil
}

// todosSave：带 rev 并发防护的原子写。incomingRev 是前端回声的版本号；
// 若与当前不一致 → 拒绝并回传最新 rev，让前端重放（绝不直接覆盖对方数据）。
func todosSave(incomingRevRaw json.RawMessage, dataRaw json.RawMessage) (any, *dbxpluginsdk.PluginError) {
	cur, err := loadDoc()
	if err != nil && !os.IsNotExist(err) {
		return nil, failed(-32002, fmt.Errorf("读取待办数据失败：%w", err))
	}
	var incomingRev int
	if len(incomingRevRaw) > 0 {
		_ = json.Unmarshal(incomingRevRaw, &incomingRev)
	}
	if !os.IsNotExist(err) && incomingRev != cur.Rev {
		return map[string]any{
			"ok":       false,
			"conflict": true,
			"newRev":   cur.Rev,
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
	// 基本校验：分组 title 不为空、任务归属已知分组（缺失分组时归到第一个或置空）。
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
	incoming.Rev = cur.Rev + 1
	incoming.Version = 1
	if err := saveDoc(incoming); err != nil {
		return nil, failed(-32002, fmt.Errorf("保存失败：%w", err))
	}
	sidecarTrace(fmt.Sprintf("todos/save ok dir=%s rev=%d groups=%d tasks=%d",
		todoDir(), incoming.Rev, len(incoming.Groups), len(incoming.Tasks)))
	return map[string]any{"ok": true, "rev": incoming.Rev, "path": todoPath(), "dir": todoDir()}, nil
}

func todosExport() (any, *dbxpluginsdk.PluginError) {
	d, err := loadDoc()
	if err != nil {
		if !os.IsNotExist(err) {
			return nil, failed(-32004, fmt.Errorf("读取待办数据失败：%w", err))
		}
		// 首次运行（还没有数据文件）导出空备份，而不是报错。
		d = TodoDoc{Rev: 0, Version: 1, Groups: []TodoGroup{}, Tasks: []TodoTask{}}
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
	// 导入 = 整体替换文档（语义同「恢复」），rev 自然递增，保证下一次保存不会因旧 rev 冲突。
	cur, rerr := loadDoc()
	if rerr != nil && !os.IsNotExist(rerr) {
		return nil, failed(-32006, fmt.Errorf("读取当前数据失败：%w", rerr))
	}
	d.Rev = cur.Rev + 1
	d.Version = 1
	if err := saveDoc(d); err != nil {
		return nil, failed(-32006, fmt.Errorf("导入失败：%w", err))
	}
	sidecarTrace(fmt.Sprintf("todos/import ok dir=%s groups=%d tasks=%d", todoDir(), len(d.Groups), len(d.Tasks)))
	return map[string]any{
		"ok":     true,
		"rev":    d.Rev,
		"groups": len(d.Groups),
		"tasks":  len(d.Tasks),
		"path":   todoPath(),
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
