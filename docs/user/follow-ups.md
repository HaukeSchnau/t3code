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

Agents keep follow-ups tidy themselves: they search before they write, update an existing one
rather than add a duplicate, and may define types with their own fields, such as a risk with a
severity. Every change is listed under the follow-up's history.

## Share follow-ups across machines

Each environment keeps its own follow-ups unless the server's `T3CODE_FOLLOW_UP_HOME` names another
environment's id. Environments that name the same home share one store: agents on any of them read
and write it, and the app shows it once. Each of them needs Linked environments switched on and a
link to the home (see [Link another environment](./remote-access.md#link-another-environment)).

The app shows the stores of the environments you have switched on, so an environment mode that
switches between work and personal machines also switches between their follow-ups.
