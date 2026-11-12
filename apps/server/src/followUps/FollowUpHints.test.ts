import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, type FollowUp, FollowUpId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as FollowUpHints from "./FollowUpHints.ts";
import * as FollowUps from "./FollowUps.ts";

const { hintFor } = FollowUpHints;

const followUp = (id: string, title: string, status: FollowUp["status"] = "open"): FollowUp => ({
  id: FollowUpId.make(id),
  title,
  body: "",
  status,
  dueAt: null,
  condition: null,
  tags: [],
  links: [],
  type: null,
  fields: {},
  origin: null,
  pickedUpThread: null,
  result: null,
  mergedInto: null,
  returnedAt: null,
  createdBy: { kind: "agent", thread: null },
  createdAt: "2026-11-12T00:00:00.000Z",
  updatedAt: "2026-11-12T00:00:00.000Z",
  closedAt: null,
});

const forwarder = followUp("fu-1", "Check the M2 forwarder health check");
const apiKey = followUp("fu-2", "Rotate the pasted Anthropic API key");

describe("hintFor", () => {
  it.each([
    {
      case: "names a follow-up whose title the message mostly repeats",
      text: "Why did the M2 forwarder health check fail silently last week?",
      hinted: ["fu-1"],
    },
    {
      case: "stays quiet when only one word overlaps",
      text: "Add a health endpoint to the API.",
      hinted: [],
    },
    {
      case: "names a follow-up the message cites by id",
      text: "Let's do fu-2 now.",
      hinted: ["fu-2"],
    },
    {
      case: "leaves closed follow-ups out",
      text: "Rotate the pasted Anthropic API key",
      candidates: [followUp("fu-3", "Rotate the pasted Anthropic API key", "done")],
      hinted: [],
    },
  ] as ReadonlyArray<{
    readonly case: string;
    readonly text: string;
    readonly candidates?: ReadonlyArray<FollowUp>;
    readonly hinted: ReadonlyArray<string>;
  }>)("$case", ({ text, candidates, hinted }) => {
    const hint = hintFor(text, candidates ?? [forwarder, apiKey]);
    for (const id of ["fu-1", "fu-2", "fu-3"]) {
      expect(hint.includes(`(${id})`)).toBe(hinted.includes(id));
    }
  });
});

it.effect("a home hints at the open follow-up a first message cites by id", () =>
  Effect.gen(function* () {
    const followUps = yield* FollowUps.FollowUps;
    const hints = yield* FollowUpHints.FollowUpHints;
    const cited = yield* followUps.save(
      { title: "Rotate the pasted Anthropic API key" },
      { kind: "agent", thread: null },
    );
    const hint = yield* hints.forFirstMessage(`Let's do ${cited.id} now.`);
    expect(hint).toContain(`(${cited.id})`);
  }).pipe(
    Effect.provide(
      FollowUpHints.layerLookup.pipe(
        Layer.provideMerge(FollowUpHints.layer),
        Layer.provideMerge(FollowUps.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
            Layer.succeed(ServerConfig, {} as ServerConfig["Service"]),
            Layer.mock(ServerEnvironment.ServerEnvironment)({
              getEnvironmentId: Effect.succeed(EnvironmentId.make("env:home")),
            }),
            Layer.mock(PeerMcpClient.PeerMcpClient)({}),
          ),
        ),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        Layer.provide(SqlitePersistence.layerMemory),
      ),
    ),
  ),
);
