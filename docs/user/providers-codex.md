# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries or environment variables.

## Use multiple accounts

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

## Answer Codex Questions

Codex can show a structured question in the composer when it needs a decision that it
cannot safely infer. Choose one of the suggested answers or enter a custom answer, then select
**Submit answers**. The same question is available on web, desktop, iOS, and Android, including
when you connect to the environment remotely.

Questions asked while a thread is in Build mode are optional. Select **Skip** to let Codex continue
with its best judgment. Plan Mode questions remain blocking because the answer may determine the
plan.

## Pause And Resume A Turn

While Codex is working, use the Pause button in the composer to interrupt the current response.
Once Codex has stopped, the empty composer shows Resume. Resuming continues from the interrupted
thread context without adding a message such as “continue” to the conversation.

If you want to change direction instead, type a new instruction. The Resume action becomes the
normal Send action as soon as the composer has content.

Resume is also available when a Codex turn stops because the selected model is at capacity. T3
Code retries that failure automatically up to five times, with waits of roughly 5, 10, 20, 40,
and 80 seconds. The retry remains scheduled if the T3 Code server restarts. The error banner shows
whether another attempt is scheduled or the automatic retries are exhausted; select Resume at any
time to retry immediately.

A retry sequence resets after Codex makes meaningful progress. Other provider errors remain visible
without automatic retries so repeated authentication, permission, or validation failures do not
loop in the background.

Pause and message-free resume are currently available for Codex threads. Other providers keep the
Stop action until their runtimes expose an equivalent continuation operation.

## I Only Use One Codex Account

Use the default provider and log in normally.

In Settings, your Codex provider can stay like this:

```text
Display name: Codex
CODEX_HOME path: ~/.codex
Shadow home path: empty
```

```bash
codex login
```

For a second account, sign in from a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3 Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Your submitted answers appear as a message in the conversation, together with their questions.
If T3 cannot save the answer, the question stays open so you can retry. If the answer was saved
but Codex could not receive it, the message remains in the conversation with the normal delivery
failure state. Retrying a question does not create a second copy of an already accepted answer.

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
