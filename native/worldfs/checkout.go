package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ensureAdmin registers the thread's worktree for a repo: a locked,
// no-checkout worktree in the mirror at the thread's host directory, with
// an index whose stat data matches the view (see admin.go). Callers hold
// the thread (enter).
func (m *machine) ensureAdmin(t *thread, r *repo) (*threadRepo, error) {
	m.mu.Lock()
	tr := t.Repos[r.name]
	version := t.versionOf(r)
	m.mu.Unlock()
	if tr != nil && tr.Admin != "" {
		return tr, nil
	}
	if version == "" {
		return nil, apiErr("unknown-repo", "%s left the %s catalog", r.name, r.world)
	}
	r.wtMu.Lock()
	defer r.wtMu.Unlock()
	m.mu.Lock()
	tr = t.Repos[r.name]
	m.mu.Unlock()
	if tr != nil && tr.Admin != "" {
		return tr, nil
	}
	dir := t.hostDir(r.name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	reason := "worldfs thread " + t.ID
	admin := adoptable(dir, r.mirror, reason)
	if admin != "" {
		// Never published, so no thread process has used it: move it to the
		// version the thread's namespaces show.
		if _, err := runGit("", adminEnv(admin), "update-ref", "--no-deref", "HEAD", version); err != nil {
			return nil, apiErr("failed", "%s: %v", r.name, err)
		}
	}
	tr0, err := r.tree(version)
	if err != nil {
		return nil, apiErr("missing-objects", "%s@%s: %v", r.name, short(version), err)
	}
	if admin == "" {
		if _, err := runGit(r.mirror, nil, "worktree", "add", "-f", "-q", "--no-checkout", "--detach",
			"--lock", "--reason", reason, dir, version); err != nil {
			return nil, apiErr("failed", "%s: %v", r.name, err)
		}
		if admin, err = runGit(dir, nil, "rev-parse", "--absolute-git-dir"); err != nil {
			return nil, apiErr("failed", "%s: %v", r.name, err)
		}
	}
	if err := tr0.writeIndex(filepath.Join(admin, "index")); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	tr = t.Repos[r.name]
	added := tr == nil
	if added {
		tr = &threadRepo{Version: version, Phase: phaseView, jjReady: make(chan struct{})}
		t.Repos[r.name] = tr
	}
	tr.Admin = admin
	if err := m.save(); err != nil {
		// Not saved, not published: a retry adopts the worktree.
		if added {
			delete(t.Repos, r.name)
		} else {
			tr.Admin = ""
		}
		return nil, err
	}
	return tr, nil
}

// adoptable finds a worktree this thread registered for dir before a crash
// kept it out of state.json.
func adoptable(dir, mirror, reason string) string {
	b, err := os.ReadFile(filepath.Join(dir, ".git"))
	if err != nil {
		return ""
	}
	admin := strings.TrimSpace(strings.TrimPrefix(string(b), "gitdir: "))
	lock, err := os.ReadFile(filepath.Join(admin, "locked"))
	if err != nil || filepath.Dir(admin) != filepath.Join(mirror, "worktrees") || strings.TrimSpace(string(lock)) != reason {
		return ""
	}
	return admin
}

// usage counts a thread's checkouts, finished and admitted. Callers hold m.mu.
func (t *thread) usage() (int, uint64) {
	n, b := t.pending, t.pendingBytes
	for _, tr := range t.Repos {
		if tr.Phase == phaseOut || tr.Phase == phaseClosing || tr.Phase == phaseClearing {
			n++
			b += tr.Bytes
		}
	}
	return n, b
}

func (t *thread) refuse(repo, who, reason string) {
	t.Refusals = append(t.Refusals, refusal{At: time.Now(), Repo: repo, Process: who, Reason: reason})
	if len(t.Refusals) > 20 {
		t.Refusals = t.Refusals[len(t.Refusals)-20:]
	}
}

// admit waits for the throttle and reserves a checkout slot and its size.
// The caller releases the reservation when the checkout ends.
func (m *machine) admit(t *thread, r *repo, size uint64, who, why string, force bool) error {
	logged := false
	for {
		m.mu.Lock()
		now := time.Now()
		cur, bytes := t.usage()
		var wait time.Duration
		var refused string
		if !force {
			wait, refused = m.policy.admit(cur, bytes, size, t.Throttled, now)
		}
		if refused != "" {
			msg := fmt.Sprintf("refused %s: %s", r.name, refused)
			t.refuse(r.name, who, refused)
			_ = m.save()
			m.mu.Unlock()
			log.Printf("REFUSED %s in %s for %s (%s): %s", r.name, t.ID, who, why, refused)
			return apiErr("cap", "%s", msg)
		}
		if wait <= 0 {
			t.pending++
			t.pendingBytes += size
			if cur >= m.policy.Free && !force {
				kept := t.Throttled[:0]
				for _, x := range t.Throttled {
					if now.Sub(x) < m.policy.Window {
						kept = append(kept, x)
					}
				}
				t.Throttled = append(kept, now)
			}
			m.mu.Unlock()
			return nil
		}
		m.mu.Unlock()
		if !logged {
			log.Printf("THROTTLED %s in %s for %s (%s): waiting %v", r.name, t.ID, who, why, wait.Round(10*time.Millisecond))
			logged = true
		}
		time.Sleep(wait)
	}
}

// checkout checks a repo out for one thread and removes the view from that
// thread's namespaces. Other threads keep their views.
func (m *machine) checkout(t *thread, r *repo, who, why string, force bool) error {
	leave, err := m.enter(t)
	if err != nil {
		return err
	}
	defer leave()
	tr, err := m.ensureAdmin(t, r)
	if err != nil {
		return err
	}
	tr.mu.Lock()
	defer tr.mu.Unlock()
	m.mu.Lock()
	ph, version, admin := tr.Phase, tr.Version, tr.Admin
	m.mu.Unlock()
	if ph == phaseOut {
		m.sync(t, r.name) // the caller's namespace may predate the checkout
		return nil
	}
	if ph == phaseClearing {
		if err := m.finishClearing(tr, t.hostDir(r.name)); err != nil {
			return err
		}
	}
	tv, err := r.tree(version)
	if err != nil {
		return apiErr("missing-objects", "%s@%s: %v", r.name, short(version), err)
	}
	if err := m.admit(t, r, tv.bytes, who, why, force); err != nil {
		return err
	}
	released := false // the reservation turns into the checkout's own usage
	defer func() {
		m.mu.Lock()
		if !released {
			t.pending--
			t.pendingBytes -= tv.bytes
		}
		m.mu.Unlock()
	}()
	t0 := time.Now()
	if err := m.setPhase(tr, phaseCheckingOut); err != nil {
		return err
	}
	dir := t.hostDir(r.name)
	index, orig, tmp := filepath.Join(admin, "index"), filepath.Join(admin, "index.worldfs-orig"), filepath.Join(admin, "index.worldfs-checkout")
	fail := func(code string, err error) error {
		rollbackCheckout(dir, admin)
		_ = m.setPhase(tr, phaseView)
		log.Printf("checkout %s in %s: %v", r.name, t.ID, err)
		return apiErr(code, "checking out %s failed: %v", r.name, err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".git"), []byte("gitdir: "+admin+"\n"), 0o644); err != nil {
		return fail("failed", err)
	}
	// Check out the index, not HEAD, so anything staged on the view
	// survives. An index git cannot write as a tree (a conflict) stays.
	treeish, err := runGit("", []string{"GIT_DIR=" + admin}, "write-tree")
	if err != nil {
		return fail("failed", fmt.Errorf("its index is not a tree: %w", err))
	}
	_ = os.Remove(tmp)
	if _, err := runGit(dir, []string{"GIT_DIR=" + admin, "GIT_WORK_TREE=" + dir, "GIT_INDEX_FILE=" + tmp},
		"-c", "checkout.workers=0", "read-tree", "--reset", "-u", treeish); err != nil {
		code := "failed"
		if strings.Contains(err.Error(), "unable to read") || strings.Contains(err.Error(), "missing") {
			code = "missing-objects"
		}
		return fail(code, err)
	}
	if err := stampCheckout(dir, admin, tmp, int64(tv.mtime)); err != nil {
		return fail("failed", err)
	}
	// Keep the view's index until the checkout is recorded. A git command
	// holding index.lock is about to write its own index; leave it be.
	if _, err := os.Stat(index + ".lock"); err == nil {
		_ = os.Remove(tmp)
	} else {
		if err := os.Link(index, orig); err != nil {
			return fail("failed", err)
		}
		if err := os.Rename(tmp, index); err != nil {
			return fail("failed", err)
		}
	}
	t1 := time.Now()
	ready := make(chan struct{})
	m.mu.Lock()
	pinned := tr.Pinned
	tr.Phase, tr.CheckedOutAt, tr.Bytes, tr.Pinned, tr.jjReady = phaseOut, t1, tv.bytes, true, ready
	err = m.save()
	if err != nil {
		tr.Phase, tr.CheckedOutAt, tr.Bytes, tr.Pinned = phaseCheckingOut, time.Time{}, 0, pinned
	} else {
		t.pending--
		t.pendingBytes -= tv.bytes
		released = true
	}
	m.mu.Unlock()
	if err != nil {
		return fail("failed", err)
	}
	_ = os.Remove(orig)
	m.sync(t, r.name)
	t2 := time.Now()
	log.Printf("CHECKOUT %s in %s by %s on %s: read-tree %v, unmount %v",
		r.name, t.ID, who, why, t1.Sub(t0).Round(time.Millisecond), t2.Sub(t1).Round(time.Millisecond))
	if out, err := runGit(r.mirror, nil, "config", "--get", "worlds.backfill"); err != nil || out != "true" {
		if _, err := runGit(r.mirror, nil, "config", "worlds.backfill", "true"); err != nil {
			log.Printf("backfill flag %s: %v", r.name, err)
		}
	}
	m.bg.Add(1)
	go m.initJJ(t, r, dir, ready)
	return nil
}

// rollbackCheckout undoes a checkout that was never recorded as done. The
// view covered the directory in every namespace until then, so nothing but
// read-tree wrote there.
func rollbackCheckout(dir, admin string) {
	_ = clearDir(dir, ".git")
	for _, f := range []string{"index.worldfs-checkout", "index.worldfs-checkout.lock"} {
		_ = os.Remove(filepath.Join(admin, f))
	}
	orig := filepath.Join(admin, "index.worldfs-orig")
	if _, err := os.Stat(orig); err == nil {
		// rename does nothing when both names are one file, as they are if
		// the crash came between the link and the swap.
		if os.Rename(orig, filepath.Join(admin, "index")) == nil {
			_ = os.Remove(orig)
		}
	}
}

// initJJ colocates a jj repo in a fresh checkout. Callers add it to m.bg.
func (m *machine) initJJ(t *thread, r *repo, dir string, ready chan struct{}) {
	defer m.bg.Done()
	defer close(ready)
	if !m.jj {
		return
	}
	t0 := time.Now()
	// Bounded, because an upgrade's drain waits for it; recover reruns an
	// init that never finished.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "jj", "git", "init", "--colocate")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		log.Printf("jj %s in %s: %v %s", r.name, t.ID, err, out)
		return
	}
	log.Printf("jj ready for %s in %s after %v", r.name, t.ID, time.Since(t0).Round(time.Millisecond))
}

