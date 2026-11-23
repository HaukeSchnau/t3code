package main

import (
	"reflect"
	"testing"
)

func TestParseMountinfo(t *testing.T) {
	data := []byte(`25 1 0:23 / / rw - tmpfs tmpfs rw
800 25 0:91 /w/example.com/a@1111 /home/u/W/my\040repo rw,nosuid - fuse.worldfs worldfs rw,user_id=1000
`)
	got := parseMountinfo(data)
	want := []mount{
		{dev: "0:23", root: "/", point: "/", fstype: "tmpfs"},
		{dev: "0:91", root: "/w/example.com/a@1111", point: "/home/u/W/my repo", fstype: "fuse.worldfs"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestPlanMounts(t *testing.T) {
	const views, live = "/s/mnt/views", "0:91"
	mounts := []mount{
		{dev: live, root: "/w/a@1", point: "/W/a", fstype: fsType},   // right version
		{dev: live, root: "/w/b@1", point: "/W/b", fstype: fsType},   // old version
		{dev: "0:50", root: "/w/c@1", point: "/W/c", fstype: fsType}, // a dead daemon's mount
		{dev: live, root: "/w/d@1", point: "/W/d", fstype: fsType},   // checked out since
		{dev: live, root: "/w/d@1", point: "/W/d", fstype: fsType},   // stacked twice
		{dev: "254:2", root: "/home", point: "/W/f", fstype: "xfs"},  // someone else's mount
	}
	want := map[string]string{"/W/a": "w/a@1", "/W/b": "w/b@2", "/W/c": "w/c@1", "/W/d": "", "/W/e": "w/e@1", "/W/f": "w/f@1"}
	got := map[string][]string{}
	for _, op := range planMounts(mounts, want, views, live) {
		got[op.Target] = append(got[op.Target], op.Op+" "+op.Source)
	}
	expect := map[string][]string{
		"/W/b": {"replace /s/mnt/views/w/b@2"},
		"/W/c": {"replace /s/mnt/views/w/c@1"},
		"/W/d": {"umount ", "umount "},
		"/W/e": {"bind /s/mnt/views/w/e@1"},
		"/W/f": {"bind /s/mnt/views/w/f@1"},
	}
	if !reflect.DeepEqual(got, expect) {
		t.Fatalf("got %v", got)
	}
}
