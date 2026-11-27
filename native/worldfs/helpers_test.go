package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func init() {
	// Commits in tests need an identity, and jj reads its own.
	for k, v := range map[string]string{
		"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
		"GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com",
		"JJ_USER": "t", "JJ_EMAIL": "t@example.com",
		"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "JJ_CONFIG": "/dev/null",
		// git commit's detached auto-maintenance would keep a cwd in the
		// checkout, and close rightly calls that busy.
		"GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "gc.auto", "GIT_CONFIG_VALUE_0": "0",
		"GIT_CONFIG_KEY_1": "maintenance.auto", "GIT_CONFIG_VALUE_1": "false",
		// The daemon never fetches lazily, and a test's own git must not fill
		// in a blob the machine cache lacks and hide a daemon bug that way.
		"GIT_NO_LAZY_FETCH": "1",
	} {
		os.Setenv(k, v)
	}
}

func run(t *testing.T, dir string, name string, args ...string) string {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%s %s in %s: %v\n%s", name, strings.Join(args, " "), dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, p, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// testWorld is a machine cache with one world, "w", of small repos shaped
// the way infra's sync shapes mirrors: blobless, with every commit and only
// the blobs of each tip it fetched. Each repo's tip renames and edits a
// file, so a git call that reads a parent's blobs fails here as on a host.
type testWorld struct {
	cache string
	src   map[string]string // repo name -> source checkout
}

func newTestWorld(t *testing.T, names ...string) *testWorld {
	t.Helper()
	w := &testWorld{cache: t.TempDir(), src: map[string]string{}}
	for _, n := range names {
		w.addRepo(t, n)
	}
	w.writeCatalog(t)
	return w
}

func (w *testWorld) mirror(name string) string {
	return filepath.Join(w.cache, "w", "mirrors", name+".git")
}

// addRepo creates a source repo and its mirror as infra's first sync does.
func (w *testWorld) addRepo(t *testing.T, name string) {
	t.Helper()
	src := filepath.Join(t.TempDir(), "src")
	run(t, "", "git", "init", "-q", "-b", "main", src)
	run(t, src, "git", "config", "uploadpack.allowFilter", "true")
	run(t, src, "git", "config", "uploadpack.allowAnySHA1InWant", "true")
	write(t, filepath.Join(src, "README.md"), "# "+name+"\n")
	write(t, filepath.Join(src, "src", "main.go"), "package main\n")
	write(t, filepath.Join(src, "notes.txt"), "one\ntwo\nthree\n")
	run(t, src, "git", "add", "-A")
	run(t, src, "git", "commit", "-q", "-m", "start")
	run(t, src, "git", "mv", "notes.txt", "NOTES.md")
	write(t, filepath.Join(src, "NOTES.md"), "one\ntwo\nthree\nfour\n")
	run(t, src, "git", "commit", "-q", "-am", "rename notes")
	w.src[name] = src
	m := w.mirror(name)
	run(t, "", "git", "init", "-q", "--bare", m)
	for _, kv := range [][2]string{
		{"remote.origin.url", "file://" + w.src[name]},
		{"remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"},
		{"remote.origin.promisor", "true"},
		{"remote.origin.partialclonefilter", "blob:none"},
	} {
		run(t, m, "git", "config", kv[0], kv[1])
	}
	w.fetch(t, name)
}

// fetch updates a mirror as infra's sync does: history without blobs, then
// the missing blobs of the default branch's tip in one request.
func (w *testWorld) fetch(t *testing.T, name string) {
	t.Helper()
	m := w.mirror(name)
	run(t, m, "git", "fetch", "-q", "--prune", "--no-write-fetch-head", "--filter=blob:none", "origin")
	run(t, m, "git", "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")
	var missing []string
	for _, l := range strings.Split(run(t, m, "git", "rev-list", "--objects", "--no-walk", "--missing=print", "refs/remotes/origin/main"), "\n") {
		if oid, ok := strings.CutPrefix(l, "?"); ok {
			missing = append(missing, oid)
		}
	}
	if len(missing) == 0 {
		return
	}
	cmd := exec.Command("git", "-c", "fetch.negotiationAlgorithm=noop", "fetch", "-q", "--no-tags",
		"--no-write-fetch-head", "--recurse-submodules=no", "--filter=blob:none", "--stdin", "origin")
	cmd.Dir = m
	cmd.Stdin = strings.NewReader(strings.Join(missing, "\n") + "\n")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("fetching the tip's blobs into %s: %v\n%s", m, err, out)
	}
}

func (w *testWorld) writeCatalog(t *testing.T) {
	t.Helper()
	c := catalog{World: "w"}
	for n := range w.src {
		c.Repos = append(c.Repos, catalogEntry{Name: n, Branch: "main",
			Commit: run(t, w.mirror(n), "git", "rev-parse", "refs/remotes/origin/main"), Mirror: w.mirror(n)})
	}
	b, _ := json.Marshal(c)
	write(t, filepath.Join(w.cache, "w", "catalog.json.tmp"), string(b))
	if err := os.Rename(filepath.Join(w.cache, "w", "catalog.json.tmp"), filepath.Join(w.cache, "w", "catalog.json")); err != nil {
		t.Fatal(err)
	}
}

// commit adds a commit upstream and fetches it into the mirror.
func (w *testWorld) commit(t *testing.T, name, file, content string) string {
	t.Helper()
	write(t, filepath.Join(w.src[name], file), content)
	run(t, w.src[name], "git", "add", "-A")
	run(t, w.src[name], "git", "commit", "-q", "-m", "change "+file)
	w.fetch(t, name)
	return run(t, w.mirror(name), "git", "rev-parse", "refs/remotes/origin/main")
}

// fakeNS stands in for thread namespaces: a pid is its own thread key, and
// reconcile only records what it was asked to show.
type fakeNS struct {
	mu    sync.Mutex
	calls []map[string]string
	alive bool
}

func (f *fakeNS) keyOf(pid int) (uint64, error) { return uint64(pid), nil }
func (f *fakeNS) live(key uint64) bool          { return f.alive }
func (f *fakeNS) reconcile(key uint64, want map[string]string, views, live string) []error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, want)
	return nil
}

func (f *fakeNS) last() map[string]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.calls) == 0 {
		return nil
	}
	return f.calls[len(f.calls)-1]
}

func newTestMachine(t *testing.T, w *testWorld, p policy) (*machine, *fakeNS) {
	t.Helper()
	ns := &fakeNS{}
	m := newMachine(w.cache, t.TempDir(), filepath.Join(t.TempDir(), "ctl.sock"), p, ns)
	m.refreshCatalogs()
	return m, ns
}

func registerThread(t *testing.T, m *machine, id string, pid int) *thread {
	t.Helper()
	th, err := m.register(registerReq{Thread: id, World: "w", Root: filepath.Join(t.TempDir(), "world"), Path: "/home/u/W", Pid: pid})
	if err != nil {
		t.Fatal(err)
	}
	return th
}