func (m *machine) setPhase(tr *threadRepo, p phase) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	prev := tr.Phase
	tr.Phase = p
	if err := m.save(); err != nil {
		tr.Phase = prev
		return err
	}
	return nil
}

// waitJJ blocks until a checked-out repo's jj repo exists.
func (m *machine) waitJJ(t *thread, name string) {
	m.mu.Lock()
	tr := t.Repos[name]
	var ready chan struct{}
	if tr != nil && tr.Phase == phaseOut {
		ready = tr.jjReady
	}
	m.mu.Unlock()
	if ready != nil {
		<-ready
	}
}

// clearDir removes everything in dir except the named entries.
func clearDir(dir string, keep ...string) error {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var first error
outer:
	for _, e := range ents {
		for _, k := range keep {
			if e.Name() == k {
				continue outer
			}
		}
		if err := os.RemoveAll(filepath.Join(dir, e.Name())); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// procInside names a process with its cwd, root or an open file inside a
// thread's repo, looking at the namespace path for the thread's own
// processes and the host path for everyone else.
func (m *machine) procInside(t *thread, name string, hostMnt uint64) string {
	inNS, onHost := t.target(name), t.hostDir(name)
	m.mu.Lock()
	key := t.Key
	m.mu.Unlock()
	inside := func(p, base string) bool { return p == base || strings.HasPrefix(p, base+"/") }
	owners := map[uint64]uint64{}
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		base := onHost
		if mnt := mntnsOf(pid); mnt != 0 && mnt != hostMnt {
			owner, ok := owners[mnt]
			if !ok {
				if u, k, err := ownerOf(pid); err == nil {
					u.Close()
					owner = k
				}
				owners[mnt] = owner
			}
			if owner == key && key != 0 {
				base = inNS
			}
		}
		links := []string{"cwd", "root"}
		if fds, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid)); err == nil {
			for _, fd := range fds {
				links = append(links, "fd/"+fd.Name())
			}
		}
		for _, l := range links {
			if p, err := os.Readlink(fmt.Sprintf("/proc/%d/%s", pid, l)); err == nil && inside(strings.TrimSuffix(p, " (deleted)"), base) {
				return procName(pid)
			}
		}
	}
	return ""
}

