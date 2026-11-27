package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// A restart cuts every live thread namespace off its views until the new
// daemon has rebound them, and breaks files processes hold open there. So
// the daemon follows its Release by itself instead: once the command it was
// started as reports another revision and no thread runs, it executes that
// command in its own process. The control socket's listener survives the
// exec, so a launch that connects meanwhile waits instead of failing.

// revision identifies the daemon's source; nix/worldfs.nix sets it.
var revision = "dev"

// listenFDEnv passes the control socket's listener across an upgrade.
const listenFDEnv = "WORLDFS_LISTEN_FD"

// launchGrace keeps a thread busy after register or binds, until its
// launch has had time to create the namespace that makes it live.
const launchGrace = time.Minute

type pendingUpgrade struct {
	Revision string    `json:"revision"`
	Since    time.Time `json:"since"`
	// WaitingFor names the threads that run, or are launching, now.
	WaitingFor []string `json:"waitingFor"`
}

// releaseCommand is the command a new Release replaces: the path the daemon
// was started as, such as the Release's bin/worldfs.
func releaseCommand(arg0 string) string {
	if !strings.Contains(arg0, "/") {
		if p, err := exec.LookPath(arg0); err == nil {
			return p
		}
	}
	p, _ := filepath.Abs(arg0)
	return p
}

// releaseRevision asks the release command for its revision, again only
// when it resolves to another file.
func (m *machine) releaseRevision() (string, error) {
	resolved, err := filepath.EvalSymlinks(m.release)
	if err != nil {
		return "", err
	}
	if resolved == m.releaseSeen {
		return m.releaseRev, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, resolved, "version").Output()
	if err != nil {
		return "", fmt.Errorf("%s version: %w", resolved, err)
	}
	m.releaseSeen, m.releaseRev = resolved, strings.TrimSpace(string(out))
	return m.releaseRev, nil
}

// busyThreads lists the threads with a live namespace or a launch underway.
func (m *machine) busyThreads() []string {
	type candidate struct {
		id       string
		key      uint64
		launched time.Time
	}
	m.mu.Lock()
	all := make([]candidate, 0, len(m.threads))
	for _, t := range m.threads {
		all = append(all, candidate{t.ID, t.Key, t.launched})
	}
	m.mu.Unlock()
	var busy []string
	for _, c := range all {
		if time.Since(c.launched) < launchGrace || (c.key != 0 && m.ns.live(c.key)) {
			busy = append(busy, c.id)
		}
	}
	sort.Strings(busy)
	return busy
}

// followRelease upgrades the daemon to the release command's revision once
// no thread is busy. The catalog poll calls it, so no refresh runs at once.
func (m *machine) followRelease() {
	rev, err := m.releaseRevision()
	if err != nil {
		if err.Error() != m.releaseErr {
			log.Printf("release: %v", err)
		}
		m.releaseErr = err.Error()
		return
	}
	m.releaseErr = ""
	if rev == "" || rev == revision {
		m.mu.Lock()
		m.upgrade = nil
		m.mu.Unlock()
		return
	}
	busy := m.busyThreads()
	m.mu.Lock()
	if m.upgrade == nil || m.upgrade.Revision != rev {
		m.upgrade = &pendingUpgrade{Revision: rev, Since: time.Now().UTC().Truncate(time.Second)}
		log.Printf("UPGRADE pending: %s ships revision %s, this daemon runs %s", m.release, rev, revision)
	}
	m.upgrade.WaitingFor = busy
	m.mu.Unlock()
	if len(busy) == 0 {
		m.reexec(rev)
	}
}

func (m *machine) waitFor(busy []string) {
	m.mu.Lock()
	if m.upgrade != nil {
		m.upgrade.WaitingFor = busy
	}
	m.mu.Unlock()
}

// reexec stops taking requests, waits for those in flight and for jj, and
// executes the release command with the listener. If a thread became busy
// meanwhile or the exec fails, the daemon serves on.
func (m *machine) reexec(rev string) {
	_ = m.listener.SetDeadline(time.Now())
	<-m.serving
	m.handlers.Wait()
	m.bg.Wait()
	resume := func() {
		_ = m.listener.SetDeadline(time.Time{})
		m.startServing()
	}
	if busy := m.busyThreads(); len(busy) > 0 {
		m.waitFor(busy)
		resume()
		return
	}
	// git cat-file would outlive the exec as a child nobody reaps.
	m.mu.Lock()
	for _, w := range m.worlds {
		for _, r := range w.repos {
			r.cats.reapIdle(0)
		}
	}
	m.mu.Unlock()
	// The Release may have moved on while requests drained.
	if now, err := m.releaseRevision(); err != nil || now != rev {
		resume()
		return
	}
	// Not f.Fd(): it would turn the listener's shared file description
	// blocking, and a failed exec would leave Accept deaf to deadlines.
	fd := -1
	f, err := m.listener.File()
	if err == nil {
		var raw syscall.RawConn
		if raw, err = f.SyscallConn(); err == nil {
			cerr := raw.Control(func(u uintptr) {
				fd = int(u)
				_, err = unix.FcntlInt(u, unix.F_SETFD, 0)
			})
			err = errors.Join(err, cerr)
		}
	}
	if err != nil {
		log.Printf("UPGRADE to %s: keeping the listener: %v", rev, err)
		if f != nil {
			f.Close()
		}
		resume()
		return
	}
	env := []string{listenFDEnv + "=" + strconv.Itoa(fd)}
	for _, e := range os.Environ() {
		if !strings.HasPrefix(e, listenFDEnv+"=") {
			env = append(env, e)
		}
	}
	log.Printf("UPGRADE to %s: no thread runs, executing %s", rev, m.release)
	err = m.exec(m.release, os.Args, env)
	log.Printf("UPGRADE to %s: %v", rev, err)
	f.Close()
	resume()
}

// inheritedListener takes the listener an upgrading daemon passed on, if
// any. It isn't close-on-exec until then, so the daemon takes it before it
// starts a child.
func inheritedListener(socket string) (*net.UnixListener, error) {
	v := os.Getenv(listenFDEnv)
	if v == "" {
		return nil, nil
	}
	os.Unsetenv(listenFDEnv)
	fd, err := strconv.Atoi(v)
	if err != nil {
		return nil, fmt.Errorf("%s=%q", listenFDEnv, v)
	}
	f := os.NewFile(uintptr(fd), socket)
	defer f.Close()
	l, err := net.FileListener(f)
	if err != nil {
		return nil, err
	}
	ul, ok := l.(*net.UnixListener)
	if !ok {
		l.Close()
		return nil, fmt.Errorf("%s: fd %d is not a unix socket", listenFDEnv, fd)
	}
	return ul, nil
}

func listen(socket string) (*net.UnixListener, error) {
	_ = os.Remove(socket)
	return net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
}
