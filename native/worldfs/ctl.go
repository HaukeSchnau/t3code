package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// apiError is a refusal or failure the control socket returns as is.
// Message is meant for people: T3 and the hook show it unchanged.
type apiError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string { return e.Message }

func apiErr(code, format string, a ...any) error {
	return &apiError{Code: code, Message: fmt.Sprintf(format, a...)}
}

// request is every method's parameters; each method reads what it needs.
type request struct {
	Method string `json:"method"`
	registerReq
	Repo  string `json:"repo"`
	Force bool   `json:"force"`
}

func (m *machine) serve(l *net.UnixListener) {
	for {
		c, err := l.AcceptUnix()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			log.Printf("accept: %v", err)
			continue
		}
		go m.handle(c)
	}
}

func peerPid(c *net.UnixConn) int {
	raw, err := c.SyscallConn()
	if err != nil {
		return 0
	}
	pid := 0
	_ = raw.Control(func(fd uintptr) {
		if cred, err := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED); err == nil {
			pid = int(cred.Pid)
		}
	})
	return pid
}

func (m *machine) handle(c *net.UnixConn) {
	defer c.Close()
	line, err := bufio.NewReaderSize(c, 64<<10).ReadBytes('\n')
	if err != nil && len(line) == 0 {
		return
	}
	var req request
	var res any
	pid := peerPid(c)
	if err := json.Unmarshal(line, &req); err != nil {
		err = apiErr("invalid", "request is not JSON: %v", err)
		res = failure(err)
	} else if err := m.scope(&req, pid); err != nil {
		res = failure(err)
	} else if out, err := m.call(req, pid); err != nil {
		res = failure(err)
	} else {
		res = out
	}
	b, _ := json.Marshal(res)
	_, _ = c.Write(append(b, '\n'))
}

func failure(err error) map[string]any {
	var ae *apiError
	if !errors.As(err, &ae) {
		ae = &apiError{Code: "failed", Message: err.Error()}
	}
	return map[string]any{"ok": false, "error": ae}
}

type okResult map[string]any

