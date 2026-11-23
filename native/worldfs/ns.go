package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// A thread is identified by the user namespace that owns its processes'
// mount namespaces. agent-exec starts every command in a new mount
// namespace inside one holder user namespace per workspace, so all of a
// thread's launches share that owner. Processes in nested user namespaces
// (bwrap adds one) still map to it, and none of them can change their own
// mounts; the daemon can, from the owner.

func nsIno(link string) uint64 {
	l, err := os.Readlink(link)
	if err != nil {
		return 0
	}
	i := strings.IndexByte(l, '[')
	if i < 0 || !strings.HasSuffix(l, "]") {
		return 0
	}
	n, _ := strconv.ParseUint(l[i+1:len(l)-1], 10, 64)
	return n
}

func mntnsOf(pid int) uint64 { return nsIno(fmt.Sprintf("/proc/%d/ns/mnt", pid)) }

// ownerOf opens the user namespace that owns pid's mount namespace.
func ownerOf(pid int) (*os.File, uint64, error) {
	f, err := os.Open(fmt.Sprintf("/proc/%d/ns/mnt", pid))
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	fd, err := unix.IoctlRetInt(int(f.Fd()), unix.NS_GET_USERNS)
	if err != nil {
		return nil, 0, fmt.Errorf("NS_GET_USERNS: %w", err)
	}
	u := os.NewFile(uintptr(fd), "userns")
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		u.Close()
		return nil, 0, err
	}
	return u, st.Ino, nil
}

// keyOf is the thread key for a process: the owner of its mount namespace,
// or, for a process still in the host's mount namespace (agent-exec's
// holder), its own user namespace.
func keyOf(pid int, hostMnt uint64) (uint64, error) {
	if mntnsOf(pid) == hostMnt {
		if k := nsIno(fmt.Sprintf("/proc/%d/ns/user", pid)); k != 0 {
			return k, nil
		}
		return 0, fmt.Errorf("process %d is gone", pid)
	}
	u, k, err := ownerOf(pid)
	if err != nil {
		return 0, err
	}
	u.Close()
	return k, nil
}

// namespace is one mount namespace of a thread and a process inside it.
type namespace struct {
	mnt uint64
	pid int
}

// threadNamespaces finds every live mount namespace owned by key.
func threadNamespaces(key, hostMnt uint64) []namespace {
	ents, _ := os.ReadDir("/proc")
	seen := map[uint64]bool{hostMnt: true}
	var out []namespace
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		m := mntnsOf(pid)
		if m == 0 || seen[m] {
			continue
		}
		seen[m] = true
		u, k, err := ownerOf(pid)
		if err != nil {
			continue
		}
		u.Close()
		if k == key {
			out = append(out, namespace{mnt: m, pid: pid})
		}
	}
	return out
}

// mount is one line of /proc/<pid>/mountinfo.
type mount struct {
	dev    string // major:minor of the superblock
	root   string // path inside the file system
	point  string // mount point, relative to the process's root
	fstype string
}

