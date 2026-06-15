package webassets

import (
	"embed"
	"io/fs"
)

//go:embed dist
var assets embed.FS

func Dist() (fs.FS, error) {
	return fs.Sub(assets, "dist")
}
