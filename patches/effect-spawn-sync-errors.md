# Effect spawn errors Node throws synchronously

Node's `child_process.spawn` emits ENOENT, EACCES and a few others as an `error` event, but throws
the rest, such as EPERM and E2BIG. Effect 4.1.2's Node spawner calls `spawn` inside
`Effect.callback`, so a thrown error becomes a defect instead of a `PlatformError`. Callers that
recover from a failed command, like the OpenCode server ledger's `ps` probe with
`Effect.orElseSucceed`, then crash instead. Upstream works around this per call site, in
`apps/server/src/processRunner.ts` with `Effect.catchDefect`.

`patches/@effect__platform-node-shared@4.1.2.patch` catches the throw and fails the spawn like an
emitted error, for every caller. The fork needs it on m1, where pull requests' desktop launch check
runs the packaged app inside `sandbox-exec`: macOS refuses setuid binaries such as `/bin/ps` there
with a thrown EPERM, which crashed the app's server at startup. `processRunner.test.ts` covers it
with an oversized argument, which throws E2BIG on Linux and macOS.

Remove the patch when Effect's Node spawner turns synchronous spawn errors into failures. The patch
is pinned to 4.1.2, so bumping `@effect/platform-node-shared` needs it re-made or removed.