func unescapeMountinfo(s string) string {
	if !strings.Contains(s, `\`) {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			if n, err := strconv.ParseUint(s[i+1:i+4], 8, 8); err == nil {
				b.WriteByte(byte(n))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func parseMountinfo(data []byte) []mount {
	var out []mount
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		sep := -1
		for i, x := range f {
			if x == "-" {
				sep = i
				break
			}
		}
		if len(f) < 5 || sep < 0 || sep+1 >= len(f) {
			continue
		}
		out = append(out, mount{dev: f[2], root: unescapeMountinfo(f[3]), point: unescapeMountinfo(f[4]), fstype: f[sep+1]})
	}
	return out
}

const fsType = "fuse.worldfs"

// nsOp is one mount change inside a thread namespace.
type nsOp struct {
	Op     string `json:"op"` // umount, bind, replace
	Source string `json:"source,omitempty"`
	Target string `json:"target"`
}

// planMounts turns the desired view per target into mount operations,
// given a namespace's mount table. want maps a target to the view directory
// (a path below views) it should show, or "" for none. live is the
// superblock of the running daemon's mount; a view of any other worldfs
// superblock belongs to a daemon that has died and is replaced.
func planMounts(mounts []mount, want map[string]string, views, live string) []nsOp {
	top := map[string]mount{} // the last mount on a point is the visible one
	depth := map[string]int{}
	for _, m := range mounts {
		if _, ok := want[m.point]; !ok {
			continue
		}
		top[m.point] = m
		if m.fstype == fsType {
			depth[m.point]++
		}
	}
	var ops []nsOp
	for target, view := range want {
		m, mounted := top[target]
		ours := mounted && m.fstype == fsType
		switch {
		case view == "":
			for i := 0; i < depth[target]; i++ {
				ops = append(ops, nsOp{Op: "umount", Target: target})
			}
		case !ours:
			ops = append(ops, nsOp{Op: "bind", Source: filepath.Join(views, view), Target: target})
		case m.dev != live || m.root != "/"+view:
			ops = append(ops, nsOp{Op: "replace", Source: filepath.Join(views, view), Target: target})
		}
	}
	return ops
}

// nsHelper changes mounts in one thread namespace. It joins the user
// namespace that owns the namespace, which has every capability there,
// and runs this binary's ns-mount with the operations on stdin.
type nsHelper struct {
	self    string
	hostMnt uint64
}

func (h nsHelper) apply(ns namespace, ops []nsOp) error {
	if len(ops) == 0 {
		return nil
	}
	owner, _, err := ownerOf(ns.pid)
	if err != nil {
		return err
	}
	defer owner.Close()
	in, _ := json.Marshal(ops)
	cmd := exec.Command("nsenter", "--user=/proc/self/fd/3",
		fmt.Sprintf("--mount=/proc/%d/ns/mnt", ns.pid), fmt.Sprintf("--root=/proc/%d/root", ns.pid),
		"--preserve-credentials", "--keep-caps", "--", h.self, "ns-mount")
	cmd.ExtraFiles = []*os.File{owner}
	cmd.Stdin = bytes.NewReader(in)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ns-mount in pid %d: %w: %s", ns.pid, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// reconcile brings every live namespace of a thread to the wanted views.
// A namespace without one of the targets (agent-exec's helper namespaces)
// is left alone for that target.
func (h nsHelper) reconcile(key uint64, want map[string]string, views, live string) []error {
	nss := threadNamespaces(key, h.hostMnt)
	var (
		mu   sync.Mutex
		errs []error
		wg   sync.WaitGroup
	)
	for _, ns := range nss {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := h.reconcileOne(ns, want, views, live); err != nil {
				mu.Lock()
				errs = append(errs, err)
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return errs
}

func (h nsHelper) reconcileOne(ns namespace, want map[string]string, views, live string) error {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/mountinfo", ns.pid))
	if err != nil {
		return nil // the process exited
	}
	mounts := parseMountinfo(data)
	if !hasMountPoint(mounts, views) {
		return nil // not a world namespace
	}
	present := map[string]string{}
	for t, v := range want {
		if hasMountPoint(mounts, t) || dirExistsIn(ns.pid, t) {
			present[t] = v
		}
	}
	return h.apply(ns, planMounts(mounts, present, views, live))
}

func hasMountPoint(mounts []mount, p string) bool {
	for _, m := range mounts {
		if m.point == p {
			return true
		}
	}
	return false
}

func dirExistsIn(pid int, p string) bool {
	st, err := os.Lstat(fmt.Sprintf("/proc/%d/root%s", pid, p))
	return err == nil && st.IsDir()
}

// nsMount runs inside a thread namespace, with the owner's capabilities.
func nsMount() error {
	var ops []nsOp
	if err := json.NewDecoder(os.Stdin).Decode(&ops); err != nil {
		return err
	}
	for _, op := range ops {
		var err error
		switch op.Op {
		case "umount":
			err = unix.Unmount(op.Target, unix.MNT_DETACH)
		case "bind":
			err = unix.Mount(op.Source, op.Target, "", unix.MS_BIND, "")
		case "replace":
			err = replaceMount(op.Source, op.Target)
		default:
			err = fmt.Errorf("unknown op %q", op.Op)
		}
		if err != nil {
			return fmt.Errorf("%s %s: %w", op.Op, op.Target, err)
		}
	}
	return nil
}

// moveMountBeneath is MOVE_MOUNT_BENEATH (Linux 6.5), which x/sys lacks.
const moveMountBeneath = 0x200

// replaceMount puts a bind of source beneath the mount on target and then
// removes the top one, so a lookup never sees the empty directory between.
func replaceMount(source, target string) error {
	fd, err := unix.OpenTree(unix.AT_FDCWD, source, unix.OPEN_TREE_CLONE|unix.OPEN_TREE_CLOEXEC)
	if err != nil {
		return fmt.Errorf("open_tree %s: %w", source, err)
	}
	defer unix.Close(fd)
	if err := unix.MoveMount(fd, "", unix.AT_FDCWD, target, unix.MOVE_MOUNT_F_EMPTY_PATH|moveMountBeneath); err != nil {
		return fmt.Errorf("move_mount beneath: %w", err)
	}
	return unix.Unmount(target, unix.MNT_DETACH)
}
