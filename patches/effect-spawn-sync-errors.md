# Effect spawn errors Node throws synchronously

Node's `child_process.spawn` emits ENOENT, EACCES and a few others as an `error` event, but throws
the rest, such as EPERM and E2BIG. Effect 4.1.5's Node spawner calls `spawn` inside
`Effect.callback`, so a thrown error becomes a defect instead of a `PlatformError`. Callers that
recover from a failed command, like the OpenCode server ledger's `ps` probe with
`Effect.orElseSucceed`, then crash instead. Upstream works around this per call site, in
`apps/server/src/processRunner.ts` with `Effect.catchDefect`.

`patches/@effect__platform-node-shared@4.1.5.patch` catches the throw and fails the spawn like an
emitted error, for every caller. Upstream patches the same package for its pluggable
`layerWithSpawn`, and pnpm takes one patch per version, so the file carries both: upstream's hunks
and the fork's try/catch around `spawnProcess` in `dist/NodeChildProcessSpawner.js`. The fork needs it on m1, where pull requests' desktop launch check
runs the packaged app inside `sandbox-exec`: macOS refuses setuid binaries such as `/bin/ps` there
with a thrown EPERM, which crashed the app's server at startup. `processRunner.test.ts` covers it
with an oversized argument, which throws E2BIG on Linux and macOS.

Remove the fork's hunk when Effect's Node spawner turns synchronous spawn errors into failures. When
upstream re-makes its patch for a new Effect version, re-make the combined file: `pnpm patch
@effect/platform-node-shared@<version>` applies upstream's patch, then add the try/catch and run
`pnpm patch-commit`.
