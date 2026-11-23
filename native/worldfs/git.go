package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

// noLazyFetch keeps the daemon's own git commands off the network: a blob
// missing from the blobless mirror is an error, not a fetch per object.
var noLazyFetch = []string{"GIT_NO_LAZY_FETCH=1", "GIT_TERMINAL_PROMPT=0"}

// gitCmd builds a git command. env replaces nothing; it is appended.
func gitCmd(dir string, env []string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(append(os.Environ(), noLazyFetch...), env...)
	return cmd
}

func runGit(dir string, env []string, args ...string) (string, error) {
	cmd := gitCmd(dir, env, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return string(out), fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(string(out)), nil
}

// adminEnv addresses a worktree's admin dir without a working tree.
func adminEnv(admin string) []string { return []string{"GIT_DIR=" + admin} }

// entry is one path in a version's tree.
type entry struct {
	name string
	rel  string
	mode uint32 // git mode: 040000, 100644, 100755, 120000, 160000
	oid  string
	size uint64
	ino  uint64
	kids map[string]*entry
	data []byte // synthetic content (.git); nil for blobs
}

func (e *entry) isDir() bool { return e.mode == 0o40000 || e.mode == 0o160000 }

// tree is a commit's tree, read once from the mirror. It never changes.
type tree struct {
	commit string
	mtime  uint64
	root   *entry
	files  []*entry
	bytes  uint64
	git    *entry // the synthetic .git file at the root
}

func inoFor(parts ...string) uint64 {
	h := fnv.New64a()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	// Keep clear of 1, the FUSE root.
	return h.Sum64() | 1<<63
}

// adminLinkDir is where every thread namespace finds its worktree admin
// links. The .git file of a view names it, so the view's content is the same
// for every thread.
const adminLinkDir = "/run/worldfs/admin"

func loadTree(world, name, mirror, commit string) (*tree, error) {
	ct, err := runGit(mirror, nil, "show", "-s", "--format=%ct", commit)
	if err != nil {
		return nil, err
	}
	t := &tree{commit: commit}
	t.mtime, _ = strconv.ParseUint(ct, 10, 64)
	cmd := gitCmd(mirror, nil, "ls-tree", "-r", "-t", "-l", "-z", "--full-tree", commit)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ls-tree %s %s: %w", name, commit, err)
	}
	t.root = &entry{mode: 0o40000, kids: map[string]*entry{}, ino: inoFor(world, name, commit)}
	dirs := map[string]*entry{"": t.root}
	for _, rec := range bytes.Split(out, []byte{0}) {
		if len(rec) == 0 {
			continue
		}
		tab := bytes.IndexByte(rec, '\t')
		if tab < 0 {
			return nil, fmt.Errorf("ls-tree %s: bad record %q", name, rec)
		}
		meta := strings.Fields(string(rec[:tab]))
		if len(meta) != 4 {
			return nil, fmt.Errorf("ls-tree %s: bad record %q", name, rec)
		}
		path := string(rec[tab+1:])
		mode, _ := strconv.ParseUint(meta[0], 8, 32)
		size, _ := strconv.ParseUint(meta[3], 10, 64) // "-" for trees and gitlinks
		parent, base := "", path
		if i := strings.LastIndexByte(path, '/'); i >= 0 {
			parent, base = path[:i], path[i+1:]
		}
		e := &entry{name: base, rel: path, mode: uint32(mode), oid: meta[2], size: size, ino: inoFor(world, name, commit, path)}
		if e.isDir() {
			e.kids = map[string]*entry{}
			if e.mode == 0o40000 {
				dirs[path] = e
			}
		}
		if e.mode != 0o40000 {
			t.files = append(t.files, e)
			t.bytes += size
		}
		p := dirs[parent]
		if p == nil {
			return nil, fmt.Errorf("ls-tree %s: %q before its directory", name, path)
		}
		p.kids[base] = e
	}
	d := []byte("gitdir: " + adminLinkDir + "/" + name + "\n")
	t.git = &entry{name: ".git", rel: ".git", mode: 0o100644, size: uint64(len(d)), ino: inoFor(world, name, commit, ".git"), data: d}
	return t, nil
}

// indexEntry is one entry of a version-2 git index: the stat data git
// compares before it trusts a file without reading it.
type indexEntry struct {
	rel                            string
	mode                           uint32
	oid                            string
	ctime, ctimeNs, mtime, mtimeNs uint32
	dev, ino, uid, gid, size       uint32
}

// writeIndex writes an index whose stat data equals what the view reports
// for each file, so git status on the view is clean without reading a
// single blob.
func (t *tree) writeIndex(path string) error { return writeIndexFile(path, t.viewIndex()) }

