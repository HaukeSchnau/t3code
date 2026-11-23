package main

import (
	"fmt"
	"path"
	"strings"
	"time"
)

// policy limits checkouts per thread: some for free, then a few a minute,
// and none past a repo count or a size. Checkouts copy from the machine
// cache, so a storm costs disk and jj time, not network.
type policy struct {
	Free      int           // checkouts that never wait
	PerWindow int           // checkouts past Free allowed per Window
	Window    time.Duration //
	MaxRepos  int           // refuse past this many checked-out repos
	MaxBytes  uint64        // refuse past this many bytes of checked-out trees
	Idle      time.Duration // close clean checkouts idle this long
}

var defaultPolicy = policy{
	Free:      20,
	PerWindow: 10,
	Window:    time.Minute,
	MaxRepos:  50,
	MaxBytes:  10 << 30,
	Idle:      10 * time.Minute,
}

// admit decides one checkout. current and bytes count what the thread has
// checked out (in-progress checkouts included), add is the new tree's size,
// and recent holds the times of the throttled checkouts so far.
// It returns how long to wait, or a refusal.
func (p policy) admit(current int, bytes, add uint64, recent []time.Time, now time.Time) (time.Duration, string) {
	if current >= p.MaxRepos {
		return 0, fmt.Sprintf("%d repos already checked out in this thread, the cap is %d", current, p.MaxRepos)
	}
	if bytes+add > p.MaxBytes {
		return 0, fmt.Sprintf("%s already checked out in this thread and this repo adds %s, the cap is %s",
			human(bytes), human(add), human(p.MaxBytes))
	}
	if current < p.Free {
		return 0, ""
	}
	var inWindow []time.Time
	for _, t := range recent {
		if now.Sub(t) < p.Window {
			inWindow = append(inWindow, t)
		}
	}
	if len(inWindow) < p.PerWindow {
		return 0, ""
	}
	// The slot frees when the oldest checkout in the window leaves it.
	oldest := inWindow[len(inWindow)-p.PerWindow]
	return oldest.Add(p.Window).Sub(now), ""
}

func human(b uint64) string {
	switch {
	case b >= 1<<30:
		return fmt.Sprintf("%.1f GB", float64(b)/(1<<30))
	case b >= 1<<20:
		return fmt.Sprintf("%.0f MB", float64(b)/(1<<20))
	default:
		return fmt.Sprintf("%d KB", b>>10)
	}
}

// layoutRule maps catalog names with Prefix to directories under Dir in a
// thread world. "git.buildlinx.io/" with "Repos/" puts
// git.buildlinx.io/buildlinx/cloud/frontend at Repos/buildlinx/cloud/frontend.
type layoutRule struct {
	Prefix string `json:"prefix"`
	Dir    string `json:"dir"`
}

// dirFor places a repo in the world by the longest matching prefix.
func dirFor(layout []layoutRule, name string) string {
	best := -1
	for i, r := range layout {
		if strings.HasPrefix(name, r.Prefix) && (best < 0 || len(r.Prefix) > len(layout[best].Prefix)) {
			best = i
		}
	}
	if best < 0 {
		return name
	}
	return path.Clean(layout[best].Dir + strings.TrimPrefix(name, layout[best].Prefix))
}

func validLayout(layout []layoutRule) error {
	for _, r := range layout {
		d := path.Clean(r.Dir + "x")
		if strings.HasPrefix(d, "/") || d == ".." || strings.HasPrefix(d, "../") || strings.Contains(r.Dir, "..") {
			return fmt.Errorf("layout dir %q must stay inside the world", r.Dir)
		}
	}
	return nil
}

// nestedDirs reports the first repo directory that sits inside another one.
// A view bound over the outer repo would hide the inner one.
func nestedDirs(dirs []string) (string, string, bool) {
	set := map[string]bool{}
	for _, d := range dirs {
		set[d] = true
	}
	for _, d := range dirs {
		for p := path.Dir(d); p != "." && p != "/"; p = path.Dir(p) {
			if set[p] {
				return p, d, true
			}
		}
	}
	return "", "", false
}
