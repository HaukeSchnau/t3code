import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { followUpHomes } from "./followUps.ts";

const srv2 = EnvironmentId.make("srv-2");
const tower = EnvironmentId.make("tower");
const devHauke = EnvironmentId.make("dev-hauke");

describe("followUpHomes", () => {
  it.each([
    {
      mode: "personal: every machine names srv-2",
      environments: [
        { environmentId: srv2, followUpHome: srv2 },
        { environmentId: tower, followUpHome: srv2 },
      ],
      homes: [{ environmentId: srv2, connected: true }],
    },
    {
      mode: "work: dev-hauke keeps its own",
      environments: [{ environmentId: devHauke, followUpHome: undefined }],
      homes: [{ environmentId: devHauke, connected: true }],
    },
    {
      mode: "all: both stores",
      environments: [
        { environmentId: tower, followUpHome: srv2 },
        { environmentId: srv2, followUpHome: srv2 },
        { environmentId: devHauke, followUpHome: devHauke },
      ],
      homes: [
        { environmentId: srv2, connected: true },
        { environmentId: devHauke, connected: true },
      ],
    },
    {
      mode: "custom: tower without its home",
      environments: [{ environmentId: tower, followUpHome: srv2 }],
      homes: [{ environmentId: srv2, connected: false }],
    },
  ])("$mode", ({ environments, homes }) => {
    expect(followUpHomes(environments)).toEqual(homes);
  });
});
