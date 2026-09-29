import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

/**
 * Sign files with matching options together instead of spawning codesign for each file.
 * When the build sets T3CODE_MACOS_DESIGNATED_REQUIREMENT, the main bundle gets that
 * requirement. Helpers keep their defaults, since the requirement names the app's identifier.
 */
export default async function sign(options: SignOptions): Promise<void> {
  const requirement = process.env.T3CODE_MACOS_DESIGNATED_REQUIREMENT?.trim();
  const optionsForFile = options.optionsForFile;
  await signApplication({
    ...options,
    batchCodesignCalls: true,
    ...(requirement
      ? {
          optionsForFile: (filePath, context) => {
            const fileOptions = optionsForFile?.(filePath, context) ?? {};
            return filePath === options.app
              ? { ...fileOptions, requirements: `=${requirement}` }
              : fileOptions;
          },
        }
      : {}),
  });
}
