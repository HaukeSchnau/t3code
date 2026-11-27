package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// TestIntegration runs the daemon against a real FUSE mount and thread
// namespaces built the way agent-exec builds them: one holder user
// namespace per thread, and a new bwrap mount namespace per launch. It
// needs /dev/fuse, fusermount3, bwrap, unshare, nsenter, git and jj, so CI
// skips it. Run it with WORLDFS_INTEGRATION=1 go test -run Integration -v.
func TestIntegration(t *testing.T) {
	if os.Getenv("WORLDFS_INTEGRATION") == "" {
		t.Skip("needs FUSE and user namespaces; set WORLDFS_INTEGRATION=1")
	}
	tmp := t.TempDir()
	build := func(rev string) string {
		out := filepath.Join(tmp, "bin", "worldfs-"+rev)
		cmd := exec.Command("go", "build", "-ldflags", "-X main.revision="+rev, "-o", out, ".")
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("build: %v\n%s", err, b)
		}
		return out
	}
	// bin is the Release's command, as infra's unit runs it.
	bin := filepath.Join(tmp, "bin", "worldfs")
	release := func(target string) {
		if err := os.Symlink(target, bin+".new"); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(bin+".new", bin); err != nil {
			t.Fatal(err)
		}
	}
	release(build("a"))
	next := build("b")
	a, b, c, d := "example.com/x/a", "example.com/x/b", "example.com/x/c", "example.com/x/d"
	w := newTestWorld(t, a, b, c, d)
	state := filepath.Join(tmp, "state")
	sock := filepath.Join(tmp, "run", "ctl.sock")
	it := &integ{t: t, bin: bin, cache: w.cache, state: state, sock: sock}
	it.start()
	defer it.stop()

	holder1, holder2 := it.holder(), it.holder()
	t1 := it.register("t1", holder1, filepath.Join(tmp, "t1"))
	t2 := it.register("t2", holder2, filepath.Join(tmp, "t2"))
	view := func(name string) string { return "/world/" + name }

	it.step("A launch in t1 reads the view of every repo without checking anything out")
	out := t1.launch(`ls /world/example.com/x; cat /world/example.com/x/a/README.md; stat -f -c %T /world/example.com/x/a; ls -a /world/example.com/x/a`)
	expect(t, out, "a\nb\nc\nd\n", "# example.com/x/a\n", "fuse\n", ".git")

	it.step("Searches read every .git file and probe .jj; that alone checks nothing out and registers no worktree")
	out = t1.launch(`grep -rn gitdir /world | head -2; rg -c package /world/example.com/x/d; stat -f -c %T /world/example.com/x/d`)
	expect(t, out, "/world/example.com/x/a/.git:1:gitdir: /run/worldfs/admin/example.com/x/a", "fuse\n")
	for _, n := range []string{a, b, c, d} {
		if wts, _ := os.ReadDir(filepath.Join(w.mirror(n), "worktrees")); len(wts) != 0 {
			t.Fatalf("reading the views registered %d worktrees in %s", len(wts), n)
		}
	}

	provider1 := t1.longLived()
	provider2 := t2.longLived()

	it.step("A write in t1 checks a out; the kernel retries it on the checkout")
	out = t1.launch(`echo more >> /world/example.com/x/a/README.md && cat /world/example.com/x/a/README.md && stat -f -c %T /world/example.com/x/a && cd /world/example.com/x/a && git status --porcelain`)
	expect(t, out, "# example.com/x/a\nmore\n", " M README.md")
	notContains(t, out, "fuse")
	it.step("t1's long-lived namespace sees the checkout too; t2 still sees the view")
	expect(t, provider1.run(`cat `+view(a)+`/README.md; stat -f -c %T `+view(a)), "more\n")
	out = provider2.run(`cat ` + view(a) + `/README.md; stat -f -c %T ` + view(a))
	expect(t, out, "fuse\n")
	notContains(t, out, "more")

	it.step("cd into b checks it out on the chdir; the shell lands on the checkout and jj works at once")
	out = t1.launch(`cd /world/example.com/x/b && pwd -P && stat -f -c %T . && ls && jj st --color=never`)
	expect(t, out, "/world/example.com/x/b\n", "README.md", "The working copy has no changes")
	notContains(t, out, "fuse")

	it.step("jj in c finds a colocated repo: the .jj lookup checks out and waits for jj")
	expect(t, t1.launch(`jj -R /world/example.com/x/c st --color=never`), "The working copy has no changes")

	it.step("Past the cap (3 here), a write gets EROFS and the daemon records who was refused")
	out = t1.launchFail(`touch /world/example.com/x/d/README.md`)
	expect(t, out, "Read-only file system")
	it.step("A refused cd stays on the view, where git works from the thread's own worktree and synthetic index")
	out = t1.launch(`cd /world/example.com/x/d && stat -f -c %T . && git status --porcelain && git log --format=%s -1 && ls /run/worldfs/admin/example.com/x`)
	expect(t, out, "fuse\nfirst\n", "d\n")
	st := it.ctl(map[string]any{"method": "status", "thread": "t1"})
	refs, _ := st["refusals"].([]any)
	if len(refs) == 0 || !strings.Contains(fmt.Sprint(refs[0]), "touch[") {
		t.Fatalf("refusals: %v", st["refusals"])
	}

	it.step("The hook's checkout from inside the thread gets a readable refusal, and force overrides it")
	out = t1.launchFail(bin + ` ctl --socket ` + sock + ` '{"method":"checkout","path":"/world/example.com/x/d/src"}'`)
	expect(t, out, `"code":"cap"`, "refused example.com/x/d: 3 repos already checked out in this thread, the cap is 3")
	out = t1.launchFail(bin + ` ctl --socket ` + sock + ` '{"method":"teardown","thread":"t2"}'`)
	expect(t, out, `"code":"forbidden"`)
	out = t1.launch(bin + ` ctl --socket ` + sock + ` '{"method":"checkout","path":"/world/example.com/x/d","force":true}'`)
	expect(t, out, `"ok":true`, `"repo":"example.com/x/d"`)

	it.step("A new upstream commit moves t2's view of a, live and in new launches; t1 keeps its checkout")
	v2 := w.commit(t, a, "README.md", "# a, version 2\n")
	w.writeCatalog(t)
	waitFor(t, func() bool { return strings.Contains(provider2.run(`cat `+view(a)+`/README.md`), "version 2") })
	expect(t, t2.launch(`cat /world/example.com/x/a/README.md; cat /world/example.com/x/a/.git`), "version 2", "gitdir: /run/worldfs/admin/example.com/x/a")
	expect(t, provider1.run(`cat `+view(a)+`/README.md`), "more\n")
	expect(t, t2.launch(`ls /world/example.com/x/a/ >/dev/null; cd /world/example.com/x/a && git log --format=%H -1`), v2)

	it.step("Closing a clean checkout puts the view back in t1's live namespace")
	it.ctl(map[string]any{"method": "close", "thread": "t1", "repo": b})
	expect(t, provider1.run(`stat -f -c %T `+view(b)+`; cat `+view(b)+`/README.md`), "fuse\n", "# example.com/x/b")

	it.step("After kill -9 and a restart, namespaces that held the dead mount read views again")
	it.kill()
	it.start()
	expect(t, provider2.run(`cat `+view(a)+`/README.md; stat -f -c %T `+view(c)+`; git --git-dir=`+view(c)+`/.git log -1 --format=%s`), "version 2", "fuse\n", "first")
	expect(t, provider1.run(`cat `+view(a)+`/README.md; cat `+view(b)+`/README.md`), "more\n", "# example.com/x/b")
	expect(t, t1.launch(`cat /world/example.com/x/b/README.md`), "# example.com/x/b")

	it.step("Status lists unpushed work per thread; teardown refuses while the thread runs or holds work")
	st = it.ctl(map[string]any{"method": "status", "thread": "t1"})
	t.Logf("status t1: %s", compact(st))
	if !strings.Contains(fmt.Sprint(st["repos"]), "lostOnTeardown:true") {
		t.Fatalf("status does not show a's edit: %v", st["repos"])
	}
	res := it.ctlFail(map[string]any{"method": "teardown", "thread": "t1"})
	expect(t, res, "live")
	provider1.stop()
	res = it.ctlFail(map[string]any{"method": "teardown", "thread": "t1"})
	expect(t, res, "work", "example.com/x/a (1 changed files")
	t1.launch(`cd /world/example.com/x/a && git checkout -q README.md && jj st >/dev/null`)
	it.ctl(map[string]any{"method": "teardown", "thread": "t1"})
	for _, n := range []string{a, b, c, d} {
		locks, _ := filepath.Glob(filepath.Join(w.mirror(n), "worktrees", "*", "locked"))
		for _, l := range locks {
			if reason, _ := os.ReadFile(l); strings.Contains(string(reason), "thread t1") {
				t.Errorf("%s keeps t1's worktree %s after teardown", n, filepath.Dir(l))
			}
		}
	}
	stats := map[string]any{"method": "stats"}
	t.Logf("stats: %s", compact(it.ctl(stats)))

	it.step("A new Release's worldfs waits while t2 runs, and t2 keeps reading its views")
	release(next)
	waitFor(t, func() bool { return compact(it.ctl(stats)["upgrade"]) != "null" })
	st = it.ctl(stats)
	expect(t, compact(st), `"revision":"a"`, `"upgrade":{"revision":"b"`, `"waitingFor":["t2"]`)
	expect(t, provider2.run(`cat `+view(a)+`/README.md; stat -f -c %T `+view(c)), "version 2", "fuse\n")

	it.step("Once t2 stops, the daemon runs the new Release in its own process, and the socket answers throughout")
	pid := it.daemon.Process.Pid
	calls, failed, slowest := 0, 0, time.Duration(0)
	stop, stopped := make(chan struct{}), make(chan struct{})
	var stopOnce sync.Once
	stopStats := func() {
		stopOnce.Do(func() { close(stop) })
		<-stopped
	}
	defer stopStats() // before the deferred it.stop, also when a wait below fails
	go func() {
		defer close(stopped)
		for {
			select {
			case <-stop:
				return
			default:
			}
			calls++
			t0 := time.Now()
			if _, err := it.tryCall(stats); err != nil {
				failed++
				t.Logf("stats during the upgrade: %v", err)
			}
			slowest = max(slowest, time.Since(t0))
		}
	}()
	provider2.stop()
	waitFor(t, func() bool { return it.ctl(stats)["revision"] == "b" })
	stopStats()
	if failed > 0 {
		t.Fatalf("%d of %d stats calls failed during the upgrade", failed, calls)
	}
	t.Logf("%d stats calls during the upgrade, none failed; the slowest took %v", calls, slowest)
	if exe, _ := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid)); exe != next {
		t.Fatalf("daemon pid %d runs %s, not %s", pid, exe, next)
	}
	expect(t, compact(it.ctl(stats)), `"revision":"b"`)
	notContains(t, compact(it.ctl(stats)), "upgrade")
	expect(t, t2.launch(`cat /world/example.com/x/a/README.md; stat -f -c %T /world/example.com/x/c`), "version 2", "fuse\n")
}

