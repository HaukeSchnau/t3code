package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// catalog is infra's <cache>/<world>/catalog.json. The machine cache sync
// rewrites it atomically after every run.
type catalog struct {
	World string         `json:"world"`
	Repos []catalogEntry `json:"repos"`
}

type catalogEntry struct {
	Name   string `json:"name"`   // forge path, such as git.schnau.dev/schnau/t3code
	Branch string `json:"branch"` // the default branch
	Commit string `json:"commit"` // newest default-branch commit whose whole tree is local
	Mirror string `json:"mirror"`
}

var (
	commitRe    = regexp.MustCompile(`^[0-9a-f]{40}$`)
	worldNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]*$`)
)

// validName accepts forge paths: relative, slash-separated, no dot segments
// and no "@", which separates the name from the commit in a view directory.
func validName(name string) bool {
	if name == "" || strings.ContainsAny(name, "@\x00\\") || strings.HasPrefix(name, "/") || strings.HasSuffix(name, "/") {
		return false
	}
	for _, seg := range strings.Split(name, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

func readCatalog(path string) (*catalog, time.Time, error) {
	st, err := os.Stat(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, time.Time{}, err
	}
	var c catalog
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, time.Time{}, fmt.Errorf("%s: %w", path, err)
	}
	// Drop entries the daemon cannot serve safely rather than the whole world.
	kept := c.Repos[:0]
	for _, r := range c.Repos {
		if validName(r.Name) && commitRe.MatchString(r.Commit) && filepath.IsAbs(r.Mirror) {
			kept = append(kept, r)
		}
	}
	c.Repos = kept
	return &c, st.ModTime(), nil
}

// catalogPaths lists <cache>/<world>/catalog.json for every world.
func catalogPaths(cache string) (map[string]string, error) {
	ents, err := os.ReadDir(cache)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, e := range ents {
		if !e.IsDir() || !worldNameRe.MatchString(e.Name()) {
			continue
		}
		p := filepath.Join(cache, e.Name(), "catalog.json")
		if _, err := os.Stat(p); err == nil {
			out[e.Name()] = p
		}
	}
	return out, nil
}
