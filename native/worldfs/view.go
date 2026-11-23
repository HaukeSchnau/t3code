package main

import (
	"context"
	"errors"
	"log"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

// One read-only FUSE mount serves every view on the machine:
//
//	<state>/mnt/views/<world>/<forge path>@<commit>/...
//
// A thread binds the directory of its version over the repo's path in its
// world. A version never changes, so the kernel may cache it for an hour.
// The directories above versions change with the catalogs and are not
// cached. One mount keeps go-fuse at GOMAXPROCS reader threads in total.

const frozen = time.Hour

// uncached marks a failed lookup as not cacheable: go-fuse turns ENOENT
// into an hour-long negative entry only when the entry timeout is unset.
const uncached = time.Nanosecond

func callerPid(ctx context.Context) int {
	if c, ok := fuse.FromContext(ctx); ok {
		return int(c.Pid)
	}
	return 0
}

func (m *machine) mountViews() (*fuse.Server, error) {
	if err := os.MkdirAll(m.views, 0o755); err != nil {
		return nil, err
	}
	negative := frozen
	return fs.Mount(m.views, &dirNode{m: m}, &fs.Options{
		MountOptions: fuse.MountOptions{
			FsName:        "worldfs",
			Name:          "worldfs",
			MaxReadAhead:  128 << 10,
			DisableXAttrs: true,
		},
		NegativeTimeout: &negative,
		UID:             uint32(os.Getuid()),
		GID:             uint32(os.Getgid()),
	})
}

// dirNode is the root (world ""), a world, or a directory on the way to a
// repo name, such as git.schnau.dev/schnau.
type dirNode struct {
	fs.Inode
	m      *machine
	world  string
	prefix string
}

func (n *dirNode) children() ([]fuse.DirEntry, map[string]fs.InodeEmbedder) {
	m := n.m
	m.mu.Lock()
	defer m.mu.Unlock()
	kids := map[string]fs.InodeEmbedder{}
	if n.world == "" {
		for w := range m.worlds {
			kids[w] = &dirNode{m: m, world: w}
		}
		kids[adminDir] = &adminNode{m: m}
	} else if w := m.worlds[n.world]; w != nil {
		pre := n.prefix
		if pre != "" {
			pre += "/"
		}
		for _, name := range w.names {
			if !strings.HasPrefix(name, pre) {
				continue
			}
			rest := name[len(pre):]
			if i := strings.IndexByte(rest, '/'); i >= 0 {
				kids[rest[:i]] = &dirNode{m: m, world: n.world, prefix: pre + rest[:i]}
				continue
			}
			r := w.repos[name]
			versions := map[string]bool{}
			if r.latest != "" {
				versions[r.latest] = true
			}
			for _, t := range m.threads {
				if tr := t.Repos[name]; t.World == n.world && tr != nil {
					versions[tr.Version] = true
				}
			}
			for v := range versions {
				kids[rest+"@"+v] = nil // created on lookup, which loads the tree
			}
		}
	}
	var list []fuse.DirEntry
	for name := range kids {
		list = append(list, fuse.DirEntry{Name: name, Mode: syscall.S_IFDIR})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return list, kids
}

func (n *dirNode) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	list, _ := n.children()
	return fs.NewListDirStream(list), 0
}

func dirAttr(a *fuse.Attr) {
	a.Mode = syscall.S_IFDIR | 0o755
	a.Nlink = 2
	a.Uid, a.Gid = uint32(os.Getuid()), uint32(os.Getgid())
}

func (n *dirNode) Getattr(ctx context.Context, f fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	dirAttr(&out.Attr)
	return 0
}

func (n *dirNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	out.SetEntryTimeout(uncached)
	if n.world != "" {
		if base, commit, ok := strings.Cut(name, "@"); ok {
			return n.lookupVersion(ctx, base, commit, out)
		}
	}
	_, kids := n.children()
	k, ok := kids[name]
	if !ok || k == nil {
		return nil, syscall.ENOENT
	}
	dirAttr(&out.Attr)
	out.SetEntryTimeout(time.Second)
	ino := inoFor("dir", n.world, n.prefix, name)
	return n.NewInode(ctx, k, fs.StableAttr{Mode: syscall.S_IFDIR, Ino: ino}), 0
}

func (n *dirNode) lookupVersion(ctx context.Context, base, commit string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	name := path.Join(n.prefix, base)
	if !commitRe.MatchString(commit) {
		return nil, syscall.ENOENT
	}
	m := n.m
	m.mu.Lock()
	var r *repo
	if w := m.worlds[n.world]; w != nil {
		r = w.repos[name]
	}
	ok := r != nil && m.allowed(r, commit)
	m.mu.Unlock()
	if !ok {
		return nil, syscall.ENOENT
	}
	t, err := r.tree(commit)
	if err != nil {
		log.Printf("tree %s@%s: %v", name, short(commit), err)
		return nil, syscall.EIO
	}
	tn := &treeNode{m: m, r: r, t: t, e: t.root}
	tn.fillAttr(&out.Attr)
	out.SetEntryTimeout(frozen)
	out.SetAttrTimeout(frozen)
	return n.NewInode(ctx, tn, fs.StableAttr{Mode: syscall.S_IFDIR, Ino: t.root.ino}), 0
}

// treeNode is a path inside one version. It never changes anything: a
// write or a chdir from a thread checks the repo out for that thread,
// removes the view from the thread's namespaces and answers ESTALE, so the
// kernel walks the path again and lands in the checkout.
type treeNode struct {
	fs.Inode
	m *machine
	r *repo
	t *tree
	e *entry
}

func (n *treeNode) isRoot() bool { return n.e == n.t.root }

func (n *treeNode) fillAttr(a *fuse.Attr) {
	e := n.e
	a.Ino = e.ino
	a.Mtime, a.Ctime, a.Atime = n.t.mtime, n.t.mtime, n.t.mtime
	a.Uid, a.Gid = uint32(os.Getuid()), uint32(os.Getgid())
	a.Blksize = 4096
	switch e.mode {
	case 0o40000, 0o160000:
		a.Mode = syscall.S_IFDIR | 0o755
		a.Nlink = 2
		a.Size = 4096
	case 0o120000:
		a.Mode = syscall.S_IFLNK | 0o777
		a.Nlink = 1
		a.Size = e.size
	default:
		a.Mode = syscall.S_IFREG | (e.mode & 0o777)
		a.Nlink = 1
		a.Size = e.size
	}
	a.Blocks = (a.Size + 511) / 512
}

func (n *treeNode) child(e *entry) *treeNode { return &treeNode{m: n.m, r: n.r, t: n.t, e: e} }

func (n *treeNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	var e *entry
	switch {
	case n.isRoot() && name == ".git":
		e = n.t.git
	case n.isRoot() && name == ".jj":
		// jj looks for .jj before it snapshots, which is a write. ripgrep
		// and prompts look for it too and only read, so only jj itself
		// checks out. The answer differs per thread and is never cached.
		out.SetEntryTimeout(uncached)
		if comm(callerPid(ctx)) == "jj" && n.trigger(ctx, "lookup .jj", true) == syscall.ESTALE {
			return nil, syscall.ESTALE
		}
		return nil, syscall.ENOENT
	default:
		if n.e.kids != nil {
			e = n.e.kids[name]
		}
	}
	if e == nil {
		return nil, syscall.ENOENT // cached as a negative entry for an hour
	}
	c := n.child(e)
	c.fillAttr(&out.Attr)
	out.SetEntryTimeout(frozen)
	out.SetAttrTimeout(frozen)
	return n.NewInode(ctx, c, fs.StableAttr{Mode: out.Attr.Mode & syscall.S_IFMT, Ino: e.ino}), 0
}

func (n *treeNode) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	var list []fuse.DirEntry
	if n.isRoot() {
		list = append(list, fuse.DirEntry{Name: ".git", Mode: syscall.S_IFREG, Ino: n.t.git.ino})
	}
	for _, k := range n.e.kids {
		var a fuse.Attr
		n.child(k).fillAttr(&a)
		list = append(list, fuse.DirEntry{Name: k.name, Mode: a.Mode, Ino: k.ino})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return fs.NewListDirStream(list), 0
}

func (n *treeNode) OpendirHandle(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	ds, errno := n.Readdir(ctx)
	return ds, fuse.FOPEN_CACHE_DIR | fuse.FOPEN_KEEP_CACHE, errno
}

func (n *treeNode) Getattr(ctx context.Context, f fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	n.fillAttr(&out.Attr)
	out.SetTimeout(frozen)
	return 0
}

func (n *treeNode) Statfs(ctx context.Context, out *fuse.StatfsOut) syscall.Errno {
	var st syscall.Statfs_t
	if err := syscall.Statfs(n.m.state, &st); err != nil {
		return fs.ToErrno(err)
	}
	out.FromStatfsT(&st)
	return 0
}

func (n *treeNode) Readlink(ctx context.Context) ([]byte, syscall.Errno) {
	b, err := n.r.cats.blob(n.e.oid)
	if err != nil {
		log.Printf("readlink %s %s: %v", n.r.name, n.e.rel, err)
		return nil, syscall.EIO
	}
	return b, 0
}

// Access is how the daemon sees a chdir: without default_permissions the
// kernel asks before changing into a directory, with the mask as X_OK.
// access(dir, X_OK) looks the same and checks the repo out too.
func (n *treeNode) Access(ctx context.Context, mask uint32) syscall.Errno {
	if mask&1 == 0 || !n.e.isDir() {
		return 0
	}
	// A shell that changes into a repo runs jj or git next; it waits for jj.
	if errno := n.trigger(ctx, "chdir "+n.e.rel, true); errno == syscall.ESTALE {
		return errno
	}
	return 0 // refused or not a thread: the read-only view stays usable
}

const writeFlags = syscall.O_WRONLY | syscall.O_RDWR | syscall.O_TRUNC | syscall.O_APPEND | syscall.O_CREAT

func (n *treeNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if flags&writeFlags != 0 {
		return nil, 0, n.write(ctx, "open-for-write "+n.e.rel)
	}
	return &memFile{n: n}, fuse.FOPEN_KEEP_CACHE, 0
}

// memFile loads its blob on the first read, not on open: with
// FOPEN_KEEP_CACHE most opens are served from the page cache.
type memFile struct {
	n    *treeNode
	once sync.Once
	data []byte
	err  error
}

func (f *memFile) Read(ctx context.Context, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	f.once.Do(func() {
		if f.n.e.data != nil {
			f.data = f.n.e.data
			return
		}
		f.data, f.err = f.n.r.cats.blob(f.n.e.oid)
	})
	if f.err != nil {
		log.Printf("blob %s %s: %v", f.n.r.name, f.n.e.rel, f.err)
		return nil, syscall.EIO
	}
	if off >= int64(len(f.data)) {
		return fuse.ReadResultData(nil), 0
	}
	end := min(off+int64(len(dest)), int64(len(f.data)))
	return fuse.ReadResultData(f.data[off:end]), 0
}

// trigger checks the repo out for the calling thread when the caller sees
// this view through its thread's bind. It answers ESTALE once the checkout
// replaced the view in the caller's namespace (and, with waitJJ, once its
// jj repo exists), EROFS when the checkout was refused or the caller is no
// thread, and EIO when it failed.
func (n *treeNode) trigger(ctx context.Context, why string, waitJJ bool) syscall.Errno {
	m := n.m
	pid := callerPid(ctx)
	t := m.threadOfPid(pid)
	who := procName(pid)
	if t == nil || t.World != n.r.world || !m.seesView(pid, t, n.r.name) {
		return syscall.EROFS
	}
	err := m.checkout(t, n.r, who, why, false)
	var ae *apiError
	switch {
	case err == nil:
		if waitJJ {
			m.waitJJ(t, n.r.name)
		}
		return syscall.ESTALE
	case errors.As(err, &ae) && ae.Code == "cap":
		return syscall.EROFS
	default:
		log.Printf("checkout %s in %s for %s: %v", n.r.name, t.ID, who, err)
		return syscall.EIO
	}
}

// seesView reports whether pid's namespace has a worldfs bind on the
// thread's directory for the repo. A thread process that reaches the views
// mount by its own path gets the plain read-only view.
func (m *machine) seesView(pid int, t *thread, name string) bool {
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/mountinfo")
	if err != nil {
		return false
	}
	target := t.target(name)
	for _, mt := range parseMountinfo(data) {
		if mt.point == target && mt.fstype == fsType {
			return true
		}
	}
	return false
}

func (n *treeNode) write(ctx context.Context, why string) syscall.Errno {
	errno := n.trigger(ctx, why, false)
	if errno == syscall.EROFS {
		log.Printf("EROFS %s for %s (%s)", n.r.name, procName(callerPid(ctx)), why)
	}
	return errno
}

func (n *treeNode) Setattr(ctx context.Context, f fs.FileHandle, in *fuse.SetAttrIn, out *fuse.AttrOut) syscall.Errno {
	return n.write(ctx, "setattr "+n.e.rel)
}

func (n *treeNode) Create(ctx context.Context, name string, flags uint32, mode uint32, out *fuse.EntryOut) (*fs.Inode, fs.FileHandle, uint32, syscall.Errno) {
	return nil, nil, 0, n.write(ctx, "create "+path.Join(n.e.rel, name))
}

func (n *treeNode) Mkdir(ctx context.Context, name string, mode uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	return nil, n.write(ctx, "mkdir "+path.Join(n.e.rel, name))
}

func (n *treeNode) Mknod(ctx context.Context, name string, mode, rdev uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	return nil, n.write(ctx, "mknod "+path.Join(n.e.rel, name))
}

func (n *treeNode) Unlink(ctx context.Context, name string) syscall.Errno {
	return n.write(ctx, "unlink "+path.Join(n.e.rel, name))
}

func (n *treeNode) Rmdir(ctx context.Context, name string) syscall.Errno {
	return n.write(ctx, "rmdir "+path.Join(n.e.rel, name))
}

func (n *treeNode) Symlink(ctx context.Context, target, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	return nil, n.write(ctx, "symlink "+path.Join(n.e.rel, name))
}

func (n *treeNode) Rename(ctx context.Context, name string, newParent fs.InodeEmbedder, newName string, flags uint32) syscall.Errno {
	return n.write(ctx, "rename "+path.Join(n.e.rel, name))
}

func (n *treeNode) Link(ctx context.Context, target fs.InodeEmbedder, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	return nil, n.write(ctx, "link "+path.Join(n.e.rel, name))
}
