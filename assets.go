// Package codejury embeds the console UI so the CLI ships as a single binary.
package codejury

import (
	"embed"
	"io/fs"
	"os"
)

//go:embed all:web
var assets embed.FS

// UI returns the console assets. It prefers ./web on disk when present, so the
// page can be edited and reloaded without rebuilding; otherwise it serves the
// copy embedded at build time. The bool reports whether the on-disk copy won.
func UI() (fs.FS, bool, error) {
	if st, err := os.Stat("web/index.html"); err == nil && !st.IsDir() {
		return os.DirFS("web"), true, nil
	}
	sub, err := fs.Sub(assets, "web")
	if err != nil {
		return nil, false, err
	}
	return sub, false, nil
}