func writeIndexFile(path string, entries []indexEntry) error {
	b, err := indexBytes(entries)
	if err != nil {
		return err
	}
	tmp := path + ".worldfs"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func indexBytes(entries []indexEntry) ([]byte, error) {
	sort.Slice(entries, func(i, j int) bool { return entries[i].rel < entries[j].rel })
	var buf bytes.Buffer
	buf.WriteString("DIRC")
	be := func(v any) { _ = binary.Write(&buf, binary.BigEndian, v) }
	be(uint32(2))
	be(uint32(len(entries)))
	for _, e := range entries {
		start := buf.Len()
		for _, v := range []uint32{e.ctime, e.ctimeNs, e.mtime, e.mtimeNs, e.dev, e.ino, e.mode, e.uid, e.gid, e.size} {
			be(v)
		}
		oid, err := hex.DecodeString(e.oid)
		if err != nil || len(oid) != 20 {
			return nil, fmt.Errorf("index: %s has object id %q", e.rel, e.oid)
		}
		buf.Write(oid)
		be(uint16(min(len(e.rel), 0xfff)))
		buf.WriteString(e.rel)
		buf.Write(make([]byte, 8-(buf.Len()-start)%8))
	}
	sum := sha1.Sum(buf.Bytes())
	buf.Write(sum[:])
	return buf.Bytes(), nil
}

// viewIndex is the index a view's tree stands for, see writeIndex.
func (t *tree) viewIndex() []indexEntry {
	uid, gid := uint32(os.Getuid()), uint32(os.Getgid())
	ts := uint32(t.mtime)
	entries := make([]indexEntry, 0, len(t.files))
	for _, e := range t.files {
		size := uint32(e.size)
		if e.mode == 0o160000 {
			size = 0
		}
		entries = append(entries, indexEntry{rel: e.rel, mode: e.mode, oid: e.oid,
			ctime: ts, mtime: ts, ino: uint32(e.ino), uid: uid, gid: gid, size: size})
	}
	return entries
}

// cats is one `git cat-file --batch` process for a mirror, started on the
// first read and stopped when idle. Reads take turns; each is one pipe
// round trip.
type cats struct {
	mirror string
	mu     sync.Mutex
	cmd    *exec.Cmd
	in     io.WriteCloser
	out    *bufio.Reader
	last   time.Time
}

func (p *cats) start() error {
	cmd := gitCmd(p.mirror, nil, "cat-file", "--batch")
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	outp, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	p.cmd, p.in, p.out = cmd, in, bufio.NewReaderSize(outp, 1<<16)
	return nil
}

// stop ends the process. Callers hold p.mu.
func (p *cats) stop() {
	if p.cmd != nil {
		p.in.Close()
		_ = p.cmd.Wait()
		p.cmd = nil
	}
}

// reapIdle stops the process once no blob was read for d.
func (p *cats) reapIdle(d time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if time.Since(p.last) >= d {
		p.stop()
	}
}

var errMissing = errors.New("object missing from the machine cache")

func (p *cats) blob(oid string) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.last = time.Now()
	if p.cmd == nil {
		if err := p.start(); err != nil {
			return nil, err
		}
	}
	broken := func(err error) ([]byte, error) {
		p.stop() // the stream is out of step
		return nil, err
	}
	if _, err := io.WriteString(p.in, oid+"\n"); err != nil {
		return broken(err)
	}
	hdr, err := p.out.ReadString('\n')
	if err != nil {
		return broken(err)
	}
	f := strings.Fields(hdr)
	if len(f) == 2 && f[1] == "missing" {
		return nil, errMissing
	}
	if len(f) != 3 {
		return broken(fmt.Errorf("cat-file: %q", hdr))
	}
	n, err := strconv.Atoi(f[2])
	if err != nil {
		return broken(fmt.Errorf("cat-file: %q", hdr))
	}
	data := make([]byte, n+1)
	if _, err := io.ReadFull(p.out, data); err != nil {
		return broken(err)
	}
	return data[:n], nil
}

// stampCheckout sets every checked-out file's mtime to the commit's time
// and rewrites the index from their real stat data. read-tree writes the
// files and the index within the same second, so git would otherwise treat
// every entry as racily clean and rehash the whole tree on the first
// status: 3.6 s for t3code.
func stampCheckout(dir, admin, index string, commitTime int64) error {
	out, err := gitCmd(dir, []string{"GIT_DIR=" + admin, "GIT_INDEX_FILE=" + index}, "ls-files", "-s", "-z").Output()
	if err != nil {
		return fmt.Errorf("ls-files: %w", err)
	}
	ts := unix.NsecToTimespec(commitTime * int64(time.Second))
	var entries []indexEntry
	for _, rec := range bytes.Split(out, []byte{0}) {
		if len(rec) == 0 {
			continue
		}
		tab := bytes.IndexByte(rec, '\t')
		if tab < 0 {
			return fmt.Errorf("ls-files: unexpected entry %q", rec)
		}
		f := strings.Fields(string(rec[:tab]))
		if len(f) != 3 || f[2] != "0" {
			return fmt.Errorf("ls-files: unexpected entry %q", rec)
		}
		mode, _ := strconv.ParseUint(f[0], 8, 32)
		e := indexEntry{rel: string(rec[tab+1:]), mode: uint32(mode), oid: f[1]}
		if e.mode != 0o160000 {
			p := filepath.Join(dir, e.rel)
			if err := unix.UtimesNanoAt(unix.AT_FDCWD, p, []unix.Timespec{ts, ts}, unix.AT_SYMLINK_NOFOLLOW); err != nil {
				return err
			}
			var st unix.Stat_t
			if err := unix.Lstat(p, &st); err != nil {
				return err
			}
			e.ctime, e.ctimeNs = uint32(st.Ctim.Sec), uint32(st.Ctim.Nsec)
			e.mtime, e.mtimeNs = uint32(st.Mtim.Sec), uint32(st.Mtim.Nsec)
			e.dev, e.ino, e.uid, e.gid, e.size = uint32(st.Dev), uint32(st.Ino), st.Uid, st.Gid, uint32(st.Size)
		}
		entries = append(entries, e)
	}
	return writeIndexFile(index, entries)
}
