package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// work is what a thread holds in one repo that no remote has.
type work struct {
	Head         string       `json:"head,omitempty"`
	HeadOnRemote bool         `json:"headOnRemote"`
	Dirty        int          `json:"dirty"`             // changed, staged or untracked files
	Ignored      int          `json:"ignored,omitempty"` // ignored entries, such as node_modules/
	Commits      int          `json:"commits"`           // git commits only this thread's HEAD or its reflog reaches
	JJCommits    int          `json:"jjCommits"`         // jj commits no ref reaches, besides an empty @
	Branches     []branchWork `json:"branches,omitempty"`
}

type branchWork struct {
	Name    string `json:"name"`
	Commits int    `json:"commits"` // commits on the branch that no remote has
}

// lost reports whether removing the thread's checkout and admin dir would
// lose anything. Branches survive: they live in the mirror's refs/heads.
func (w work) lost() bool { return w.Dirty > 0 || w.Commits > 0 || w.JJCommits > 0 }

// jjOnly selects jj commits that no bookmark, remote bookmark or tag
// reaches, apart from an empty, undescribed working-copy commit.
const jjOnly = `(::visible_heads() ~ ::(bookmarks() | remote_bookmarks() | tags())) ~ (@ & empty() & description(exact:""))`

func countLines(s string) int {
	if strings.TrimSpace(s) == "" {
		return 0
	}
	return len(strings.Split(strings.TrimSpace(s), "\n"))
}

// inspectCheckout reads a checked-out repo without writing to it.
func inspectCheckout(dir string) (work, error) {
	var w work
	cmd := gitCmd(dir, []string{"GIT_OPTIONAL_LOCKS=0"}, "status", "--porcelain=v1", "-z", "--ignored=traditional", "--untracked-files=normal")
	out, err := cmd.Output()
	if err != nil {
		return w, err
	}
	recs := bytes.Split(out, []byte{0})
	for i := 0; i < len(recs); i++ {
		r := recs[i]
		if len(r) < 4 {
			continue
		}
		code, p := string(r[:2]), string(r[3:])
		if code[0] == 'R' || code[0] == 'C' {
			i++ // the rename source follows
		}
		switch {
		case p == ".jj/" || strings.HasPrefix(p, ".jj/"):
		case code == "!!":
			w.Ignored++
		default:
			w.Dirty++
		}
	}
	// Files marked assume-unchanged or skip-worktree hide their edits from
	// status; count them as changed rather than trust them.
	flagged, err := gitCmd(dir, nil, "ls-files", "-v").Output()
	if err != nil {
		return w, err
	}
	for _, l := range strings.Split(string(flagged), "\n") {
		if len(l) > 1 && (l[0] == 'S' || (l[0] >= 'a' && l[0] <= 'z')) {
			w.Dirty++
		}
	}
	st, err := os.Stat(filepath.Join(dir, ".jj", "repo"))
	hasJJ := err == nil && st.IsDir()
	if err := w.inspectHead(dir, nil, !hasJJ); err != nil {
		return w, err
	}
	if hasJJ {
		jj := exec.Command("jj", "log", "--ignore-working-copy", "--no-graph", "--color=never", "-R", dir, "-r", jjOnly, "-T", `commit_id ++ "\n"`)
		jj.Env = append(os.Environ(), noLazyFetch...)
		out, err := jj.Output()
		if err != nil {
			return w, err
		}
		w.JJCommits = countLines(string(out))
		n, err := gitOnlyReflogCommits(dir)
		if err != nil {
			return w, err
		}
		w.Commits += n
	}
	return w, nil
}

