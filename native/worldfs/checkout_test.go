package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func checkedOut(t *testing.T, m *machine, th *thread, name string) {
	t.Helper()
	if err := m.checkout(th, m.repo("w", name), "test[1]", "write", false); err != nil {
		t.Fatalf("checkout %s: %v", name, err)
	}
	waitSettled(m, th, name)
}

// waitSettled waits for the daemon's background jj init in a checkout, so
// a test never races it or removes its directory under it.
func waitSettled(m *machine, th *thread, name string) { m.waitJJ(th, name) }

func code(err error) string {
	var ae *apiError
	if errors.As(err, &ae) {
		return ae.Code
	}
	return ""
}

func TestCheckoutAndClose(t *testing.T) {
	w := newTestWorld(t, "example.com/x/a")
	m, ns := newTestMachine(t, w, defaultPolicy)
	th := registerThread(t, m, "t1", 11)
	v1 := m.repo("w", "example.com/x/a").latest
	if got := ns.last()["/home/u/W/example.com/x/a"]; got != "w/example.com/x/a@"+v1 {
		t.Fatalf("registered thread shows %q", got)
	}

	checkedOut(t, m, th, "example.com/x/a")
	dir := th.hostDir("example.com/x/a")
	if b, err := os.ReadFile(filepath.Join(dir, "README.md")); err != nil || string(b) != "# example.com/x/a\n" {
		t.Fatalf("checkout content %q %v", b, err)
	}
	if got := run(t, dir, "git", "status", "--porcelain"); got != "" {
		t.Fatalf("fresh checkout is dirty: %q", got)
	}
	// Files carry the commit's time, so no index entry is racily clean.
	st, _ := os.Stat(filepath.Join(dir, "README.md"))
	if ct := run(t, dir, "git", "show", "-s", "--format=%ct", "HEAD"); fmt.Sprint(st.ModTime().Unix()) != ct {
		t.Fatalf("README.md mtime %d, commit time %s", st.ModTime().Unix(), ct)
	}
	if _, err := os.Stat(filepath.Join(dir, ".jj", "repo")); err != nil {
		t.Fatalf("no jj repo: %v", err)
	}
	if got, ok := ns.last()["/home/u/W/example.com/x/a"]; !ok || got != "" {
		t.Fatalf("checkout left the view in the namespace: %q", got)
	}
	if out := run(t, w.mirror("example.com/x/a"), "git", "config", "worlds.backfill"); out != "true" {
		t.Fatalf("backfill flag %q", out)
	}

	if err := m.close(th, m.repo("w", "example.com/x/a"), false); err != nil {
		t.Fatalf("close: %v", err)
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 0 {
		t.Fatalf("close left %d entries", len(ents))
	}
	if got := ns.last()["/home/u/W/example.com/x/a"]; got != "w/example.com/x/a@"+v1 {
		t.Fatalf("closed repo shows %q", got)
	}
	tr := th.Repos["example.com/x/a"]
	if tr.Phase != phaseView || !follows(tr.Admin, v1) {
		t.Fatalf("closed repo: phase %s, follows %v", tr.Phase, follows(tr.Admin, v1))
	}

	// It checks out again from the same admin dir.
	checkedOut(t, m, th, "example.com/x/a")
	if got := run(t, dir, "git", "status", "--porcelain"); got != "" {
		t.Fatalf("second checkout is dirty: %q", got)
	}
}

func TestCloseRefusesWork(t *testing.T) {
	w := newTestWorld(t, "example.com/x/a")
	m, _ := newTestMachine(t, w, defaultPolicy)
	th := registerThread(t, m, "t1", 11)
	r := m.repo("w", "example.com/x/a")
	checkedOut(t, m, th, r.name)
	dir := th.hostDir(r.name)

	cases := []struct {
		name  string
		setup func()
		undo  func()
		idle  bool
	}{
		{"edit", func() { write(t, filepath.Join(dir, "README.md"), "changed\n") },
			func() { run(t, dir, "git", "checkout", "README.md") }, false},
		{"untracked", func() { write(t, filepath.Join(dir, "new.txt"), "x") },
			func() { os.Remove(filepath.Join(dir, "new.txt")) }, false},
		{"jj commit", func() { run(t, dir, "jj", "describe", "-m", "plan") },
			func() { run(t, dir, "jj", "describe", "-m", "") }, false},
		{"assume-unchanged edit", func() {
			run(t, dir, "git", "update-index", "--assume-unchanged", "README.md")
			write(t, filepath.Join(dir, "README.md"), "hidden\n")
		}, func() {
			run(t, dir, "git", "update-index", "--no-assume-unchanged", "README.md")
			run(t, dir, "git", "checkout", "README.md")
		}, false},
		{"git commit", func() { run(t, dir, "git", "commit", "-q", "--allow-empty", "-m", "local") },
			func() { // a branch keeps the commit, so it is no longer only the reflog's
				run(t, dir, "git", "branch", "-f", "kept")
				run(t, dir, "git", "reset", "-q", "--hard", "HEAD~1")
			}, false},
		{"ignored files on idle", func() {
			write(t, filepath.Join(dir, "node_modules", "x", "index.js"), "")
			write(t, filepath.Join(r.mirror, "info", "exclude"), "node_modules/\n")
		}, func() { os.RemoveAll(filepath.Join(dir, "node_modules")) }, true},
	}
	for _, c := range cases {
		c.setup()
		err := m.close(th, r, c.idle)
		if code(err) != "work" {
			t.Errorf("%s: close gave %v, want a work refusal", c.name, err)
		}
		c.undo()
	}
	// jj snapshots during the cases; settle it, then the repo closes.
	run(t, dir, "jj", "st")
	if err := m.close(th, r, true); err != nil {
		t.Fatalf("clean repo did not close: %v", err)
	}
}

func TestCapRefusesWithReadableReason(t *testing.T) {
	w := newTestWorld(t, "example.com/x/a", "example.com/x/b")
	p := defaultPolicy
	p.MaxRepos = 1
	m, _ := newTestMachine(t, w, p)
	th := registerThread(t, m, "t1", 11)
	checkedOut(t, m, th, "example.com/x/a")
	err := m.checkout(th, m.repo("w", "example.com/x/b"), "pnpm[42]", "mkdir node_modules", false)
	if code(err) != "cap" || err.Error() != "refused example.com/x/b: 1 repos already checked out in this thread, the cap is 1" {
		t.Fatalf("got %v", err)
	}
	st := m.status(th)
	refs := st["refusals"].([]refusal)
	if len(refs) != 1 || refs[0].Process != "pnpm[42]" || refs[0].Repo != "example.com/x/b" {
		t.Fatalf("refusals %+v", refs)
	}
	// An explicit open overrides the cap.
	if err := m.checkout(th, m.repo("w", "example.com/x/b"), "t3[1]", "open", true); err != nil {
		t.Fatalf("forced checkout: %v", err)
	}
	waitSettled(m, th, "example.com/x/b")
}

func TestIdleClose(t *testing.T) {
	w := newTestWorld(t, "example.com/x/a", "example.com/x/b", "example.com/x/c")
	p := defaultPolicy
	p.Idle = 50 * time.Millisecond
	m, _ := newTestMachine(t, w, p)
	th := registerThread(t, m, "t1", 11)
	for _, n := range []string{"example.com/x/a", "example.com/x/b", "example.com/x/c"} {
		checkedOut(t, m, th, n)
	}
	write(t, filepath.Join(th.hostDir("example.com/x/b"), "README.md"), "edited\n")
	time.Sleep(100 * time.Millisecond)
	// c changed just now, so it is not idle yet.
	write(t, filepath.Join(th.hostDir("example.com/x/c"), "scratch"), "")
	os.Remove(filepath.Join(th.hostDir("example.com/x/c"), "scratch"))
	m.closeIdle()
	for n, want := range map[string]phase{"example.com/x/a": phaseView, "example.com/x/b": phaseOut, "example.com/x/c": phaseOut} {
		if got := th.Repos[n].Phase; got != want {
			t.Errorf("%s: %s, want %s", n, got, want)
		}
	}
}

// Decision 9: views follow the catalog for threads that have not touched
// a repo; a thread that checked it out or moved HEAD keeps its version.
func TestRefreshFollowsOnlyUntouchedThreads(t *testing.T) {
	w := newTestWorld(t, "example.com/x/a")
	m, ns := newTestMachine(t, w, defaultPolicy)
	name := "example.com/x/a"
	r := m.repo("w", name)
	v1 := r.latest
	follower := registerThread(t, m, "follower", 11) // looked at .git only
	if _, err := m.ensureAdmin(follower, r); err != nil {
		t.Fatal(err)
	}
	mover := registerThread(t, m, "mover", 12) // committed on the view
	tr, err := m.ensureAdmin(mover, r)
	if err != nil {
		t.Fatal(err)
	}
	run(t, "", "git", "--git-dir="+tr.Admin, "commit", "-q", "--allow-empty", "-m", "on the view")
	holder := registerThread(t, m, "holder", 13) // checked out, then closed
	checkedOut(t, m, holder, name)
	if err := m.close(holder, r, false); err != nil {
		t.Fatal(err)
	}
	untouched := registerThread(t, m, "untouched", 14)

	v2 := w.commit(t, name, "README.md", "v2\n")
	w.writeCatalog(t)
	m.worlds["w"].mtime = time.Time{}
	changed := m.refreshCatalogs()
	if len(changed["w"]) != 1 {
		t.Fatalf("changed %v", changed)
	}
	m.advance("w", changed["w"])

	ftr := follower.Repos[name]
	if ftr.Version != v2 || !follows(ftr.Admin, v2) {
		t.Fatalf("follower at %s, follows v2 %v", short(ftr.Version), follows(ftr.Admin, v2))
	}
	if got := run(t, "", "git", "--git-dir="+ftr.Admin, "diff-index", "--cached", "--name-only", "HEAD"); got != "" {
		t.Fatalf("follower index differs from HEAD: %q", got)
	}
	if mover.Repos[name].Version != v1 {
		t.Fatal("mover was moved")
	}
	if holder.Repos[name].Version != v1 || holder.Repos[name].Phase != phaseView {
		t.Fatal("holder was moved: a closed checkout keeps its version")
	}
	if untouched.versionOf(r) != v2 {
		t.Fatal("untouched thread does not follow")
	}
	var sawUntouched bool
	for _, c := range ns.calls {
		if c["/home/u/W/"+name] == "w/"+name+"@"+v2 {
			sawUntouched = true
		}
	}
	if !sawUntouched {
		t.Fatal("no namespace was moved to the new view")
	}
	// A repo that joins the catalog gets a directory and a view in every thread.
	w2 := newTestWorld(t, "example.com/x/new")
	w.src["example.com/x/new"] = w2.src["example.com/x/new"]
	run(t, "", "git", "init", "-q", "--bare", w.mirror("example.com/x/new"))
	w.fetch(t, "example.com/x/new")
	w.writeCatalog(t)
	m.worlds["w"].mtime = time.Time{}
	changed = m.refreshCatalogs()
	m.advance("w", changed["w"])
	if st, err := os.Stat(untouched.hostDir("example.com/x/new")); err != nil || !st.IsDir() {
		t.Fatalf("no directory for the new repo: %v", err)
	}
	if got := ns.last()["/home/u/W/example.com/x/new"]; !strings.HasPrefix(got, "w/example.com/x/new@") {
		t.Fatalf("new repo shows %q", got)
	}
	m.mu.Lock()
	allowedV1 := m.allowed(r, v1)
	m.mu.Unlock()
	if !allowedV1 {
		t.Fatal("the old version disappeared while threads hold it")
	}
}

func TestStatusAndTeardown(t *testing.T) {
	w := newTestWorld(t, "example.com/x/a", "example.com/x/b")
	m, ns := newTestMachine(t, w, defaultPolicy)
	th := registerThread(t, m, "t1", 11)
	a, b := "example.com/x/a", "example.com/x/b"
	checkedOut(t, m, th, a)
	if _, err := m.ensureAdmin(th, m.repo("w", b)); err != nil {
		t.Fatal(err)
	}
	dir := th.hostDir(a)
	run(t, dir, "git", "switch", "-q", "-c", "feature")
	write(t, filepath.Join(dir, "f.txt"), "f\n")
	run(t, dir, "git", "add", "f.txt")
	run(t, dir, "git", "commit", "-q", "-m", "feature")
	write(t, filepath.Join(dir, "dirty.txt"), "x")

	repos := m.status(th)["repos"].([]repoStatus)
	if len(repos) != 2 {
		t.Fatalf("status lists %d repos", len(repos))
	}
	sa, sb := repos[0], repos[1]
	if sa.State != "checked-out" || sa.Dirty != 1 || sa.Commits != 0 || !sa.LostOnTeardown ||
		len(sa.Branches) != 1 || sa.Branches[0].Name != "feature" || sa.Branches[0].Commits != 1 {
		t.Fatalf("a: %+v", sa)
	}
	if sb.State != "view" || !sb.Following || sb.LostOnTeardown {
		t.Fatalf("b: %+v", sb)
	}

	ns.alive = true
	if err := m.teardown(th); code(err) != "live" {
		t.Fatalf("teardown of a live thread: %v", err)
	}
	ns.alive = false
	if err := m.teardown(th); code(err) != "work" || !strings.Contains(err.Error(), "example.com/x/a (1 changed files") {
		t.Fatalf("teardown with work: %v", err)
	}
	os.Remove(filepath.Join(dir, "dirty.txt"))
	run(t, dir, "jj", "st") // jj's own commits are on the branch or empty
	if err := m.teardown(th); err != nil {
		t.Fatalf("teardown: %v", err)
	}
	if ents, _ := os.ReadDir(filepath.Join(w.mirror(a), "worktrees")); len(ents) != 0 {
		t.Fatalf("worktrees left: %d", len(ents))
	}
	if _, err := os.Stat(th.Root); !os.IsNotExist(err) {
		if ents, _ := os.ReadDir(th.Root); len(ents) != 0 {
			t.Fatalf("thread root keeps %d entries", len(ents))
		}
	}
	if got := run(t, w.mirror(a), "git", "rev-parse", "--verify", "refs/heads/feature"); got == "" {
		t.Fatal("the branch went with the thread")
	}
	if m.threads["t1"] != nil {
		t.Fatal("thread still registered")
	}
}

func TestRecover(t *testing.T) {
	a, b, c, d, e := "example.com/x/a", "example.com/x/b", "example.com/x/c", "example.com/x/d", "example.com/x/e"
	w := newTestWorld(t, a, b, c, d, e)
	m, _ := newTestMachine(t, w, defaultPolicy)
	th := registerThread(t, m, "t1", 11)
	for _, n := range []string{a, b, c, d, e} {
		if _, err := m.ensureAdmin(th, m.repo("w", n)); err != nil {
			t.Fatal(err)
		}
	}
	// a: died while read-tree wrote files. b: died after the index swap,
	// before the checkout was recorded. c: died while closing. d: died
	// between moving HEAD and the index to a new catalog commit.
	write(t, filepath.Join(th.hostDir(a), "README.md"), "partial")
	write(t, filepath.Join(th.Repos[a].Admin, "index.worldfs-checkout.lock"), "")
	write(t, filepath.Join(th.hostDir(b), "README.md"), "# example.com/x/b\n")
	run(t, "", "ln", filepath.Join(th.Repos[b].Admin, "index"), filepath.Join(th.Repos[b].Admin, "index.worldfs-orig"))
	write(t, filepath.Join(th.Repos[b].Admin, "index.new"), "checkout index") // renamed over, as checkout does
	if err := os.Rename(filepath.Join(th.Repos[b].Admin, "index.new"), filepath.Join(th.Repos[b].Admin, "index")); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(th.hostDir(c), "README.md"), "edited after the checks\n")
	if err := os.MkdirAll(filepath.Join(th.hostDir(c), ".jj", "repo"), 0o755); err != nil { // jj was ready
		t.Fatal(err)
	}
	v2 := w.commit(t, d, "README.md", "v2\n")
	tv2, err := m.repo("w", d).tree(v2)
	if err != nil {
		t.Fatal(err)
	}
	lockBytes, _ := indexBytes(tv2.viewIndex())
	write(t, filepath.Join(th.Repos[d].Admin, advanceFile), string(lockBytes))
	run(t, "", "ln", filepath.Join(th.Repos[d].Admin, advanceFile), filepath.Join(th.Repos[d].Admin, "index.lock"))
	run(t, "", "git", "--git-dir="+th.Repos[d].Admin, "update-ref", "--no-deref", "HEAD", v2)
	w.writeCatalog(t)
	// e: died while closing, before jj ever initialized.
	write(t, filepath.Join(th.hostDir(e), "README.md"), "# example.com/x/e\n")
	th.Repos[a].Phase, th.Repos[b].Phase, th.Repos[c].Phase, th.Repos[e].Phase = phaseCheckingOut, phaseCheckingOut, phaseClosing, phaseClosing
	th.Repos[d].Advancing = v2
	m.mu.Lock()
	_ = m.save()
	m.mu.Unlock()

	m2 := newMachine(m.cache, m.state, m.socket, defaultPolicy, &fakeNS{})
	if err := m2.load(); err != nil {
		t.Fatal(err)
	}
	m2.refreshCatalogs()
	m2.recover()
	th2 := m2.threads["t1"]
	for _, n := range []string{a, b} {
		if th2.Repos[n].Phase != phaseView {
			t.Errorf("%s: %s", n, th2.Repos[n].Phase)
		}
		if _, err := os.Stat(filepath.Join(th2.hostDir(n), "README.md")); !os.IsNotExist(err) {
			t.Errorf("%s: partial checkout left behind", n)
		}
		if _, err := os.Stat(filepath.Join(th2.hostDir(n), ".git")); err != nil {
			t.Errorf("%s: .git link removed", n)
		}
		if !follows(th2.Repos[n].Admin, th2.Repos[n].Version) {
			t.Errorf("%s: the view's index was not restored", n)
		}
	}
	if th2.Repos[c].Phase != phaseOut {
		t.Errorf("c: %s", th2.Repos[c].Phase)
	}
	waitSettled(m2, th2, c)
	if b, err := os.ReadFile(filepath.Join(th2.hostDir(c), "README.md")); err != nil || string(b) != "edited after the checks\n" {
		t.Errorf("c: interrupted close lost the checkout: %q %v", b, err)
	}
	waitSettled(m2, th2, e)
	if _, err := os.Stat(filepath.Join(th2.hostDir(e), ".jj", "repo")); err != nil {
		t.Error("e: jj not initialized after recovery")
	}
	if dr := th2.Repos[d]; dr.Version != v2 || dr.Advancing != "" || !follows(dr.Admin, v2) {
		t.Errorf("d: version %s, advancing %q, follows v2 %v", short(dr.Version), dr.Advancing, follows(dr.Admin, v2))
	}
	for _, f := range []string{"index.lock", advanceFile} {
		if _, err := os.Stat(filepath.Join(th2.Repos[d].Admin, f)); !os.IsNotExist(err) {
			t.Errorf("d: %s left behind", f)
		}
	}
}