type integ struct {
	t                       *testing.T
	bin, cache, state, sock string
	daemon                  *exec.Cmd
	log                     *os.File
	holders                 []*exec.Cmd // stopped last, after every launch in them
	launches                []*exec.Cmd
}

func (it *integ) step(s string) { it.t.Logf("=== %s", s) }

func (it *integ) start() {
	it.t.Helper()
	if it.log == nil {
		f, err := os.Create(filepath.Join(filepath.Dir(it.state), "daemon.log"))
		if err != nil {
			it.t.Fatal(err)
		}
		it.log = f
	}
	it.daemon = exec.Command(it.bin, "daemon", "--cache", it.cache, "--state", it.state, "--socket", it.sock,
		"--max-repos", "3", "--poll", "200ms")
	it.daemon.Env = append(os.Environ(), "GOMAXPROCS=4")
	it.daemon.Stdout, it.daemon.Stderr = it.log, it.log
	if err := it.daemon.Start(); err != nil {
		it.t.Fatal(err)
	}
	waitFor(it.t, func() bool {
		c, err := net.Dial("unix", it.sock)
		if err == nil {
			c.Close()
		}
		return err == nil
	})
}

func (it *integ) kill() {
	_ = it.daemon.Process.Signal(syscall.SIGKILL)
	_ = it.daemon.Wait()
}

