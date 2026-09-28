# Automatic Thread Titles

## Purpose

Use the inexpensive text-generation model to keep generated thread titles aligned with a
conversation as its durable goal becomes clearer or changes.

## Contract

- New and generated titles are automatic. Direct user edits are manual and never refresh in the
  background. Explicit regeneration returns a thread to automatic mode.
- Legacy threads have unknown title provenance and remain unchanged until explicitly regenerated.
- Every later user-authored turn may schedule a refresh when the server setting is enabled. The
  prompt preserves an accurate title and changes it only for a meaningful specificity gain or a
  clear user-led topic shift.
- Refreshes are latest-wins per thread and globally limited to three concurrent generations. A
  compare-and-swap title guard prevents late work from overwriting a newer generated or manual
  title.
- Returning the current title is a no-op. First-turn generation remains enabled when later
  automatic refreshes are disabled.
- Title generation uses the configured text-generation model, whose default is GPT-5.6 Luna at low
  reasoning effort.

## Surfaces

- The server owns refresh scheduling, so web, desktop, mobile, local, remote, and tunnel clients
  observe the same persisted title updates.
- Web and desktop expose **Automatic thread titles** in General settings. Mobile does not currently
  expose general server settings, but receives the resulting title events through the shared client
  runtime.

## Verification

- Reactor tests cover first-turn generation, later context refresh, latest-wins cancellation,
  manual-title preservation, the disabled setting, and explicit regeneration.
- Decider tests cover manual ownership, stale compare-and-swap rejection, and first-turn seed
  preservation for manual titles.
- Migration, projection, prompt, settings, and shared client reducer tests cover the remaining
  persistence and transport path.

## Maintenance

Retire this patch when upstream tracks generated-versus-manual title ownership and performs bounded,
stable, per-turn title refreshes with equivalent legacy-title and race protections.
