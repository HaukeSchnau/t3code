package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type phase string

const (
	phaseView        phase = "view"
	phaseCheckingOut phase = "checking-out"
	phaseOut         phase = "checked-out"
	phaseClosing     phase = "closing"
	phaseClearing    phase = "clearing" // closed for good; deleting the files
)

// threadRepo is a repo a thread has touched: it opened .git (an admin dir
// exists), checked the repo out, or holds a version other than the latest.
type threadRepo struct {
	Version      string    `json:"version"`
	Phase        phase     `json:"phase"`
	Admin        string    `json:"admin,omitempty"`
	CheckedOutAt time.Time `json:"checkedOutAt,omitzero"`
	Bytes        uint64    `json:"bytes,omitempty"`
	// Pinned is set by the first checkout: the version is the thread's from
	// then on, also after an idle close (decision 9).
	Pinned bool `json:"pinned,omitempty"`
	// Advancing names the commit a catalog refresh is moving HEAD and the
	// index to, until both are written.
	Advancing string `json:"advancing,omitempty"`

	mu      sync.Mutex    // serializes checkout, close and refresh of this repo
	jjReady chan struct{} // closed once the checkout's jj repo exists
}

type refusal struct {
	At      time.Time `json:"at"`
	Repo    string    `json:"repo"`
	Process string    `json:"process"`
	Reason  string    `json:"reason"`
}

type thread struct {
	ID        string                 `json:"id"`
	World     string                 `json:"world"`
	Root      string                 `json:"root"` // host directory of the thread world
	Path      string                 `json:"path"` // canonical path of the world inside the thread
	Layout    []layoutRule           `json:"layout,omitempty"`
	Key       uint64                 `json:"key"` // user namespace inode, see ns.go
	Repos     map[string]*threadRepo `json:"repos"`
	Throttled []time.Time            `json:"throttled,omitempty"`
	Refusals  []refusal              `json:"refusals,omitempty"`

	pending      int    // checkouts admitted but not finished
	pendingBytes uint64 // their sizes
	ops          sync.RWMutex
	gone         bool       // torn down; held under ops and m.mu
	syncMu       sync.Mutex // one reconcile at a time, so none applies a stale snapshot
}

// enter holds off teardown while one operation runs on a thread.
func (m *machine) enter(t *thread) (func(), error) {
	t.ops.RLock()
	m.mu.Lock()
	gone := t.gone
	m.mu.Unlock()
	if gone {
		t.ops.RUnlock()
		return nil, apiErr("unknown-thread", "thread %s was torn down", t.ID)
	}
	return t.ops.RUnlock, nil
}

// repo is one catalog repo of a world on this machine.
type repo struct {
	world  string
	name   string
	branch string
	mirror string
	latest string // "" once the repo left the catalog
	cats   *cats

	wtMu  sync.Mutex // git worktree add numbers admin dirs racily
	mu    sync.Mutex
	trees map[string]*tree
}

type world struct {
	name    string
	catalog string
	mtime   time.Time
	repos   map[string]*repo
	names   []string
}

type machine struct {
	cache   string
	state   string
	views   string // the FUSE mount
	socket  string
	policy  policy
	jj      bool
	ns      nsOps
	hostMnt uint64
	live    string // major:minor of the running FUSE mount

	mu      sync.Mutex
	worlds  map[string]*world
	threads map[string]*thread
	byKey   map[uint64]*thread
}

// nsOps is how the machine reaches thread namespaces; tests replace it.
type nsOps interface {
	keyOf(pid int) (uint64, error)
	reconcile(key uint64, want map[string]string, views, live string) []error
	live(key uint64) bool
}

type realNS struct{ nsHelper }

func (r realNS) keyOf(pid int) (uint64, error) { return keyOf(pid, r.hostMnt) }
func (r realNS) live(key uint64) bool          { return len(threadNamespaces(key, r.hostMnt)) > 0 }

var threadIDRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func newMachine(cache, state, socket string, p policy, ns nsOps) *machine {
	return &machine{
		cache: cache, state: state, socket: socket, policy: p, jj: true, ns: ns,
		views:   filepath.Join(state, "mnt", "views"),
		worlds:  map[string]*world{},
		threads: map[string]*thread{},
		byKey:   map[uint64]*thread{},
	}
}

func (m *machine) statePath() string { return filepath.Join(m.state, "state.json") }