func (it *integ) stop() {
	for _, l := range it.launches {
		_ = l.Process.Kill()
		_ = l.Wait()
	}
	if it.daemon != nil && it.daemon.ProcessState == nil {
		_ = it.daemon.Process.Signal(syscall.SIGTERM)
		_ = it.daemon.Wait()
	}
	_ = exec.Command("fusermount3", "-u", "-z", filepath.Join(it.state, "mnt", "views")).Run()
	for _, h := range it.holders {
		_ = h.Process.Kill()
		_ = h.Wait()
	}
	if it.log != nil {
		it.log.Close()
		b, _ := os.ReadFile(it.log.Name())
		it.t.Logf("daemon log:\n%s", b)
	}
}

// holder is agent-exec's per-workspace namespace holder.
func (it *integ) holder() int {
	it.t.Helper()
	cmd := exec.Command("unshare", "--user", "--map-current-user", "--pid", "--fork", "--kill-child", "sleep", "infinity")
	if err := cmd.Start(); err != nil {
		it.t.Fatal(err)
	}
	it.holders = append(it.holders, cmd)
	host := nsIno("/proc/self/ns/pid")
	waitFor(it.t, func() bool { return nsIno(fmt.Sprintf("/proc/%d/ns/pid_for_children", cmd.Process.Pid)) != host })
	return cmd.Process.Pid
}