func comm(pid int) string {
	b, _ := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	return strings.TrimSpace(string(b))
}

func procName(pid int) string { return fmt.Sprintf("%s[%d]", comm(pid), pid) }

// newestChange is the latest ctime below dir, stopping early once one is
// newer than since.
func newestChange(dir string, since time.Time) time.Time {
	var newest time.Time
	_ = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		var st syscall.Stat_t
		if syscall.Lstat(p, &st) != nil {
			return nil
		}
		if c := time.Unix(st.Ctim.Sec, st.Ctim.Nsec); c.After(newest) {
			newest = c
			if newest.After(since) {
				return filepath.SkipAll
			}
		}
		return nil
	})
	return newest
}

// closable reports why a checkout must stay, or nil. idle additionally
// keeps repos with ignored files, such as installed dependencies, which
// the caller of an explicit close may discard.
func (m *machine) closable(t *thread, name string, idle bool) (work, error) {
	if who := m.procInside(t, name, m.hostMnt); who != "" {
		return work{}, apiErr("busy", "%s is in use by %s", name, who)
	}
	w, err := inspectCheckout(t.hostDir(name))
	switch {
	case err != nil:
		return w, apiErr("failed", "%s: %v", name, err)
	case w.lost():
		return w, apiErr("work", "%s holds work no remote has: %s", name, describeWork(w))
	case !w.HeadOnRemote:
		return w, apiErr("work", "%s is at %s, which no remote has", name, short(w.Head))
	case idle && w.Ignored > 0:
		return w, apiErr("work", "%s has ignored files, such as installed dependencies", name)
	}
	return w, nil
}

