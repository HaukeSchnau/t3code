// worldfs serves fleet worlds on one Linux machine: a read-only view of
// every repo in the machine cache, and a checkout per thread on first
// write or chdir. See README.md.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  worldfs daemon --cache DIR --state DIR [--socket PATH] [policy flags]
  worldfs ctl [--socket PATH] JSON     send one request to the daemon
  worldfs version                      print the revision`)
	os.Exit(2)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "daemon":
		daemon(os.Args[2:])
	case "ctl":
		fl := flag.NewFlagSet("ctl", flag.ExitOnError)
		socket := fl.String("socket", defaultSocket(), "control socket")
		_ = fl.Parse(os.Args[2:])
		if fl.NArg() != 1 {
			usage()
		}
		os.Exit(ctlClient(*socket, []byte(fl.Arg(0))))
	case "version":
		fmt.Println(revision)
	case "ns-mount":
		// Internal: runs inside a thread namespace, see ns.go.
		if err := nsMount(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	default:
		usage()
	}
}

func daemon(args []string) {
	fl := flag.NewFlagSet("daemon", flag.ExitOnError)
	cache := fl.String("cache", "", "the machine cache: <cache>/<world>/catalog.json and the mirrors")
	state := fl.String("state", "", "the daemon's state: state.json and mnt/views")
	socket := fl.String("socket", defaultSocket(), "control socket")
	p := defaultPolicy
	fl.IntVar(&p.Free, "free", p.Free, "checkouts per thread that never wait")
	fl.IntVar(&p.PerWindow, "per-minute", p.PerWindow, "checkouts per minute past the free ones")
	fl.IntVar(&p.MaxRepos, "max-repos", p.MaxRepos, "checked-out repos per thread past which checkouts are refused")
	maxGB := fl.Float64("max-gb", float64(p.MaxBytes)/(1<<30), "checked-out size per thread past which checkouts are refused")
	fl.DurationVar(&p.Idle, "idle", p.Idle, "close clean checkouts unchanged this long")
	poll := fl.Duration("poll", 30*time.Second, "how often to look for changed catalogs")
	_ = fl.Parse(args)
	if *cache == "" || *state == "" {
		usage()
	}
	p.MaxBytes = uint64(*maxGB * (1 << 30))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	self, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	hostMnt := mntnsOf(os.Getpid())
	m := newMachine(*cache, *state, *socket, p, realNS{nsHelper{self: self, hostMnt: hostMnt}})
	m.hostMnt = hostMnt
	m.release = releaseCommand(os.Args[0])
	for _, d := range []string{*state, filepath.Dir(*socket)} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			log.Fatal(err)
		}
	}
	// Callers of an upgrading daemon wait in its listener's backlog. A
	// fresh daemon opens the socket once it is ready.
	if m.listener, err = inheritedListener(*socket); err != nil {
		log.Fatal(err)
	}
	if err := m.load(); err != nil {
		log.Fatal(err)
	}
	m.refreshCatalogs()

	// A previous daemon's mount is dead; its namespaces copies are replaced below.
	_ = exec.Command("fusermount3", "-u", "-z", m.views).Run()
	if _, err := m.mountViews(); err != nil {
		log.Fatalf("mount %s: %v", m.views, err)
	}
	var st unix.Stat_t
	if err := unix.Stat(m.views, &st); err != nil {
		log.Fatal(err)
	}
	m.live = fmt.Sprintf("%d:%d", unix.Major(st.Dev), unix.Minor(st.Dev))
	m.recover()
	m.catchUp()
	m.mu.Lock()
	threads := make([]*thread, 0, len(m.threads))
	for _, t := range m.threads {
		threads = append(threads, t)
	}
	m.mu.Unlock()
	for _, t := range threads {
		m.sync(t)
	}

	if m.listener == nil {
		if m.listener, err = listen(*socket); err != nil {
			log.Fatal(err)
		}
	}
	m.startServing()
	log.Printf("worldfs %s: %d worlds, %d threads, views at %s, socket %s", revision, len(m.worlds), len(threads), m.views, *socket)

	go func() {
		for range time.Tick(*poll) {
			m.periodic.Lock()
			for w, names := range m.refreshCatalogs() {
				log.Printf("catalog %s: %d repos moved", w, len(names))
				m.advance(w, names)
			}
			m.followRelease()
			m.periodic.Unlock()
		}
	}()
	go func() {
		for range time.Tick(time.Minute) {
			m.periodic.Lock()
			m.closeIdle()
			m.dropUnused()
			m.periodic.Unlock()
		}
	}()
	go func() {
		for range time.Tick(10 * time.Second) {
			m.mu.Lock()
			var all []*repo
			for _, w := range m.worlds {
				for _, r := range w.repos {
					all = append(all, r)
				}
			}
			m.mu.Unlock()
			for _, r := range all {
				r.cats.reapIdle(30 * time.Second)
			}
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	m.listener.Close()
	// Lazily: thread namespaces still hold binds, and the next daemon
	// replaces them (see recover and sync).
	if err := exec.Command("fusermount3", "-u", "-z", m.views).Run(); err != nil {
		log.Printf("unmount %s: %v", m.views, err)
	}
	log.Printf("stopped")
}