// gitOnlyReflogCommits counts commits only the HEAD reflog reaches that
// jj never imported, such as a git commit reset away before any jj command
// ran. Commits jj rewrote are in its store and are not counted.
func gitOnlyReflogCommits(dir string) (int, error) {
	log, err := runGit(dir, nil, "reflog", "show", "--format=%H", "HEAD")
	if err != nil {
		return 0, nil // no reflog
	}
	tips := strings.Fields(log)
	if len(tips) == 0 {
		return 0, nil
	}
	out, err := runGit(dir, nil, append(append([]string{"rev-list"}, tips...), "--not", "HEAD", "--remotes", "--branches", "--tags")...)
	if err != nil {
		return 0, err
	}
	ids := strings.Fields(out)
	if len(ids) == 0 {
		return 0, nil
	}
	unknown := len(ids)
	for len(ids) > 0 {
		batch := ids[:min(len(ids), 100)]
		ids = ids[len(batch):]
		revset := make([]string, len(batch))
		for i, id := range batch {
			revset[i] = "present(" + id + ")"
		}
		jj := exec.Command("jj", "log", "--ignore-working-copy", "--no-graph", "--color=never", "-R", dir,
			"-r", strings.Join(revset, " | "), "-T", `commit_id ++ "\n"`)
		known, err := jj.Output()
		if err != nil {
			return 0, err
		}
		unknown -= countLines(string(known))
	}
	return unknown, nil
}

// inspectAdmin reads the admin dir of a repo the thread has not checked
// out. Its working tree is the view, so only HEAD and the index can differ.
func inspectAdmin(admin string) (work, error) {
	var w work
	env := adminEnv(admin)
	if err := w.inspectHead("", env, true); err != nil {
		return w, err
	}
	out, err := runGit("", env, "diff-index", "--cached", "--name-only", "HEAD")
	if err != nil {
		return w, err
	}
	w.Dirty = countLines(out)
	return w, nil
}

// inspectHead counts commits only HEAD reaches, and with reflog also those
// only its reflog reaches. In a jj checkout jj decides instead: it moves
// HEAD to every commit it later rewrites, so the reflog fills with
// superseded commits that are no one's work.
func (w *work) inspectHead(dir string, env []string, reflog bool) error {
	head, err := runGit(dir, env, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return err
	}
	w.Head = head
	on, err := runGit(dir, env, "for-each-ref", "--contains", "HEAD", "--count=1", "--format=x", "refs/remotes")
	if err != nil {
		return err
	}
	w.HeadOnRemote = on != ""
	// Teardown removes the worktree's HEAD and its reflog, so a commit only
	// those reach (a detached commit, or one reset away) would be lost.
	tips := []string{"HEAD"}
	if log, err := runGit(dir, env, "reflog", "show", "--format=%H", "HEAD"); reflog && err == nil {
		tips = append(tips, strings.Fields(log)...)
	}
	n, err := runGit(dir, env, append(append([]string{"rev-list", "--count"}, tips...), "--not", "--remotes", "--branches", "--tags")...)
	if err != nil {
		return err
	}
	w.Commits, _ = strconv.Atoi(n)
	return nil
}

// unpushedBranches lists the mirror's branches with commits no remote has.
// refs/heads is shared by every thread on the machine.
func unpushedBranches(mirror string) ([]branchWork, error) {
	out, err := runGit(mirror, nil, "for-each-ref", "--format=%(refname)", "refs/heads")
	if err != nil {
		return nil, err
	}
	var bw []branchWork
	for _, ref := range strings.Fields(out) {
		n, err := runGit(mirror, nil, "rev-list", "--count", ref, "--not", "--remotes")
		if err != nil {
			return nil, err
		}
		if c, _ := strconv.Atoi(n); c > 0 {
			bw = append(bw, branchWork{Name: strings.TrimPrefix(ref, "refs/heads/"), Commits: c})
		}
	}
	return bw, nil
}

// follows reports whether a repo's admin dir is still where the daemon put
// it: HEAD detached at the version and nothing staged. Such a thread follows
// the catalog.
func follows(admin, version string) bool {
	head, err := os.ReadFile(filepath.Join(admin, "HEAD"))
	if err != nil || strings.TrimSpace(string(head)) != version {
		return false
	}
	err = gitCmd("", adminEnv(admin), "diff-index", "--cached", "--quiet", version).Run()
	return err == nil
}
