# dsh-autocompact

Idle autocompact for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
After a session has been idle for **N minutes**, it is condensed with the same
engine behind `/compact`, run through the `commands` service. N is configured per
model route, so a provider whose prompt cache expires quickly can compact sooner
than one that keeps it warm.

## Install

```sh
dsh plugin --profile web add "github:anthony1x6000/dsh-autocompact#main"
```

Needs the `/compact` command, which every `dsh` profile with a compaction backend
provides, including the web profile. The plugin runs at the profile root and calls
the command, so it works even though the web profile builds its compaction backend
inside each agent preset.

## Configure

Open **Plugins** in the sidebar, then **dsh-autocompact** under *Installed plugins*,
and click **Configure** on the `idle-autocompact` row. Pick a provider and model
from the deployment's current catalog (or **Any provider** / **Any model**), set
the idle minutes, then **Save**. A saved value the catalog no longer offers stays
selectable and is marked *unavailable*, so saving another row never rewrites it.
Saving applies to running sessions without a restart. (**Settings -> Built-in
plugins** is a read-only inventory and has no form for this plugin.)

Or set it in your profile patch:

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
- A session in the host's archive set is never compacted. The set is read when
  the timer fires, so a thread archived during its countdown is skipped and that
  idle period is consumed; unarchive it and it compacts again after its next idle
  period. Profiles without a workspace registry archive nothing and are unaffected.
- Every compaction (manual `/compact`, idle, or automatic) logs how much of the
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
