import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import {
  applyUsageLimitsUpdate,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "./providerUsageLimits.ts";
import {
  fetchZaiUsageWindows,
  withZaiUsageLimits,
  zaiQuotaUrlForApiUrl,
  zaiUsageWindowsFromResponse,
} from "./zaiUsage.ts";

const SOURCE = {
  apiKey: "secret-test-key",
  quotaUrl: "https://api.z.ai/api/monitor/usage/quota/limit",
};

const quotaResponse = (limits: ReadonlyArray<Record<string, unknown>>) => ({
  code: 200,
  success: true,
  data: { level: "Pro", limits },
});

const FIVE_HOUR_LIMIT = {
  type: "TOKENS_LIMIT",
  unit: 3,
  number: 5,
  percentage: 6,
  nextResetTime: 1_788_186_101_938,
};
const MCP_LIMIT = {
  type: "TIME_LIMIT",
  unit: 5,
  number: 1,
  percentage: 9,
  nextResetTime: 1_788_454_881_998,
};

const quotaClient = (requests: Array<HttpClientRequest.HttpClientRequest>, body: unknown) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return HttpClientResponse.fromWeb(request, Response.json(body));
    }),
  );

describe("zaiUsageWindowsFromResponse", () => {
  it("maps coding and MCP quotas onto stable upstream windows", () => {
    expect(
      zaiUsageWindowsFromResponse(
        quotaResponse([
          MCP_LIMIT,
          {
            type: "TOKENS_LIMIT",
            unit: 6,
            number: 1,
            percentage: 41,
            nextResetTime: 1_788_480_000,
          },
          FIVE_HOUR_LIMIT,
        ]),
      ),
    ).toEqual([
      {
        id: "zai_mcp",
        kind: "monthly",
        label: "GLM · MCP",
        usedPercent: 9,
        resetsAt: "2026-09-03T17:01:21.998Z",
        windowDurationMins: 44_640,
      },
      {
        id: "zai_weekly",
        kind: "weekly",
        label: "GLM · Weekly",
        usedPercent: 41,
        resetsAt: "2026-09-04T00:00:00.000Z",
        windowDurationMins: 10_080,
      },
      {
        id: "zai_5h",
        kind: "session",
        label: "GLM · Session",
        usedPercent: 6,
        resetsAt: "2026-08-31T14:21:41.938Z",
        windowDurationMins: 300,
      },
    ]);
  });

  it("rejects unsuccessful, malformed, and responses without coding quota", () => {
    expect(
      zaiUsageWindowsFromResponse({ code: 500, success: false, data: { limits: [] } }),
    ).toBeUndefined();
    expect(zaiUsageWindowsFromResponse({ success: true })).toBeUndefined();
    expect(zaiUsageWindowsFromResponse(quotaResponse([MCP_LIMIT]))).toBeUndefined();
  });
});

describe("zaiQuotaUrlForApiUrl", () => {
  it("routes supported global and mainland API URLs to their quota endpoint", () => {
    expect(zaiQuotaUrlForApiUrl("https://api.z.ai/api/coding/paas/v4")).toBe(
      "https://api.z.ai/api/monitor/usage/quota/limit",
    );
    expect(zaiQuotaUrlForApiUrl("https://open.bigmodel.cn/api/coding/paas/v4")).toBe(
      "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    );
  });

  it("rejects arbitrary and insecure hosts", () => {
    expect(zaiQuotaUrlForApiUrl("https://example.com/api/coding/paas/v4")).toBeNull();
    expect(zaiQuotaUrlForApiUrl("http://api.z.ai/api/coding/paas/v4")).toBeNull();
    expect(zaiQuotaUrlForApiUrl("not a URL")).toBeNull();
  });
});

describe("fetchZaiUsageWindows", () => {
  effectIt.effect("sends the raw API key only to the resolved quota URL", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return fetchZaiUsageWindows(SOURCE).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        quotaClient(requests, quotaResponse([FIVE_HOUR_LIMIT])),
      ),
      Effect.tap((windows) =>
        Effect.sync(() => {
          expect(requests).toHaveLength(1);
          expect(requests[0]?.url).toBe(SOURCE.quotaUrl);
          expect(requests[0]?.headers.authorization).toBe("secret-test-key");
          expect(windows.map((window) => window.id)).toEqual(["zai_5h"]);
        }),
      ),
      Effect.asVoid,
    );
  });
});

