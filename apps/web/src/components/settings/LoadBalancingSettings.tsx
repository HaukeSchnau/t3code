import { AuthSettingsWriteScope, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";

import { usePlacementWeights } from "~/hooks/useLoadBalancedEnvironment";
import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import type { MessageResolver } from "~/i18n/messages";
import type { EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { EnvironmentRow, EnvironmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { useSearchableSetting } from "./settingsSearch";

const preferences = [
  { value: 100, label: msg("Prefer") },
  { value: 50, label: msg("Normal", { $context: "load balancing preference" }) },
  { value: 25, label: msg("Less often") },
  { value: 0, label: msg("Manual only") },
] as const;

const summaryLabels = {
  100: msg("{environment} prefer"),
  25: msg("{environment} less often"),
} as const;

type LoadPreference = (typeof preferences)[number]["value"];

function loadPreference(weight: number | null | undefined): LoadPreference {
  if (!weight) return 0;
  if (weight === 50) return 50;
  return weight < 50 ? 25 : 100;
}

function summarizeLoadPreferences(
  environments: ReadonlyArray<EnvironmentPresentation>,
  weights: ReadonlyArray<number | null | undefined>,
  resolve: MessageResolver,
): string {
  const parts = environments.flatMap((environment, index) => {
    const preference = loadPreference(weights[index]);
    if (preference === 0) return [];
    return preference === 50
      ? [environment.label]
      : [resolve(summaryLabels[preference], { environment: environment.label })];
  });
  return parts.length === 0
    ? resolve(msg("Off", { $context: "load balancing is turned off" }))
    : parts.join(" · ");
}

function PlacementRow({
  environment,
  weight,
}: {
  environment: EnvironmentPresentation;
  weight: number | null | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const items = preferences.map((entry) => ({ ...entry, label: m(entry.label) }));
  const canWrite = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  return (
    <EnvironmentRow
      kind={resolveEnvironmentMachineKind(environment.serverConfig)}
      label={environment.label}
      subtitle={<EnvironmentTransportLabel environment={environment} />}
    >
      <Select
        items={items}
        value={loadPreference(weight)}
        disabled={weight === undefined || !canWrite}
        onValueChange={(value) => {
          if (value === null) return;
          updateSettings({ placementWeight: value });
        }}
      >
        <SelectTrigger
          size="xs"
          className="w-32"
          aria-label={gt("{environment} load preference", { environment: environment.label })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {items.map(({ value, label }) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </EnvironmentRow>
  );
}

export function LoadBalancingSettings({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const searchableSetting = useSearchableSetting();
  const m = useMessages();
  const weights = usePlacementWeights(environments.map((environment) => environment.environmentId));
  if (environments.length < 2) return null;

  const { id, title } = searchableSetting("load-balancing");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={summarizeLoadPreferences(environments, weights, m)}
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        <T>
          New threads in shared projects start on the machine with the most room for another agent,
          and skip machines under memory pressure. Each machine keeps its own preference, so every
          device sees the same choice.
        </T>
      </p>
      {environments.map((environment, index) => (
        <PlacementRow
          key={environment.environmentId}
          environment={environment}
          weight={weights[index]}
        />
      ))}
    </FoldedSettingsSection>
  );
}