// A commit made on a view and reset away lives only in the worktree's
// reflog, which teardown removes.
func TestResetAwayCommitIsWork(t *testing.T) {
	w := newTestWorld(t, "example.com/x/a")
	m, _ := newTestMachine(t, w, defaultPolicy)
	th := registerThread(t, m, "t1", 11)
	tr, err := m.ensureAdmin(th, m.repo("w", "example.com/x/a"))
	if err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) { run(t, "", "git", append([]string{"--git-dir=" + tr.Admin}, args...)...) }
	git("commit", "-q", "--allow-empty", "-m", "on the view")
	git("reset", "-q", "--soft", "HEAD~1")
	wk, err := inspectAdmin(tr.Admin)
	if err != nil || wk.Commits != 1 || !wk.lost() {
		t.Fatalf("work %+v, %v", wk, err)
	}
	if err := m.teardown(th); code(err) != "work" {
		t.Fatalf("teardown: %v", err)
	}
}

// Two checkouts admitted at once reserve their sizes together.
func TestAdmitReservesBytes(t *testing.T) {
	w := newTestWorld(t, "example.com/x/a", "example.com/x/b")
	p := defaultPolicy
	p.MaxBytes = 10 << 30
	m, _ := newTestMachine(t, w, p)
	th := registerThread(t, m, "t1", 11)
	if err := m.admit(th, m.repo("w", "example.com/x/a"), 6<<30, "a[1]", "write", false); err != nil {
		t.Fatal(err)
	}
	if err := m.admit(th, m.repo("w", "example.com/x/b"), 6<<30, "b[2]", "write", false); code(err) != "cap" {
		t.Fatalf("second 6 GB checkout: %v", err)
	}
}

// In a jj checkout, a git commit reset away before any jj command ran is
// in no ref and not in jj's store; only the reflog keeps it.
func TestResetAwayCommitInJJCheckoutIsWork(t *testing.T) {
	w := newTestWorld(t, "example.com/x/a")
	m, _ := newTestMachine(t, w, defaultPolicy)
	th := registerThread(t, m, "t1", 11)
	r := m.repo("w", "example.com/x/a")
	checkedOut(t, m, th, r.name)
	dir := th.hostDir(r.name)
	run(t, dir, "git", "commit", "-q", "--allow-empty", "-m", "local")
	run(t, dir, "git", "reset", "-q", "--soft", "HEAD~1")
	if err := m.close(th, r, false); code(err) != "work" {
		t.Fatalf("close: %v", err)
	}
	// A commit jj rewrote is in jj's store and does not count.
	run(t, dir, "jj", "describe", "-m", "plan")
	run(t, dir, "jj", "new")
	run(t, dir, "jj", "abandon", "@-")
	wk, err := inspectCheckout(dir)
	if err != nil || wk.Commits != 1 {
		t.Fatalf("work %+v, %v", wk, err)
	}
}
