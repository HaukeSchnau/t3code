import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

describe("ProviderInstanceIcon", () => {
  it("renders native Claude without a Claudex mark", () => {
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon
        instanceId={ProviderInstanceId.make("claudeAgent")}
        driverKind={ProviderDriverKind.make("claudeAgent")}
        displayName="Claude"
      />,
    );

    expect(markup).not.toContain('data-provider-icon="claudex"');
    expect(markup).not.toContain(">CL<");
  });

  it("renders the dedicated Claudex mark without an initials badge", () => {
    const markup = renderToStaticMarkup(
      <ProviderInstanceIcon
        instanceId={ProviderInstanceId.make("claudex")}
        driverKind={ProviderDriverKind.make("claudeAgent")}
        displayName="Claudex"
        accentColor="#f97316"
        showBadge
      />,
    );

    expect(markup).toContain('data-provider-icon="claudex"');
    expect(markup).not.toContain(">CL<");
  });
});