func (m *machine) thread(id string, pid int) (*thread, error) {
	if id == "" {
		if t := m.threadOfPid(pid); t != nil {
			return t, nil
		}
		return nil, apiErr("not-in-thread", "%s is not in a thread world", procName(pid))
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if t := m.threads[id]; t != nil {
		return t, nil
	}
	return nil, apiErr("unknown-thread", "no thread %s on this machine", id)
}

// scope limits a caller inside a mount namespace other than the daemon's,
// such as an agent's hook, to its own thread and to the methods a thread
// needs. register, binds and teardown belong to the host's launcher and T3.
func (m *machine) scope(req *request, pid int) error {
	if pid <= 0 {
		return apiErr("forbidden", "the caller's credentials are unknown")
	}
	if mntnsOf(pid) == m.hostMnt {
		return nil
	}
	switch req.Method {
	case "checkout", "status", "close", "sync", "stats":
	default:
		return apiErr("forbidden", "%s is only for the host, not from inside a thread", req.Method)
	}
	t := m.threadOfPid(pid)
	if t == nil {
		return apiErr("not-in-thread", "%s is not in a thread world", procName(pid))
	}
	if req.Thread != "" && req.Thread != t.ID {
		return apiErr("forbidden", "%s may only act on its own thread", procName(pid))
	}
	req.Thread = t.ID
	return nil
}

func (m *machine) call(req request, pid int) (okResult, error) {
	switch req.Method {
	case "register":
		t, err := m.register(req.registerReq)
		if err != nil {
			return nil, err
		}
		return okResult{"ok": true, "thread": t.ID, "binds": m.binds(t), "socket": m.socket}, nil
	case "binds":
		t, err := m.thread(req.Thread, pid)
		if err != nil {
			return nil, err
		}
		return okResult{"ok": true, "binds": m.binds(t)}, nil
	case "checkout":
		return m.ctlCheckout(req, pid)
	case "status":
		t, err := m.thread(req.Thread, pid)
		if err != nil {
			return nil, err
		}
		return m.status(t), nil
	case "close":
		t, err := m.thread(req.Thread, pid)
		if err != nil {
			return nil, err
		}
		r := m.repo(t.World, req.Repo)
		if r == nil {
			return nil, apiErr("unknown-repo", "no repo %s in world %s", req.Repo, t.World)
		}
		if err := m.close(t, r, false); err != nil {
			return nil, err
		}
		return okResult{"ok": true, "repo": r.name}, nil
	case "teardown":
		t, err := m.thread(req.Thread, pid)
		if err != nil {
			return nil, err
		}
		if err := m.teardown(t); err != nil {
			return nil, err
		}
		return okResult{"ok": true}, nil
	case "sync":
		// A launch calls this from its new namespace before it starts
		// the command, so a checkout or catalog change that raced the
		// launch's binds is applied to it too.
		t, err := m.thread(req.Thread, pid)
		if err != nil {
			return nil, err
		}
		if errs := m.sync(t); len(errs) > 0 {
			return nil, apiErr("failed", "%v", errors.Join(errs...))
		}
		return okResult{"ok": true}, nil
	case "stats":
		return m.stats(), nil
	}
	return nil, apiErr("invalid", "unknown method %q", req.Method)
}

func (m *machine) ctlCheckout(req request, pid int) (okResult, error) {
	t, err := m.thread(req.Thread, pid)
	if err != nil {
		return nil, err
	}
	name := req.Repo
	if name == "" {
		in, inWorld := m.repoAt(t, req.Path)
		if !inWorld {
			return nil, apiErr("outside", "%s is outside the world at %s", req.Path, t.Path)
		}
		if in == "" {
			return nil, apiErr("outside", "%s is in the world but in no repo", req.Path)
		}
		name = in
	}
	r := m.repo(t.World, name)
	if r == nil {
		return nil, apiErr("unknown-repo", "no repo %s in world %s", name, t.World)
	}
	t0 := time.Now()
	why := "ctl checkout"
	if req.Force {
		why = "ctl checkout --force"
	}
	if err := m.checkout(t, r, procName(pid), why, req.Force); err != nil {
		return nil, err
	}
	m.waitJJ(t, name)
	return okResult{"ok": true, "repo": name, "dir": t.target(name), "ms": time.Since(t0).Milliseconds()}, nil
}

type repoStatus struct {
	Repo      string `json:"repo"`
	Dir       string `json:"dir"`
	State     string `json:"state"` // view or checked-out
	Version   string `json:"version"`
	Following bool   `json:"following"`
	work
	LostOnTeardown bool   `json:"lostOnTeardown"`
	Error          string `json:"error,omitempty"`
}

// status reports each repo the thread touched and what it holds that no
// remote has, across checkouts, admin dirs and the mirrors' branches.
func (m *machine) status(t *thread) okResult {
	m.mu.Lock()
	type item struct {
		name, version, admin string
		phase                phase
		pinned               bool
		r                    *repo
	}
	var items []item
	w := m.worlds[t.World]
	for n, tr := range t.Repos {
		var r *repo
		if w != nil {
			r = w.repos[n]
		}
		items = append(items, item{n, tr.Version, tr.Admin, tr.Phase, tr.Pinned, r})
	}
	count, bytes := t.usage()
	refusals := append([]refusal(nil), t.Refusals...)
	m.mu.Unlock()
	sort.Slice(items, func(i, j int) bool { return items[i].name < items[j].name })
	var repos []repoStatus
	for _, it := range items {
		s := repoStatus{Repo: it.name, Dir: t.target(it.name), Version: it.version, State: "view"}
		var err error
		if it.phase == phaseView {
			s.work, err = inspectAdmin(it.admin)
			s.Following = err == nil && !it.pinned && follows(it.admin, it.version)
		} else {
			s.State = "checked-out"
			s.work, err = inspectCheckout(t.hostDir(it.name))
		}
		if err == nil && it.r != nil {
			s.Branches, err = unpushedBranches(it.r.mirror)
		}
		if err != nil {
			s.Error = err.Error()
		}
		s.LostOnTeardown = s.lost() || err != nil
		repos = append(repos, s)
	}
	return okResult{
		"ok": true, "thread": t.ID, "world": t.World, "path": t.Path,
		"checkedOut": count, "bytes": bytes,
		"cap":      map[string]any{"free": m.policy.Free, "perMinute": m.policy.PerWindow, "maxRepos": m.policy.MaxRepos, "maxBytes": m.policy.MaxBytes},
		"repos":    repos,
		"refusals": refusals,
	}
}

func (m *machine) stats() okResult {
	status, _ := os.ReadFile("/proc/self/status")
	var rss, threads string
	for _, l := range strings.Split(string(status), "\n") {
		if v, ok := strings.CutPrefix(l, "VmRSS:"); ok {
			rss = strings.TrimSpace(v)
		}
		if v, ok := strings.CutPrefix(l, "Threads:"); ok {
			threads = strings.TrimSpace(v)
		}
	}
	fds, _ := os.ReadDir("/proc/self/fd")
	m.mu.Lock()
	defer m.mu.Unlock()
	views := 0
	for _, w := range m.worlds {
		views += len(w.names)
	}
	return okResult{"ok": true, "worlds": len(m.worlds), "repos": views, "threads": len(m.threads),
		"rss": rss, "osThreads": threads, "goroutines": runtime.NumGoroutine(), "fds": len(fds)}
}

// defaultSocket follows systemd's RuntimeDirectory=worldfs.
func defaultSocket() string {
	if d := os.Getenv("RUNTIME_DIRECTORY"); d != "" {
		return filepath.Join(strings.Split(d, ":")[0], "ctl.sock")
	}
	return filepath.Join(os.Getenv("XDG_RUNTIME_DIR"), "worldfs", "ctl.sock")
}

// ctlClient sends one request and prints the response. Exit status 2
// means the daemon refused.
func ctlClient(socket string, body []byte) int {
	c, err := net.Dial("unix", socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	defer c.Close()
	if _, err := c.Write(append(body, '\n')); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	out, err := bufio.NewReader(c).ReadBytes('\n')
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	os.Stdout.Write(out)
	var res struct {
		OK bool `json:"ok"`
	}
	if json.Unmarshal(out, &res) != nil || !res.OK {
		return 2
	}
	return 0
}
