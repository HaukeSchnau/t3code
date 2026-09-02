/**
 * The scripted scenario: one long-lived coordinator, five efforts, one
 * ungrouped delegation, and unrelated threads mixed in. Each step is an event
 * batch with a frozen clock and a caption; the store replays steps up to the
 * cursor and appends the user's own events after it.
 */
import type { FixtureEvent, FixtureStep, FixtureThreadSeed } from "./model";

export const PROJECT_T3 = "project-t3code";
export const PROJECT_INFRA = "project-infra";
export const COORDINATOR_ID = "thread-coordinator";

export const EFFORT_AUTH = "effort-auth";
export const EFFORT_FLAKE = "effort-flake";
export const EFFORT_DOCS = "effort-docs";
export const EFFORT_NAMING = "effort-naming";

const WORKSPACE_T3 = "/home/hauke/Code/t3code";
const WORKSPACE_INFRA = "/home/hauke/infra";

/** Step 1 starts here; the baseline sits days earlier. */
const T0 = Date.parse("2026-09-02T08:00:00.000Z");
const MINUTE = 60_000;

function at(minutes: number): string {
  return new Date(T0 + minutes * MINUTE).toISOString();
}

function daysAgo(days: number, minutes = 0): string {
  return new Date(T0 - days * 24 * 60 * MINUTE + minutes * MINUTE).toISOString();
}

