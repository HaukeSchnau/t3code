import type { FollowUp, FollowUpError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { FollowUpsResult } from "../mcp/toolkits/followUps/tools.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as FollowUps from "./FollowUps.ts";

/**
 * A line for an agent starting a thread that clearly continues an open follow-up. Turn start
 * reads it, but only the server above it can reach the home over a peer link, so that side
 * registers the lookup here; until it does, there are no hints.
 */
export class FollowUpHints extends Context.Service<
  FollowUpHints,
  {
    readonly register: (lookup: (text: string) => Effect.Effect<string>) => Effect.Effect<void>;
    /** The hint for a thread's first message, or "" when nothing matches strongly. */
    readonly forFirstMessage: (text: string) => Effect.Effect<string>;
  }
>()("t3/followUps/FollowUpHints") {}

const HINT_TIMEOUT = "2 seconds";
const MAX_HINTS = 2;
const CANDIDATE_LIMIT = 100;
// A long paste repeats most titles' words; the opening says what the thread is for.
const MATCHED_TEXT_CHARS = 2_000;

/** Most of the title's words appear in the message, and at least two of them. */
const isStrongMatch = (followUp: FollowUp, messageTerms: ReadonlySet<string>) => {
  const titleTerms = FollowUps.searchTerms(followUp.title);
  const matched = titleTerms.filter((term) => messageTerms.has(term)).length;
  return matched >= 2 && matched / titleTerms.length >= 0.6;
};

export const hintFor = (text: string, candidates: ReadonlyArray<FollowUp>) => {
  const terms = new Set(FollowUps.searchTerms(text.slice(0, MATCHED_TEXT_CHARS)));
  const strong = candidates
    .filter(
      (followUp) =>
        followUp.status === "open" &&
        (text.includes(followUp.id) || isStrongMatch(followUp, terms)),
    )
    .slice(0, MAX_HINTS);
  if (strong.length === 0) return "";
  const named = strong.map((followUp) => `"${followUp.title}" (${followUp.id})`).join(" and ");
  return `This may continue the open follow-up${strong.length === 1 ? "" : "s"} ${named}. Read ${
    strong.length === 1 ? "it" : "them"
  } with follow_ups if so; otherwise ignore this.`;
};

export const layer = Layer.effect(
  FollowUpHints,
  Effect.gen(function* () {
    const lookup = yield* Ref.make<((text: string) => Effect.Effect<string>) | null>(null);
    const register: FollowUpHints["Service"]["register"] = (next) => Ref.set(lookup, next);
    const forFirstMessage: FollowUpHints["Service"]["forFirstMessage"] = Effect.fn(
      "FollowUpHints.forFirstMessage",
    )(
      function* (text) {
        const current = yield* Ref.get(lookup);
        return current === null ? "" : yield* current(text);
      },
      Effect.timeoutOption(HINT_TIMEOUT),
      Effect.map(Option.getOrElse(() => "")),
      Effect.catchCause(() => Effect.succeed("")),
    );
    return FollowUpHints.of({ register, forFirstMessage });
  }),
);

/** Reads the home's open follow-ups: this environment's store, or the home's over its peer link. */
export const layerLookup = Layer.effectDiscard(
  Effect.gen(function* () {
    const hints = yield* FollowUpHints;
    const config = yield* ServerConfig;
    const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const followUps = yield* FollowUps.FollowUps;
    const peers = yield* PeerMcpClient.PeerMcpClient;
    const home =
      config.followUpHome === undefined || config.followUpHome === environmentId
        ? null
        : config.followUpHome;
    const openFollowUps: Effect.Effect<
      ReadonlyArray<FollowUp>,
      FollowUpError | OrchestratorMcpFailure
    > = home === null
      ? followUps
          .search({ statuses: ["open"], limit: CANDIDATE_LIMIT })
          .pipe(Effect.map((matches) => matches.map((match) => match.followUp)))
      : peers
          .call({
            environmentId: home,
            tool: "follow_ups",
            arguments: { status: ["open"], limit: CANDIDATE_LIMIT },
            limits: { runtimeMode: "approval-required", interactionMode: "default" },
            success: FollowUpsResult,
          })
          .pipe(Effect.map((result) => result.followUps));
    yield* hints.register((text) =>
      FollowUps.searchTerms(text.slice(0, MATCHED_TEXT_CHARS)).length < 2
        ? Effect.succeed("")
        : openFollowUps.pipe(
            Effect.map((found) => hintFor(text, found)),
            Effect.orElseSucceed(() => ""),
          ),
    );
  }),
);