// close turns a checkout back into a view when nothing would be lost. The
// view goes over the checkout in every namespace first, then the checks
// run again, so nothing written in between is deleted.
func (m *machine) close(t *thread, r *repo, idle bool) error {
	leave, err := m.enter(t)
	if err != nil {
		return err
	}
	defer leave()
	m.mu.Lock()
	tr := t.Repos[r.name]
	m.mu.Unlock()
	if tr == nil {
		return apiErr("not-checked-out", "%s is not checked out in this thread", r.name)
	}
	tr.mu.Lock()
	defer tr.mu.Unlock()
	m.mu.Lock()
	ph, admin, ready, prev := tr.Phase, tr.Admin, tr.jjReady, tr.Version
	m.mu.Unlock()
	if ph == phaseClearing {
		return m.finishClearing(tr, t.hostDir(r.name)) // a close that failed to delete
	}
	if ph != phaseOut {
		return apiErr("not-checked-out", "%s is not checked out in this thread", r.name)
	}
	<-ready // the daemon's own jj must not count as a process inside
	w, err := m.closable(t, r.name, idle)
	if err != nil {
		return err
	}
	tv, err := r.tree(w.Head)
	if err != nil {
		return apiErr("missing-objects", "%s@%s: %v", r.name, short(w.Head), err)
	}
	m.mu.Lock()
	tr.Phase, tr.Version = phaseClosing, w.Head
	err = m.save()
	if err != nil {
		tr.Phase, tr.Version = phaseOut, prev
	}
	m.mu.Unlock()
	if err != nil {
		return err
	}
	reopen := func(err error) error {
		m.mu.Lock()
		tr.Phase, tr.Version = phaseOut, prev
		_ = m.save()
		m.mu.Unlock()
		m.sync(t, r.name)
		return err
	}
	if errs := m.sync(t, r.name); len(errs) > 0 {
		return reopen(apiErr("failed", "%s: the view did not replace the checkout: %v", r.name, errors.Join(errs...)))
	}
	if w2, err := m.closable(t, r.name, idle); err != nil {
		return reopen(err)
	} else if w2.Head != w.Head {
		return reopen(apiErr("busy", "%s moved while closing", r.name))
	}
	if err := tv.writeIndex(filepath.Join(admin, "index")); err != nil {
		return reopen(err)
	}
	if err := m.setPhase(tr, phaseClearing); err != nil {
		return reopen(err)
	}
	if err := m.finishClearing(tr, t.hostDir(r.name)); err != nil {
		return err
	}
	log.Printf("CLOSED %s in %s at %s (idle %v)", r.name, t.ID, short(w.Head), idle)
	return nil
}

