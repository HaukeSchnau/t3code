import {
  ChevronDownIcon,
  CopyIcon,
  MonitorIcon,
  MoonIcon,
  RotateCcwIcon,
  SunIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { Schema, SchemaIssue } from "effect";
import { type ChangeEvent, useCallback, useMemo, useRef, useState } from "react";
import {
  ThemeDocumentSchema,
  type ColorMode,
  type ThemeDerivedOverrides,
  type ThemeDocument,
  type ThemeMode,
} from "@t3tools/contracts";
import {
  BUILTIN_THEME_PRESETS,
  canonicalizeThemeDocument,
  getDefaultThemeId,
  getThemeDocumentsForMode,
  serializeThemeDocument,
} from "@t3tools/shared/appearance/registry";
import { cn } from "../../lib/utils";
import { useAppearance } from "../../hooks/useAppearance";
import { useUpdateSettings } from "../../hooks/useSettings";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "./SettingsPanels";
import {
  createDuplicateTheme,
  normalizeImportedThemeDocument,
  replaceCustomTheme,
  updateThemeDocument,
} from "./appearance.logic";

const COLOR_MODE_OPTIONS = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
] as const satisfies ReadonlyArray<{
  value: ColorMode;
  label: string;
  icon: typeof MonitorIcon;
}>;

const MODE_COPY = {
  light: {
    label: "Light Theme",
    modeLabel: "Light",
    importTitle: "Import Light Theme",
    emptyDescription: "Imported or duplicated light theme.",
  },
  dark: {
    label: "Dark Theme",
    modeLabel: "Dark",
    importTitle: "Import Dark Theme",
    emptyDescription: "Imported or duplicated dark theme.",
  },
} as const satisfies Record<
  ThemeMode,
  {
    label: string;
    modeLabel: string;
    importTitle: string;
    emptyDescription: string;
  }
>;

const OVERRIDE_FIELDS: ReadonlyArray<{
  key: keyof ThemeDerivedOverrides;
  label: string;
  placeholder: string;
}> = [
  { key: "background", label: "Background", placeholder: "Auto" },
  { key: "foreground", label: "Foreground", placeholder: "Auto" },
  { key: "card", label: "Card", placeholder: "Auto" },
  { key: "cardForeground", label: "Card text", placeholder: "Auto" },
  { key: "popover", label: "Popover", placeholder: "Auto" },
  { key: "popoverForeground", label: "Popover text", placeholder: "Auto" },
  { key: "primary", label: "Primary", placeholder: "Auto" },
  { key: "primaryForeground", label: "Primary text", placeholder: "Auto" },
  { key: "secondary", label: "Secondary", placeholder: "Auto" },
  { key: "secondaryForeground", label: "Secondary text", placeholder: "Auto" },
  { key: "muted", label: "Muted", placeholder: "Auto" },
  { key: "mutedForeground", label: "Muted text", placeholder: "Auto" },
  { key: "accentSurface", label: "Accent surface", placeholder: "Auto" },
  { key: "accentForeground", label: "Accent text", placeholder: "Auto" },
  { key: "border", label: "Border", placeholder: "Auto" },
  { key: "input", label: "Input", placeholder: "Auto" },
  { key: "ring", label: "Ring", placeholder: "Auto" },
  { key: "destructive", label: "Destructive", placeholder: "Auto" },
  { key: "destructiveForeground", label: "Destructive text", placeholder: "Auto" },
  { key: "info", label: "Info", placeholder: "Auto" },
  { key: "infoForeground", label: "Info text", placeholder: "Auto" },
  { key: "success", label: "Success", placeholder: "Auto" },
  { key: "successForeground", label: "Success text", placeholder: "Auto" },
  { key: "warning", label: "Warning", placeholder: "Auto" },
  { key: "warningForeground", label: "Warning text", placeholder: "Auto" },
  { key: "diffAddition", label: "Diff addition", placeholder: "Auto" },
  { key: "diffDeletion", label: "Diff deletion", placeholder: "Auto" },
  { key: "sidebar", label: "Sidebar", placeholder: "Auto" },
  { key: "sidebarForeground", label: "Sidebar text", placeholder: "Auto" },
  { key: "sidebarAccent", label: "Sidebar accent", placeholder: "Auto" },
  { key: "sidebarAccentForeground", label: "Sidebar accent text", placeholder: "Auto" },
  { key: "sidebarBorder", label: "Sidebar border", placeholder: "Auto" },
];

