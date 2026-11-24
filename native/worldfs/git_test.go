package main

import (
	"fmt"
	"path/filepath"
	"testing"
)

func TestLoadTreeOfARenameInABloblessMirror(t *testing.T) {
	src := filepath.Join(t.TempDir(), "src")
	run(t, "", "git", "init", "-q", "-b", "main", src)
	run(t, src, "git", "config", "uploadpack.allowFilter", "true")
	write(t, filepath.Join(src, "old.txt"), "one\ntwo\nthree\nfour\n")
	run(t, src, "git", "add", "-A")
	run(t, src, "git", "commit", "-q", "-m", "first")
	run(t, src, "git", "mv", "old.txt", "new.txt")
	write(t, filepath.Join(src, "new.txt"), "one\ntwo\nthree\nfour\nfive\n")
	run(t, src, "git", "commit", "-q", "-am", "rename and edit")

	mirror := filepath.Join(t.TempDir(), "m.git")
	run(t, "", "git", "clone", "-q", "--bare", "--filter=blob:none", "file://"+src, mirror)
	tip := run(t, mirror, "git", "rev-parse", "HEAD")
	// The machine cache holds the tip's blobs and none of its parents'.
	run(t, mirror, "git", "ls-tree", "-r", "-l", tip)

	tr, err := loadTree("w", "r", mirror, tip)
	if err != nil {
		t.Fatal(err)
	}
	if want := run(t, mirror, "git", "log", "-1", "--format=%ct", tip); fmt.Sprint(tr.mtime) != want {
		t.Fatalf("mtime %d, want %s", tr.mtime, want)
	}
}
