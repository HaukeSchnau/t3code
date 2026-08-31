import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/unstable/http";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import {
  fetchZaiUsageLimits,
  zaiQuotaUrlForApiUrl,
  zaiUsageLimitsFromResponse,
} from "./zaiUsage.ts";

describe("zaiUsageLimitsFromResponse", () => {
  it("normalizes the live personal-plan response without treating MCP as coding quota", () => {
    expect(
      zaiUsageLimitsFromResponse(
        {
          code: 200,
          success: true,
          data: {
            level: "Pro",
            limits: [
              {
                type: "TIME_LIMIT",
                unit: 5,
                number: 1,
                percentage: 0,
                nextResetTime: 1_788_454_881_998,
              },
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                percentage: 6,
                nextResetTime: 1_788_186_101_938,
              },
            ],
          },
        },
        "zai-coding-plan",
      ),
    ).toEqual({
      limitId: "zai-coding-plan",
      limitName: "GLM Coding Plan",
      planType: "Pro",
      rateLimitReachedType: null,
      credits: null,
      primary: {
        key: "zai:tokens:3:5",
        label: "Current window",
        usedPercent: 6,
        resetsAt: "2026-08-31T14:21:41.938Z",
        windowDurationMins: 300,
      },
      secondary: null,
      windows: [
        {
          key: "zai:tokens:3:5",
          label: "Current window",
          usedPercent: 6,
          resetsAt: "2026-08-31T14:21:41.938Z",
          windowDurationMins: 300,
        },
      ],
    });
  });

  it("sorts an optional weekly window behind the five-hour window", () => {
    const usage = zaiUsageLimitsFromResponse(
      {
        code: 200,
        success: true,
        data: {
          planName: "Max",
          limits: [
            {
              type: "TOKENS_LIMIT",
              unit: 6,
              number: 1,
              percentage: 41,
              nextResetTime: 1_788_480_000_000,
            },
            {
              type: "TOKENS_LIMIT",
              unit: 3,
              number: 5,
              percentage: 18,
              nextResetTime: 1_788_192_000_000,
            },
          ],
        },
      },
      "zai-coding-plan",
    );

    expect(usage?.primary).toMatchObject({
      key: "zai:tokens:3:5",
      label: "Current window",
      usedPercent: 18,
      windowDurationMins: 300,
    });
    expect(usage?.secondary).toMatchObject({
      key: "zai:tokens:6:1",
      label: "Weekly",
      usedPercent: 41,
      windowDurationMins: 10_080,
    });
    expect(usage?.planType).toBe("Max");
  });

  it("rejects unsuccessful, malformed, and unsupported-only responses", () => {
    expect(
      zaiUsageLimitsFromResponse(
        { code: 500, success: false, data: { limits: [] } },
        "zai-coding-plan",
      ),
    ).toBeUndefined();
    expect(zaiUsageLimitsFromResponse({ success: true }, "zai-coding-plan")).toBeUndefined();
    expect(
      zaiUsageLimitsFromResponse(
        {
          code: 200,
          success: true,
          data: {
            limits: [{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 10 }],
          },
        },
        "zai-coding-plan",
      ),
    ).toBeUndefined();
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

describe("fetchZaiUsageLimits", () => {
  effectIt.effect("sends the raw API key only to the resolved quota URL", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const client = HttpClient.make((request) =>
      Effect.sync(() => {
        requests.push(request);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            code: 200,
            success: true,
            data: {
              limits: [
                {
                  type: "TOKENS_LIMIT",
                  unit: 3,
                  number: 5,
                  percentage: 6,
                  nextResetTime: 1_788_186_101_938,
                },
              ],
            },
          }),
        );
      }),
    );

    return fetchZaiUsageLimits({
      apiKey: "secret-test-key",
      limitId: "zai-coding-plan",
      quotaUrl: "https://api.z.ai/api/monitor/usage/quota/limit",
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.tap((usage) =>
        Effect.sync(() => {
          expect(requests).toHaveLength(1);
          expect(requests[0]?.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
          expect(requests[0]?.headers.authorization).toBe("secret-test-key");
          expect(usage.primary?.usedPercent).toBe(6);
        }),
      ),
      Effect.asVoid,
    );
  });
});
