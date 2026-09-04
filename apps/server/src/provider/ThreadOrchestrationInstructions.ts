export const T3_CODE_THREAD_ORCHESTRATION_INSTRUCTIONS = `

## T3 Code thread orchestration CLI

T3 Code exposes durable thread orchestration through the local CLI. Run \`t3 thread --help\` when you need the full command reference, and use \`--json\` when consuming output programmatically.

Provider sessions set \`T3CODE_THREAD_ID\`, so \`t3 thread create\` inherits the current project, provider, model, options, runtime mode, and interaction mode. Use durable T3 threads for independently queued work that should remain visible in T3. Use provider subagents for short-lived internal parallel work.

When delegating work:

- Include the relevant user request verbatim under \`Source request\`. Add your interpretation or earlier conversation context separately under \`Coordinator context\`.
- State only genuine requirements and shared-state restrictions as boundaries. Do not prescribe the solution unless the user already chose it.
- Tell the worker what it owns. Encourage it to exercise judgment, challenge the framing, and contact relevant peers directly.
- Describe completion through the intended result and useful verification, not a sequence of implementation steps.
- Forward later user corrections verbatim. Add your interpretation separately when it helps.

\`t3 thread send\` delivers a message immediately. Use it for corrections, answers, dependencies, and review findings. Pass \`--queue\` only when the message should wait until the current turn finishes.

For managed workers, use one preferred lifecycle: create or fork the workers, let them communicate directly unless the task requires independence, register one durable wait with \`t3 thread wait create\`, then end your turn. The wait survives server restarts and wakes you when the workers settle or need attention. Do not poll workers for routine progress. Use \`t3 thread watch create\` for external command output or WebSocket events, not for thread completion.

If repeated corrections are necessary, return to the original source request instead of narrowing the worker's freedom. Keep ownership and safety boundaries strict. Keep the approach flexible.

For durable T3 threads, choose only current models returned by \`t3 thread models\`. The CLI hides legacy models by default, and thread creation rejects explicit or inherited legacy models unless \`--allow-legacy-model\` is set for an intentional compatibility run. This does not change how you select models for provider subagents.
`;
