---
name: upstream-sync
description: Merge upstream pingdotgg/t3code main into this fork and land it. Use for the weekly upstream sync, or whenever asked to sync, catch up with, or merge upstream.
---

# Upstream sync

The fork merges `upstream/main` into its `main` through one merge commit per sync, resolved hunk by hunk. `patches/fork-workflow.md` and AGENTS.md "Fork maintenance" are the rules: what to keep, migration ids, test config, lockfiles. This skill is how a sync gets from fetch to merged without losing anyone's work.

The goal is a merge where nothing is silently lost. Every upstream change survives unless a `patches/*.md` doc says why not, every fork behavior survives unless upstream now covers it (then the fork code and its doc go), and the result runs on real data. A sync goes **full send**: it merges when the gate is green, without waiting for Hauke.

## Shape of a sync

- Start from the remotes, not a local `main`: fetch `origin` and `upstream`. If `main@origin` already contains `main@upstream`, there is nothing to sync. If an open `sync/upstream-*` PR exists, resume it instead of starting a second one.
- Work in a fresh `jj workspace` next to the main checkout: `jj new main@origin main@upstream`, with `--config ui.conflict-marker-style=git` so the markers carry the base. Resolve manifests first, then regenerate the lockfile with `pnpm run fork:lockfile`.
- Hand large conflict sets to subagents by area, balanced by conflict lines, not file counts. [brief.md](brief.md) is the brief that worked. The lead keeps the cross-cutting files: manifests, `Migrations.ts`, root configs, `flake.nix`.
- After the resolvers finish, typecheck every touched package and send each agent the errors in its area. It keeps its context, so it fixes faster than a fresh one.
- Run the one-side check: any conflicted file whose result equals the fork or upstream side whole, while the other side changed it, either gets the lost changes back or gets a `patches/*.md` entry saying why they're gone. Dropping or changing a fork requirement is Hauke's decision: ask with the question tool and leave the PR unmerged.
- Keep reconciliation work that isn't a conflict resolution (for example, making fork code pass a new upstream lint) in its own commit on top. Fold later fixes into the commit they belong to with `jj squash --use-destination-message --from @ --into <change> <paths>`.
- Proof before the PR:
  - `vp run migrate-dev-db --projects 4 --threads-per-project 10` applies the new migrations to a slice of the real database.
  - `vp run dev` on that slice, a Replay turn through approval, and a look at the fork's own screens.
  - `node scripts/refresh-pnpm-deps-hashes.ts`, whose "Verified the Nix release contract" is the production build.
  - `vp run check:changed main@origin`, so it compares against the fork base rather than upstream.
- Review with the `sol-loop` skill on `jj diff -r <merge>`, which for a merge commit is exactly the resolutions, plus the commits on top. A finding that is upstream's own behavior can wait for a follow-up, unless it breaks the fork as shipped; then it blocks like any other.
- File with `tea` (Forgejo, merge style `merge`) and watch with `watch_pull_request`. The watch doesn't wake when `main` moves, so before merging, check that the PR head contains the current `main@origin` and that its checks ran on that head. Merge through the API with the verified head pinned: `tea api -X POST repos/schnau/t3code/pulls/<n>/merge -f do=merge -f head_commit_id=<sha>`. Then follow Calder's `push to main` run until `calder projects` shows the new commit deployed.
- When the run can't land (a decision that belongs to Hauke, missing proof, broken infrastructure), ask with the question tool and leave the PR open.
- When `main` moves under the PR, rebase the merge commit onto it with `jj rebase -s <merge> -d main@origin -d <upstream commit>`. jj carries the resolutions over, so only the new collisions need work. Check `Migrations.ts` first: if main took fork ids that the sync gave upstream migrations, shift upstream's ids past them, along with every test and doc that names them.

## Traps this repo has

- **The shell exports `NODE_ENV=production` and a German locale.** React tests then fail with `act is not a function`, and number formats break assertions. Run tests with `env -u NODE_ENV LC_ALL=C.UTF-8`, as the CI shell does.
- **The workspace is a git worktree, and Nix reads its git index**, not jj. Before any `nix build` or hash refresh, run `git add -A`, or Nix misses new files and trips over deleted ones.
- **Calder reruns only the test files whose inputs changed.** A change to a shared input, such as the CI shell or a browser setup file, reruns every file and surfaces latent failures in one go. To get the same picture early, run the full server suite locally inside `nix develop .#ci` with `GIT_CONFIG_GLOBAL=/dev/null` and `umask 022`.
- **Calder's shared hosts time out passing suites under load.** A browser shard that "did not respond to a heartbeat", or a step that hits its timeout while every finished test passed, is load: run the file locally, then `calder rerun <run>`. A file that fails the same way under low load is real.
- **Check the formatter by its exit code.** `vp fmt --check` names unformatted files above its last line, so piping it through `tail -1` hides them.
- **`check:changed` runs a focused test set**: the tests beside changed files plus a few cross-file checks. CI runs the full suites on NixOS hosts, where new upstream tests break on `/bin/bash`, a missing `/usr/bin`, and a newer glibc. Expect a round of those. Fix them in the test, or behind a CI-only switch, and record each in `patches/nixos-ci-portability.md`. Check that production doesn't make the same assumption: the fork's hosts are NixOS.
- **Nix source sets lag upstream.** A build config that imports a new `scripts/lib` file, a new workspace package family, or a vendored tarball needs adding in `flake.nix` (`patches/nix-flake-packaging.md`).
- **pnpm takes one patch per package version.** When upstream starts patching a package the fork already patches, combine both into one file: `pnpm patch` applies upstream's version, you add the fork's hunk, then `pnpm patch-commit`.
- **Upstream assumes `worktree` is the only isolated strategy.** New predicates on `workspacePreparation.type === "worktree"` usually need the fork's `workspace` too. The shared `preparesWorktree` covers both.

## After the sync

If `patches/redesign-integration.md` exists, refresh the `redesign` bookmark it describes in the same run. The fork owns that bookmark and rewrites it on every refresh. Rebase its merge commit onto the new `main@origin` and Maria's current stack head, as the doc says; jj carries the earlier resolutions over. Run the same proof on it, and push it only once the proof passes.
