# Follow-ups

Follow-ups are things worth doing later. Agents write them down when a thread leaves work for
another day, most often when you settle a thread, so the work no longer depends on your memory.
Each follow-up links back to the thread and message it came from.

Open **Follow-ups** from the sidebar or the command palette. On mobile, choose **Follow-ups** in
the workspace navigation.

## Work with a follow-up

- **Start a thread** opens a new thread seeded with the follow-up and a link to where it came
  from. The follow-up shows that thread, and the agent closes it with its result when the work is
  done.
- **Done** and **Drop** close it. **Later** moves its date.
- A follow-up with a date comes back to your inbox, in the thread list, when the date arrives.

## Write one yourself

- Select a passage in an agent's reply and choose **Follow-up** to keep it, with a link back to
  that message.
- On your phone, tap **+** in **Follow-ups**, or long-press the app icon and choose **New
  follow-up**, then type or dictate. The first line becomes the title.

**Graph** on the follow-ups page shows how follow-ups connect to each other and to the threads
they came from or were picked up in.

## Keep them tidy

Agents keep follow-ups tidy themselves: they search before they write, update an existing one
rather than add a duplicate, and may define types with their own fields, such as a risk with a
severity. Every change is listed under the follow-up's history.

A server can tend its follow-ups once a night when `T3CODE_FOLLOW_UP_GARDENER_AT` is set to a local
time such as `03:30`. The pass merges duplicates, closes what turns out to be done, checks the
plain-language conditions, keeps types consistent, and writes down follow-ups that settled threads
left behind. Its thread ends with a short report of every change; the follow-ups page links to the
latest one and can start a pass now. `T3CODE_FOLLOW_UP_MEMBERS` lists the other environments, by
id, whose settled threads the pass reads.

When you start a thread that clearly continues an open follow-up, the agent is told about it.

## Share follow-ups across machines

Each environment keeps its own follow-ups unless the server's `T3CODE_FOLLOW_UP_HOME` names another
environment's id. Environments that name the same home share one store: agents on any of them read
and write it, and the app shows it once. Each of them needs Linked environments switched on and a
link to the home (see [Link another environment](./remote-access.md#link-another-environment)).

The app shows the stores of the environments you have switched on, so an environment mode that
switches between work and personal machines also switches between their follow-ups.
