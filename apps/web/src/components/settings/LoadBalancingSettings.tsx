import { AuthSettingsWriteScope, resolveEnvironmentMachineKind } from "@t3tools/contracts";

import { usePlacementWeights } from "~/hooks/useLoadBalancedEnvironment";
import { useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import type { EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { EnvironmentRow, EnvironmentTransportLabel } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { searchableSetting } from "./settingsSearch";

const preferences = [
  { value: 100, label: "Prefer" },
  { value: 50, label: "Normal" },
  { value: 25, label: "Less often" },
  { value: 0, label: "Manual only" },
] as const;

type LoadPreference = (typeof preferences)[number]["value"];

function loadPreference(weight: number | null | undefined): LoadPreference {
  if (!weight) return 0;
  if (weight === 50) return 50;
  return weight < 50 ? 25 : 100;
}

function preferenceLabel(preference: LoadPreference): string {
  return preferences.find((entry) => entry.value === preference)!.label;
}

function summarizeLoadPreferences(
  environments: ReadonlyArray<EnvironmentPresentation>,
  weights: ReadonlyArray<number | null | undefined>,
): string {
  const parts = environments.flatMap((environment, index) => {
    const preference = loadPreference(weights[index]);
    if (preference === 0) return [];
    return preference === 50
      ? [environment.label]
      : [`${environment.label} ${preferenceLabel(preference).toLowerCase()}`];
  });
  return parts.length === 0 ? "Off" : parts.join(" · ");
}

function PlacementRow({
  environment,
  weight,
}: {
  environment: EnvironmentPresentation;
  weight: number | null | undefined;
}) {
  const canWrite = useEnvironmentScope(environment.environmentId, AuthSettingsWriteScope);
  const updateSettings = useUpdateEnvironmentSettings(environment.environmentId);
  return (
    <EnvironmentRow
      kind={resolveEnvironmentMachineKind(environment.serverConfig)}
      label={environment.label}
      subtitle={<EnvironmentTransportLabel environment={environment} />}
    >
      <Select
        items={preferences}
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
          aria-label={`${environment.label} load preference`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          {preferences.map(({ value, label }) => (
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
  const weights = usePlacementWeights(environments.map((environment) => environment.environmentId));
  if (environments.length < 2) return null;

  const { id, title } = searchableSetting("load-balancing");
  return (
    <FoldedSettingsSection
      id={id}
      title={title}
      summary={summarizeLoadPreferences(environments, weights)}
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        New threads in shared projects start on the machine with the most room for another agent,
        and skip machines under memory pressure. Each machine keeps its own preference, so every
        device sees the same choice.
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
