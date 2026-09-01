import type { ColorValue } from "react-native";
import { useCSSVariable } from "uniwind";

/** Returns one Uniwind color variable for native APIs that need a ColorValue. */
export function useThemeColor(variable: `--color-${string}`): ColorValue {
  return useCSSVariable(variable) as string as ColorValue;
}
