// build.go — Compiles web/src/index.html into web/index.html
// Replaces <include file="X"/> tags with the contents of web/src/X
//
// Usage: go run cmd/build/main.go

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

func main() {
	srcDir := "web/src"
	outFile := "web/index.html"

	input, err := os.ReadFile(filepath.Join(srcDir, "index.html"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	re := regexp.MustCompile(`<include file="([^"]+)"\s*/>`)
	result := re.ReplaceAllStringFunc(string(input), func(match string) string {
		parts := re.FindStringSubmatch(match)
		if len(parts) < 2 {
			return match
		}
		filename := parts[1]
		content, err := os.ReadFile(filepath.Join(srcDir, filename))
		if err != nil {
			fmt.Fprintf(os.Stderr, "error including %s: %v\n", filename, err)
			os.Exit(1)
		}
		return strings.TrimRight(string(content), "\n")
	})

	if err := os.WriteFile(outFile, []byte(result), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "error writing %s: %v\n", outFile, err)
		os.Exit(1)
	}

	// Count includes
	count := len(re.FindAllString(string(input), -1))
	fmt.Printf("Compiled %s → %s (%d includes)\n", filepath.Join(srcDir, "index.html"), outFile, count)
}
