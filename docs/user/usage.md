# Usage and limits

## Understand your usage

**Usage** combines Codex, Claude Code, and Grok Build session history from your connected
environments. It shows token use, cache savings, model breakdowns, and estimated API-equivalent
cost. These estimates are not your subscription bill.

Totals depend on the history available on each server. Grok turns without a saved completed-turn
record are missing from the totals.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

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

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Track subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your environments and hubs you read one number per window rather than a
list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts are ordered by their 5-hour reset, soonest
first, or by the first available window when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Codex accounts with banked
reset credits show a ticket count and the **Use reset** action in the account details. On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Tap a row to open its details.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

If a window looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.
