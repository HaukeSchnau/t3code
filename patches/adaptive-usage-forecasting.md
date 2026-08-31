# Adaptive Usage Forecasting

## Purpose

Keep the Codex usage forecast useful at the beginning of a limit window, when raw pace
extrapolation is unstable, and adapt it to the user's changing usage over time.

## Contract

- Provider usage projections retain percentage-change points for the eight newest windows of each
  duration, compacted to at most 24 points per window.
- Migration 53 backfills that bounded history from existing provider usage-limit events. New live
  updates extend it transactionally with the latest usage projection.
- Forecasts use the typical remaining usage from equivalent points in completed recent windows.
  Recent windows receive more weight, and the model reaches full historical confidence after three
  completed windows.
- Before enough history exists, raw pace is regularized toward a 100% neutral prior. The current
  window still affects the forecast immediately and joins history only after its reset passes.
- Forecast time is anchored to the provider observation timestamp rather than the client's wall
  clock. After ten minutes without a successful observation, the meter pauses forecasts and reports
  the snapshot as stale; an expired observed window is shown as awaiting refresh.
- The compact meter remains forecast-first. Its details identify early estimates, state how many
  recent windows informed an adaptive estimate, and show the observed range after three windows.
- Forecasts above 100% also derive an exhaustion time from the same projected usage. The estimate
  follows the existing sleep and weekend weighting, and historical percentage ranges become timing
  ranges. This calculation stays in the web client and adds no persistence or contract state.

## Surfaces

- The server owns bounded history so web and desktop, local and remote connections, and reconnects
  share the same forecast inputs. The web client owns the pure forecast calculation and display.
- Chat, previous-message editing, and monitor entry points all consume the same provider history.
  Mobile does not currently render the usage meter.

## Verification

- Contract tests cover backward-compatible snapshots with and without history.
- Migration and repository tests cover backfill, percentage-change deduplication, and window bounds.
- Snapshot tests cover transport of history to clients.
- Forecast tests cover the unstable opening-window case, historical remainder estimates, ranges,
  and the existing sleep/weekend behavior.
- Render tests cover forecast-forward accessible copy and historical explanation.

## Maintenance

Retire this patch when upstream retains bounded provider usage curves and provides a similarly
stable, adaptive, and explainable projection at the beginning of weekly windows.