func short(c string) string {
	if len(c) > 12 {
		return c[:12]
	}
	return c
}

func describeWork(w work) string {
	var parts []string
	if w.Dirty > 0 {
		parts = append(parts, fmt.Sprintf("%d changed files", w.Dirty))
	}
	if w.Commits > 0 {
		parts = append(parts, fmt.Sprintf("%d commits no branch, tag or remote reaches", w.Commits))
	}
	if w.JJCommits > 0 {
		parts = append(parts, fmt.Sprintf("%d jj commits no bookmark reaches", w.JJCommits))
	}
	return strings.Join(parts, ", ")
}

// closeIdle closes checkouts nobody changed for the idle time.
func (m *machine) closeIdle() {
	now := time.Now()
	type item struct {
		t *thread
		r *repo
	}
	var due []item
	m.mu.Lock()
	for _, t := range m.threads {
		w := m.worlds[t.World]
		for name, tr := range t.Repos {
			if tr.Phase == phaseOut && now.Sub(tr.CheckedOutAt) >= m.policy.Idle && w != nil && w.repos[name] != nil {
				due = append(due, item{t, w.repos[name]})
			}
		}
	}
	m.mu.Unlock()
	for _, it := range due {
		if newestChange(it.t.hostDir(it.r.name), now.Add(-m.policy.Idle)).After(now.Add(-m.policy.Idle)) {
			continue
		}
		if err := m.close(it.t, it.r, true); err != nil {
			continue // busy or holding work; it stays checked out
		}
	}
}

// catchUp brings every thread to the catalogs as read at startup, which
// may have moved while the daemon was down.
func (m *machine) catchUp() {
	m.mu.Lock()
	names := map[string][]string{}
	for w, world := range m.worlds {
		names[w] = append([]string(nil), world.names...)
	}
	m.mu.Unlock()
	for w, ns := range names {
		m.advance(w, ns)
	}
}

// advance moves threads that follow the catalog to a repo's new commit:
// their HEAD and index, then the bind in their namespaces. A repo new to
// the catalog gets its directory in every thread world first.
func (m *machine) advance(worldName string, names []string) {
	m.mu.Lock()
	var ts []*thread
	for _, t := range m.threads {
		if t.World == worldName {
			ts = append(ts, t)
		}
	}
	m.mu.Unlock()
	for _, t := range ts {
		leave, err := m.enter(t)
		if err != nil {
			continue
		}
		for _, n := range names {
			r := m.repo(worldName, n)
			if r == nil {
				continue
			}
			m.mu.Lock()
			tr, latest := t.Repos[n], r.latest
			m.mu.Unlock()
			if latest != "" {
				if err := os.MkdirAll(t.hostDir(n), 0o755); err != nil {
					log.Printf("advance %s in %s: %v", n, t.ID, err)
				}
			}
			if tr == nil || latest == "" {
				continue
			}
			if err := m.advanceOne(t, r, tr, latest); err != nil {
				log.Printf("advance %s in %s: %v", r.name, t.ID, err)
			}
		}
		m.sync(t, names...)
		leave()
	}
}

