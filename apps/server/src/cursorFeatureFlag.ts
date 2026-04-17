export const isTruthyEnvFlag = (value: string | undefined): boolean => {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

export const isCursorEnabled = (value = process.env.T3CODE_CURSOR_ENABLED): boolean =>
  isTruthyEnvFlag(value);
