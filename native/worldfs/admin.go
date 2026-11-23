package main

import (
	"context"
	"log"
	"os"
	"path"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

// The admin links live in the views mount too:
//
//	<state>/mnt/views/.admin/<thread>/<forge path> -> <mirror>/worktrees/<id>
//
// Each thread binds its own directory at /run/worldfs/admin, which every
// view's .git file names. Looking a link up registers the thread's worktree
// for that repo. Only git itself gets one: grep -r reads every .git file,
// and ripgrep follows it to find info/exclude, and neither needs a
// worktree in the mirror per repo and thread.

const adminDir = ".admin"

type adminNode struct {
	fs.Inode
	m      *machine
	thread string // "" for .admin itself
	prefix string
}

func (n *adminNode) Getattr(ctx context.Context, f fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	dirAttr(&out.Attr)
	return 0
}

func (n *adminNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	out.SetEntryTimeout(uncached)
	m := n.m
	m.mu.Lock()
	if n.thread == "" {
		_, ok := m.threads[name]
		m.mu.Unlock()
		if !ok {
			return nil, syscall.ENOENT
		}
		dirAttr(&out.Attr)
		return n.NewInode(ctx, &adminNode{m: m, thread: name}, fs.StableAttr{Mode: syscall.S_IFDIR, Ino: inoFor(adminDir, name)}), 0
	}
	t := m.threads[n.thread]
	var w *world
	if t != nil {
		w = m.worlds[t.World]
	}
	full := path.Join(n.prefix, name)
	var r *repo
	inner := false
	if w != nil {
		r = w.repos[full]
		for _, x := range w.names {
			if strings.HasPrefix(x, full+"/") {
				inner = true
				break
			}
		}
	}
	m.mu.Unlock()
	switch {
	case r != nil && comm(callerPid(ctx)) != "git":
		return nil, syscall.ENOENT
	case r != nil:
		leave, err := m.enter(t)
		if err != nil {
			return nil, syscall.ENOENT
		}
		tr, err := m.ensureAdmin(t, r)
		leave()
		if err != nil {
			log.Printf("admin %s in %s: %v", r.name, t.ID, err)
			return nil, syscall.EIO
		}
		out.Attr.Mode = syscall.S_IFLNK | 0o777
		out.Attr.Size = uint64(len(tr.Admin))
		out.SetEntryTimeout(time.Second) // teardown removes it
		return n.NewInode(ctx, &linkNode{target: tr.Admin}, fs.StableAttr{Mode: syscall.S_IFLNK, Ino: inoFor(adminDir, t.ID, full)}), 0
	case inner:
		dirAttr(&out.Attr)
		return n.NewInode(ctx, &adminNode{m: m, thread: n.thread, prefix: full}, fs.StableAttr{Mode: syscall.S_IFDIR, Ino: inoFor(adminDir, t.ID, full+"/")}), 0
	}
	return nil, syscall.ENOENT
}

// Readdir lists what exists: threads, and the repos a thread has an admin
// dir for.
func (n *adminNode) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	m := n.m
	m.mu.Lock()
	defer m.mu.Unlock()
	seen := map[string]uint32{}
	if n.thread == "" {
		for id := range m.threads {
			seen[id] = syscall.S_IFDIR
		}
	} else if t := m.threads[n.thread]; t != nil {
		pre := n.prefix
		if pre != "" {
			pre += "/"
		}
		for name, tr := range t.Repos {
			if tr.Admin == "" || !strings.HasPrefix(name, pre) {
				continue
			}
			rest := name[len(pre):]
			if i := strings.IndexByte(rest, '/'); i >= 0 {
				seen[rest[:i]] = syscall.S_IFDIR
			} else {
				seen[rest] = syscall.S_IFLNK
			}
		}
	}
	list := make([]fuse.DirEntry, 0, len(seen))
	for name, mode := range seen {
		list = append(list, fuse.DirEntry{Name: name, Mode: mode})
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Name < list[j].Name })
	return fs.NewListDirStream(list), 0
}

type linkNode struct {
	fs.Inode
	target string
}

func (n *linkNode) Readlink(ctx context.Context) ([]byte, syscall.Errno) {
	return []byte(n.target), 0
}

func (n *linkNode) Getattr(ctx context.Context, f fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Attr.Mode = syscall.S_IFLNK | 0o777
	out.Attr.Size = uint64(len(n.target))
	out.Attr.Uid, out.Attr.Gid = uint32(os.Getuid()), uint32(os.Getgid())
	return 0
}