func (it *integ) call(req map[string]any) (map[string]any, bool) {
	it.t.Helper()
	res, err := it.tryCall(req)
	if err != nil {
		it.t.Fatal(err)
	}
	ok, _ := res["ok"].(bool)
	return res, ok
}

func (it *integ) tryCall(req map[string]any) (map[string]any, error) {
	c, err := net.Dial("unix", it.sock)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(10 * time.Second))
	b, _ := json.Marshal(req)
	if _, err := c.Write(append(b, '\n')); err != nil {
		return nil, err
	}
	line, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	var res map[string]any
	return res, json.Unmarshal(line, &res)
}

func (it *integ) ctl(req map[string]any) map[string]any {
	it.t.Helper()
	res, ok := it.call(req)
	if !ok {
		it.t.Fatalf("%v: %v", req, res)
	}
	return res
}

func (it *integ) ctlFail(req map[string]any) string {
	it.t.Helper()
	res, ok := it.call(req)
	if ok {
		it.t.Fatalf("%v succeeded", req)
	}
	it.t.Logf("%s -> %s", req["method"], compact(res["error"]))
	return compact(res["error"])
}

type sandboxThread struct {
	it     *integ
	id     string
	holder int
	binds  []bind
}

func (it *integ) register(id string, holder int, root string) *sandboxThread {
	it.t.Helper()
	res := it.ctl(map[string]any{"method": "register", "thread": id, "world": "w", "root": root, "path": "/world", "pid": holder})
	var binds []bind
	raw, _ := json.Marshal(res["binds"])
	if err := json.Unmarshal(raw, &binds); err != nil {
		it.t.Fatal(err)
	}
	return &sandboxThread{it: it, id: id, holder: holder, binds: binds}
}

