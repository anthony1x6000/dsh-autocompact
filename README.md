# dsh-autocompact

Idle autocompact for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
After a session has been idle for **N minutes**, it is condensed with the same
engine behind `/compact` (`ctx.compaction.compactNow()`). N is configured per
model route, so a provider whose prompt cache expires quickly can compact sooner
than one that keeps it warm.

## Install

```sh
dsh plugin --profile web add "github:anthony1x6000/dsh-autocompact#main"
```

Requires a mounted compaction backend (the default `dsh` base has one).

## Configure

Open **Settings -> Plugins -> idle-autocompact** and edit `rules`, or set it in the
patch:

```yaml
- id: idle-autocompact
  config:
    rules:
      - provider: deepseek          # any model on this provider
        minutes: 10
      - model: deepseek-chat        # this model on any provider
        minutes: 5
      - provider: deepseek          # exact route, most specific
        model: deepseek-reasoner
        minutes: 0                  # 0 = never autocompact this route
```

| Rule has | Matches | Priority |
|---|---|---|
| `provider` + `model` | that exact route | highest |
| `model` only | that model on any provider | middle |
| `provider` only | any model on that provider | lowest |

Routes with no matching rule are never autocompacted. Duplicate selectors, rows
with neither `provider` nor `model`, and negative minutes fail at load.

## Behavior

- The countdown starts when the agent becomes idle (and when a session is first
  loaded) and is cancelled as soon as a turn starts.
- The route is the one used by the session's latest request, falling back to the
  agent's configured model before the first request.
- One compaction per idle period; it does not repeat until the session has been
  active again.
- If compaction is already running, or the agent became busy, the attempt is
  skipped silently. Other failures are logged as warnings and never crash a turn.

## Develop

```sh
pnpm install
pnpm build
pnpm test
```
