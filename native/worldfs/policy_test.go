package main

import (
	"strings"
	"testing"
	"time"
)

// The storm from the per-repo-mounts spike: a write into each of 60 repos
// at once. 20 go free, 10 more fit the first minute, the next tens wait a
// minute each, and the cap refuses everything past 50.
func TestAdmitStorm(t *testing.T) {
	p := defaultPolicy
	start := time.Unix(1_000_000, 0)
	var recent []time.Time
	current := 0
	var got []string
	for i := 1; i <= 60; i++ {
		now := start
		for {
			wait, refused := p.admit(current, 0, 1<<20, recent, now)
			if refused != "" {
				got = append(got, "refused")
				break
			}
			if wait > 0 {
				now = now.Add(wait)
				continue
			}
			if current >= p.Free {
				recent = append(recent, now)
			}
			current++
			got = append(got, now.Sub(start).String())
			break
		}
	}
	want := map[int]string{1: "0s", 30: "0s", 31: "1m0s", 40: "1m0s", 41: "2m0s", 50: "2m0s", 51: "refused", 60: "refused"}
	for i, w := range want {
		if got[i-1] != w {
			t.Errorf("checkout %d: got %s, want %s", i, got[i-1], w)
		}
	}
}

func TestAdmitSizeCap(t *testing.T) {
	p := defaultPolicy
	p.MaxBytes = 100 << 20
	if _, refused := p.admit(1, 50<<20, 40<<20, nil, time.Now()); refused != "" {
		t.Fatalf("90 MB refused: %s", refused)
	}
	_, refused := p.admit(1, 50<<20, 60<<20, nil, time.Now())
	if !strings.Contains(refused, "50 MB already checked out") || !strings.Contains(refused, "the cap is 100 MB") {
		t.Fatalf("refusal %q", refused)
	}
}

func TestLayout(t *testing.T) {
	layout := []layoutRule{{Prefix: "git.buildlinx.io/", Dir: "Repos/"}, {Prefix: "git.schnau.dev/schnau/infra", Dir: "infra"}}
	for name, want := range map[string]string{
		"git.buildlinx.io/buildlinx/cloud/frontend": "Repos/buildlinx/cloud/frontend",
		"git.schnau.dev/schnau/infra":               "infra",
		"github.com/HaukeSchnau/x":                  "github.com/HaukeSchnau/x",
	} {
		if got := dirFor(layout, name); got != want {
			t.Errorf("%s: got %s, want %s", name, got, want)
		}
	}
	if err := validLayout([]layoutRule{{Prefix: "a/", Dir: "../out/"}}); err == nil {
		t.Error("a layout leaving the world was accepted")
	}
	if outer, inner, bad := nestedDirs([]string{"a/b", "a/b/c", "d"}); !bad || outer != "a/b" || inner != "a/b/c" {
		t.Errorf("nested: %v %v %v", outer, inner, bad)
	}
}
