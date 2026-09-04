# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

The **Limits** view shows how much of each subscription window you have used on Codex and Claude
Code, per connected environment: the session and weekly windows, plus a per-model weekly window
such as Fable when your plan has one. Each window is a bar from the moment it opened to its reset,
filled by the share of quota spent; a thin line marks how far into the window you are, which is
also where even spending would have put the fill, and the icon beside the label says whether you
are ahead of, on, or under that pace. Hover a bar for the exact reset time. Limits refresh on the
provider health-check interval and update live while a turn runs. API-key accounts have no
subscription windows and say so; that includes a Claude Code that reaches Anthropic through a proxy
via `ANTHROPIC_AUTH_TOKEN`, since the CLI then treats itself as an API-key client.

If you pool accounts behind a CLIProxyAPI hub, open **Settings → Providers → Usage providers**
and choose **Add hub**. Select the device that should connect to the hub; its accounts appear on
the Limits view. Remove hubs from the same settings section. Each limits row shows its provider
and instance name, or a small _CLI Proxy_ label for
hub accounts. When a connected provider reports limits for the same provider and email, its row
replaces the hub copy, keeping details such as banked reset credits. The hub copy remains visible
if the connected provider cannot report limits. Enter the hub's URL and management key; the key
is stored on the server and never sent back to a client. Emails are blurred until clicked, as in
provider settings.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Refreshing rescans every connected environment and refetches model pricing on
each of them, so a newly released model that showed $0.00 gets a price without waiting for the daily
pricing update.

## Understand limit forecasts

The usage meter beside the composer supports Codex, Claude, and GLM models used through a Z.AI
Coding Plan in OpenCode. It forecasts how much of each limit window you are likely to use by its
reset. It learns from the observed portions of recent windows, so shifts in your working pattern
gradually change future forecasts. The current window affects the estimate immediately.

For GLM, T3 Code uses the API key and API endpoint already resolved by OpenCode for the selected
model. The meter appears only while that matching GLM model is selected. Its compact rows show the
five-hour coding allowance and the weekly allowance when Z.AI reports one. Open the meter to see the
monthly MCP quota for Z.AI Web Search, Web Reader, and ZRead calls. Other MCP servers do not consume
that allowance, and Z.AI's vision MCP shares the five-hour coding pool instead. GLM activity is not
yet included in the historical Usage page.

For Claude, open the meter to see every limit Claude reports, including the current session, the
weekly all-model limit, and model-specific weekly limits. Claude does not always return a plan name,
so T3 Code shows the limit data without guessing one. The meter appears only when the connected
Claude account reports subscription rate limits; API-billed setups may not provide them.

While a Claude or matching GLM session is active, T3 Code checks the account after completed turns
and at least every five minutes. Open the meter to see when its values were last updated. If the last
successful check is more than ten minutes old, the meter marks the values as stale and pauses its
forecast. An expired window stays visible as the previous observation while T3 Code waits for
refreshed limits instead of presenting it as current.

Before enough history coverage exists, the meter shows an early estimate that keeps the opening
hours of a weekly window from dominating the entire forecast. A window reset ahead of schedule can
still contribute the usage observed before its reset, but the forecast does not treat its missing
tail as zero usage. History adjusts the current-window estimate conservatively instead of replacing
it outright. Once recent history covers the equivalent remaining span often enough, the details
show its observed range. The server retains only a compact history of the eight newest windows for
each distinct limit.

When the forecast exceeds 100%, the compact meter estimates how long before the reset you will run
out. Open the meter for the approximate date and time. If recent windows disagree, the details show
a likely range before reset or say that usage may still last until reset. These estimates use the
same sleep and weekend weighting as the percentage forecast and update as new usage arrives. A
forecast is anchored to the time its usage percentage was observed; only the reset countdown
advances between provider updates.
