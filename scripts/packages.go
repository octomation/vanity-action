// Command packages lists the Go packages of a module directory, the same way
// on every runner: build constraints don't depend on the runner's GOOS,
// GOARCH or cgo, so a package that builds only for windows, wasm or with cgo
// is listed everywhere. The action runs it with the runner's go:
//
//	go run packages.go <module dir>
//
// It prints one directory per line, relative to the module directory, as "" for
// the root and "/a/b" for the rest, sorted, and nothing else. A directory is a
// package when it holds at least one Go file that some build could include:
// every file counts except files with a leading "_" or "." and files whose
// build constraint holds only with the "ignore" tag. Like `go list ./...`, it
// skips the directories testdata and vendor, names starting with "." or "_",
// symbolic links, and nested modules: a directory with its own go.mod and
// everything under it.
//
// No dependencies outside the standard library, so it needs no module.
package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"go/build"
	"go/build/constraint"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run packages.go <module dir>")
		os.Exit(2)
	}
	dirs, err := list(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	w := bufio.NewWriter(os.Stdout)
	for _, d := range dirs {
		fmt.Fprintln(w, d)
	}
	if err := w.Flush(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func list(root string) ([]string, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		return nil, fmt.Errorf("%s: no go.mod: %w", root, err)
	}

	ctxt := build.Default
	ctxt.GOOS, ctxt.GOARCH = "linux", "amd64"
	ctxt.CgoEnabled = true // keep files with import "C"
	ctxt.UseAllFiles = true
	ctxt.BuildTags, ctxt.ToolTags, ctxt.ReleaseTags = nil, nil, nil
	ctxt.GOPATH = ""
	ctxt.ReadDir = readDir

	found := map[string]bool{"": true}
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			return nil
		}
		if path != root {
			name := d.Name()
			if name == "testdata" || name == "vendor" || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "_") {
				return filepath.SkipDir
			}
			if _, err := os.Lstat(filepath.Join(path, "go.mod")); err == nil {
				return filepath.SkipDir
			}
		}
		_, err = ctxt.ImportDir(path, build.ImportComment)
		var none *build.NoGoError
		if errors.As(err, &none) {
			return nil
		}
		// any other error (two package names, a syntax error) still
		// means Go files are there: the directory is a package
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		found["/"+filepath.ToSlash(rel)] = true
		return nil
	})
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(found))
	for d := range found {
		out = append(out, d)
	}
	sort.Strings(out)
	return out, nil
}

// readDir hides from go/build what no build includes: symbolic links and Go
// files that only an "ignore" build would compile.
func readDir(dir string) ([]fs.FileInfo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var out []fs.FileInfo
	for _, e := range entries {
		if e.Type()&fs.ModeSymlink != 0 {
			continue
		}
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".go") {
			ok, err := buildable(filepath.Join(dir, e.Name()))
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
		}
		info, err := e.Info()
		if err != nil {
			return nil, err
		}
		out = append(out, info)
	}
	return out, nil
}

// buildable reports whether some set of build tags without "ignore" satisfies
// the file's build constraint.
func buildable(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	head, cut, err := header(f)
	if err != nil {
		return false, err
	}
	expr := parseConstraint(head, cut)
	if expr == nil {
		return true, nil
	}
	var tags []string
	seen := map[string]bool{}
	expr.Eval(func(tag string) bool {
		if !seen[tag] && tag != "ignore" {
			seen[tag] = true
			tags = append(tags, tag)
		}
		return false
	})
	if len(tags) > 16 {
		return true, nil // too many to try: assume some build includes it
	}
	for mask := 0; mask < 1<<len(tags); mask++ {
		on := map[string]bool{}
		for i, t := range tags {
			on[t] = mask&(1<<i) != 0
		}
		if expr.Eval(func(tag string) bool { return on[tag] }) {
			return true, nil
		}
	}
	return false, nil
}

// header returns the leading comment lines of a Go file, where build
// constraints live: everything before the first line that is neither blank
// nor a comment. Like go/build, it also returns how many of them come before
// the last blank line: only those can hold // +build lines; a //go:build
// line counts anywhere in the header.
func header(r io.Reader) (lines []string, cut int, err error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1024*1024)
	inBlock := false
	for sc.Scan() {
		line := strings.TrimSpace(string(bytes.TrimPrefix(sc.Bytes(), []byte("\xef\xbb\xbf"))))
		switch {
		case inBlock:
			if i := strings.Index(line, "*/"); i >= 0 {
				inBlock = false
				if strings.TrimSpace(line[i+2:]) != "" {
					return lines, cut, nil
				}
			}
		case line == "":
			cut = len(lines)
		case strings.HasPrefix(line, "//"):
			lines = append(lines, line)
		case strings.HasPrefix(line, "/*"):
			if i := strings.Index(line[2:], "*/"); i >= 0 {
				if strings.TrimSpace(line[2+i+2:]) != "" {
					return lines, cut, nil
				}
			} else {
				inBlock = true
			}
		default:
			return lines, cut, nil
		}
	}
	return lines, cut, sc.Err()
}

// parseConstraint returns the file's //go:build expression, or the
// conjunction of its // +build lines, or nil.
func parseConstraint(lines []string, cut int) constraint.Expr {
	var plus constraint.Expr
	for i, line := range lines {
		if constraint.IsGoBuild(line) {
			if expr, err := constraint.Parse(line); err == nil {
				return expr
			}
			return nil
		}
		if i < cut && constraint.IsPlusBuild(line) {
			expr, err := constraint.Parse(line)
			if err != nil {
				continue
			}
			if plus == nil {
				plus = expr
			} else {
				plus = &constraint.AndExpr{X: plus, Y: expr}
			}
		}
	}
	return plus
}
