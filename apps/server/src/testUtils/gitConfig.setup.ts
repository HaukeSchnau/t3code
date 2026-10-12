// @effect-diagnostics nodeBuiltinImport:off -- setup runs before any Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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

// jj gets the same treatment: a fixed identity and no signing, instead of the
// developer's config, so jj fixtures never wait on an SSH agent.
if (process.env.T3_TEST_JJ_CONFIG === undefined) {
  const jjConfig = NodePath.join(NodeOS.tmpdir(), `t3-test-jj-${process.pid}.toml`);
  NodeFS.writeFileSync(
    jjConfig,
    '[user]\nname = "Test"\nemail = "test@test.com"\n[signing]\nbehavior = "drop"\n[ui]\npaginate = "never"\n',
  );
  process.env.T3_TEST_JJ_CONFIG = jjConfig;
  process.env.JJ_CONFIG = jjConfig;
}
