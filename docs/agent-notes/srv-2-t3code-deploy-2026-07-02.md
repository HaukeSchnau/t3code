# srv-2 T3 Code Deploy - 2026-07-02

## Goal

- Verify the T3 Code flake on `srv-2`, push the local T3 Code stack to `main`, update `~/infra` to the new T3 Code revision, and deploy `srv-2`.

## Current State

- T3 Code local stack was merged with `upstream/main` at `Restore the ultrathink frame border effect (#3625)`.
- Sync merge commit before hash fix: `468d673cafcc9d2d4d868956c5b29e95b76918df`.
- `srv-2` is `aarch64-linux`.
- Remote flake check from `/tmp/t3code-flake-build` failed because `flake.nix` had a stale `fetchPnpmDeps` hash.

## Verification Log

- `nix flake check --system aarch64-linux --print-build-logs` on `srv-2` reached the fixed-output dependency derivation and reported:
  - specified: `sha256-J+JKgo4fOuTdcr685HOdUzA0zgK+FHQKA+RhtGCzxfg=`
  - got: `sha256-vA9tHr/f6baLHzLBhOB5ydamjBC+1PrC6zGqiFzzq5g=`

## Next Steps

- Rerun the `srv-2` flake check after committing the hash update.
- Run required local checks: `vp check` and `vp run typecheck`.
- Push T3 Code `main`, update `~/infra`, deploy `srv-2`, and verify service health.
