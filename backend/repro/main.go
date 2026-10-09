package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

func tryOpen(label, dsn string) {
	dir := filepath.Join(os.TempDir(), "zzrepro-"+label)
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(filepath.Join(dir, ".todo"), 0o755); err != nil {
		fmt.Println(label, "mkdir err:", err)
		return
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		fmt.Println(label, "open err:", err)
		return
	}
	defer db.Close()
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`)
	if err != nil {
		fmt.Println(label, "CREATE err:", err)
		return
	}
	_, err = db.Exec(`INSERT OR IGNORE INTO meta(key,value) VALUES('rev','0')`)
	if err != nil {
		fmt.Println(label, "INSERT err:", err)
		return
	}
	fmt.Println(label, "OK")
}

func main() {
	base := func(label string) string {
		dir := filepath.Join(os.TempDir(), "zzrepro-"+label)
		_ = os.RemoveAll(dir)
		_ = os.MkdirAll(filepath.Join(dir, ".todo"), 0o755)
		return "file:" + filepath.Join(dir, ".todo", "todos.db")
	}
	tryOpen("plain", base("plain"))
	tryOpen("memjournal", base("memjournal")+"?_pragma=journal_mode(MEMORY)")
	tryOpen("wal", base("wal")+"?_pragma=journal_mode(WAL)")
	tryOpen("deletejournal", base("deletejournal")+"?_pragma=journal_mode(DELETE)")
	for _, l := range []string{"plain", "memjournal", "wal", "deletejournal"} {
		_ = os.RemoveAll(filepath.Join(os.TempDir(), "zzrepro-"+l))
	}
}
