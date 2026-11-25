# Brief for a conflict-resolution subagent

Fill in the workspace path, the three commit ids, and the agent's file list. Each agent gets one area.

---

You are resolving merge conflicts in a personal fork of T3 Code that is merging upstream pingdotgg/t3code main. Read AGENTS.md "Fork maintenance" and `patches/fork-workflow.md` first.

Workspace: `<path>`, a jj workspace whose working copy is the merge. Your files: `<list>`. Touch only those, plus a `patches/*.md` doc when one of your decisions changes what it describes. Other agents resolve other areas in the same workspace at the same time.

The markers are git style with a base section. The first side (`<<<<<<<`, `<fork id>`) is the fork, `|||||||` (`<base id>`) is the merge base, and `>>>>>>>` (`<upstream id>`) is new upstream. The lead fills in the real ids. After a rebase, the sides change meaning, so read the label on each hunk. Read more with `jj file show -r <id> <path>`, and see why a side changed with `git log --oneline <base>..<upstream|fork> -- <path>`.

How to resolve:

- Resolve hunk by hunk. Keep fork behavior that a `patches/*.md` doc describes, and take upstream's change everywhere else. Where both sides changed the same lines for different reasons, combine them so both intents survive.
- When upstream now does what a fork doc requires, use upstream's code, delete the fork code, and update or remove the doc.
- When you can't tell whether a resolution drops a fork requirement, keep the fork behavior and put the question in your report.
- For a delete-versus-modify conflict, find who deleted the file and why, and follow that unless the other side's change has to move elsewhere.
- Settle every file hunk by hunk. Leave jj history alone (no `new`, `commit`, `squash`, `restore` and so on), and leave installs, dev servers and repo-wide checks to the lead.

Done when the marker grep finds nothing in your files and `jj resolve --list <files>` lists none of them. Report in at most 40 lines: each hunk where you dropped one side for a non-obvious reason (one line each), the patch docs you changed, and open questions.