// bwrap builds a launch the way agent-exec does: the holder's user and pid
// namespaces, a fresh mount namespace, no host root, and the daemon's binds.
func (s *sandboxThread) bwrap(script string) *exec.Cmd {
	res := s.it.ctl(map[string]any{"method": "binds", "thread": s.id})
	raw, _ := json.Marshal(res["binds"])
	var binds []bind
	_ = json.Unmarshal(raw, &binds)
	args := []string{"--userns", "3", "--pidns", "4", "--die-with-parent", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"}
	for _, p := range []string{"/nix", "/etc", "/run/current-system"} {
		args = append(args, "--ro-bind", p, p)
	}
	args = append(args, "--ro-bind", filepath.Dir(s.it.bin), filepath.Dir(s.it.bin))
	for _, b := range binds {
		flag := "--bind"
		if b.ReadOnly {
			flag = "--ro-bind"
		}
		args = append(args, flag, b.Source, b.Target)
	}
	args = append(args, "--setenv", "HOME", "/tmp", "--chdir", "/", "--", "sh", "-c", script)
	cmd := exec.Command("bwrap", args...)
	u, _ := os.Open(fmt.Sprintf("/proc/%d/ns/user", s.holder))
	p, _ := os.Open(fmt.Sprintf("/proc/%d/ns/pid_for_children", s.holder))
	cmd.ExtraFiles = []*os.File{u, p}
	return cmd
}

func (s *sandboxThread) launch(script string) string {
	s.it.t.Helper()
	out, err := s.bwrap(script).CombinedOutput()
	s.it.t.Logf("[%s] $ %s\n%s", s.id, script, out)
	if err != nil {
		s.it.t.Fatalf("[%s] %v", s.id, err)
	}
	return string(out)
}

func (s *sandboxThread) launchFail(script string) string {
	s.it.t.Helper()
	out, err := s.bwrap(script).CombinedOutput()
	s.it.t.Logf("[%s] $ %s\n%s", s.id, script, out)
	if err == nil {
		s.it.t.Fatalf("[%s] succeeded", s.id)
	}
	return string(out)
}

// longLived is a launch that stays, like a provider process, so the
// daemon has to change mounts in a namespace that already exists.
type longLived struct {
	s   *sandboxThread
	cmd *exec.Cmd
	pid int // a process inside, in the host's pid namespace
}

func (s *sandboxThread) longLived() *longLived {
	s.it.t.Helper()
	cmd := s.bwrap("exec sleep infinity")
	if err := cmd.Start(); err != nil {
		s.it.t.Fatal(err)
	}
	s.it.launches = append(s.it.launches, cmd)
	l := &longLived{s: s, cmd: cmd}
	host := mntnsOf(os.Getpid())
	waitFor(s.it.t, func() bool {
		kids, _ := os.ReadFile(fmt.Sprintf("/proc/%d/task/%d/children", cmd.Process.Pid, cmd.Process.Pid))
		for _, k := range strings.Fields(string(kids)) {
			var pid int
			fmt.Sscan(k, &pid)
			exe, _ := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
			if mntnsOf(pid) != host && (strings.HasSuffix(exe, "/sleep") || strings.HasSuffix(exe, "/coreutils")) {
				l.pid = pid
				return true
			}
		}
		return false
	})
	return l
}

func (l *longLived) run(script string) string {
	l.s.it.t.Helper()
	cmd := exec.Command("nsenter", "--target", fmt.Sprint(l.pid), "--user", "--mount", "--pid", "--root", "--wdns=/",
		"--preserve-credentials", "--", "sh", "-c", script)
	out, _ := cmd.CombinedOutput()
	l.s.it.t.Logf("[%s, long-lived] $ %s\n%s", l.s.id, script, out)
	return string(out)
}

func (l *longLived) stop() {
	_ = l.cmd.Process.Kill()
	_ = l.cmd.Wait()
	waitFor(l.s.it.t, func() bool { _, err := os.Stat(fmt.Sprintf("/proc/%d", l.pid)); return err != nil })
}

func expect(t *testing.T, out string, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(out, w) {
			t.Fatalf("output lacks %q:\n%s", w, out)
		}
	}
}

func notContains(t *testing.T, out, s string) {
	t.Helper()
	if strings.Contains(out, s) {
		t.Fatalf("output has %q:\n%s", s, out)
	}
}

func waitFor(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 200; i++ {
		if ok() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("timed out")
}

func compact(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