// advanceOne moves one follower's HEAD and index under git's own index
// lock, so staging that races the refresh is never overwritten.
// tr.Advancing lets recovery finish the pair if the daemon dies between.
func (m *machine) advanceOne(t *thread, r *repo, tr *threadRepo, latest string) error {
	tr.mu.Lock()
	defer tr.mu.Unlock()
	m.mu.Lock()
	ph, version, admin, pinned := tr.Phase, tr.Version, tr.Admin, tr.Pinned
	m.mu.Unlock()
	if ph != phaseView || pinned || version == latest {
		return nil
	}
	tv, err := r.tree(latest)
	if err != nil {
		return err
	}
	b, err := indexBytes(tv.viewIndex())
	if err != nil {
		return err
	}
	// Journal first, so recovery looks for the daemon's index.lock (see
	// recoverAdvance).
	m.mu.Lock()
	tr.Advancing = latest
	err = m.save()
	if err != nil {
		tr.Advancing = ""
	}
	m.mu.Unlock()
	if err != nil {
		return err
	}
	done := func(v string) {
		m.mu.Lock()
		tr.Version, tr.Advancing = v, ""
		_ = m.save()
		m.mu.Unlock()
	}
	// The lock appears complete or not at all: it is a hard link to a fully
	// written private file, which also lets recovery tell it is ours.
	lock, own := filepath.Join(admin, "index.lock"), filepath.Join(admin, advanceFile)
	if err := os.WriteFile(own, b, 0o644); err != nil {
		_ = os.Remove(own)
		done(version)
		return err
	}
	if err := os.Link(own, lock); err != nil {
		_ = os.Remove(own)
		done(version)
		return nil // git is writing the index; the thread's version stays
	}
	abandon := func(err error) error {
		_ = os.Remove(lock)
		_ = os.Remove(own)
		done(version)
		return err
	}
	if !follows(admin, version) {
		return abandon(nil) // the thread moved HEAD or staged something: the version is the thread's
	}
	if _, err := runGit("", adminEnv(admin), "update-ref", "--no-deref", "-m", "worldfs: follow "+r.branch, "HEAD", latest, version); err != nil {
		return abandon(err)
	}
	if err := os.Rename(lock, filepath.Join(admin, "index")); err != nil {
		return err // recovery finishes it
	}
	_ = os.Remove(own)
	done(latest)
	return nil
}

const advanceFile = "index.worldfs-advance"

// recover finishes or rolls back what a crash interrupted. It runs before
// the control socket opens. It never deletes a checkout that may hold
// work: an interrupted close keeps its checkout.
func (m *machine) recover() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, t := range m.threads {
		w := m.worlds[t.World]
		for name, tr := range t.Repos {
			dir := t.hostDir(name)
			switch tr.Phase {
			case phaseCheckingOut:
				rollbackCheckout(dir, tr.Admin)
				tr.Phase = phaseView
				log.Printf("RECOVER %s in %s: rolled back an unfinished checkout", name, t.ID)
			case phaseClosing:
				tr.Phase = phaseOut
				log.Printf("RECOVER %s in %s: kept a checkout whose close was interrupted", name, t.ID)
			case phaseClearing:
				if clearDir(dir) == nil {
					tr.Phase, tr.CheckedOutAt, tr.Bytes = phaseView, time.Time{}, 0
					log.Printf("RECOVER %s in %s: finished closing", name, t.ID)
				}
			}
			if tr.Advancing != "" {
				m.recoverAdvance(t, w.repoOrStub(name), tr)
			}
			if tr.Phase == phaseOut {
				_ = os.Remove(filepath.Join(tr.Admin, "index.worldfs-orig"))
				tr.jjReady = make(chan struct{})
				if st, err := os.Stat(filepath.Join(dir, ".jj", "repo")); err == nil && st.IsDir() {
					close(tr.jjReady)
				} else {
					_ = os.RemoveAll(filepath.Join(dir, ".jj"))
					m.bg.Add(1)
					go m.initJJ(t, w.repoOrStub(name), dir, tr.jjReady)
				}
			}
		}
	}
	_ = m.save()
}