function seed(
  id: string,
  title: string,
  provider: FixtureThreadSeed["provider"],
  options: Partial<Pick<FixtureThreadSeed, "projectId" | "branch" | "worktree" | "model">> = {},
): FixtureThreadSeed {
  const model =
    options.model ??
    (provider === "codex" ? "gpt-5.3-codex" : provider === "claude" ? "claude-opus-5" : "glm-5");
  return {
    id,
    title,
    provider,
    model,
    projectId: options.projectId ?? PROJECT_T3,
    branch: options.branch ?? null,
    worktree: options.worktree ?? false,
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

const FLAKE_CODEX_PATCH = `diff --git a/apps/server/src/checkpointing/restore.ts b/apps/server/src/checkpointing/restore.ts
--- a/apps/server/src/checkpointing/restore.ts
+++ b/apps/server/src/checkpointing/restore.ts
@@ -41,14 +41,11 @@ export const restoreCheckpoint = Effect.fn("restoreCheckpoint")(function* (
   const ref = yield* resolveCheckpointRef(input);
-  yield* git.checkout(ref);
-  // Give the worker a moment to observe the new tree.
-  yield* Effect.sleep("50 millis");
-  const receipt = yield* receipts.latest(input.threadId);
-  if (receipt.checkpointRef !== ref) {
-    return yield* new CheckpointRestoreError({ ref, reason: "receipt-mismatch" });
-  }
+  const restored = receipts.awaitCheckpoint(input.threadId, ref);
+  yield* git.checkout(ref);
+  // The reactor emits the restore receipt once the tree is observed; wait on
+  // that milestone instead of a sleep so slow CI runners cannot race it.
+  const receipt = yield* restored;
   return { ref, restoredAt: receipt.createdAt };
 });
`;

const FLAKE_CLAUDE_PATCH = `diff --git a/apps/server/src/checkpointing/CheckpointReactor.ts b/apps/server/src/checkpointing/CheckpointReactor.ts
--- a/apps/server/src/checkpointing/CheckpointReactor.ts
+++ b/apps/server/src/checkpointing/CheckpointReactor.ts
@@ -88,9 +88,15 @@ export const CheckpointReactorLive = Layer.effect(
       const restore = (command: RestoreCommand) =>
-        Effect.forkIn(restoreCheckpoint(command), scope);
+        // Restores for one thread run serially: two overlapping restores
+        // observed each other's tree and produced a receipt for the wrong ref.
+        queue.offer({ threadId: command.threadId, run: restoreCheckpoint(command) });
 
+      yield* Effect.forkScoped(
+        Stream.fromQueue(queue).pipe(
+          Stream.groupByKey((item) => item.threadId),
+          Stream.mapEffect((item) => item.run),
+          Stream.runDrain,
+        ),
+      );
       return { restore };
`;

const FLAKE_GLM_PATCH = `diff --git a/apps/server/test/checkpoint.test.ts b/apps/server/test/checkpoint.test.ts
--- a/apps/server/test/checkpoint.test.ts
+++ b/apps/server/test/checkpoint.test.ts
@@ -12,7 +12,7 @@ describe("checkpoint restore", () => {
-  it("restores the previous tree", async () => {
+  it("restores the previous tree", { retry: 3 }, async () => {
     const harness = await makeHarness();
`;

const AUTH_IMPL_RETRY_PATCH = `diff --git a/apps/server/src/auth/session.ts b/apps/server/src/auth/session.ts
--- a/apps/server/src/auth/session.ts
+++ b/apps/server/src/auth/session.ts
@@ -1,6 +1,7 @@
 import * as Effect from "effect/Effect";
 import * as Schema from "effect/Schema";
+import { SignedToken, verifySignedToken } from "./signedToken.ts";
 
 export const SessionCookie = Schema.Struct({
   sessionId: Schema.String,
@@ -24,12 +25,21 @@ export const readSession = Effect.fn("readSession")(function* (request: Request)
   const cookie = parseCookie(request.headers.get("cookie"));
-  if (cookie === null) {
-    return yield* new SessionMissingError();
+  const bearer = request.headers.get("authorization");
+  // Cookies stay valid for one rotation window so open clients keep working
+  // while the JWT path rolls out; both paths yield the same Session.
+  if (bearer?.startsWith("Bearer ")) {
+    const token = yield* verifySignedToken(bearer.slice("Bearer ".length));
+    return sessionFromToken(token);
   }
+  if (cookie === null) return yield* new SessionMissingError();
   return yield* lookupSession(cookie.sessionId);
 });
+
+function sessionFromToken(token: SignedToken) {
+  return { sessionId: token.sub, expiresAt: token.exp, rotation: token.rot };
+}
diff --git a/apps/server/src/auth/signedToken.ts b/apps/server/src/auth/signedToken.ts
new file mode 100644
--- /dev/null
+++ b/apps/server/src/auth/signedToken.ts
@@ -0,0 +1,18 @@
+import * as Effect from "effect/Effect";
+import * as Schema from "effect/Schema";
+
+export const SignedToken = Schema.Struct({
+  sub: Schema.String,
+  exp: Schema.String,
+  rot: Schema.Number,
+});
+export type SignedToken = typeof SignedToken.Type;
+
+export const verifySignedToken = Effect.fn("verifySignedToken")(function* (raw: string) {
+  const [payload, signature] = raw.split(".");
+  if (payload === undefined || signature === undefined) {
+    return yield* new TokenMalformedError({ raw });
+  }
+  yield* checkSignature(payload, signature);
+  return yield* Schema.decodeUnknownEffect(SignedToken)(JSON.parse(atob(payload)));
+});
`;

const AUTH_IMPL_FAILED_PATCH = `diff --git a/apps/server/src/auth/session.ts b/apps/server/src/auth/session.ts
--- a/apps/server/src/auth/session.ts
+++ b/apps/server/src/auth/session.ts
@@ -24,9 +24,8 @@ export const readSession = Effect.fn("readSession")(function* (request: Request)
-  const cookie = parseCookie(request.headers.get("cookie"));
-  if (cookie === null) {
-    return yield* new SessionMissingError();
-  }
-  return yield* lookupSession(cookie.sessionId);
+  const bearer = request.headers.get("authorization");
+  if (bearer === null) return yield* new SessionMissingError();
+  return sessionFromToken(yield* verifySignedToken(bearer.slice(7)));
 });
`;

const VITEST_OK = [
  "$ vp test run apps/server/test/checkpoint.test.ts",
  "",
  " ✓ apps/server/test/checkpoint.test.ts (12 tests) 1842ms",
  "",
  " Test Files  1 passed (1)",
  "      Tests  12 passed (12)",
  "   Start at  09:18:41",
  "   Duration  3.21s",
];

const AUTH_FAILED_TERMINAL = [
  "$ vp test run apps/server/src/auth/session.test.ts",
  "",
  " ❯ apps/server/src/auth/session.test.ts (12 tests | 4 failed) 912ms",
  "   × reads a legacy cookie session",
  "     → SessionMissingError: no session on request",
  "   × keeps a cookie session for one rotation window",
  "     → SessionMissingError: no session on request",
  "   × rejects a tampered bearer token",
  "     → TypeError: Cannot read properties of undefined (reading 'split')",
  "   × rotates on expiry",
  "",
  " Test Files  1 failed (1)",
  "      Tests  4 failed | 8 passed (12)",
];

const AUTH_RETRY_TERMINAL = [
  "$ vp test run apps/server/src/auth",
  "",
  " ✓ apps/server/src/auth/session.test.ts (12 tests) 1104ms",
  " ✓ apps/server/src/auth/signedToken.test.ts (6 tests) 233ms",
  "",
  " Test Files  2 passed (2)",
  "      Tests  18 passed (18)",
];

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

const baseline: FixtureEvent[] = [
  {
    type: "project.added",
    at: daysAgo(40),
    project: { id: PROJECT_T3, title: "t3code", workspaceRoot: WORKSPACE_T3 },
  },
  {
    type: "project.added",
    at: daysAgo(40),
    project: { id: PROJECT_INFRA, title: "infra", workspaceRoot: WORKSPACE_INFRA },
  },
  {
    type: "thread.created",
    at: daysAgo(21),
    thread: seed(COORDINATOR_ID, "Platform coordinator", "claude", { branch: "main" }),
    prompt:
      "You are the long-lived coordinator for platform work. Delegate to child threads, group related work into efforts, wait durably, and summarize for me. Do not implement anything yourself.",
    status: "completed",
  },
  { type: "thread.pinned", at: daysAgo(21), threadId: COORDINATOR_ID },
  {
    type: "thread.message",
    at: daysAgo(21, 1),
    threadId: COORDINATOR_ID,
    role: "assistant",
    text: "Understood. I will open an effort per goal, delegate with clear briefs, and only report back with decisions you need to make.",
  },

  // Unrelated threads in both projects.
  {
    type: "thread.created",
    at: daysAgo(3),
    thread: seed("thread-tooltip", "Fix sidebar tooltip flicker", "codex", {
      branch: "fix/tooltip-flicker",
    }),
    prompt:
      "The sidebar tooltip flickers when hovering fast across rows. Find the cause and fix it.",
    status: "completed",
  },
  {
    type: "thread.message",
    at: daysAgo(3, 22),
    threadId: "thread-tooltip",
    role: "assistant",
    text: "The tooltip re-mounted on every row hover because the trigger key included the hover timestamp. Keyed it on the thread id and the flicker is gone.",
  },
  {
    type: "thread.created",
    at: daysAgo(0, -55),
    thread: seed("thread-ws", "Investigate WS reconnect storm", "claude", {
      branch: "fix/ws-reconnect",
      worktree: true,
    }),
    prompt: "Relay clients reconnect in a tight loop after a server restart. Reproduce and fix.",
  },
  {
    type: "thread.status",
    at: daysAgo(0, -40),
    threadId: "thread-ws",
    status: "running",
    activity: "Bisecting the backoff schedule",
  },
  {
    type: "thread.created",
    at: daysAgo(6),
    thread: seed("thread-vite", "Bump vite-plus to 0.4", "codex"),
    prompt: "Bump vite-plus to 0.4 and fix whatever breaks.",
    status: "completed",
  },
  {
    type: "thread.message",
    at: daysAgo(6, 12),
    threadId: "thread-vite",
    role: "assistant",
    text: "Bumped. One config key renamed; lint and typecheck pass.",
  },
  {
    type: "thread.created",
    at: daysAgo(2),
    thread: seed("thread-relay", "Rotate relay tokens", "claude", { projectId: PROJECT_INFRA }),
    prompt: "Rotate the relay bearer tokens for all hosts and roll them out.",
    status: "completed",
  },
  {
    type: "thread.message",
    at: daysAgo(2, 9),
    threadId: "thread-relay",
    role: "assistant",
    text: "Rotated on srv-1 and srv-2. Old tokens expire tonight.",
  },
  {
    type: "thread.created",
    at: daysAgo(0, -30),
    thread: seed("thread-zram", "nixos: enable zram on srv-2", "codex", {
      projectId: PROJECT_INFRA,
      branch: "srv-2/zram",
    }),
    prompt: "Enable zram swap on srv-2 with a sane default and document it.",
  },
  {
    type: "thread.status",
    at: daysAgo(0, -12),
    threadId: "thread-zram",
    status: "running",
    activity: "Writing the module option",
  },

  // A closed effort from last week: three competing implementations.
  {
    type: "thread.message",
    at: daysAgo(5),
    threadId: COORDINATOR_ID,
    role: "user",
    text: "checkpoint.test.ts flakes about one run in five on CI. Fan the fix out to Codex, Claude and GLM in separate worktrees, then tell me which fix to take.",
  },
  {
    type: "effort.opened",
    at: daysAgo(5, 1),
    effortId: EFFORT_FLAKE,
    coordinatorId: COORDINATOR_ID,
    title: "Checkpoint flake",
  },
  {
    type: "thread.created",
    at: daysAgo(5, 1),
    thread: seed("thread-flake-codex", "Codex · checkpoint fix", "codex", {
      branch: "fix/checkpoint-flake-codex",
      worktree: true,
    }),
    prompt:
      "Find and fix the race behind the flaky checkpoint restore test. Keep the fix minimal; no retries, no sleeps.",
    status: "completed",
    delegation: {
      parentId: COORDINATOR_ID,
      label: "Codex",
      effortId: EFFORT_FLAKE,
      turnId: "turn-flake",
    },
  },
  {
    type: "thread.created",
    at: daysAgo(5, 1),
    thread: seed("thread-flake-claude", "Claude · checkpoint fix", "claude", {
      branch: "fix/checkpoint-flake-claude",
      worktree: true,
    }),
    prompt:
      "Find and fix the race behind the flaky checkpoint restore test. Keep the fix minimal; no retries, no sleeps.",
    status: "completed",
    delegation: {
      parentId: COORDINATOR_ID,
      label: "Claude",
      effortId: EFFORT_FLAKE,
      turnId: "turn-flake",
    },
  },
  {
    type: "thread.created",
    at: daysAgo(5, 1),
    thread: seed("thread-flake-glm", "GLM · checkpoint fix", "glm", {
      branch: "fix/checkpoint-flake-glm",
      worktree: true,
    }),
    prompt:
      "Find and fix the race behind the flaky checkpoint restore test. Keep the fix minimal; no retries, no sleeps.",
    status: "completed",
    delegation: {
      parentId: COORDINATOR_ID,
      label: "GLM",
      effortId: EFFORT_FLAKE,
      turnId: "turn-flake",
    },
  },
  {
    type: "thread.artifacts",
    at: daysAgo(5, 6),
    threadId: "thread-flake-codex",
    artifacts: {
      patch: FLAKE_CODEX_PATCH,
      files: [
        {
          path: "apps/server/src/checkpointing/restore.ts",
          kind: "modified",
          additions: 5,
          deletions: 8,
        },
      ],
      terminal: { label: "vitest", lines: VITEST_OK },
    },
  },
  {
    type: "thread.message",
    at: daysAgo(5, 6),
    threadId: "thread-flake-codex",
    role: "assistant",
    text: "The restore slept 50ms and then read the latest receipt, which on a slow runner was still the previous one. I subscribe to the checkpoint receipt before checking out and await it, so there is no timing window. 12 of 12 pass across 40 local runs.",
  },
  {
    type: "thread.artifacts",
    at: daysAgo(5, 8),
    threadId: "thread-flake-claude",
    artifacts: {
      patch: FLAKE_CLAUDE_PATCH,
      files: [
        {
          path: "apps/server/src/checkpointing/CheckpointReactor.ts",
          kind: "modified",
          additions: 10,
          deletions: 1,
        },
      ],
      terminal: { label: "vitest", lines: VITEST_OK },
    },
  },
  {
    type: "thread.message",
    at: daysAgo(5, 8),
    threadId: "thread-flake-claude",
    role: "assistant",
    text: "Two restores for the same thread could overlap and each observe the other's tree. I serialize restores per thread through the reactor queue. This also fixes the receipt mismatch, but it is a broader change than the test strictly needs.",
  },
  {
    type: "thread.artifacts",
    at: daysAgo(5, 4),
    threadId: "thread-flake-glm",
    artifacts: {
      patch: FLAKE_GLM_PATCH,
      files: [
        {
          path: "apps/server/test/checkpoint.test.ts",
          kind: "modified",
          additions: 1,
          deletions: 1,
        },
      ],
      terminal: { label: "vitest", lines: VITEST_OK },
    },
  },
  {
    type: "thread.message",
    at: daysAgo(5, 4),
    threadId: "thread-flake-glm",
    role: "assistant",
    text: "Added `retry: 3` to the flaky case. The test is green in CI.",
  },
  {
    type: "thread.message",
    at: daysAgo(5, 10),
    threadId: COORDINATOR_ID,
    role: "assistant",
    text: "Take Codex. It removes the sleep and waits on the receipt the reactor already emits, which is the actual invariant. Claude's per-thread queue also works but changes reactor scheduling for every restore. GLM papered over it with a retry, which the brief forbade.",
  },
  { type: "effort.closed", at: daysAgo(5, 11), effortId: EFFORT_FLAKE, stopMembers: false },

  // An ungrouped delegation, grouped by its launching turn.
  {
    type: "thread.message",
    at: daysAgo(1),
    threadId: COORDINATOR_ID,
    role: "user",
    text: "Bump the vendored GhosttyKit to the latest tag while you're at it.",
  },
  {
    type: "thread.created",
    at: daysAgo(1, 1),
    thread: seed("thread-ghostty", "Bump vendored GhosttyKit", "codex", {
      branch: "chore/ghostty-bump",
    }),
    prompt:
      "Bump the vendored GhosttyKit to the latest tag and update the terminal integration if the API moved.",
    status: "completed",
    delegation: {
      parentId: COORDINATOR_ID,
      label: "GhosttyKit bump",
      effortId: null,
      turnId: "turn-ghostty",
    },
  },
  {
    type: "thread.message",
    at: daysAgo(1, 25),
    threadId: "thread-ghostty",
    role: "assistant",
    text: "Bumped to 1.2.4. One renamed callback in the terminal bridge; desktop builds and the terminal smoke test pass.",
  },
];

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const AUTH_RESEARCH_ANSWER = `## Session layer today

- **Three entry points** read the cookie: \`readSession\` in the HTTP layer, the WebSocket upgrade handler, and the relay pairing flow.
- Cookies are opaque ids looked up in \`sessions\`; there is no expiry rotation, only absolute expiry after 30 days.
- The mobile client already sends a bearer header on every request, so a token path can ship without a client release.

## Risks

1. The relay pairing flow shares the cookie parser; changing its shape breaks paired mobile devices.
2. Tests stub \`lookupSession\` directly in 14 places.`;

const AUTH_PLAN_ANSWER = `## Plan

1. Add \`signedToken.ts\` with verify and rotate. Keep cookie sessions valid for one rotation window.
2. Route \`readSession\` through both paths and return one \`Session\` shape.
3. Migrate the WebSocket upgrade and relay pairing to the shared reader. No parser change for pairing.
4. Add a \`token_rotations\` table; a migration is needed in test and dev.
5. Replace the 14 \`lookupSession\` stubs with a session harness.

Two reviewers afterwards: security on the token format, compatibility on the cookie window.`;

const DEBATE_ADVOCATE = `**Position: "environment" everywhere.**

It is already the word in the glossary and in the contracts. A host is a machine; an environment is one running server with its state, which is what users actually connect to. Two servers on one machine are two environments and one host, and the docs must be able to say that.`;

const DEBATE_CRITIC = `**Position: "host" in user docs, "environment" in internals.**

Users think in machines: "my Mac", "the server". Nobody pairs with an environment. The glossary word is right for contributors and wrong for the pairing screen. Use "host" wherever a user picks a machine, keep "environment" in code and internals.`;

const DEBATE_PROPOSAL = `## Proposal

Use **environment** as the noun in user docs and UI, with one sentence of onboarding copy that says an environment is a running T3 server on a machine. Keep "host" only inside "remote host" for tunnels, where the phrase already exists.

Why not "host": the two-servers-on-one-machine case is real (desktop plus \`npx t3\`) and "host" cannot express it. The Critic's onboarding concern is met by the one-sentence definition rather than a second vocabulary.

Changes: 6 doc pages, 2 UI strings, glossary unchanged.`;

export const FIXTURE_STEPS: ReadonlyArray<FixtureStep> = [
  {
    caption:
      "Baseline: coordinator with a closed effort, an ungrouped delegation, and unrelated threads",
    at: daysAgo(0, -5),
    events: baseline,
  },
  {
    caption: "Coordinator opens Auth migration, launches Research, and waits on it",
    at: at(0),
    events: [
      {
        type: "thread.message",
        at: at(0),
        threadId: COORDINATOR_ID,
        role: "user",
        text: "Kick off the auth migration: session cookies to signed tokens with rotation. Research first, then plan, then implement, then review. Keep me out of it unless something needs a decision.",
      },
      {
        type: "thread.status",
        at: at(0),
        threadId: COORDINATOR_ID,
        status: "running",
        activity: "Opening the effort",
      },
      {
        type: "effort.opened",
        at: at(1),
        effortId: EFFORT_AUTH,
        coordinatorId: COORDINATOR_ID,
        title: "Auth migration",
      },
      {
        type: "thread.created",
        at: at(1),
        thread: seed("thread-auth-research", "Auth migration · research", "codex"),
        prompt:
          "Survey the current session layer: every place that reads the session cookie, its lifetime rules, and what the mobile client sends. Report risks. Do not change code.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Research",
          effortId: EFFORT_AUTH,
          turnId: "turn-auth-1",
        },
      },
      {
        type: "thread.status",
        at: at(2),
        threadId: "thread-auth-research",
        status: "running",
        activity: "Reading apps/server/src/auth",
      },
      {
        type: "wait.opened",
        at: at(1),
        waitId: "wait-research",
        threadId: COORDINATOR_ID,
        targets: ["thread-auth-research"],
        condition: "all",
      },
      {
        type: "thread.message",
        at: at(1),
        threadId: COORDINATOR_ID,
        role: "assistant",
        text: "Opened **Auth migration**. Research is surveying the session layer; I will plan once it reports and only come back to you for decisions.",
      },
      {
        type: "thread.status",
        at: at(1),
        threadId: COORDINATOR_ID,
        status: "completed",
        activity: "Waiting on Research",
      },
    ],
  },
  {
    caption: "Research finishes; the wait is satisfied, the coordinator wakes and launches Plan",
    at: at(14),
    events: [
      {
        type: "thread.artifacts",
        at: at(13),
        threadId: "thread-auth-research",
        artifacts: { answer: AUTH_RESEARCH_ANSWER },
      },
      {
        type: "thread.message",
        at: at(13),
        threadId: "thread-auth-research",
        role: "assistant",
        text: AUTH_RESEARCH_ANSWER,
      },
      {
        type: "thread.status",
        at: at(13),
        threadId: "thread-auth-research",
        status: "completed",
        activity: "Report delivered",
      },
      {
        type: "thread.status",
        at: at(14),
        threadId: COORDINATOR_ID,
        status: "running",
        activity: "Reading the research report",
      },
      {
        type: "thread.message",
        at: at(14),
        threadId: COORDINATOR_ID,
        role: "assistant",
        text: "Research found three session entry points and a shared cookie parser with relay pairing. The mobile client already sends a bearer header, so the token path can ship without a client release. Launching Plan with those constraints.",
      },
      {
        type: "thread.created",
        at: at(14),
        thread: seed("thread-auth-plan", "Auth migration · plan", "claude"),
        prompt:
          "Using the research report below, write an implementation plan for cookie-to-signed-token migration with rotation. Keep cookie sessions valid for one rotation window. Name the reviewers we will need.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Plan",
          effortId: EFFORT_AUTH,
          turnId: "turn-auth-2",
        },
      },
      {
        type: "thread.status",
        at: at(15),
        threadId: "thread-auth-plan",
        status: "running",
        activity: "Drafting the plan",
      },
      {
        type: "wait.opened",
        at: at(14),
        waitId: "wait-plan",
        threadId: COORDINATOR_ID,
        targets: ["thread-auth-plan"],
        condition: "all",
      },
      {
        type: "thread.status",
        at: at(14),
        threadId: COORDINATOR_ID,
        status: "completed",
        activity: "Waiting on Plan",
      },
    ],
  },
  {
    caption: "Plan lands; Implementation starts in its own worktree",
    at: at(31),
    events: [
      {
        type: "thread.artifacts",
        at: at(30),
        threadId: "thread-auth-plan",
        artifacts: { answer: AUTH_PLAN_ANSWER },
      },
      {
        type: "thread.message",
        at: at(30),
        threadId: "thread-auth-plan",
        role: "assistant",
        text: AUTH_PLAN_ANSWER,
      },
      {
        type: "thread.status",
        at: at(30),
        threadId: "thread-auth-plan",
        status: "completed",
        activity: "Plan delivered",
      },
      {
        type: "thread.status",
        at: at(31),
        threadId: COORDINATOR_ID,
        status: "running",
        activity: "Reading the plan",
      },
      {
        type: "thread.message",
        at: at(31),
        threadId: COORDINATOR_ID,
        role: "assistant",
        text: "Plan is five steps with one migration. Implementation runs in a worktree on `feat/auth-jwt`; I will add security and compatibility reviewers when it lands.",
      },
      {
        type: "thread.created",
        at: at(31),
        thread: seed("thread-auth-impl", "Auth migration · implementation", "codex", {
          branch: "feat/auth-jwt",
          worktree: true,
        }),
        prompt:
          "Implement the plan below on feat/auth-jwt. Keep cookie sessions valid for one rotation window. Run the auth tests before reporting.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Implementation",
          effortId: EFFORT_AUTH,
          turnId: "turn-auth-3",
        },
      },
      {
        type: "thread.status",
        at: at(32),
        threadId: "thread-auth-impl",
        status: "running",
        activity: "Adding signedToken.ts",
      },
      {
        type: "wait.opened",
        at: at(31),
        waitId: "wait-impl",
        threadId: COORDINATOR_ID,
        targets: ["thread-auth-impl"],
        condition: "all",
      },
      {
        type: "thread.status",
        at: at(31),
        threadId: COORDINATOR_ID,
        status: "completed",
        activity: "Waiting on Implementation",
      },
    ],
  },
  {
    caption:
      "Implementation fails its tests; the coordinator replaces it with a retry seeded with the failure",
    at: at(58),
    events: [
      {
        type: "thread.artifacts",
        at: at(56),
        threadId: "thread-auth-impl",
        artifacts: {
          patch: AUTH_IMPL_FAILED_PATCH,
          files: [
            {
              path: "apps/server/src/auth/session.ts",
              kind: "modified",
              additions: 3,
              deletions: 5,
            },
          ],
          terminal: { label: "vitest", lines: AUTH_FAILED_TERMINAL },
        },
      },
      {
        type: "thread.message",
        at: at(56),
        threadId: "thread-auth-impl",
        role: "assistant",
        text: "4 of 12 session tests fail. I dropped the cookie path entirely, which breaks the rotation-window requirement, and the bearer parser assumes a header is always present. Stopping here rather than patching around it.",
      },
      {
        type: "thread.status",
        at: at(56),
        threadId: "thread-auth-impl",
        status: "failed",
        activity: "12 tests, 4 failed",
      },
      {
        type: "thread.status",
        at: at(57),
        threadId: COORDINATOR_ID,
        status: "running",
        activity: "Reading the failure",
      },
      {
        type: "thread.message",
        at: at(57),
        threadId: COORDINATOR_ID,
        role: "assistant",
        text: "Implementation dropped the cookie path and failed the compatibility tests. Replacing it with a fresh worker seeded with the failing output and the plan's rotation-window rule; the wait carries over.",
      },
      {
        type: "thread.created",
        at: at(58),
        thread: seed(
          "thread-auth-impl-retry",
          "Auth migration · implementation (retry)",
          "claude",
          { branch: "feat/auth-jwt", worktree: true },
        ),
        prompt:
          "Implement the plan on feat/auth-jwt. The previous attempt failed these tests (output below) by removing the cookie path. Both paths must yield the same Session for one rotation window.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Implementation (retry)",
          effortId: EFFORT_AUTH,
          turnId: "turn-auth-4",
        },
        replaces: "thread-auth-impl",
      },
      {
        type: "thread.status",
        at: at(59),
        threadId: "thread-auth-impl-retry",
        status: "running",
        activity: "Restoring the cookie path",
      },
      {
        type: "thread.status",
        at: at(58),
        threadId: COORDINATOR_ID,
        status: "completed",
        activity: "Waiting on Implementation (retry)",
      },
    ],
  },
  {
    caption: "The retry blocks on an approval; the wait shows blocked and the coordinator is told",
    at: at(72),
    events: [
      {
        type: "approval.requested",
        at: at(72),
        threadId: "thread-auth-impl-retry",
        text: "Run `bun run db:migrate --env test` to add the token_rotations table?",
      },
    ],
  },
  {
    caption: "The approval is granted and the retry resumes",
    at: at(75),
    events: [
      { type: "approval.resolved", at: at(75), threadId: "thread-auth-impl-retry", approved: true },
    ],
  },
  {
    caption:
      "Retry lands with green tests; two reviewers are added and the coordinator waits on both",
    at: at(101),
    events: [
      {
        type: "thread.artifacts",
        at: at(100),
        threadId: "thread-auth-impl-retry",
        artifacts: {
          patch: AUTH_IMPL_RETRY_PATCH,
          files: [
            {
              path: "apps/server/src/auth/session.ts",
              kind: "modified",
              additions: 14,
              deletions: 4,
            },
            {
              path: "apps/server/src/auth/signedToken.ts",
              kind: "added",
              additions: 18,
              deletions: 0,
            },
            {
              path: "apps/server/src/auth/signedToken.test.ts",
              kind: "added",
              additions: 41,
              deletions: 0,
            },
            {
              path: "apps/server/src/persistence/Migrations/061_TokenRotations.ts",
              kind: "added",
              additions: 22,
              deletions: 0,
            },
          ],
          terminal: { label: "vitest", lines: AUTH_RETRY_TERMINAL },
        },
      },
      {
        type: "thread.message",
        at: at(100),
        threadId: "thread-auth-impl-retry",
        role: "assistant",
        text: "Both paths read through `readSession` and return one Session. Cookies stay valid for one rotation window. 18 tests pass, including the four that failed before. Migration 061 adds `token_rotations`.",
      },
      {
        type: "thread.status",
        at: at(100),
        threadId: "thread-auth-impl-retry",
        status: "completed",
        activity: "18 tests passed",
      },
      {
        type: "thread.status",
        at: at(101),
        threadId: COORDINATOR_ID,
        status: "running",
        activity: "Reading the implementation report",
      },
      {
        type: "thread.message",
        at: at(101),
        threadId: COORDINATOR_ID,
        role: "assistant",
        text: "Implementation landed on `feat/auth-jwt` with 18 green tests. Adding two reviewers: security on the token format and compatibility on the cookie window. I will summarize once both report.",
      },
      {
        type: "thread.created",
        at: at(101),
        thread: seed("thread-auth-rev-a", "Auth migration · security review", "codex"),
        prompt:
          "Review feat/auth-jwt for token format, signature checks, and rotation. Report findings with severity. Do not change code.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Reviewer A · security",
          effortId: EFFORT_AUTH,
          turnId: "turn-auth-5",
        },
      },
      {
        type: "thread.created",
        at: at(101),
        thread: seed("thread-auth-rev-b", "Auth migration · compat review", "glm"),
        prompt:
          "Review feat/auth-jwt for cookie compatibility during the rotation window and relay pairing. Report findings with severity. Do not change code.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Reviewer B · compat",
          effortId: EFFORT_AUTH,
          turnId: "turn-auth-5",
        },
      },
      {
        type: "thread.status",
        at: at(102),
        threadId: "thread-auth-rev-a",
        status: "running",
        activity: "Reading signedToken.ts",
      },
      {
        type: "thread.status",
        at: at(102),
        threadId: "thread-auth-rev-b",
        status: "running",
        activity: "Tracing the pairing flow",
      },
      {
        type: "wait.opened",
        at: at(101),
        waitId: "wait-review",
        threadId: COORDINATOR_ID,
        targets: ["thread-auth-rev-a", "thread-auth-rev-b"],
        condition: "all",
      },
      {
        type: "thread.status",
        at: at(101),
        threadId: COORDINATOR_ID,
        status: "completed",
        activity: "Waiting on 2 reviewers",
      },
    ],
  },
  {
    caption:
      "Docs refresh: three cooperating workers on one workspace; Content spawns two page workers",
    at: at(110),
    events: [
      {
        type: "thread.message",
        at: at(108),
        threadId: COORDINATOR_ID,
        role: "user",
        text: "Also refresh the docs site: navigation, content, and styling in parallel on docs/refresh. Don't block on auth.",
      },
      {
        type: "thread.status",
        at: at(108),
        threadId: COORDINATOR_ID,
        status: "running",
        activity: "Opening the docs effort",
      },
      {
        type: "effort.opened",
        at: at(109),
        effortId: EFFORT_DOCS,
        coordinatorId: COORDINATOR_ID,
        title: "Docs site refresh",
      },
      {
        type: "thread.created",
        at: at(109),
        thread: seed("thread-docs-nav", "Docs refresh · navigation", "claude", {
          branch: "docs/refresh",
        }),
        prompt:
          "Restructure the docs navigation on docs/refresh: one sidebar tree, user and internals split at the top. Coordinate with Content and Styling; you share the checkout.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Navigation",
          effortId: EFFORT_DOCS,
          turnId: "turn-docs-1",
        },
      },
      {
        type: "thread.created",
        at: at(109),
        thread: seed("thread-docs-content", "Docs refresh · content", "codex", {
          branch: "docs/refresh",
        }),
        prompt:
          "Rewrite the user docs pages on docs/refresh in shipped-product voice. Delegate per page if it helps. You share the checkout with Navigation and Styling.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Content",
          effortId: EFFORT_DOCS,
          turnId: "turn-docs-1",
        },
      },
      {
        type: "thread.created",
        at: at(109),
        thread: seed("thread-docs-style", "Docs refresh · styling", "glm", {
          branch: "docs/refresh",
        }),
        prompt:
          "Restyle the docs site on docs/refresh to match the app's density and type scale. Keep the preview running so others can look.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Styling",
          effortId: EFFORT_DOCS,
          turnId: "turn-docs-1",
        },
      },
      {
        type: "thread.status",
        at: at(110),
        threadId: "thread-docs-nav",
        status: "running",
        activity: "Building the sidebar tree",
      },
      {
        type: "thread.status",
        at: at(110),
        threadId: "thread-docs-content",
        status: "running",
        activity: "Splitting page work",
      },
      {
        type: "thread.status",
        at: at(110),
        threadId: "thread-docs-style",
        status: "running",
        activity: "Porting the type scale",
      },
      {
        type: "wait.opened",
        at: at(109),
        waitId: "wait-docs",
        threadId: COORDINATOR_ID,
        targets: ["thread-docs-nav", "thread-docs-content", "thread-docs-style"],
        condition: "all",
      },
      {
        type: "thread.message",
        at: at(109),
        threadId: COORDINATOR_ID,
        role: "assistant",
        text: "Opened **Docs site refresh** with Navigation, Content and Styling on one checkout. They coordinate directly; I will integrate when all three report.",
      },
      {
        type: "thread.status",
        at: at(109),
        threadId: COORDINATOR_ID,
        status: "completed",
        activity: "Waiting on 2 reviewers and 3 docs workers",
      },
      {
        type: "thread.message",
        at: at(110),
        threadId: "thread-docs-content",
        role: "assistant",
        text: "Eleven pages. The two longest, remote setup and providers, go to their own workers so the rest can move.",
      },
      {
        type: "thread.created",
        at: at(110),
        thread: seed("thread-docs-page-remote", "Docs refresh · remote setup page", "codex", {
          branch: "docs/refresh",
        }),
        prompt:
          "Rewrite docs/user/remote.md in shipped-product voice. Cover Tailscale, T3 Connect, and pairing. Same checkout.",
        delegation: {
          parentId: "thread-docs-content",
          label: "Remote setup page",
          effortId: EFFORT_DOCS,
          turnId: "turn-content-1",
        },
      },
      {
        type: "thread.created",
        at: at(110),
        thread: seed("thread-docs-page-providers", "Docs refresh · providers page", "codex", {
          branch: "docs/refresh",
        }),
        prompt:
          "Rewrite docs/user/providers.md in shipped-product voice. One section per provider. Same checkout.",
        delegation: {
          parentId: "thread-docs-content",
          label: "Providers page",
          effortId: EFFORT_DOCS,
          turnId: "turn-content-1",
        },
      },
      {
        type: "thread.status",
        at: at(111),
        threadId: "thread-docs-page-remote",
        status: "running",
        activity: "Rewriting the pairing section",
      },
      {
        type: "thread.status",
        at: at(111),
        threadId: "thread-docs-page-providers",
        status: "running",
        activity: "Rewriting the Codex section",
      },
      {
        type: "wait.opened",
        at: at(110),
        waitId: "wait-content",
        threadId: "thread-docs-content",
        targets: ["thread-docs-page-remote", "thread-docs-page-providers"],
        condition: "all",
      },
      {
        type: "thread.status",
        at: at(110),
        threadId: "thread-docs-content",
        status: "completed",
        activity: "Waiting on 2 pages",
      },
    ],
  },
  {
    caption: "Navigation and Styling bring up previews; the first page draft lands",
    at: at(125),
    events: [
      {
        type: "thread.artifacts",
        at: at(122),
        threadId: "thread-docs-nav",
        artifacts: {
          preview: { url: "http://localhost:5173/docs/", variant: "nav" },
          files: [
            { path: "docs/site/nav.ts", kind: "modified", additions: 48, deletions: 31 },
            { path: "docs/site/Sidebar.astro", kind: "modified", additions: 22, deletions: 9 },
          ],
        },
      },
      {
        type: "thread.message",
        at: at(122),
        threadId: "thread-docs-nav",
        role: "assistant",
        text: "Preview is up on :5173. The tree splits User and Internals at the top; Operations folds under Internals. Styling, your type scale changes will land on top of this, I did not touch CSS.",
      },
      {
        type: "thread.status",
        at: at(122),
        threadId: "thread-docs-nav",
        status: "running",
        activity: "Tightening the tree indentation",
      },
      {
        type: "thread.message",
        at: at(123),
        threadId: "thread-docs-style",
        role: "user",
        fromId: "thread-docs-nav",
        text: "Nav tree is in. Your type scale changes will land on top of this; I did not touch CSS.",
      },
      {
        type: "thread.artifacts",
        at: at(124),
        threadId: "thread-docs-style",
        artifacts: {
          preview: { url: "http://localhost:5174/docs/", variant: "style" },
          files: [
            { path: "docs/site/styles/tokens.css", kind: "modified", additions: 64, deletions: 40 },
            { path: "docs/site/styles/prose.css", kind: "modified", additions: 19, deletions: 12 },
          ],
        },
      },
      {
        type: "thread.message",
        at: at(124),
        threadId: "thread-docs-style",
        role: "assistant",
        text: "Second preview on :5174 with the app's type scale and 13px body. Compare it against Navigation's :5173 to see the density change on the same pages.",
      },
      {
        type: "thread.status",
        at: at(124),
        threadId: "thread-docs-style",
        status: "running",
        activity: "Matching sidebar row height",
      },
      {
        type: "thread.message",
        at: at(125),
        threadId: "thread-docs-page-remote",
        role: "assistant",
        text: "Remote setup rewritten: Tailscale, T3 Connect, and pairing each get one task-shaped section. 212 lines, no source paths.",
      },
      {
        type: "thread.artifacts",
        at: at(125),
        threadId: "thread-docs-page-remote",
        artifacts: {
          files: [{ path: "docs/user/remote.md", kind: "modified", additions: 140, deletions: 96 }],
        },
      },
      {
        type: "thread.status",
        at: at(125),
        threadId: "thread-docs-page-remote",
        status: "completed",
        activity: "Page delivered",
      },
    ],
  },
  {
    caption: "Naming debate: three agents exchange handoffs and the Moderator posts a proposal",
    at: at(140),
    events: [
      {
        type: "thread.message",
        at: at(132),
        threadId: COORDINATOR_ID,
        role: "user",
        text: "Before the docs bikeshed further: settle 'environment' vs 'host' in user docs. Run a short debate and bring me one proposal.",
      },
      {
        type: "thread.status",
        at: at(132),
        threadId: COORDINATOR_ID,
        status: "running",
        activity: "Setting up the debate",
      },
      {
        type: "effort.opened",
        at: at(133),
        effortId: EFFORT_NAMING,
        coordinatorId: COORDINATOR_ID,
        title: "Naming debate",
      },
      {
        type: "thread.created",
        at: at(133),
        thread: seed("thread-deb-advocate", "Naming · advocate", "claude"),
        prompt:
          "Argue for using 'environment' everywhere in user docs. Send your position to the Moderator thread, answer its questions, and stop.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Advocate",
          effortId: EFFORT_NAMING,
          turnId: "turn-naming-1",
        },
      },
      {
        type: "thread.created",
        at: at(133),
        thread: seed("thread-deb-critic", "Naming · critic", "codex"),
        prompt:
          "Argue for 'host' in user docs and 'environment' only in internals. Send your position to the Moderator thread, answer its questions, and stop.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Critic",
          effortId: EFFORT_NAMING,
          turnId: "turn-naming-1",
        },
      },
      {
        type: "thread.created",
        at: at(133),
        thread: seed("thread-deb-moderator", "Naming · moderator", "glm"),
        prompt:
          "Collect the Advocate's and Critic's positions, ask each one question, then write one proposal with the change list. Report the proposal as your final message.",
        delegation: {
          parentId: COORDINATOR_ID,
          label: "Moderator",
          effortId: EFFORT_NAMING,
          turnId: "turn-naming-1",
        },
      },
      {
        type: "wait.opened",
        at: at(133),
        waitId: "wait-naming",
        threadId: COORDINATOR_ID,
        targets: ["thread-deb-moderator"],
        condition: "all",
      },
      {
        type: "thread.status",
        at: at(133),
        threadId: COORDINATOR_ID,
        status: "completed",
        activity: "Waiting on the Moderator",
      },
      {
        type: "thread.message",
        at: at(134),
        threadId: "thread-deb-advocate",
        role: "assistant",
        text: DEBATE_ADVOCATE,
      },
      {
        type: "thread.artifacts",
        at: at(134),
        threadId: "thread-deb-advocate",
        artifacts: { answer: DEBATE_ADVOCATE },
      },
      {
        type: "thread.message",
        at: at(134),
        threadId: "thread-deb-moderator",
        role: "user",
        fromId: "thread-deb-advocate",
        text: DEBATE_ADVOCATE,
      },
      {
        type: "thread.message",
        at: at(135),
        threadId: "thread-deb-critic",
        role: "assistant",
        text: DEBATE_CRITIC,
      },
      {
        type: "thread.artifacts",
        at: at(135),
        threadId: "thread-deb-critic",
        artifacts: { answer: DEBATE_CRITIC },
      },
      {
        type: "thread.message",
        at: at(135),
        threadId: "thread-deb-moderator",
        role: "user",
        fromId: "thread-deb-critic",
        text: DEBATE_CRITIC,
      },
      {
        type: "thread.message",
        at: at(136),
        threadId: "thread-deb-advocate",
        role: "user",
        fromId: "thread-deb-moderator",
        text: "How would a first-time user learn the word 'environment' before the pairing screen asks them to pick one?",
      },
      {
        type: "thread.message",
        at: at(137),
        threadId: "thread-deb-advocate",
        role: "assistant",
        text: "One sentence on the pairing screen: 'An environment is a running T3 Code server on a machine.' That is cheaper than teaching two words.",
      },
      {
        type: "thread.message",
        at: at(137),
        threadId: "thread-deb-moderator",
        role: "user",
        fromId: "thread-deb-advocate",
        text: "One sentence on the pairing screen: 'An environment is a running T3 Code server on a machine.' That is cheaper than teaching two words.",
      },
      {
        type: "thread.message",
        at: at(136),
        threadId: "thread-deb-critic",
        role: "user",
        fromId: "thread-deb-moderator",
        text: "How does 'host' describe the desktop app and `npx t3` running on the same Mac?",
      },
      {
        type: "thread.message",
        at: at(138),
        threadId: "thread-deb-critic",
        role: "assistant",
        text: "It does not, cleanly. I would call them 'two servers on one host', which admits that 'host' alone is not enough for that case.",
      },
      {
        type: "thread.message",
        at: at(138),
        threadId: "thread-deb-moderator",
        role: "user",
        fromId: "thread-deb-critic",
        text: "It does not, cleanly. I would call them 'two servers on one host', which admits that 'host' alone is not enough for that case.",
      },
      {
        type: "thread.status",
        at: at(138),
        threadId: "thread-deb-advocate",
        status: "completed",
        activity: "Position delivered",
      },
      {
        type: "thread.status",
        at: at(138),
        threadId: "thread-deb-critic",
        status: "completed",
        activity: "Position delivered",
      },
      {
        type: "thread.message",
        at: at(139),
        threadId: "thread-deb-moderator",
        role: "assistant",
        text: DEBATE_PROPOSAL,
      },
      {
        type: "thread.artifacts",
        at: at(139),
        threadId: "thread-deb-moderator",
        artifacts: { answer: DEBATE_PROPOSAL },
      },
      {
        type: "thread.status",
        at: at(139),
        threadId: "thread-deb-moderator",
        status: "completed",
        activity: "Proposal delivered",
      },
      {
        type: "thread.status",
        at: at(140),
        threadId: COORDINATOR_ID,
        status: "running",
        activity: "Reading the proposal",
      },
      {
        type: "thread.message",
        at: at(140),
        threadId: COORDINATOR_ID,
        role: "assistant",
        text: "The Moderator proposes **environment** everywhere in user docs with one onboarding sentence, keeping 'host' only inside 'remote host'. The Critic conceded the two-servers-on-one-machine case. Select the three debate threads in Work to read the positions side by side.",
      },
      {
        type: "thread.status",
        at: at(140),
        threadId: COORDINATOR_ID,
        status: "completed",
        activity: "Waiting on 2 reviewers and 3 docs workers",
      },
    ],
  },
  {
    caption:
      "Reviewer A reports; the review wait stays open on Reviewer B. The providers page lands and Content wakes",
    at: at(154),
    events: [
      {
        type: "thread.message",
        at: at(152),
        threadId: "thread-auth-rev-a",
        role: "assistant",
        text: "Two findings.\n\n1. **Medium**: `verifySignedToken` accepts an empty signature segment; `checkSignature` must reject zero-length input.\n2. **Low**: rotation counter is a plain integer; a wrap is theoretical but cheap to guard.\n\nToken format and expiry handling are sound.",
      },
      {
        type: "thread.artifacts",
        at: at(152),
        threadId: "thread-auth-rev-a",
        artifacts: {
          answer:
            "Two findings: medium (empty signature segment accepted), low (rotation counter wrap).",
        },
      },
      {
        type: "thread.status",
        at: at(152),
        threadId: "thread-auth-rev-a",
        status: "completed",
        activity: "2 findings",
      },
      {
        type: "thread.status",
        at: at(153),
        threadId: "thread-auth-rev-b",
        status: "running",
        activity: "Checking the pairing cookie window",
      },
      {
        type: "thread.message",
        at: at(153),
        threadId: "thread-docs-page-providers",
        role: "assistant",
        text: "Providers page rewritten, one section each for Codex, Claude, Cursor, Grok and OpenCode, in shipped-product voice.",
      },
      {
        type: "thread.artifacts",
        at: at(153),
        threadId: "thread-docs-page-providers",
        artifacts: {
          files: [
            { path: "docs/user/providers.md", kind: "modified", additions: 118, deletions: 74 },
          ],
        },
      },
      {
        type: "thread.status",
        at: at(153),
        threadId: "thread-docs-page-providers",
        status: "completed",
        activity: "Page delivered",
      },
      {
        type: "thread.status",
        at: at(154),
        threadId: "thread-docs-content",
        status: "running",
        activity: "Merging the page drafts",
      },
    ],
  },
];

export const FIXTURE_STEP_COUNT = FIXTURE_STEPS.length;
