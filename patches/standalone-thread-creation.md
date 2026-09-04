# Standalone thread creation

## Fork requirement

Personal automation such as Warte must be able to start a normal root thread without pretending
that another agent delegated the work. The thread should still use T3's authenticated API, managed
workspace service, model validation, and durable first-turn dispatch.

## Behavior

- `t3 thread create` creates a delegated worker when `--from-thread` or `T3CODE_THREAD_ID` supplies
  a caller.
- Without a caller, the command creates a root thread and records no `createdBy` relationship.
- Root creation requires an explicit project and model selection. Caller-owned effort, label, and
  replacement options remain unavailable without a caller.
- Remote root creation uses the same authenticated thread-orchestration API as local creation.

## Maintenance

Retire this patch if upstream exposes caller-free root creation through the CLI with equivalent
managed-workspace and remote-environment behavior.
