// Package huskvarnademo embeds the web UI so the mower ships as one binary.
package huskvarnademo

import (
	"embed"
	"io/fs"
)

//go:embed all:web
var webRoot embed.FS

// WebFS is the embedded web UI rooted at web/.
func WebFS() fs.FS {
	sub, err := fs.Sub(webRoot, "web")
	if err != nil {
		panic(err)
	}
	return sub
}