// save writes the thread table. Callers hold m.mu. A step that exposes a
// checkout or deletes files only proceeds once its phase is saved.
func (m *machine) save() error {
	b, err := json.MarshalIndent(struct {
		Threads map[string]*thread `json:"threads"`
	}{m.threads}, "", " ")
	if err == nil {
		tmp := m.statePath() + ".tmp"
		if err = os.WriteFile(tmp, b, 0o600); err == nil {
			err = os.Rename(tmp, m.statePath())
		}
	}
	if err != nil {
		log.Printf("save state: %v", err)
		return apiErr("failed", "saving state: %v", err)
	}
	return nil
}

func (m *machine) load() error {
	b, err := os.ReadFile(m.statePath())
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var s struct {
		Threads map[string]*thread `json:"threads"`
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("%s: %w", m.statePath(), err)
	}
	for id, t := range s.Threads {
		if t.Repos == nil {
			t.Repos = map[string]*threadRepo{}
		}
		for _, tr := range t.Repos {
			tr.jjReady = make(chan struct{})
			if tr.Phase == phaseOut {
				close(tr.jjReady) // recovery reruns jj if it never finished
			}
		}
		m.threads[id] = t
		if t.Key != 0 {
			m.byKey[t.Key] = t
		}
	}
	return nil
}

// refreshCatalogs reads every catalog whose file changed. It returns the
// repos that joined, moved or left a catalog since the first read, per world.
func (m *machine) refreshCatalogs() map[string][]string {
	paths, err := catalogPaths(m.cache)
	if err != nil {
		log.Printf("catalogs: %v", err)
		return nil
	}
	changed := map[string][]string{}
	for name, p := range paths {
		m.mu.Lock()
		w := m.worlds[name]
		m.mu.Unlock()
		st, err := os.Stat(p)
		if err != nil || (w != nil && st.ModTime().Equal(w.mtime)) {
			continue
		}
		c, mtime, err := readCatalog(p)
		if err != nil {
			log.Printf("catalog %s: %v", name, err)
			continue
		}
		m.mu.Lock()
		first := w == nil
		if first {
			w = &world{name: name, catalog: p, repos: map[string]*repo{}}
			m.worlds[name] = w
		}
		w.mtime = mtime
		seen := map[string]bool{}
		for _, e := range c.Repos {
			seen[e.Name] = true
			r := w.repos[e.Name]
			if r == nil {
				r = &repo{world: name, name: e.Name, mirror: e.Mirror, trees: map[string]*tree{},
					cats: &cats{mirror: e.Mirror}}
				w.repos[e.Name] = r
			}
			r.branch = e.Branch
			if r.latest != e.Commit {
				if !first {
					changed[name] = append(changed[name], e.Name)
				}
				r.latest = e.Commit
			}
		}
		for n, r := range w.repos {
			if !seen[n] && r.latest != "" {
				r.latest = ""
				changed[name] = append(changed[name], n)
			}
		}
		w.names = w.names[:0]
		for n := range w.repos {
			w.names = append(w.names, n)
		}
		sort.Strings(w.names)
		m.mu.Unlock()
	}
	return changed
}

func (m *machine) repo(worldName, name string) *repo {
	m.mu.Lock()
	defer m.mu.Unlock()
	if w := m.worlds[worldName]; w != nil {
		return w.repos[name]
	}
	return nil
}

// versionOf is the commit a thread sees for a repo. Callers hold m.mu.
func (t *thread) versionOf(r *repo) string {
	if tr := t.Repos[r.name]; tr != nil {
		return tr.Version
	}
	return r.latest
}

// allowed reports whether some thread or the catalog uses a version, so
// the view serves it. Callers hold m.mu.
func (m *machine) allowed(r *repo, commit string) bool {
	if commit == r.latest {
		return true
	}
	for _, t := range m.threads {
		if t.World == r.world {
			if tr := t.Repos[r.name]; tr != nil && tr.Version == commit {
				return true
			}
		}
	}
	return false
}

func (r *repo) tree(commit string) (*tree, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if t := r.trees[commit]; t != nil {
		return t, nil
	}
	t, err := loadTree(r.world, r.name, r.mirror, commit)
	if err != nil {
		return nil, err
	}
	r.trees[commit] = t
	return t, nil
}

// dropUnused forgets trees no thread or catalog uses. The kernel's open
// inodes keep their own references.
func (m *machine) dropUnused() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, w := range m.worlds {
		for _, r := range w.repos {
			r.mu.Lock()
			for c := range r.trees {
				if !m.allowed(r, c) {
					delete(r.trees, c)
				}
			}
			r.mu.Unlock()
		}
	}
}

