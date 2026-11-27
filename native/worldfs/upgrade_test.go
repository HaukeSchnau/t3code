package main

import (
	"bufio"
	"errors"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestUpgradeWaitsUntilNoThreadRuns(t *testing.T) {
	w := newTestWorld(t, "example.com/x/a")
	m, ns := newTestMachine(t, w, defaultPolicy)
	m.hostMnt = mntnsOf(os.Getpid())
	th := registerThread(t, m, "t1", 101)
	m.release = filepath.Join(t.TempDir(), "worldfs")
	write(t, m.release, "#!/bin/sh\necho next\n")
	if err := os.Chmod(m.release, 0o755); err != nil {
		t.Fatal(err)
	}
	l, err := listen(m.socket)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	m.listener = l
	m.peerTimeout = 100 * time.Millisecond
	m.startServing()
	var execs [][]string
	m.exec = func(path string, argv, env []string) error {
		execs = append(execs, append([]string{path}, env...))
		return errors.New("no exec in tests")
	}
	pending := func() *pendingUpgrade {
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.upgrade
	}

	ns.alive = true
	m.followRelease()
	if u := pending(); len(execs) != 0 || u == nil || u.Revision != "next" || !slices.Equal(u.WaitingFor, []string{"t1"}) {
		t.Fatalf("with t1 running: execs %v, upgrade %+v", execs, u)
	}

	ns.alive = false
	m.launching(th)
	m.followRelease()
	if u := pending(); len(execs) != 0 || !slices.Equal(u.WaitingFor, []string{"t1"}) {
		t.Fatalf("with t1 launching: execs %v, upgrade %+v", execs, u)
	}

	// A caller that connects and never sends its line doesn't hold the upgrade off.
	silent, err := net.Dial("unix", m.socket)
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	stats(t, m.socket) // accepted after the silent one, so its handler is reading
	m.mu.Lock()
	th.launched = time.Now().Add(-launchGrace)
	m.mu.Unlock()
	m.followRelease()
	if len(execs) != 1 || execs[0][0] != m.release || !slices.ContainsFunc(execs[0], func(e string) bool { return strings.HasPrefix(e, listenFDEnv+"=") }) {
		t.Fatalf("once nothing runs: execs %v", execs)
	}

	// The exec failed, so the daemon serves on.
	if line := stats(t, m.socket); !strings.Contains(line, `"revision":"dev"`) || !strings.Contains(line, `"upgrade":{"revision":"next"`) {
		t.Fatalf("stats after a failed exec: %q", line)
	}
}

func stats(t *testing.T, socket string) string {
	t.Helper()
	c, err := net.Dial("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte(`{"method":"stats"}` + "\n"))
	line, err := bufio.NewReader(c).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	return line
}