function ThemeCard({
  theme,
  isSelected,
  onSelect,
}: {
  theme: ThemeDocument;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "group relative flex items-center gap-3 overflow-hidden rounded-xl border p-2.5 text-left transition-all",
        isSelected
          ? "border-primary bg-primary/6"
          : "border-border bg-card hover:border-primary/40 hover:bg-accent/40",
      )}
    >
      <div
        className="h-9 w-12 shrink-0 rounded-lg border border-black/8"
        style={{
          background: `linear-gradient(135deg, ${theme.background}, ${theme.accent})`,
        }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{theme.name}</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          {theme.origin === "custom" ? "Custom" : "Builtin"}
        </p>
      </div>
      {isSelected ? <span className="size-1.5 shrink-0 rounded-full bg-primary" /> : null}
    </button>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-7 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
      />
      <div className="min-w-0">
        <span className="block text-[11px] font-medium text-muted-foreground">{label}</span>
        <code className="block text-[11px] text-foreground/70">{value}</code>
      </div>
    </label>
  );
}

function ThemeEditor({
  theme,
  onChange,
}: {
  theme: ThemeDocument;
  onChange: (updater: (theme: ThemeDocument) => ThemeDocument) => void;
}) {
  return (
    <div className="space-y-3">
      {/* Colors row */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <ColorField
          label="Accent"
          value={theme.accent}
          onChange={(accent) => onChange((currentTheme) => ({ ...currentTheme, accent }))}
        />
        <ColorField
          label="Background"
          value={theme.background}
          onChange={(background) => onChange((currentTheme) => ({ ...currentTheme, background }))}
        />
        <ColorField
          label="Foreground"
          value={theme.foreground}
          onChange={(foreground) => onChange((currentTheme) => ({ ...currentTheme, foreground }))}
        />
      </div>

      {/* Scale + typography */}
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Radius</span>
          <Input
            value={theme.radius}
            onChange={(event) =>
              onChange((currentTheme) => ({ ...currentTheme, radius: event.target.value }))
            }
            placeholder="0.625rem"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Font size</span>
          <Input
            value={theme.fontSize}
            onChange={(event) =>
              onChange((currentTheme) => ({ ...currentTheme, fontSize: event.target.value }))
            }
            placeholder="16px"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">UI font</span>
          <Input
            value={theme.uiFontFamily}
            onChange={(event) =>
              onChange((currentTheme) => ({ ...currentTheme, uiFontFamily: event.target.value }))
            }
            placeholder="font-family stack"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">Code font</span>
          <Input
            value={theme.codeFontFamily}
            onChange={(event) =>
              onChange((currentTheme) => ({ ...currentTheme, codeFontFamily: event.target.value }))
            }
            placeholder="font-family stack"
          />
        </label>
      </div>

      {/* Contrast + translucent sidebar */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="flex min-w-0 flex-1 items-center gap-3">
          <span className="text-[11px] font-medium text-muted-foreground">Contrast</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={theme.contrast}
            onChange={(event) =>
              onChange((currentTheme) => ({
                ...currentTheme,
                contrast: Number.parseInt(event.target.value, 10),
              }))
            }
            className="h-1.5 min-w-24 flex-1 cursor-pointer accent-primary"
          />
          <code className="text-[11px] tabular-nums text-muted-foreground">{theme.contrast}</code>
        </label>
        <label className="flex items-center gap-2">
          <Switch
            checked={theme.sidebarTranslucent}
            onCheckedChange={(checked) =>
              onChange((currentTheme) => ({ ...currentTheme, sidebarTranslucent: checked }))
            }
          />
          <span className="text-[11px] font-medium text-muted-foreground">Translucent sidebar</span>
        </label>
      </div>

      {/* Advanced overrides */}
      <Collapsible defaultOpen={false}>
        <CollapsibleTrigger className="flex items-center gap-1.5 text-left">
          <ChevronDownIcon className="size-3.5 text-muted-foreground" />
          <span className="text-[11px] font-medium text-muted-foreground">
            Advanced token overrides
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2.5">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {OVERRIDE_FIELDS.map((field) => (
              <label key={field.key} className="grid gap-1">
                <span className="text-[11px] text-muted-foreground">{field.label}</span>
                <Input
                  value={theme.overrides?.[field.key] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    onChange((currentTheme) => {
                      const value = event.target.value.trim();
                      const nextOverrides = {
                        ...currentTheme.overrides,
                        [field.key]: value || undefined,
                      } satisfies ThemeDerivedOverrides;

                      const hasOverrides = Object.values(nextOverrides).some(Boolean);
                      if (hasOverrides) {
                        return {
                          ...currentTheme,
                          overrides: nextOverrides,
                        };
                      }

                      const { overrides: _overrides, ...nextTheme } = currentTheme;
                      return nextTheme;
                    })
                  }
                />
              </label>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

export function AppearanceSettingsPanel() {
  const { colorMode, activeLightTheme, activeDarkTheme, customThemes, setColorMode, setThemeId } =
    useAppearance();
  const { updateSettings } = useUpdateSettings();
  const lightImportInputRef = useRef<HTMLInputElement>(null);
  const darkImportInputRef = useRef<HTMLInputElement>(null);
  const [importErrors, setImportErrors] = useState<Record<ThemeMode, string | null>>({
    light: null,
    dark: null,
  });

  const themeLibraryByMode = useMemo(
    () => ({
      light: getThemeDocumentsForMode("light", customThemes).map((theme) => ({
        theme,
        description:
          BUILTIN_THEME_PRESETS.find((preset) => preset.theme.id === theme.id)?.description ??
          MODE_COPY.light.emptyDescription,
      })),
      dark: getThemeDocumentsForMode("dark", customThemes).map((theme) => ({
        theme,
        description:
          BUILTIN_THEME_PRESETS.find((preset) => preset.theme.id === theme.id)?.description ??
          MODE_COPY.dark.emptyDescription,
      })),
    }),
    [customThemes],
  );

  const activeThemeByMode = useMemo(
    () =>
      ({
        light: activeLightTheme,
        dark: activeDarkTheme,
      }) as const satisfies Record<ThemeMode, ThemeDocument>,
    [activeLightTheme, activeDarkTheme],
  );

  const updateModeSelection = useCallback(
    (mode: ThemeMode, themeId: string) => {
      setThemeId(mode, themeId);
    },
    [setThemeId],
  );

  const saveTheme = useCallback(
    (themeDocument: ThemeDocument) => {
      updateSettings({
        ...(themeDocument.mode === "dark"
          ? { activeDarkThemeId: themeDocument.id }
          : { activeLightThemeId: themeDocument.id }),
        customThemes: replaceCustomTheme(
          customThemes,
          canonicalizeThemeDocument(themeDocument, "custom"),
        ),
      });
    },
    [customThemes, updateSettings],
  );

  const getEditableTheme = useCallback(
    (mode: ThemeMode, announceDuplicate: boolean): ThemeDocument => {
      const activeTheme = activeThemeByMode[mode];
      if (activeTheme.origin === "custom") {
        return activeTheme;
      }

      const duplicate = createDuplicateTheme(activeTheme, customThemes);
      if (announceDuplicate) {
        toastManager.add({
          type: "info",
          title: "Created editable copy",
          description: `${activeTheme.name} was duplicated into ${duplicate.name}.`,
        });
      }
      return duplicate;
    },
    [activeThemeByMode, customThemes],
  );

  const handleThemeChange = useCallback(
    (mode: ThemeMode, updater: (themeDocument: ThemeDocument) => ThemeDocument) => {
      const baseTheme = getEditableTheme(mode, true);
      const nextTheme = updateThemeDocument(baseTheme, updater);
      saveTheme(nextTheme);
    },
    [getEditableTheme, saveTheme],
  );

  const handleDuplicateTheme = useCallback(
    (mode: ThemeMode) => {
      const duplicate = createDuplicateTheme(activeThemeByMode[mode], customThemes);
      updateSettings({
        ...(mode === "dark"
          ? { activeDarkThemeId: duplicate.id }
          : { activeLightThemeId: duplicate.id }),
        customThemes: [...customThemes, duplicate],
      });
      toastManager.add({
        type: "success",
        title: "Theme duplicated",
        description: `${duplicate.name} is now selected and editable.`,
      });
    },
    [activeThemeByMode, customThemes, updateSettings],
  );

  const handleDeleteTheme = useCallback(
    (mode: ThemeMode) => {
      const activeTheme = activeThemeByMode[mode];
      if (activeTheme.origin !== "custom") return;

      updateSettings({
        ...(mode === "dark"
          ? { activeDarkThemeId: getDefaultThemeId("dark") }
          : { activeLightThemeId: getDefaultThemeId("light") }),
        customThemes: customThemes.filter((theme) => theme.id !== activeTheme.id),
      });
      toastManager.add({
        type: "success",
        title: "Custom theme deleted",
        description: `${activeTheme.name} was removed from your library.`,
      });
    },
    [activeThemeByMode, customThemes, updateSettings],
  );

  const handleResetCurrent = useCallback(
    (mode: ThemeMode) => {
      const activeTheme = activeThemeByMode[mode];
      if (activeTheme.origin === "builtin") {
        updateModeSelection(mode, getDefaultThemeId(mode));
        return;
      }

      const builtinDefault = BUILTIN_THEME_PRESETS.find(
        (preset) => preset.theme.id === getDefaultThemeId(mode),
      )!.theme;
      const resetTheme = canonicalizeThemeDocument(
        {
          ...builtinDefault,
          id: activeTheme.id,
          name: activeTheme.name,
          origin: "custom",
        },
        "custom",
      );
      saveTheme(resetTheme);
      toastManager.add({
        type: "success",
        title: "Theme reset",
        description: `${activeTheme.name} now matches the default ${MODE_COPY[mode].modeLabel.toLowerCase()} preset.`,
      });
    },
    [activeThemeByMode, saveTheme, updateModeSelection],
  );

  const handleCopyTheme = useCallback(
    async (mode: ThemeMode) => {
      const activeTheme = activeThemeByMode[mode];
      try {
        await navigator.clipboard.writeText(serializeThemeDocument(activeTheme));
        toastManager.add({
          type: "success",
          title: "Theme JSON copied",
          description: `${activeTheme.name} is ready to paste or share.`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not copy theme JSON",
          description: error instanceof Error ? error.message : "Clipboard access failed.",
        });
      }
    },
    [activeThemeByMode],
  );

  const handleImportTheme = useCallback(
    (mode: ThemeMode) => async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      setImportErrors((current) => ({ ...current, [mode]: null }));

      let rawJson: unknown;
      try {
        rawJson = JSON.parse(await file.text());
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid JSON.";
        setImportErrors((current) => ({ ...current, [mode]: message }));
        return;
      }

      let decoded: ThemeDocument;
      try {
        decoded = Schema.decodeUnknownSync(ThemeDocumentSchema)(rawJson);
      } catch (error) {
        const message =
          typeof error === "object" && error !== null && "issue" in error
            ? SchemaIssue.makeFormatterDefault()((error as { issue: never }).issue)
            : error instanceof Error
              ? error.message
              : "Invalid theme document.";
        setImportErrors((current) => ({ ...current, [mode]: message }));
        return;
      }

      if (decoded.mode !== mode) {
        setImportErrors((current) => ({
          ...current,
          [mode]: `Imported theme mode mismatch. Expected ${mode}, received ${decoded.mode}.`,
        }));
        return;
      }

      const existingIds = new Set([
        ...BUILTIN_THEME_PRESETS.map((preset) => preset.theme.id),
        ...customThemes.map((theme) => theme.id),
      ]);
      const normalized = normalizeImportedThemeDocument(decoded, existingIds);

      updateSettings({
        ...(mode === "dark"
          ? { activeDarkThemeId: normalized.id }
          : { activeLightThemeId: normalized.id }),
        customThemes: [...customThemes, normalized],
      });
      toastManager.add({
        type: "success",
        title: MODE_COPY[mode].importTitle,
        description:
          normalized.id === decoded.id
            ? `${normalized.name} is now available in your custom ${mode} theme library.`
            : `${normalized.name} was imported as ${normalized.id} to avoid an id conflict.`,
      });
    },
    [customThemes, updateSettings],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Color Mode">
        <div className="grid gap-2 px-4 py-3 sm:grid-cols-3 sm:px-5">
          {COLOR_MODE_OPTIONS.map((option) => {
            const Icon = option.icon;
            const selected = colorMode === option.value;

            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setColorMode(option.value)}
                className={cn(
                  "flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                  selected
                    ? "border-primary bg-primary/6 text-foreground"
                    : "border-border bg-card/60 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-8 items-center justify-center rounded-lg",
                    selected ? "bg-primary text-primary-foreground" : "bg-accent text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                </span>
                <span>
                  <span className="block text-xs font-medium">{option.label}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {option.value === "system"
                      ? "Follow OS preference"
                      : option.value === "light"
                        ? "Always light"
                        : "Always dark"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </SettingsSection>

      {(["light", "dark"] as const satisfies ReadonlyArray<ThemeMode>).map((mode) => {
        const activeTheme = activeThemeByMode[mode];
        const importInputRef = mode === "light" ? lightImportInputRef : darkImportInputRef;

        return (
          <SettingsSection
            key={mode}
            title={MODE_COPY[mode].label}
            headerAction={
              <div className="flex items-center gap-1.5">
                <Button size="xs" variant="outline" onClick={() => importInputRef.current?.click()}>
                  <UploadIcon className="size-3" />
                  Import
                </Button>
                <Button size="xs" variant="outline" onClick={() => handleCopyTheme(mode)}>
                  <CopyIcon className="size-3" />
                  Copy
                </Button>
                <Button size="xs" variant="outline" onClick={() => handleDuplicateTheme(mode)}>
                  Duplicate
                </Button>
                <Button size="xs" variant="outline" onClick={() => handleResetCurrent(mode)}>
                  <RotateCcwIcon className="size-3" />
                  Reset
                </Button>
                {activeTheme.origin === "custom" ? (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    onClick={() => handleDeleteTheme(mode)}
                  >
                    <Trash2Icon className="size-3" />
                    Delete
                  </Button>
                ) : null}
              </div>
            }
          >
            <div className="px-4 py-3 sm:px-5">
              {/* Theme grid */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {themeLibraryByMode[mode].map((entry) => (
                  <ThemeCard
                    key={entry.theme.id}
                    theme={entry.theme}
                    isSelected={activeTheme.id === entry.theme.id}
                    onSelect={() => updateModeSelection(mode, entry.theme.id)}
                  />
                ))}
              </div>

              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleImportTheme(mode)}
              />
              {importErrors[mode] ? (
                <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-xs text-destructive-foreground">
                  <p className="font-medium">Import failed</p>
                  <p className="mt-0.5 whitespace-pre-wrap">{importErrors[mode]}</p>
                </div>
              ) : null}

              {/* Inline editor */}
              <div className="mt-3 border-t border-border pt-3">
                <ThemeEditor
                  theme={activeTheme}
                  onChange={(updater) => handleThemeChange(mode, updater)}
                />
              </div>
            </div>
          </SettingsSection>
        );
      })}
    </SettingsPageContainer>
  );
}
