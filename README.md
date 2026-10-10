# 待办 Todo（DBX 插件）

轻量待办（Todo）插件，运行在 [DBX](https://dbxio.com) 宿主里。分组管理任务，支持优先级、起止时间、子任务与里程碑、完成度进度条，以及 **列表 / 日历 / 执行（看板）** 三视图。

数据落盘到「连接配置」里选择的**待办存储目录**下的 `.todo/todos.db`（SQLite），由内置的 **Go 原生侧车（native sidecar）** 写入。

---

## 1. 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  DBX 宿主（桌面应用）                                          │
│                                                                │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  UI 工作台（sandbox iframe，opaque origin）              │   │
│  │   ui/index.html · app.js · storage.js · styles.css      │   │
│  │      │                                                   │   │
│  │      │ window.dbxPlugin.invoke(method, params)           │   │
│  └──────┼──────────────────────────────────────────────────┘   │
│         │   JSON-RPC 2.0（stdin/stdout, JSON Lines）            │
│         ▼                                                       │
│  ┌────────────────────────────────────────────────────────┐   │
│  │  原生侧车（Go 可执行文件，独立进程）                    │   │
│  │   backend/main.go  →  dbx-plugin-todo(.exe)             │   │
│  │   · dbxsdk（vendor 的官方 Go SDK）                       │   │
│  │   · modernc.org/sqlite（纯 Go，无 cgo）                  │   │
│  │   · 持久化：<storage_dir>/.todo/todos.db                 │   │
│  └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

三个关键事实：

1. **前端不碰磁盘**。UI 跑在 opaque origin 的 sandbox iframe 里，`localStorage` 一碰就抛 `SecurityError`。唯一可靠的落盘通道是 `dbxPlugin.invoke()` → 原生侧车 → SQLite。
2. **侧车是原生进程**，不是网页 Worker / WASM。它由 DBX 宿主按需要启动，通过 **标准输入/输出上的 JSON-RPC 2.0** 与宿主通信。
3. **宿主方法与侧车方法不能混用**：`dbxPlugin.request()` 调宿主（如 `host.getContext`、`host.saveFile`），`dbxPlugin.invoke()` 调侧车。见第 6 节。

---

## 2. 目录结构

```
dbx-todo/
├── manifest.json          # 插件清单（id / 版本 / entrypoints / contributions / 权限）
├── dbx-plugin.toml        # 打包配置（后端语言、二进制名、include）
├── .dbx-store.json        # 本地 store 元数据
├── assets/plugin.svg      # 图标
├── ui/                    # 前端（sandbox iframe 内运行）
│   ├── index.html
│   ├── app.js             # 视图渲染、交互、视图切换（列表/日历/看板）
│   ├── storage.js         # 桥接层：invoke/request、rev 回声、诊断、看门狗
│   └── styles.css
├── backend/               # 原生侧车（Go）
│   ├── main.go            # RPC handler、SQLite 存储、连接态
│   ├── go.mod / go.sum
│   └── dbxsdk/           # vendor 的官方 DBX Go SDK（sdk.go + VENDOR.md）
├── dist/                  # 构建产物（*.dbxp 发布包 + release-candidates.json）
│   └── old/               # 历史版本归档（不删，仅挪走）
├── _release.mjs           # 一键交叉编译 + 打包 + 校验 + 出 release-candidates.json
├── _buildpkg.js           # 单平台打包（zip + checksums + 权限位闸门）
├── _verify.mjs            # 单包校验（结构 / sha256 / 真跑侧车探针）
├── _domcheck.py           # 前端静态闸门（DOM 悬空引用 / 关键元素 / 重复函数）
├── _smoke_import.mjs      # 导出→导入回环冒烟
└── _testutil.mjs          # 异步 spawn 封装（绕过沙箱 spawnSync EBUSY）
```

---

## 3. Native Sidecar Behavior（原生侧车行为）

> 这一节是本文档的重点。它描述侧车进程如何被宿主启动、如何通信、如何并发、如何持久化——也就是「原生侧车」与普通网页逻辑的本质区别。

### 3.1 侧车是什么

`backend/main.go` 编译出的 `dbx-plugin-todo`（Windows 上 `dbx-plugin-todo.exe`）是一个**独立的原生可执行文件**，用 Go 标准库 + vendor 的官方 SDK 编写，**没有 cgo 依赖**（SQLite 用的是纯 Go 的 `modernc.org/sqlite`）。它没有 GUI、没有 HTTP 服务，唯一的对外接口是**标准输入读 JSON-RPC、标准输出写 JSON-RPC**。

### 3.2 启动与生命周期

| 阶段 | 行为 |
|------|------|
| **宿主启动侧车** | DBX 找到 `manifest.json` → `entrypoints.backend.executable`（`bin/dbx-plugin-todo`），按当前平台启动该二进制作为子进程，并把它的 stdin/stdout 接管为 JSON-RPC 通道。 |
| **协议握手** | 宿主先发 `plugin/initialize`，参数含 `host.protocolVersions`。**这一步由 SDK 自己应答**，返回 `{protocolVersion, capabilities, plugin:{id,version}}`；若宿主与侧车的协议版本（当前 `1`）没有交集，侧车直接返回 `-32001`，宿主会丢弃侧车（UI 表现为「无法持久化」）。 |
| **RPC 服务** | `Server.Serve()`（`dbxsdk/sdk.go`）用 `bufio.Scanner` 逐行读 stdin，每行一个 JSON-RPC 请求。读到一条就 `go` 一个 goroutine 去 `Handler.Handle()`，再把结果序列化写回 stdout。 |
| **优雅退出** | 宿主关闭侧车 stdin（EOF）→ scanner 循环结束 → `workers.Wait()` 等所有在途请求处理完 → `Serve()` 返回 → 进程退出。 |
| **进程级身份** | 侧车身份来自包内 `manifest.json` 的 `id` / `version`（`resolveMetadata()` 会在 exe 附近至多向上 6 层找 `manifest.json` 并校验 `id` 一致）。`main.go` 里的 `pluginVersion` 常量只是兜底。 |

### 3.3 传输协议（JSON Lines，不是 Framed）

`manifest` v1 已不再有 `entrypoints.backend.transport` 字段。**Go 侧车只能用 JSON Lines**（每行一条 `jsonrpc: "2.0"` 消息，以 `\n` 分隔）：

- 请求上限 `8 MiB`/行（`maxJSONBytes`）。
- 二进制消息（如 `host.network` 的大负载）需要 **Framed** 传输（5 字节头 + payload），而 **Framed 是 Rust SDK 的能力，Go 侧车必须留在 JSON Lines**。本插件不收发二进制信道，因此默认 JSON Lines 即可。
- 没有 `id` 的请求被当作 **notification（事件/广播）**，SDK 不回写响应。

> 这是从官方 SDK 源码实证得来：手写一个「自己读 stdin 的循环」很容易把 `plugin/initialize` 协议、`8 MiB` 行缓冲、通知不回应这三点搞错——任何一点出错都会让宿主丢弃侧车。所以这里直接 vendored 官方 SDK，而不是自己造循环。

### 3.4 并发模型

- **每请求一 goroutine**：`Server.Serve()` 对每个有 `id` 的请求 `go` 一个 worker。
- **SQLite 串行化**：所有 RPC 复用**单个全局连接** `gDB`（`openDB()` 用 `sync.Mutex` 守护单例，`SetMaxOpenConns(1)` 把连接池压成 1）。这样即使多个 goroutine 同时打进来，SQL 也是串行执行的，避免 SQLite 的并发写竞争。
- **连接态用互斥锁**：`plugin.connections`（`map[string]struct{}`）和存储目录 `currentDir` 都由 `sync.Mutex` 保护，`connection/connect` / `setDir` 是线程安全的。
- **`defer db.Close()` 是反模式**：早期版本每次 RPC 都 `sql.Open` 新建连接 + `defer db.Close()`，在 Windows 上文件锁释放延迟会触发 `SQLITE_BUSY` 自锁（打包探针里 `todos/export` 实测踩过）。改为全局单例后该问题根治。

### 3.5 持久化与目录解析

侧车写两个地方，职责不同：

| 路径 | 内容 | 说明 |
|------|------|------|
| `<storage_dir>/.todo/todos.db` | 待办数据本体（SQLite） | 用户选择的「待办存储目录」下；这是**真正的业务数据**。 |
| `<DBX_PLUGIN_DATA_DIR>/config.json` | `{ "storage_dir": "..." }` | 侧车跨连接持久化的目录记忆，避免每次启动都丢目录。 |
| `<DBX_PLUGIN_DATA_DIR>/prefs.json` | 界面偏好（面板宽度、上次视图…） | 不进业务数据目录，由 `ui/getPrefs` / `ui/setPrefs` 读写。 |
| `<DBX_PLUGIN_DATA_DIR>/sidecar-trace.log` | 侧车运行轨迹（>64 KiB 自动截断） | 用于远程定位「为什么没存上」。 |

存储目录解析优先级（`dataDir()` / `todoDir()`）：

1. 环境变量 `DBX_PLUGIN_DATA_DIR`（宿主注入）→ `DBX_PLUGIN_SPACE`
2. 回退到 `os.UserConfigDir()/dbx/plugins/com.lwai.todo`
3. 再回退到 `./data`

业务目录 `<storage_dir>` 的确定：

1. `connection/connect` 或 `todos/save`/`setDir` 传入的 `storage_dir`；
2. 若未传，则回退到上面的 `dataDir()`（`dirConfigured()` 返回 false，UI 会提示「未配置存储目录」）。

**吸收扫描**：每个非 `todos/save`/`todos/import` 的 RPC 进 `Handle()` 前都过一遍 `absorbParams()`，递归扫描 `storage_dir`/`storageDir`/`todo_dir`/`storage_path` 等键，自动把目录喂给 `setDir()`——这样即使前端把路径藏在嵌套结构里，侧车也能拿到正确目录。

### 3.6 存储层（SQLite ↔ 文档模型）

底层是四张关系表：`meta(rev,version)`、`groups`、`tasks`、`subtasks`。

- **前端视角是「整体文档」**：`TodoDoc{ _rev, version, groups[], tasks[] }`。`tasks[].subtasks[]` 直接挂在任务下。
- **侧车在两者之间互转**：`loadDoc()` 从三张表读出后组装成文档；`saveDocToDB()` 在**一个事务**里 `DELETE` 三张表再整体 `INSERT`，保证不会出现「半份快照」。
- **首次运行**：`openDB()` 发现 `.db` 不存在 → `created=true`，前端拿到空壳去 seed 一个默认分组。
- **瞬态锁缓解**：`busy_timeout(5000)` + `migrate` 失败重试一次，错误带语句序号与库路径，便于远程定位。

### 3.7 并发版本控制（`_rev` 乐观锁）

单连接正常情况下不会冲突，但「被其它进程改过」时前端手里的 `rev` 会落后于磁盘。`todos/save` 的语义：

1. 读当前磁盘 `rev`（事务内，被 SQLite 串行化）；
2. 若前端回声的 `incomingRev != 当前 rev` → 返回 `conflict: true` + `newRev`，**绝不覆盖**对方数据；
3. 否则整体替换写入，并把 `rev` 递增后回传；
4. 前端（`storage.js`）收到新 `rev` 更新 `currentRev`；遇到 `conflict` 会 `refreshRev()` 后重试一次。

`todos/import` 是用户主动的「整体替换」，不经前端 rev 回声检查，但在当前 rev 基础上递增，保证下一次保存不会因旧 rev 冲突。

### 3.8 错误模型

侧车用 `dbxpluginsdk.PluginError{Code, Message}` 表达业务错误，映射成 JSON-RPC 的 `error` 字段。常用码：

| Code | 含义 |
|------|------|
| `-32601` | 方法不存在（`MethodNotFound`） |
| `-32602` | 参数非法（`badParams`） |
| `-32001` | 协议版本不匹配（由 SDK 在 `plugin/initialize` 返回） |
| `-32002` | 读取/保存 SQLite 失败 |
| `-32004` | 导出失败 |
| `-32006` | 导入失败 |
| `-32012` | 写入界面偏好失败 |
| `-32020` | `rev` 冲突（数据已被其它会话修改） |

> 前端 `storage.js` 的 `rpc()` 会把这些错误翻译成可读文案，并触发「重连侧车 → 再写一次」的容错（`writeNow`）。

---

## 4. RPC 参考（侧车对外接口）

所有方法经 `plugin.Handle()` 分发。参数里的 `storage_dir` 等键会被 `absorbParams` 自动吸收，无需显式处理。

| 方法 | 入参（关键字段） | 返回 | 说明 |
|------|----------------|------|------|
| `connection/test` | — | `{success, message}` | 校验「待办存储目录」可写（建目录试一次）。 |
| `connection/connect` | `connection.id`, `storage_dir` | `{success, storageDir, configured}` | 登记连接、锁定存储目录、建 `.todo/`。 |
| `connection/disconnect` | `connection.id` | `{success}` | 从连接表移除。 |
| `todos/ping` | — | `{ok, plugin, version, storageDir, configured}` | 前端启动握手，确认侧车活着。 |
| `todos/probe` | — | `{ok, dir, configured}` | 非破坏性可写性探测（写一个 `.write-probe` 文件），前端用它替代「存整份快照」。 |
| `todos/setDir` | `dir` / `storage_dir` | `{ok, path, dir}` | 显式覆盖存储目录（前端兜底用）。 |
| `todos/load` | — | `{data, rev, path, dir, firstRun, configured}` | 读回整体文档。 |
| `todos/save` | `data(TodoDoc)`, `rev`, `storage_dir?` | `{ok, rev, path, dir}` / `{conflict, newRev}` | 带 rev 并发防护的原子写。 |
| `todos/export` | — | `{ok, fileName, dataBase64, bytes, count, groups}` | 把文档 bytes 交给前端（再由宿主「另存为」），侧车**不自己写盘**。 |
| `todos/import` | `dataBase64` | `{ok, rev, groups, tasks}` | base64 校验 + 整体替换文档。 |
| `ui/getPrefs` | — | `{prefs}` | 读界面偏好。 |
| `ui/setPrefs` | `{prefs}` | `{prefs}` | 写界面偏好（仅 `prefKeys` 白名单键生效）。 |

---

## 5. 前端桥接（sandbox iframe）

`ui/storage.js` 封装了与宿主 / 侧车的全部交互，对外暴露 `window.TodoStore`：

```js
await TodoStore.init();        // 注入桥接、握手侧车、load 首屏
await TodoStore.save(data);    // 防抖落盘（debounce 400ms）
await TodoStore.reload();      // 重新 load
await TodoStore.getPrefs();    // 读偏好
await TodoStore.saveFile(...); // 走宿主「另存为」（导出/备份）
```

要点：

- **`invoke` vs `request`**：侧车 RPC 走 `dbxPlugin.invoke(method, params, {timeoutMs})`；宿主方法走 `dbxPlugin.request(method, params)`。绝不可混用。
- **`ready` 只是上下文数据**：`dbxPlugin.ready` 的 Promise 解出来的是**纯数据（工作台上下文）**，不是宿主 API 对象。真正的 API 永远是 `window.dbxPlugin` 本身。
- **导出走宿主对话框**：sandbox iframe 里 `blob` 下载会被宿主无声取消，所以导出/备份一律拿 `todos/export` 的 base64，再交给 `host.saveFile`（原生保存对话框）。`request` 参数 JSON 上限 2 MiB，故传 base64 时守住 `MAX_UPSTREAM_BYTES = 1.5 MB`。
- **诊断与看门狗**：`storage.js` 内置分步诊断（`TodoStore.report()`）和看门狗，拿不到结果也会在 UI 留下「卡在哪一步」的证据——安装后白屏 / 存不上时先看这份报告。

---

## 6. 构建与打包

### 6.1 前置

- Go 1.25（交叉编译用 `CGO_ENABLED=0`，任意 1.20+ 即可）。
- Node.js（跑打包/校验脚本）+ 国内代理 `GOPROXY=goproxy.cn` + `GOTOOLCHAIN=local`。

### 6.2 一键出三平台包

```bash
cd dbx-todo
GOPROXY=goproxy.cn GOTOOLCHAIN=local node _release.mjs
```

它会依次：① 交叉编译侧车（`windows-x64` / `darwin-arm64` / `linux-x64`，纯 Go 无 cgo 可跨平台）② 逐平台 `_buildpkg.js` 打包 ③ 逐包 `_verify.mjs` 校验（含 windows 真跑侧车 `initialize→probe→load→export` 探针）④ 汇总 `dist/release-candidates.json`。

> 官方 `dbx-plugin package` 只允许在当前宿主平台打包，跨平台会被拒。本插件因侧车纯 Go，直接在 Windows 上交叉编译出 darwin/linux 字节正确的包；`darwin-arm64` / `linux-x64` 因非本机，校验阶段侧车探针为 `SKIP`，**需在对应真机各跑一次冒烟**。

### 6.3 产物

```
dist/
├── com.lwai.todo-0.1.5-windows-x64.dbxp
├── com.lwai.todo-0.1.5-darwin-arm64.dbxp
├── com.lwai.todo-0.1.5-linux-x64.dbxp
├── release-candidates.json        # 商店发布流程读取（plugin 元信息 + 各平台 sha256/size）
└── old/                          # 历史版本归档
```

安装未签名包时，需在 DBX 插件页开「允许安装未签名开发包」。

### 6.4 版本号三处必须一致

改版本时同步：`manifest.json` 的 `version`、`backend/main.go` 的 `pluginVersion`、`ui/storage.js` 的 `UI_VERSION`（`_buildpkg.js` 会做一致性闸门校验）。

---

## 7. 开发调试

- **侧车日志**：`<DBX_PLUGIN_DATA_DIR>/sidecar-trace.log` 记录启动、connect、save/import、probe 等关键事件（>64 KiB 自动截断）。
- **前端诊断**：`TodoStore.report()` 输出环境快照（origin / 是否 sandbox / `dbxPlugin` 形状）、侧车握手、load/save 各步耗时与成败。
- **静态闸门**：提交前跑 `python _domcheck.py`（DOM 悬空引用 / 关键元素 / 重复函数）与 `_verify.mjs`（包结构 / checksums / executable 路径与扩展名 / 真跑侧车探针）。
- **导入回环冒烟**：`_smoke_import.mjs` 直接驱动侧车做「空库导出 → 导入 → 导出→导入→导出一致 → 非法 base64 被拒」四步验证。

---

## 8. 许可

见 `LICENSE`。