func viewDir(r *repo, commit string) string { return r.world + "/" + r.name + "@" + commit }

// target is where a repo appears inside the thread's namespace.
func (t *thread) target(name string) string { return filepath.Join(t.Path, dirFor(t.Layout, name)) }

// hostDir is the same directory on the host.
func (t *thread) hostDir(name string) string { return filepath.Join(t.Root, dirFor(t.Layout, name)) }

// want is the view each of the named repos should show in the thread's
// namespaces, and the thread's admin links. Callers hold m.mu.
func (m *machine) want(t *thread, names []string) map[string]string {
	w := m.worlds[t.World]
	out := map[string]string{adminLinkDir: adminDir + "/" + t.ID}
	if w == nil {
		return out
	}
	for _, n := range names {
		r := w.repos[n]
		if r == nil {
			continue
		}
		v := t.versionOf(r)
		tr := t.Repos[n]
		// A checkout in progress keeps its view until its files are complete.
		if v == "" || (tr != nil && tr.Phase == phaseOut) {
			out[t.target(n)] = ""
		} else {
			out[t.target(n)] = viewDir(r, v)
		}
	}
	return out
}

// sync makes the thread's live namespaces show what want says.
func (m *machine) sync(t *thread, names ...string) []error {
	t.syncMu.Lock()
	defer t.syncMu.Unlock()
	m.mu.Lock()
	if names == nil && m.worlds[t.World] != nil {
		names = m.worlds[t.World].names
	}
	want := m.want(t, names)
	key := t.Key
	m.mu.Unlock()
	if key == 0 {
		return nil
	}
	errs := m.ns.reconcile(key, want, m.views, m.live)
	for _, err := range errs {
		log.Printf("sync %s: %v", t.ID, err)
	}
	return errs
}

func (m *machine) threadByKey(key uint64) *thread {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.byKey[key]
}

func (m *machine) threadOfPid(pid int) *thread {
	if pid <= 0 {
		return nil
	}
	k, err := m.ns.keyOf(pid)
	if err != nil {
		return nil
	}
	return m.threadByKey(k)
}

