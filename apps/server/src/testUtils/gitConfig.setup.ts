// Pins git behaviour for every repository the suite creates, ahead of the
// host's ~/.gitconfig. Git for Windows installs with core.autocrlf=true,
// which checks committed LF files out as CRLF and breaks every byte-exact
// content assertion; a signing key or a non-default init branch on the
// developer's machine breaks fixtures the same way. Set as environment so
// each git child the driver spawns sees it without touching the fixtures.
const entries: ReadonlyArray<readonly [key: string, value: string]> = [
  ["core.autocrlf", "false"],
  ["core.filemode", "false"],
  ["core.longpaths", "true"],
  ["commit.gpgsign", "false"],
  ["tag.gpgsign", "false"],
  ["init.defaultBranch", "main"],
];

// Setup files run before every test file. Without isolation the files share a
// process, so the entries are appended only when they aren't already the last.
const count = Number(process.env.GIT_CONFIG_COUNT ?? "0");
const start = count - entries.length;
const applied =
  start >= 0 &&
  entries.every(
    ([key, value], index) =>
      process.env[`GIT_CONFIG_KEY_${start + index}`] === key &&
      process.env[`GIT_CONFIG_VALUE_${start + index}`] === value,
  );
if (!applied) {
  process.env.GIT_CONFIG_COUNT = String(count + entries.length);
  entries.forEach(([key, value], index) => {
    process.env[`GIT_CONFIG_KEY_${count + index}`] = key;
    process.env[`GIT_CONFIG_VALUE_${count + index}`] = value;
  });
}
