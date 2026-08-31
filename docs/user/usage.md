# Review usage

The Usage page combines Codex and Claude Code activity from your connected environments. It reads
the providers' local session history and shows API-equivalent token cost, processed tokens, cache
savings, provider shares, and model breakdowns. Subscription billing is separate from the raw token
cost shown here.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

## Understand limit forecasts

The usage meter beside the composer supports Codex and Claude. It forecasts how much of each limit
window you are likely to use by its reset. It learns from the changing percentage during recent
completed windows, so shifts in your working pattern gradually change future forecasts. The current
window affects the estimate immediately.

For Claude, open the meter to see every limit Claude reports, including the current session, the
weekly all-model limit, and model-specific weekly limits. Claude does not always return a plan name,
so T3 Code shows the limit data without guessing one. The meter appears only when the connected
Claude account reports subscription rate limits; API-billed setups may not provide them.

While a Claude session is active, T3 Code checks the account after completed turns and at least every
five minutes. Open the meter to see when its values were last updated. If the last successful check
is more than ten minutes old, the meter marks the values as stale and pauses its forecast. An expired
window stays visible as the previous observation while T3 Code waits for refreshed limits instead of
presenting it as current.

Before enough completed history exists, the meter shows an early estimate that keeps the opening
hours of a weekly window from dominating the entire forecast. After three completed windows, its
details show how many recent windows informed the estimate and the range those windows produced.
The server retains only a compact history of the eight newest windows for each distinct limit.

When the forecast exceeds 100%, the compact meter estimates how long the remaining usage will last.
Open the meter for the approximate date and time. If recent windows disagree, the details show a
likely timing range or say that usage may still last until reset. These estimates use the same sleep
and weekend weighting as the percentage forecast and update as new usage arrives. A forecast is
anchored to the time its usage percentage was observed; only the reset countdown advances between
provider updates.