// recoverAdvance settles a catalog refresh the daemon died in. It only
// touches an index.lock that is a hard link to the daemon's private file,
// and never rewrites the index itself, so staging done since stays.
func (m *machine) recoverAdvance(t *thread, r *repo, tr *threadRepo) {
	head, _ := os.ReadFile(filepath.Join(tr.Admin, "HEAD"))
	moved := strings.TrimSpace(string(head)) == tr.Advancing
	lock, own := filepath.Join(tr.Admin, "index.lock"), filepath.Join(tr.Admin, advanceFile)
	lst, lerr := os.Stat(lock)
	ost, oerr := os.Stat(own)
	if lerr == nil && oerr == nil && os.SameFile(lst, ost) {
		if moved {
			_ = os.Rename(lock, filepath.Join(tr.Admin, "index"))
		} else {
			_ = os.Remove(lock)
		}
	}
	_ = os.Remove(own)
	if moved {
		tr.Version = tr.Advancing
	}
	log.Printf("RECOVER %s in %s: settled following the catalog at %s", r.name, t.ID, short(tr.Version))
	tr.Advancing = ""
}

// finishClearing deletes a closed checkout's files. Until that succeeds
// the repo stays clearing and counts against the cap. Callers hold tr.mu.
func (m *machine) finishClearing(tr *threadRepo, dir string) error {
	if err := clearDir(dir); err != nil {
		return apiErr("failed", "deleting the closed checkout at %s: %v", dir, err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	tr.Phase, tr.CheckedOutAt, tr.Bytes = phaseView, time.Time{}, 0
	return m.save()
}

// repoOrStub gives a repo that left the catalog a name to log.
func (w *world) repoOrStub(name string) *repo {
	if w != nil && w.repos[name] != nil {
		return w.repos[name]
	}
	return &repo{name: name}
}

// teardown removes a thread's worktrees, checkouts and links, unless that
// would lose work no remote has or the thread still runs. It holds the
// thread against every other operation until it is done.
func (m *machine) teardown(t *thread) error {
	t.ops.Lock()
	defer t.ops.Unlock()
	m.mu.Lock()
	key, gone := t.Key, t.gone
	m.mu.Unlock()
	if gone {
		return apiErr("unknown-thread", "thread %s was torn down", t.ID)
	}
	if key != 0 && m.ns.live(key) {
		return apiErr("live", "processes still run in thread %s; stop them first", t.ID)
	}
	m.mu.Lock()
	repos := map[string]*threadRepo{}
	for n, tr := range t.Repos {
		repos[n] = tr
	}
	w := m.worlds[t.World]
	m.mu.Unlock()
	var held []string
	for n, tr := range repos {
		var wk work
		var err error
		// A clearing repo was clean when it closed, and its checkout may
		// already lack .git; its admin dir holds what's left.
		if tr.Phase == phaseView || tr.Phase == phaseClearing {
			wk, err = inspectAdmin(tr.Admin)
		} else {
			wk, err = inspectCheckout(t.hostDir(n))
		}
		if err != nil {
			held = append(held, fmt.Sprintf("%s (%v)", n, err))
		} else if wk.lost() {
			held = append(held, fmt.Sprintf("%s (%s)", n, describeWork(wk)))
		}
	}
	if len(held) > 0 {
		return apiErr("work", "thread %s holds work no remote has: %s", t.ID, strings.Join(held, "; "))
	}
	// Files first: while one can't be deleted, the admin dirs and the
	// thread record stay, so teardown can run again.
	for n := range repos {
		if err := clearDir(t.hostDir(n)); err != nil && !os.IsNotExist(err) {
			return apiErr("failed", "deleting %s: %v", t.hostDir(n), err)
		}
	}
	for _, tr := range repos {
		if tr.Admin != "" {
			if err := os.RemoveAll(tr.Admin); err != nil {
				return apiErr("failed", "removing %s: %v", tr.Admin, err)
			}
		}
	}
	if w != nil {
		m.mu.Lock()
		names := append([]string(nil), w.names...)
		m.mu.Unlock()
		for _, n := range names {
			removeEmptyUp(t.hostDir(n), t.Root)
		}
	}
	m.mu.Lock()
	t.gone = true
	delete(m.threads, t.ID)
	if m.byKey[t.Key] == t {
		delete(m.byKey, t.Key)
	}
	err := m.save()
	m.mu.Unlock()
	log.Printf("TEARDOWN %s: %d repos", t.ID, len(repos))
	return err
}

// removeEmptyUp removes dir and its empty parents below root.
func removeEmptyUp(dir, root string) {
	for d := dir; d != root && strings.HasPrefix(d, root+"/"); d = filepath.Dir(d) {
		if os.Remove(d) != nil {
			return
		}
	}
}