// repoAt finds the repo a path inside the thread (or below its host root)
// belongs to, and whether the path is inside the world at all.
func (m *machine) repoAt(t *thread, p string) (string, bool) {
	p = filepath.Clean(p)
	var rel string
	for _, base := range []string{t.Path, t.Root} {
		if r, err := filepath.Rel(base, p); err == nil && r != ".." && !strings.HasPrefix(r, "../") {
			rel = r
			break
		}
	}
	if rel == "" || rel == "." {
		return "", rel != ""
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	w := m.worlds[t.World]
	if w == nil {
		return "", true
	}
	dirs := map[string]string{}
	for _, n := range w.names {
		dirs[dirFor(t.Layout, n)] = n
	}
	for cur := rel; cur != "." && cur != "/"; cur = filepath.Dir(cur) {
		if n, ok := dirs[cur]; ok {
			return n, true
		}
	}
	return "", true
}

type registerReq struct {
	Thread string       `json:"thread"`
	World  string       `json:"world"`
	Root   string       `json:"root"`
	Path   string       `json:"path"`
	Pid    int          `json:"pid"`
	Layout []layoutRule `json:"layout,omitempty"`
}

func (m *machine) register(req registerReq) (*thread, error) {
	if !threadIDRe.MatchString(req.Thread) {
		return nil, apiErr("invalid", "thread id %q must be letters, digits, dot, dash or underscore", req.Thread)
	}
	if !filepath.IsAbs(req.Root) || !filepath.IsAbs(req.Path) {
		return nil, apiErr("invalid", "root and path must be absolute")
	}
	if err := validLayout(req.Layout); err != nil {
		return nil, apiErr("invalid", "%v", err)
	}
	key, err := m.ns.keyOf(req.Pid)
	if err != nil {
		return nil, apiErr("invalid", "pid %d: %v", req.Pid, err)
	}
	if key == nsIno("/proc/self/ns/user") {
		return nil, apiErr("invalid", "pid %d is in the host's user namespace, not a thread's", req.Pid)
	}
	m.mu.Lock()
	w := m.worlds[req.World]
	if w == nil {
		m.mu.Unlock()
		return nil, apiErr("unknown-world", "no world %q on this machine", req.World)
	}
	dirs := make([]string, 0, len(w.names))
	seen := map[string]string{}
	for _, n := range w.names {
		d := dirFor(req.Layout, n)
		if other, dup := seen[d]; dup {
			m.mu.Unlock()
			return nil, apiErr("invalid", "layout puts %s and %s at %s", other, n, d)
		}
		seen[d] = n
		dirs = append(dirs, d)
	}
	m.mu.Unlock()
	if outer, inner, bad := nestedDirs(dirs); bad {
		return nil, apiErr("invalid", "layout puts %s inside %s", inner, outer)
	}
	t, created, leave := m.holdThread(req)
	defer leave()
	m.mu.Lock()
	if created && m.threads[t.ID] != nil {
		m.mu.Unlock()
		return m.register(req) // another registration published it first
	}
	// Everything but the namespace is fixed: mounts and checkouts depend on it.
	if !created && (t.World != req.World || t.Root != req.Root || t.Path != req.Path || !sameLayout(t.Layout, req.Layout)) {
		m.mu.Unlock()
		return nil, apiErr("invalid", "thread %s is already registered with another world, root, path or layout", t.ID)
	}
	prevKey, displaced := t.Key, m.byKey[key]
	if displaced != nil && displaced != t {
		displaced.Key = 0 // the namespace was reused by a new holder
	}
	if prevKey != 0 && prevKey != key {
		delete(m.byKey, prevKey)
	}
	t.Key = key
	m.byKey[key] = t
	if created {
		m.threads[t.ID] = t
	}
	err = m.save()
	if err != nil {
		delete(m.byKey, key)
		if displaced != nil {
			m.byKey[key] = displaced
			displaced.Key = key
		}
		if prevKey != 0 {
			m.byKey[prevKey] = t
		}
		t.Key = prevKey
		if created {
			delete(m.threads, t.ID)
		}
	}
	m.mu.Unlock()
	if err != nil {
		return nil, err
	}
	for _, d := range dirs {
		if err := os.MkdirAll(filepath.Join(t.Root, d), 0o755); err != nil {
			return nil, err
		}
	}
	m.sync(t)
	return t, nil
}

// holdThread returns the registered thread with its ops lock held shared,
// so a teardown can neither run concurrently nor remove it from under the
// registration. Without one it returns a new, unpublished thread; register
// publishes it together with its first save.
func (m *machine) holdThread(req registerReq) (*thread, bool, func()) {
	for {
		m.mu.Lock()
		t := m.threads[req.Thread]
		if t == nil {
			m.mu.Unlock()
			t = &thread{ID: req.Thread, World: req.World, Root: req.Root, Path: req.Path, Layout: req.Layout, Repos: map[string]*threadRepo{}}
			t.ops.RLock() // held from before it is published
			return t, true, t.ops.RUnlock
		}
		m.mu.Unlock()
		leave, err := m.enter(t)
		if err != nil {
			continue // torn down meanwhile
		}
		m.mu.Lock()
		same := m.threads[req.Thread] == t
		m.mu.Unlock()
		if same {
			return t, false, leave
		}
		leave()
	}
}

func sameLayout(a, b []layoutRule) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

type bind struct {
	Source   string `json:"source"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"readOnly,omitempty"`
}

// binds is what a new launch in the thread mounts, in order.
func (m *machine) binds(t *thread) []bind {
	m.mu.Lock()
	defer m.mu.Unlock()
	mnt := filepath.Dir(m.views)
	out := []bind{
		{Source: t.Root, Target: t.Path},
		// The parent of the views mount, so a remounted view after a
		// daemon restart propagates into running namespaces.
		{Source: mnt, Target: mnt},
		{Source: filepath.Join(m.views, adminDir, t.ID), Target: adminLinkDir, ReadOnly: true},
		{Source: m.cache, Target: m.cache},
		{Source: filepath.Dir(m.socket), Target: filepath.Dir(m.socket)},
	}
	w := m.worlds[t.World]
	if w == nil {
		return out
	}
	want := m.want(t, w.names)
	targets := make([]string, 0, len(want))
	for tg := range want {
		targets = append(targets, tg)
	}
	sort.Strings(targets)
	for _, tg := range targets {
		if v := want[tg]; v != "" && tg != adminLinkDir {
			out = append(out, bind{Source: filepath.Join(m.views, v), Target: tg})
		}
	}
	return out
}