describe("withZaiUsageLimits", () => {
  const checkedAt = "2026-08-31T12:00:00.000Z";
  const goUnsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });

  effectIt.effect("lets live Z.AI updates land on an OpenCode snapshot without OpenCode Go", () =>
    withZaiUsageLimits(goUnsupported, Effect.succeed(SOURCE)).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        quotaClient([], quotaResponse([FIVE_HOUR_LIMIT, MCP_LIMIT])),
      ),
      Effect.tap((probed) =>
        Effect.sync(() => {
          expect(probed.unavailable).toBeUndefined();
          expect(probed.windows.map((window) => window.id)).toEqual(["zai_5h", "zai_mcp"]);

          // The adapter's poll arrives as a sparse `account.rate-limits.updated`.
          const merged = applyUsageLimitsUpdate({
            previous: probed,
            update: { windows: [{ ...probed.windows[0]!, usedPercent: 40 }] },
            checkedAt: "2026-08-31T12:05:00.000Z",
          });
          expect(merged?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
            ["zai_5h", 40],
            ["zai_mcp", 9],
          ]);
        }),
      ),
      Effect.asVoid,
    ),
  );

  effectIt.effect("keeps the Go result when no Z.AI provider is configured", () =>
    withZaiUsageLimits(goUnsupported, Effect.succeed(null)).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected Z.AI request")),
      ),
      Effect.tap((limits) => Effect.sync(() => expect(limits).toBe(goUnsupported))),
      Effect.asVoid,
    ),
  );

  effectIt.effect("keeps the last good windows when either side of the probe fails", () =>
    Effect.gen(function* () {
      const goWindow = {
        id: "go_rolling",
        kind: "session",
        label: "Go · Session",
        usedPercent: 12,
      } as const;
      const goRead = makeUsageLimits({ checkedAt, windows: [goWindow] });
      const goFailed = makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
      const published = makeUsageLimits({
        checkedAt,
        windows: [
          goWindow,
          { id: "zai_5h", kind: "session", label: "GLM · Session", usedPercent: 6 },
        ],
      });
      const failingQuota = quotaClient([], { code: 500, success: false, data: { limits: [] } });

      const probes = [
        // OpenCode's provider list could not be read.
        yield* withZaiUsageLimits(goUnsupported, Effect.fail("provider.list failed")).pipe(
          Effect.provideService(HttpClient.HttpClient, failingQuota),
        ),
        // Go read fine, Z.AI did not.
        yield* withZaiUsageLimits(goRead, Effect.succeed(SOURCE)).pipe(
          Effect.provideService(HttpClient.HttpClient, failingQuota),
        ),
        // Go failed; Z.AI alone must not replace the Go windows.
        yield* withZaiUsageLimits(goFailed, Effect.succeed(SOURCE)).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("unexpected Z.AI request")),
          ),
        ),
      ];

      for (const probed of probes) {
        expect(probed.unavailable?.reason).toBe("probeFailed");
        expect(resolveUsageLimitsAfterProbe({ published, probed })).toBe(published);
      }
    }),
  );

  effectIt.effect("reports a failed read instead of unsupported when Z.AI is configured", () =>
    withZaiUsageLimits(goUnsupported, Effect.succeed(SOURCE)).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        quotaClient([], { code: 500, success: false, data: { limits: [] } }),
      ),
      Effect.tap((limits) =>
        Effect.sync(() => expect(limits.unavailable?.reason).toBe("probeFailed")),
      ),
      Effect.asVoid,
    ),
  );
});
