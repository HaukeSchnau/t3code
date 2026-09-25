import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  BUILD_REFRESH_MS,
  buildNumberAt,
  findCurrentBuild,
  runtimeNote,
} from "./mobile-testflight.ts";

const nowMs = Date.UTC(2026, 8, 24, 21, 30);

function build(
  id: string,
  overrides: { expired?: boolean; processingState?: string; ageMs?: number } = {},
) {
  return {
    id,
    attributes: {
      version: id,
      uploadedDate: DateTime.formatIso(DateTime.makeUnsafe(nowMs - (overrides.ageMs ?? 0))),
      expired: overrides.expired ?? false,
      processingState: overrides.processingState ?? "VALID",
    },
    relationships: { betaBuildLocalizations: { data: [{ id: `${id}-en` }] } },
  };
}

function note(buildId: string, whatsNew: string) {
  return {
    id: `${buildId}-en`,
    type: "betaBuildLocalizations",
    attributes: { locale: "en-US", whatsNew },
  };
}

it("reuses only a usable, recent build that names the runtime", () => {
  const page = {
    data: [
      build("other-runtime"),
      build("expired", { expired: true }),
      build("failed", { processingState: "FAILED" }),
      build("near-expiry", { ageMs: BUILD_REFRESH_MS + 1 }),
      build("current", { processingState: "PROCESSING" }),
    ],
    included: [
      note("other-runtime", `Fix\n\n${runtimeNote("b")}`),
      note("expired", runtimeNote("a")),
      note("failed", runtimeNote("a")),
      note("near-expiry", runtimeNote("a")),
      note("current", `Fix\n\n${runtimeNote("a")}`),
    ],
  };

  assert.strictEqual(findCurrentBuild(page, "a", nowMs)?.id, "current");
  assert.strictEqual(findCurrentBuild(page, "c", nowMs), undefined);
});

it("numbers builds so later uploads always sort higher", () => {
  assert.strictEqual(buildNumberAt(nowMs), "260924.2130");
  // Minutes past midnight stay numerically ordered without zero padding.
  assert.strictEqual(buildNumberAt(Date.UTC(2026, 8, 25, 0, 5)), "260925.5");
  assert.strictEqual(buildNumberAt(Date.UTC(2026, 8, 25, 1, 0)), "260925.100");
});
