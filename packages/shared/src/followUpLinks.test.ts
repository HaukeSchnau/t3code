import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, FollowUpId } from "@t3tools/contracts";

import { followUpLinkHrefs, formatFollowUpLink, parseFollowUpLinkHref } from "./followUpLinks.ts";

const ref = (environmentId: string, followUpId: string) => ({
  environmentId: EnvironmentId.make(environmentId),
  followUpId: FollowUpId.make(followUpId),
});

describe("follow-up links", () => {
  it("names the home and the follow-up, labeled with a title that cannot end the link", () => {
    const link = formatFollowUpLink(ref("home-1", "fu-3f55bacd"), "Fix [the] login\nflow");
    expect(link).toBe("[Fix the login flow](t3-follow-up://home-1/fu-3f55bacd)");
    expect(followUpLinkHrefs(`See ${link}, and ${link}.`)).toEqual([
      "t3-follow-up://home-1/fu-3f55bacd",
    ]);
  });

  it("falls back to the id when the title is blank", () => {
    expect(formatFollowUpLink(ref("home-1", "fu-1"), "  ")).toBe(
      "[fu-1](t3-follow-up://home-1/fu-1)",
    );
  });

  it("reads only follow-up links that name both a home and an id", () => {
    expect(parseFollowUpLinkHref("t3-follow-up://home-1/fu-1")).toEqual(ref("home-1", "fu-1"));
    expect(parseFollowUpLinkHref("t3-follow-up://fu-1")).toBeNull();
    expect(parseFollowUpLinkHref("t3-follow-up://home-1/")).toBeNull();
    expect(parseFollowUpLinkHref("t3-thread://v2/home-1/fu-1")).toBeNull();
  });
});
