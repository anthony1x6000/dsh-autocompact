# dsh-autocompact

Autocompact for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
configured per model route with either or both triggers:

- **Idle**: after a session has been idle for **N minutes**, it is condensed with
  the same engine behind `/compact`, run through the `commands` service. N is
  configured per model route, so a provider whose prompt cache expires quickly
  can compact sooner than one that keeps it warm.
- **Tokens**: at every **step boundary**, a session whose measured context
  pressure reaches **N tokens** is condensed mid-turn, through the agent's own
  compaction backend. N is configured per model route. This keeps one long turn
  below the window even when that backend's own pressure policy is unconfigured
  or disabled (for example a route whose `maxTokens` equals its `contextWindow`,
  which leaves `dsh-compaction-basic` no pressure budget).

## Install

```sh
dsh plugin --profile web add "github:anthony1x6000/dsh-autocompact#main"
```

Needs the `/compact` command, which every `dsh` profile with a compaction backend
provides, including the web profile. The idle trigger runs at the profile root
and calls the command. The token trigger resolves the backend per agent: the web
profile builds it inside each agent preset, so the plugin asks the preset
registry (`agentPresets.serviceFor(agent, 'compaction')`), and falls back to a
root `compaction` service when a composition mounts one there.

## Configure

Open **Plugins** in the sidebar, then **dsh-autocompact** under *Installed plugins*,
and click **Configure** on the `idle-autocompact` row. Pick a provider and model
from the deployment's current catalog (or **Any provider** / **Any model**), set
idle minutes, a token threshold, or both, then **Save**. A saved value the catalog
no longer offers stays selectable and is marked *unavailable*, so saving another
row never rewrites it. Saving applies to running sessions without a restart.
(**Settings -> Built-in plugins** is a read-only inventory and has no form for
this plugin.)

Or set it in your profile patch:

```yaml
- id: idle-autocompact
  config:
    rules:
      - provider: deepseek          # any model on this provider
        minutes: 10
      - model: deepseek-chat        # this model on any provider
        tokens: 250000
      - provider: opencode-go       # exact route, both triggers
        model: deepseek-v4.1-flash
        minutes: 55
        tokens: 300000
      - provider: opencode-go       # exact route, token trigger only
        model: glm-5.3
        tokens: 0                   # 0 / blank disables that trigger
      - provider: opencode-go       # declared window reduced on purpose
        model: deepseek-v4.1-flash
        tokens: 900000
        contextWindow: 1000000      # real capacity for this route
```

| Rule has | Matches | Priority |
|---|---|---|
| `provider` + `model` | that exact route | highest |
| `model` only | that model on any provider | middle |
| `provider` only | any model on that provider | lowest |

The most specific matching rule supplies both triggers; a more specific rule does
not inherit the broader rule's idle minutes or token threshold. A trigger is off
when it is absent, blank, or `0`. Routes with no matching rule are never
autocompacted. Duplicate selectors, non-finite or negative minutes, and negative
or fractional token thresholds fail at load.

## Exceeding a reduced context window

If a route's declared `contextWindow` is deliberately smaller than what the model
really supports, set the rule's `contextWindow` to the real capacity. The
`dsh-llm-pi-ai` adapter turns a successful response whose reported prompt is
above the declared window into `CONTEXT_WINDOW_EXCEEDED`; the plugin's
`llm/stream` listener restores the successful finish (`stop` or `tool-calls`)
when all of these hold:

- the stream completed (every started block ended and the adapter emitted its
  replay state),
- usage was reported, and
- the reported prompt (`input + cacheRead + cacheWrite`) is below the rule's
  `contextWindow`.

A genuine overflow (prompt beyond the override), a provider-raised error, or an
interrupted stream keeps its failure. The override covers ordinary requests and
the compaction summary call alike.

Keep `tokens` below `contextWindow` so the trigger fires before the real limit.
Note that `dsh-compaction-basic` still measures the declared window; on a profile
where you want to pass it, set that backend's `auto: false` (or a policy that
fits), because otherwise it can compact at its own threshold first. Only declare
a real capacity you know: a provider that silently truncates input within it can
be presented as a success.

## Behavior

- **Idle**: the countdown starts when the agent becomes idle (and when a session
  is first loaded) and is cancelled as soon as a turn starts. If the route's
  token threshold is already reached at that moment, the session compacts right
  away instead of waiting for the minutes.
- **Tokens**: checked at every `agent/pre-step`, so a single long turn is
  protected without waiting for it to finish. The measured number is
  `ctx.tokenMeter.measure(session).totalTokens`, the same request pressure
  `dsh-compaction-basic` uses. One attempt is made per threshold crossing: after
  an attempt the plugin stays quiet until pressure drops below the threshold
  again, so an impossible range or a partial reduction does not retry every
  step.
- The token trigger uses the backend's forced-reduction path
  (`compactIfNeeded(agent, 'context-overflow', signal)`), which bypasses that
  backend's own threshold and retained tail. It still respects tool-call/result
  pairing, an already-running compaction, and turn cancellation.
- The route is the one used by the session's latest request, falling back to the
  agent's configured model before the first request.
- A session whose newest history activity is already a compaction is never
  compacted. The history tail is read when a trigger fires, so a manual
  `/compact` during the countdown consumes that idle period instead of being
  compacted again; the next turn re-arms it as usual.
- A session in the host's archive set is never compacted. The set is read when
  an idle timer fires, so a thread archived during its countdown is skipped and
  that idle period is consumed; unarchive it and it compacts again after its next
  idle period. Profiles without a workspace registry archive nothing and are
  unaffected.
- Every compaction (manual `/compact`, idle, or token) logs how much of the
  summarization request was read from the provider's prompt cache, e.g.
  `compaction cache: 98% of input read from cache (read 11760, write 0, uncached 240, total 12000)`.
  A high read share means the history was warm; near 0% means it was re-read cold.
- If compaction is already running, or the agent became busy, the attempt is
  skipped silently. Other failures are logged as warnings and never crash a turn.

## Develop

```sh
pnpm install
pnpm build
pnpm test
```
