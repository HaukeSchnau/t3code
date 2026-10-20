import * as Fleet from "@schnau/fleet";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * srv-2 checks the placement against t3code's grant in ~/infra, which keeps the host's paths,
 * telemetry and the release's privileges. Calder delivers the revision itself.
 */
export default Alchemy.Stack(
  "T3Code",
  {
    providers: Layer.mergeAll(Fleet.providers(), Cloudflare.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const placement = yield* Fleet.Placement("Release", {
      project: "t3code",
      host: "srv-2",
      endpoint: { hostName: "t3.schnau.dev", visibility: "tailnet" },
      secrets: { apnsPrivateKey: "t3code/apns-private-key" },
      parameters: { apnsKeyId: "LLC3MC4S8K", apnsTeamId: "2243J9RD68" },
    });
    return { url: placement.url };
  }),
);
