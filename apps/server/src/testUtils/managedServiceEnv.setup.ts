import { SERVICE_LAUNCHER_CONTEXT_ENV } from "../cloud/serviceProtocol.ts";

// Agents inside a managed T3 service inherit its home and launcher context; CI has neither.
for (const name of ["T3CODE_HOME", "T3_BOOT_SERVICE_UNIT", SERVICE_LAUNCHER_CONTEXT_ENV]) {
  delete process.env[name];
}

// Hosts may carry Claude managed settings, such as an endpoint and a key helper. Tests read none.
process.env.T3CODE_CLAUDE_MANAGED_SETTINGS_DIR = "/nonexistent/t3code-test-claude-managed";
