import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  apply,
  Config,
  formatCacheUsage,
  historyEndsWithCompaction,
  IdleCompactor,
  inject,
  resolveContextWindow,
  resolveIdleMinutes,
  resolveTokenThreshold,
  restoreSuccessfulFinish,
  routeOf,
  TokenCompactor,
  validateRules,
  type CompactionEngine,
  type IdleAgent,
  type Rule,
  type TokenMeter,
} from './index.ts'

const MINUTE = 60_000

function fakeAgent(overrides: Partial<IdleAgent> = {}): IdleAgent {
  return {
    status: 'idle',
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: {
      header: { id: 'session-1' },
      seq: 0,
      eventAt: () => undefined,
      requestHeader: () => undefined,
    },
    runMaintenance: async (task) => task(new AbortController().signal),
    ...overrides,
  }
}

function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  return {
    pending,
    set(fn: () => void, ms: number): number {
      const id = next++
      pending.set(id, { fn, ms })
      return id
    },
    clear(id: unknown): void {
      pending.delete(id as number)
    },
    fireAll(): void {
      for (const [id, entry] of [...pending]) {
        pending.delete(id)
        entry.fn()
      }
    },
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('resolveIdleMinutes', () => {
  const rules: Rule[] = [
    { provider: 'deepseek', minutes: 30 },
    { model: 'deepseek-chat', minutes: 10 },
    { provider: 'deepseek', model: 'deepseek-chat', minutes: 5 },
  ]

  it('prefers provider+model over model over provider', () => {
    assert.equal(resolveIdleMinutes(rules, { provider: 'deepseek', model: 'deepseek-chat' }), 5)
    assert.equal(resolveIdleMinutes(rules.slice(0, 2), { provider: 'deepseek', model: 'deepseek-chat' }), 10)
    assert.equal(resolveIdleMinutes(rules.slice(0, 1), { provider: 'deepseek', model: 'deepseek-chat' }), 30)
  })

  it('model-only rules match any provider; provider-only rules match any model', () => {
    assert.equal(resolveIdleMinutes([{ model: 'm', minutes: 7 }], { provider: 'other', model: 'm' }), 7)
    assert.equal(resolveIdleMinutes([{ provider: 'p', minutes: 9 }], { provider: 'p', model: 'anything' }), 9)
  })

  it('returns undefined when nothing matches or the route is unknown', () => {
    assert.equal(resolveIdleMinutes(rules, { provider: 'x', model: 'y' }), undefined)
    assert.equal(resolveIdleMinutes(rules, {}), undefined)
    assert.equal(resolveIdleMinutes([], { provider: 'deepseek', model: 'deepseek-chat' }), undefined)
  })

  it('treats minutes 0 as disabled, overriding a broader rule', () => {
    const disabled: Rule[] = [
      { provider: 'deepseek', minutes: 30 },
      { provider: 'deepseek', model: 'deepseek-chat', minutes: 0 },
    ]
    assert.equal(resolveIdleMinutes(disabled, { provider: 'deepseek', model: 'deepseek-chat' }), undefined)
    assert.equal(resolveIdleMinutes(disabled, { provider: 'deepseek', model: 'other' }), 30)
  })
})

describe('resolveTokenThreshold', () => {
  const rules: Rule[] = [
    { provider: 'deepseek', tokens: 300_000 },
    { model: 'deepseek-chat', tokens: 250_000 },
    { provider: 'deepseek', model: 'deepseek-chat', tokens: 200_000 },
  ]

  it('prefers provider+model over model over provider', () => {
    assert.equal(resolveTokenThreshold(rules, { provider: 'deepseek', model: 'deepseek-chat' }), 200_000)
    assert.equal(resolveTokenThreshold(rules.slice(0, 2), { provider: 'deepseek', model: 'deepseek-chat' }), 250_000)
    assert.equal(resolveTokenThreshold(rules.slice(0, 1), { provider: 'deepseek', model: 'deepseek-chat' }), 300_000)
  })

  it('treats an absent or 0 threshold on the most specific rule as disabled', () => {
    const disabled: Rule[] = [
      { provider: 'deepseek', tokens: 300_000 },
      { provider: 'deepseek', model: 'deepseek-chat', tokens: 0 },
    ]
    assert.equal(resolveTokenThreshold(disabled, { provider: 'deepseek', model: 'deepseek-chat' }), undefined)
    assert.equal(resolveTokenThreshold(disabled, { provider: 'deepseek', model: 'other' }), 300_000)
  })

  it('does not inherit a broader threshold into an override with no tokens', () => {
    const rules: Rule[] = [
      { provider: 'deepseek', tokens: 300_000 },
      { provider: 'deepseek', model: 'deepseek-chat', minutes: 5 },
    ]
    assert.equal(resolveTokenThreshold(rules, { provider: 'deepseek', model: 'deepseek-chat' }), undefined)
  })

  it('returns undefined when nothing matches or the route is unknown', () => {
    assert.equal(resolveTokenThreshold(rules, { provider: 'x', model: 'y' }), undefined)
    assert.equal(resolveTokenThreshold(rules, {}), undefined)
    assert.equal(resolveTokenThreshold([], { provider: 'deepseek', model: 'deepseek-chat' }), undefined)
  })
})

describe('resolveContextWindow', () => {
  const rules: Rule[] = [
    { provider: 'openai', contextWindow: 500_000 },
    { model: 'squished', contextWindow: 900_000 },
    { provider: 'openai', model: 'squished', contextWindow: 1_000_000 },
  ]

  it('prefers provider+model over model over provider', () => {
    assert.equal(resolveContextWindow(rules, { provider: 'openai', model: 'squished' }), 1_000_000)
    assert.equal(resolveContextWindow(rules.slice(0, 2), { provider: 'openai', model: 'squished' }), 900_000)
    assert.equal(resolveContextWindow(rules.slice(0, 1), { provider: 'openai', model: 'squished' }), 500_000)
  })

  it('treats an absent or 0 override on the most specific rule as disabled', () => {
    const disabled: Rule[] = [
      { provider: 'openai', contextWindow: 1_000_000 },
      { provider: 'openai', model: 'squished', contextWindow: 0 },
    ]
    assert.equal(resolveContextWindow(disabled, { provider: 'openai', model: 'squished' }), undefined)
    assert.equal(resolveContextWindow(disabled, { provider: 'openai', model: 'other' }), 1_000_000)
  })

  it('returns undefined when nothing matches', () => {
    assert.equal(resolveContextWindow(rules, { provider: 'x', model: 'y' }), undefined)
    assert.equal(resolveContextWindow([], { provider: 'openai', model: 'squished' }), undefined)
  })
})

describe('restoreSuccessfulFinish', () => {
  const replayState = { response: { id: 'resp-1' }, blocks: [{}] }
  const overflow = { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } }
  const finish = (reason: unknown = overflow) => ({ type: 'finish' as const, reason, replayState })
  const observed = (overrides: Record<string, unknown> = {}) => ({
    usage: { inputTokens: 500_000 },
    balanced: true,
    sawBlockEnd: true,
    sawToolCall: false,
    ...overrides,
  })

  it('restores a successful stop when the prompt fits the override and blocks streamed', () => {
    assert.deepEqual(
      restoreSuccessfulFinish(finish() as never, observed() as never, 1_000_000),
      { type: 'finish', reason: { kind: 'stop' }, replayState },
    )
  })

  it('restores tool-calls when a tool call streamed', () => {
    assert.deepEqual(
      restoreSuccessfulFinish(finish() as never, observed({ sawToolCall: true }) as never, 1_000_000),
      { type: 'finish', reason: { kind: 'tool-calls' }, replayState },
    )
  })

  it('counts cached input against the override', () => {
    const usage = { inputTokens: 200_000, cacheReadTokens: 700_000 }
    assert.equal(restoreSuccessfulFinish(finish() as never, observed({ usage }) as never, 900_000), undefined)
    assert.deepEqual(
      restoreSuccessfulFinish(finish() as never, observed({ usage }) as never, 950_000)?.reason,
      { kind: 'stop' },
    )
  })

  it('keeps a genuine overflow beyond the override', () => {
    assert.equal(restoreSuccessfulFinish(finish() as never, observed() as never, 500_000), undefined)
  })

  it('keeps errors that did not come from a completed provider response', () => {
    assert.equal(
      restoreSuccessfulFinish({ type: 'finish', reason: overflow } as never, observed() as never, 1_000_000),
      undefined,
    )
    assert.equal(restoreSuccessfulFinish(finish() as never, observed({ balanced: false }) as never, 1_000_000), undefined)
    assert.equal(restoreSuccessfulFinish(finish() as never, observed({ sawBlockEnd: false }) as never, 1_000_000), undefined)
    assert.equal(restoreSuccessfulFinish(finish() as never, observed({ usage: undefined }) as never, 1_000_000), undefined)
  })

  it('ignores other failure codes and already-successful finishes', () => {
    const rateLimit = { kind: 'error', failure: { code: 'RATE_LIMIT' } }
    assert.equal(restoreSuccessfulFinish(finish(rateLimit) as never, observed() as never, 1_000_000), undefined)
    assert.equal(restoreSuccessfulFinish(finish({ kind: 'stop' }) as never, observed() as never, 1_000_000), undefined)
  })

  it('does nothing when the route has no override', () => {
    assert.equal(restoreSuccessfulFinish(finish() as never, observed() as never, undefined), undefined)
  })
})

describe('validateRules', () => {
  it('accepts a well-formed table', () => {
    assert.doesNotThrow(() => validateRules([{ provider: 'p', minutes: 5 }, { model: 'm', minutes: 0 }]))
  })

  it('accepts a token-only rule and a rule with both triggers', () => {
    assert.doesNotThrow(() => validateRules([{ provider: 'p', tokens: 250_000 }]))
    assert.doesNotThrow(() => validateRules([{ provider: 'p', minutes: 5, tokens: 0 }]))
  })

  it('rejects negative, fractional and non-finite token thresholds', () => {
    assert.throws(() => validateRules([{ provider: 'p', tokens: -1 }]), /tokens/)
    assert.throws(() => validateRules([{ provider: 'p', tokens: 1.5 }]), /tokens/)
    assert.throws(() => validateRules([{ provider: 'p', tokens: Number.NaN }]), /tokens/)
  })

  it('accepts a positive context-window override and rejects bad ones', () => {
    assert.doesNotThrow(() => validateRules([{ provider: 'p', contextWindow: 1_000_000 }]))
    assert.doesNotThrow(() => validateRules([{ provider: 'p', contextWindow: 0 }]))
    assert.throws(() => validateRules([{ provider: 'p', contextWindow: -1 }]), /contextWindow/)
    assert.throws(() => validateRules([{ provider: 'p', contextWindow: 1.5 }]), /contextWindow/)
  })

  it('rejects a rule with neither provider nor model', () => {
    assert.throws(() => validateRules([{ minutes: 5 }]), /provider or model/)
  })

  it('rejects duplicate selectors', () => {
    assert.throws(
      () => validateRules([{ provider: 'p', minutes: 5 }, { provider: 'p', minutes: 9 }]),
      /duplicate/i,
    )
  })

  it('rejects negative or non-finite minutes', () => {
    assert.throws(() => validateRules([{ provider: 'p', minutes: -1 }]), /minutes/)
    assert.throws(() => validateRules([{ provider: 'p', minutes: Number.NaN }]), /minutes/)
  })
})

describe('routeOf', () => {
  it('prefers the latest request header over agent options', () => {
    const agent = fakeAgent({
      session: {
        header: { id: 'session-1' },
        requestHeader: () => ({ config: { provider: 'hdr-p', model: 'hdr-m' } }),
      },
    })
    assert.deepEqual(routeOf(agent), { provider: 'hdr-p', model: 'hdr-m' })
  })

  it('falls back to agent options before any request was made', () => {
    assert.deepEqual(routeOf(fakeAgent()), { provider: 'deepseek', model: 'deepseek-chat' })
  })
})

describe('IdleCompactor', () => {
  function setup(
    rules: Rule[],
    compact = async () => ({}),
    tokenDue: (agent: IdleAgent) => boolean = () => false,
  ) {
    const timers = fakeTimers()
    const compacted: IdleAgent[] = []
    const warnings: string[] = []
    const compactor = new IdleCompactor<IdleAgent>({
      rules: () => rules,
      timers,
      tokenDue,
      compact: async (agent, signal) => {
        compacted.push(agent)
        return compact(agent, signal)
      },
      log: { info: () => {}, warn: (message: string) => warnings.push(message) },
    })
    return { timers, compacted, warnings, compactor }
  }

  it('compacts immediately without a timer when the token threshold is already reached', async () => {
    const { timers, compacted, compactor } = setup(
      [{ provider: 'deepseek', tokens: 250_000 }],
      async () => ({}),
      () => true,
    )
    const agent = fakeAgent()
    compactor.arm(agent)
    await settle()
    assert.deepEqual(compacted, [agent])
    assert.equal(timers.pending.size, 0)
  })

  it('keeps the idle timer when the token threshold is not reached', () => {
    const { timers, compactor } = setup([{ provider: 'deepseek', minutes: 5, tokens: 250_000 }])
    compactor.arm(fakeAgent())
    assert.equal(timers.pending.size, 1)
  })

  it('refresh compacts right away when the threshold was crossed while idle', async () => {
    let due = false
    const { timers, compacted, compactor } = setup(
      [{ provider: 'deepseek', minutes: 5, tokens: 250_000 }],
      async () => ({}),
      () => due,
    )
    const agent = fakeAgent()
    compactor.arm(agent)
    assert.equal(timers.pending.size, 1)
    due = true
    compactor.refresh()
    await settle()
    assert.deepEqual(compacted, [agent])
    assert.equal(timers.pending.size, 0)
  })

  it('arms a timer of N minutes for a matching rule', () => {
    const { timers, compactor } = setup([{ provider: 'deepseek', minutes: 5 }])
    compactor.arm(fakeAgent())
    assert.equal(timers.pending.size, 1)
    assert.equal([...timers.pending.values()][0]?.ms, 5 * MINUTE)
  })

  it('arms nothing when no rule matches or minutes is 0', () => {
    const { timers, compactor } = setup([{ provider: 'other', minutes: 5 }, { provider: 'deepseek', minutes: 0 }])
    compactor.arm(fakeAgent())
    assert.equal(timers.pending.size, 0)
  })

  it('compacts once when the idle timer fires and does not re-arm itself', async () => {
    const { timers, compacted, compactor } = setup([{ provider: 'deepseek', minutes: 5 }])
    const agent = fakeAgent()
    compactor.arm(agent)
    timers.fireAll()
    await settle()
    assert.deepEqual(compacted, [agent])
    assert.equal(timers.pending.size, 0)
  })

  it('replaces the previous timer when armed again', () => {
    const { timers, compactor } = setup([{ provider: 'deepseek', minutes: 5 }])
    const agent = fakeAgent()
    compactor.arm(agent)
    compactor.arm(agent)
    assert.equal(timers.pending.size, 1)
  })

  it('disarm cancels the pending timer', async () => {
    const { timers, compacted, compactor } = setup([{ provider: 'deepseek', minutes: 5 }])
    const agent = fakeAgent()
    compactor.arm(agent)
    compactor.disarm(agent)
    timers.fireAll()
    await settle()
    assert.equal(timers.pending.size, 0)
    assert.equal(compacted.length, 0)
  })

  it('skips compaction when the agent is no longer idle at fire time', async () => {
    const { timers, compacted, compactor } = setup([{ provider: 'deepseek', minutes: 5 }])
    const agent = fakeAgent()
    compactor.arm(agent)
    agent.status = 'running'
    timers.fireAll()
    await settle()
    assert.equal(compacted.length, 0)
  })

  it('skips compaction when the session is archived at fire time, consuming the idle period', async () => {
    const timers = fakeTimers()
    const compacted: IdleAgent[] = []
    const compactor = new IdleCompactor<IdleAgent>({
      rules: () => [{ provider: 'deepseek', minutes: 5 }],
      timers,
      archived: () => true,
      compact: async (agent) => {
        compacted.push(agent)
        return {}
      },
      log: { info: () => {}, warn: () => {} },
    })
    const agent = fakeAgent()
    compactor.arm(agent)
    timers.fireAll()
    await settle()
    assert.deepEqual(compacted, [])
    assert.equal(timers.pending.size, 0)
  })

  it('skips compaction when the history already ends with one, consuming the idle period', async () => {
    const timers = fakeTimers()
    const compacted: IdleAgent[] = []
    const compactor = new IdleCompactor<IdleAgent>({
      rules: () => [{ provider: 'deepseek', minutes: 5 }],
      timers,
      compacted: () => true,
      compact: async (agent) => {
        compacted.push(agent)
        return {}
      },
      log: { info: () => {}, warn: () => {} },
    })
    const agent = fakeAgent()
    compactor.arm(agent)
    timers.fireAll()
    await settle()
    assert.deepEqual(compacted, [])
    compactor.refresh()
    assert.equal(timers.pending.size, 0)
  })

  it('reads the already-compacted state at fire time, not at arm time', async () => {
    let compactedNow = false
    const timers = fakeTimers()
    const compacted: IdleAgent[] = []
    const compactor = new IdleCompactor<IdleAgent>({
      rules: () => [{ provider: 'deepseek', minutes: 5 }],
      timers,
      compacted: () => compactedNow,
      compact: async (agent) => {
        compacted.push(agent)
        return {}
      },
      log: { info: () => {}, warn: () => {} },
    })
    const agent = fakeAgent()
    compactor.arm(agent)
    compactedNow = true
    timers.fireAll()
    await settle()
    assert.deepEqual(compacted, [])
  })

  it('logs and swallows compaction failures', async () => {
    const { timers, warnings, compactor } = setup([{ provider: 'deepseek', minutes: 5 }], async () => {
      throw new Error('boom')
    })
    compactor.arm(fakeAgent())
    timers.fireAll()
    await settle()
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /boom/)
  })

  it('dispose clears every timer and aborts in-flight compaction', async () => {
    let seen: AbortSignal | undefined
    const { timers, compactor } = setup([{ provider: 'deepseek', minutes: 5 }], async (_agent, signal) => {
      seen = signal
      await new Promise(() => {})
      return {}
    })
    compactor.arm(fakeAgent())
    compactor.arm(fakeAgent())
    timers.fireAll()
    await settle()
    compactor.arm(fakeAgent())
    compactor.dispose()
    assert.equal(timers.pending.size, 0)
    assert.equal(seen?.aborted, true)
  })

  it('refresh re-arms idle agents with the minutes of the current rules', () => {
    let rules: Rule[] = [{ provider: 'deepseek', minutes: 5 }]
    const timers = fakeTimers()
    const compactor = new IdleCompactor<IdleAgent>({
      rules: () => rules,
      timers,
      compact: async () => ({}),
      log: { info: () => {}, warn: () => {} },
    })
    compactor.arm(fakeAgent())
    rules = [{ provider: 'deepseek', minutes: 1 }]
    compactor.refresh()
    assert.equal(timers.pending.size, 1)
    assert.equal([...timers.pending.values()][0]?.ms, MINUTE)
  })

  it('refresh arms an idle agent that had no rule before and drops one whose rule is gone', () => {
    let rules: Rule[] = []
    const timers = fakeTimers()
    const compactor = new IdleCompactor<IdleAgent>({
      rules: () => rules,
      timers,
      compact: async () => ({}),
      log: { info: () => {}, warn: () => {} },
    })
    compactor.arm(fakeAgent())
    assert.equal(timers.pending.size, 0)
    rules = [{ provider: 'deepseek', minutes: 5 }]
    compactor.refresh()
    assert.equal(timers.pending.size, 1)
    rules = []
    compactor.refresh()
    assert.equal(timers.pending.size, 0)
  })

  it('refresh leaves running, disposed and already compacted agents alone', async () => {
    const { timers, compacted, compactor } = setup([{ provider: 'deepseek', minutes: 5 }])
    const running = fakeAgent()
    const gone = fakeAgent()
    const done = fakeAgent()
    compactor.arm(running)
    compactor.disarm(running)
    compactor.arm(gone)
    compactor.disarm(gone)
    compactor.arm(done)
    timers.fireAll()
    await settle()
    assert.deepEqual(compacted, [done])
    compactor.refresh()
    assert.equal(timers.pending.size, 0)
  })
})

describe('TokenCompactor', () => {
  type Call = { agent: IdleAgent; trigger: string; signal: AbortSignal }

  function setup(
    rules: Rule[],
    total: () => number,
    withEngine = true,
    withMeter = true,
  ) {
    const calls: Call[] = []
    const infos: string[] = []
    const warnings: string[] = []
    const engine: CompactionEngine = {
      async compactIfNeeded(agent, trigger, signal) {
        calls.push({ agent, trigger, signal })
        return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 12_000 }
      },
    }
    const meter: TokenMeter = { measure: () => ({ totalTokens: total() }) }
    const compactor = new TokenCompactor<IdleAgent>({
      rules: () => rules,
      meter: () => withMeter ? meter : undefined,
      engine: () => withEngine ? engine : undefined,
      log: { info: (message: string) => infos.push(message), warn: (message: string) => warnings.push(message) },
    })
    return { calls, infos, warnings, compactor }
  }

  const signal = () => new AbortController().signal

  it('does nothing below the route threshold', async () => {
    const { calls, compactor } = setup([{ provider: 'deepseek', tokens: 250_000 }], () => 249_999)
    assert.equal(await compactor.check(fakeAgent(), signal()), false)
    assert.deepEqual(calls, [])
  })

  it('forces a context-overflow reduction at the threshold and logs the numbers', async () => {
    const { calls, infos, compactor } = setup([{ provider: 'deepseek', tokens: 250_000 }], () => 250_000)
    const agent = fakeAgent()
    assert.equal(await compactor.check(agent, signal()), true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.agent, agent)
    assert.equal(calls[0]?.trigger, 'context-overflow')
    assert.match(infos.join('\n'), /250000 tokens/)
    assert.match(infos.join('\n'), /3 surface nodes/)
  })

  it('attempts once per crossing and re-arms after the pressure drops', async () => {
    let total = 250_000
    const { calls, compactor } = setup([{ provider: 'deepseek', tokens: 250_000 }], () => total)
    const agent = fakeAgent()
    assert.equal(await compactor.check(agent, signal()), true)
    assert.equal(await compactor.check(agent, signal()), false)
    assert.equal(calls.length, 1)
    total = 1_000
    assert.equal(await compactor.check(agent, signal()), false)
    total = 260_000
    assert.equal(await compactor.check(agent, signal()), true)
    assert.equal(calls.length, 2)
  })

  it('resolves the threshold for the agent route', async () => {
    const rules: Rule[] = [
      { model: 'small', tokens: 10_000 },
      { model: 'large', tokens: 500_000 },
    ]
    const { calls, compactor } = setup(rules, () => 20_000)
    assert.equal(await compactor.check(fakeAgent({ options: { provider: 'p', model: 'small' } }), signal()), true)
    assert.equal(await compactor.check(fakeAgent({ options: { provider: 'p', model: 'large' } }), signal()), false)
    assert.equal(calls.length, 1)
  })

  it('skips a route with no token threshold', async () => {
    const { calls, compactor } = setup([{ provider: 'deepseek', minutes: 5 }], () => 10_000_000)
    assert.equal(await compactor.check(fakeAgent(), signal()), false)
    assert.deepEqual(calls, [])
  })

  it('warns once and compacts nothing when no token meter is mounted', async () => {
    const { warnings, compactor } = setup([{ provider: 'deepseek', tokens: 1 }], () => 10, true, false)
    assert.equal(await compactor.check(fakeAgent(), signal()), false)
    assert.equal(await compactor.check(fakeAgent(), signal()), false)
    assert.equal(warnings.filter((line) => /token meter/i.test(line)).length, 1)
  })

  it('warns when the agent has no reachable compaction backend', async () => {
    const { warnings, compactor } = setup([{ provider: 'deepseek', tokens: 1 }], () => 10, false)
    assert.equal(await compactor.check(fakeAgent(), signal()), false)
    assert.match(warnings.join('\n'), /compaction backend/)
  })

  it('logs and swallows a backend failure without breaking the step', async () => {
    const warnings: string[] = []
    const compactor = new TokenCompactor<IdleAgent>({
      rules: () => [{ provider: 'deepseek', tokens: 1 }],
      meter: () => ({ measure: () => ({ totalTokens: 10 }) }),
      engine: () => ({ compactIfNeeded: async () => { throw new Error('summary exploded') } }),
      log: { info: () => {}, warn: (message: string) => warnings.push(message) },
    })
    assert.equal(await compactor.check(fakeAgent(), signal()), false)
    assert.match(warnings.join('\n'), /summary exploded/)
  })

  it('does not start a compaction after the turn was cancelled', async () => {
    const { calls, compactor } = setup([{ provider: 'deepseek', tokens: 1 }], () => 10)
    const controller = new AbortController()
    controller.abort()
    assert.equal(await compactor.check(fakeAgent(), controller.signal), false)
    assert.deepEqual(calls, [])
  })
})

describe('formatCacheUsage', () => {
  it('reports a warm read when the whole history came from cache', () => {
    assert.equal(
      formatCacheUsage({ inputTokens: 240, outputTokens: 500, cacheReadTokens: 11_760, cacheWriteTokens: 0 }),
      '98% of input read from cache (read 11760, write 0, uncached 240, total 12000)',
    )
  })

  it('reports 0% when the provider reports no cache hit', () => {
    assert.equal(
      formatCacheUsage({ inputTokens: 5000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 5000 }),
      '0% of input read from cache (read 0, write 5000, uncached 5000, total 10000)',
    )
  })

  it('treats missing cache fields as zero', () => {
    assert.equal(
      formatCacheUsage({ inputTokens: 800, outputTokens: 50 }),
      '0% of input read from cache (read 0, write 0, uncached 800, total 800)',
    )
  })

  it('says so when the provider emitted no usage', () => {
    assert.equal(formatCacheUsage(undefined), 'usage not reported by provider')
  })

  it('does not divide by zero on an empty request', () => {
    assert.equal(formatCacheUsage({ inputTokens: 0, outputTokens: 0 }), '0% of input read from cache (read 0, write 0, uncached 0, total 0)')
  })
})

describe('historyEndsWithCompaction', () => {
  type Event = { type: string; data?: { error?: string } }

  /** A session-log stub with one event per seq, counting every read. */
  function fakeLog(events: Event[]) {
    const reads: number[] = []
    return {
      reads,
      log: {
        seq: events.length,
        eventAt(seq: number): Event | undefined {
          reads.push(seq)
          return events[seq]
        },
      },
    }
  }

  const turnEnd: Event = { type: 'turn/end' }
  const turnStart: Event = { type: 'turn/start' }

  it('is true when the newest history is a compaction, command noise included', () => {
    const { log } = fakeLog([
      turnEnd,
      { type: 'command/run' },
      { type: 'compaction/start' },
      { type: 'compaction/summary' },
      { type: 'user/message' },
      { type: 'compaction/end' },
      { type: 'command/done' },
    ])
    assert.equal(historyEndsWithCompaction(log), true)
  })

  it('is false once a turn has closed after the compaction', () => {
    const { log } = fakeLog([
      { type: 'compaction/end' },
      { type: 'command/done' },
      turnStart,
      { type: 'user/message' },
      { type: 'assistant/message' },
      turnEnd,
    ])
    assert.equal(historyEndsWithCompaction(log), false)
  })

  it('is false for a failed compaction, which leaves the history unchanged', () => {
    const { log } = fakeLog([
      turnEnd,
      { type: 'command/run' },
      { type: 'compaction/start' },
      { type: 'compaction/end', data: { error: 'summary failed' } },
      { type: 'command/done' },
    ])
    assert.equal(historyEndsWithCompaction(log), false)
  })

  it('is false while a compaction is still in flight', () => {
    const { log } = fakeLog([turnEnd, { type: 'command/run' }, { type: 'compaction/start' }])
    assert.equal(historyEndsWithCompaction(log), false)
  })

  it('is false for a session that never compacted', () => {
    assert.equal(historyEndsWithCompaction(fakeLog([]).log), false)
    assert.equal(historyEndsWithCompaction(fakeLog([turnEnd]).log), false)
  })

  it('stops at the newest deciding event instead of scanning the log', () => {
    const fresh = fakeLog([turnStart, { type: 'user/message' }, turnEnd])
    assert.equal(historyEndsWithCompaction(fresh.log), false)
    assert.deepEqual(fresh.reads, [2])

    const compacted = fakeLog([turnEnd, { type: 'compaction/end' }])
    assert.equal(historyEndsWithCompaction(compacted.log), true)
    assert.deepEqual(compacted.reads, [1])
  })
})

describe('apply', () => {
  type Execution = { result: { kind: 'success' | 'error'; text?: string } } | undefined

  function fakeCtx(
    outcome: Execution | Error | 'missing' = { result: { kind: 'success', text: 'Compacted 3 history items (~900 tokens).' } },
    workspace?: { archivedSessionIds: string[] },
    services: {
      tokenMeter?: TokenMeter
      compaction?: CompactionEngine
      agentPresets?: { serviceFor(agent: IdleAgent, name: string): CompactionEngine | undefined }
    } = {},
  ) {
    const handlers = new Map<string, (...args: never[]) => unknown>()
    const disposers: Array<() => unknown> = []
    const executed: Array<{ agent: IdleAgent; line: string; attachments: readonly unknown[] }> = []
    const infos: string[] = []
    const warnings: string[] = []
    const ctx = {
      commands: {
        execute: async (agent: IdleAgent, line: string, attachments: readonly unknown[]) => {
          executed.push({ agent, line, attachments })
          if (outcome instanceof Error) throw outcome
          return outcome === 'missing' ? undefined : outcome
        },
      },
      get(name: string) {
        if (name === 'workspaceRegistry') return workspace
        if (name === 'tokenMeter') return services.tokenMeter
        if (name === 'compaction') return services.compaction
        if (name === 'agentPresets') return services.agentPresets
        return undefined
      },
      logger: { info: (m: string) => infos.push(m), warn: (m: string) => warnings.push(m) },
      on(event: string, handler: (...args: never[]) => unknown) {
        handlers.set(event, handler)
        return () => handlers.delete(event)
      },
      effect(factory: () => Iterator<unknown>) {
        const iterator = factory()
        for (let step = iterator.next(); !step.done; step = iterator.next()) {
          disposers.push(step.value as () => unknown)
        }
      },
    }
    const emit = (event: string, ...args: unknown[]) => handlers.get(event)?.(...args as never[])
    return { ctx, emit, disposers, executed, infos, warnings, handlers }
  }

  async function fireIdle(ctx: ReturnType<typeof fakeCtx>['ctx'], emit: ReturnType<typeof fakeCtx>['emit']) {
    const timers = fakeTimers()
    apply(ctx as never, { rules: [{ provider: 'deepseek', minutes: 5 }] }, timers)
    emit('agent/status', { agent: fakeAgent(), status: 'idle' })
    timers.fireAll()
    await settle()
  }

  it('injects the commands service, which every composed profile mounts at root', () => {
    assert.deepEqual(inject, ['commands'])
  })

  describe('step-boundary token trigger', () => {
    function fakeBackend() {
      const calls: Array<{ agent: IdleAgent; trigger: string; signal: AbortSignal }> = []
      const engine: CompactionEngine = {
        async compactIfNeeded(agent, trigger, signal) {
          calls.push({ agent, trigger, signal })
          return { shadowedSeqs: [7], shadowedTokenCount: 1_000 }
        },
      }
      return { calls, engine }
    }

    async function step(
      ctx: ReturnType<typeof fakeCtx>['ctx'],
      emit: ReturnType<typeof fakeCtx>['emit'],
      agent = fakeAgent(),
      signal?: AbortSignal,
    ) {
      const decisions: unknown[] = []
      await (emit as unknown as (
        event: string,
        payload: unknown,
        next: () => Promise<unknown>,
      ) => Promise<unknown>)('agent/pre-step', { agent, signal: signal ?? new AbortController().signal }, async () => {
        decisions.push('next')
        return { kind: 'continue' }
      })
      return decisions
    }

    it('compacts through the agent preset backend when the measured pressure reaches N', async () => {
      const { calls, engine } = fakeBackend()
      const tokenMeter: TokenMeter = { measure: () => ({ totalTokens: 352_734 }) }
      const presets = { serviceFor: (_agent: IdleAgent, name: string) => name === 'compaction' ? engine : undefined }
      const { ctx, emit } = fakeCtx(undefined, undefined, { tokenMeter, agentPresets: presets })
      apply(ctx as never, { rules: [{ provider: 'deepseek', model: 'deepseek-chat', tokens: 300_000 }] })
      const agent = fakeAgent()
      const decisions = await step(ctx, emit, agent)
      assert.deepEqual(decisions, ['next'])
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.agent, agent)
      assert.equal(calls[0]?.trigger, 'context-overflow')
    })

    it('falls back to a root compaction service when presets are absent', async () => {
      const { calls, engine } = fakeBackend()
      const { ctx, emit } = fakeCtx(undefined, undefined, {
        tokenMeter: { measure: () => ({ totalTokens: 400_000 }) },
        compaction: engine,
      })
      apply(ctx as never, { rules: [{ provider: 'deepseek', tokens: 300_000 }] })
      await step(ctx, emit)
      assert.equal(calls.length, 1)
    })

    it('advances the step without compacting below the threshold', async () => {
      const { calls, engine } = fakeBackend()
      const { ctx, emit } = fakeCtx(undefined, undefined, {
        tokenMeter: { measure: () => ({ totalTokens: 299_999 }) },
        compaction: engine,
      })
      apply(ctx as never, { rules: [{ provider: 'deepseek', tokens: 300_000 }] })
      const decisions = await step(ctx, emit)
      assert.deepEqual(decisions, ['next'])
      assert.equal(calls.length, 0)
    })

    it('never blocks the step when no token meter is mounted', async () => {
      const { ctx, emit } = fakeCtx()
      apply(ctx as never, { rules: [{ provider: 'deepseek', tokens: 300_000 }] })
      const decisions = await step(ctx, emit)
      assert.deepEqual(decisions, ['next'])
    })

    it('does not compact once the turn is cancelled', async () => {
      const { calls, engine } = fakeBackend()
      const { ctx, emit } = fakeCtx(undefined, undefined, {
        tokenMeter: { measure: () => ({ totalTokens: 400_000 }) },
        compaction: engine,
      })
      apply(ctx as never, { rules: [{ provider: 'deepseek', tokens: 300_000 }] })
      const controller = new AbortController()
      controller.abort()
      const decisions = await step(ctx, emit, fakeAgent(), controller.signal)
      assert.deepEqual(decisions, ['next'])
      assert.equal(calls.length, 0)
    })
  })

  describe('context window override', () => {
    const overflow = { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } }
    const replayState = { response: { id: 'resp-1' } }

    function chunks(promptTokens: number) {
      return [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
        { type: 'usage', usage: { inputTokens: promptTokens } },
        { type: 'finish', reason: overflow, replayState },
      ]
    }

    async function run(
      ctx: ReturnType<typeof fakeCtx>['ctx'],
      emit: ReturnType<typeof fakeCtx>['emit'],
      source: unknown[],
    ) {
      const iterable = (emit as unknown as (
        event: string,
        options: { provider: string; model: string },
        next: () => AsyncIterable<unknown>,
      ) => AsyncIterable<unknown>)('llm/stream', { provider: 'openai', model: 'squished' }, () => (async function* () {
        yield* source
      })())
      const seen: unknown[] = []
      for await (const chunk of iterable) seen.push(chunk)
      return seen
    }

    it('passes every chunk through untouched when the route has no override', async () => {
      const { ctx, emit } = fakeCtx()
      apply(ctx as never, { rules: [{ provider: 'openai', model: 'squished', tokens: 500_000 }] })
      const seen = await run(ctx, emit, chunks(500_000))
      assert.deepEqual(seen, chunks(500_000))
    })

    it('restores a successful finish when the reported prompt fits the override', async () => {
      const { ctx, emit, infos } = fakeCtx()
      apply(ctx as never, { rules: [{ provider: 'openai', model: 'squished', contextWindow: 1_000_000 }] })
      const seen = await run(ctx, emit, chunks(900_000))
      assert.deepEqual((seen.at(-1) as { reason: unknown }).reason, { kind: 'stop' })
      assert.match(infos.join('\n'), /context override/)
    })

    it('leaves a genuine overflow beyond the override as an error', async () => {
      const { ctx, emit } = fakeCtx()
      apply(ctx as never, { rules: [{ provider: 'openai', model: 'squished', contextWindow: 1_000_000 }] })
      const seen = await run(ctx, emit, chunks(1_000_001))
      assert.deepEqual((seen.at(-1) as { reason: unknown }).reason, overflow)
    })

    it('leaves an uncompleted stream as an error', async () => {
      const { ctx, emit } = fakeCtx()
      apply(ctx as never, { rules: [{ provider: 'openai', model: 'squished', contextWindow: 1_000_000 }] })
      const interrupted = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'usage', usage: { inputTokens: 900_000 } },
        { type: 'finish', reason: overflow, replayState },
      ]
      const seen = await run(ctx, emit, interrupted)
      assert.deepEqual((seen.at(-1) as { reason: unknown }).reason, overflow)
    })
  })

  it('rejects an invalid rule table at load', () => {
    const { ctx } = fakeCtx()
    assert.throws(() => apply(ctx as never, { rules: [{ minutes: 5 }] }), /provider or model/)
  })

  it('arms on creation, disarms while running, re-arms on idle, disarms on disposal', () => {
    const { ctx, emit } = fakeCtx()
    const timers = fakeTimers()
    apply(ctx as never, { rules: [{ provider: 'deepseek', minutes: 5 }] }, timers)
    const agent = fakeAgent()

    emit('agent/created', { agent, source: 'startup' })
    assert.equal(timers.pending.size, 1)

    agent.status = 'running'
    emit('agent/status', { agent, status: 'running' })
    assert.equal(timers.pending.size, 0)

    agent.status = 'idle'
    emit('agent/status', { agent, status: 'idle' })
    assert.equal(timers.pending.size, 1)

    emit('agent/disposed', { agent })
    assert.equal(timers.pending.size, 0)
  })

  it('runs the /compact command against the agent when the idle timer fires', async () => {
    const { ctx, emit, executed, infos } = fakeCtx()
    const timers = fakeTimers()
    apply(ctx as never, { rules: [{ provider: 'deepseek', minutes: 5 }] }, timers)
    const agent = fakeAgent()
    emit('agent/status', { agent, status: 'idle' })
    timers.fireAll()
    await settle()
    assert.deepEqual(executed, [{ agent, line: '/compact', attachments: [] }])
    assert.match(infos.join('\n'), /Compacted 3 history items/)
  })

  it('does not compact a session in the host archive set', async () => {
    const { ctx, emit, executed, warnings } = fakeCtx(undefined, { archivedSessionIds: ['session-1'] })
    const timers = fakeTimers()
    apply(ctx as never, { rules: [{ provider: 'deepseek', minutes: 5 }] }, timers)
    emit('agent/status', { agent: fakeAgent(), status: 'idle' })
    timers.fireAll()
    await settle()
    assert.deepEqual(executed, [])
    assert.deepEqual(warnings, [])
  })

  it('compacts a session that is not in the archive set', async () => {
    const { ctx, emit, executed } = fakeCtx(undefined, { archivedSessionIds: ['another-session'] })
    const timers = fakeTimers()
    apply(ctx as never, { rules: [{ provider: 'deepseek', minutes: 5 }] }, timers)
    const agent = fakeAgent()
    emit('agent/status', { agent, status: 'idle' })
    timers.fireAll()
    await settle()
    assert.deepEqual(executed, [{ agent, line: '/compact', attachments: [] }])
  })

  it('compacts again once the session leaves the archive set and goes idle', async () => {
    const workspace = { archivedSessionIds: ['session-1'] }
    const { ctx, emit, executed } = fakeCtx(undefined, workspace)
    const timers = fakeTimers()
    apply(ctx as never, { rules: [{ provider: 'deepseek', minutes: 5 }] }, timers)
    const agent = fakeAgent()
    emit('agent/status', { agent, status: 'idle' })
    timers.fireAll()
    await settle()
    assert.deepEqual(executed, [])

    workspace.archivedSessionIds = []
    agent.status = 'running'
    emit('agent/status', { agent, status: 'running' })
    agent.status = 'idle'
    emit('agent/status', { agent, status: 'idle' })
    timers.fireAll()
    await settle()
    assert.deepEqual(executed, [{ agent, line: '/compact', attachments: [] }])
  })

  it('compacts normally in a profile that mounts no workspace registry', async () => {
    const { ctx, emit, executed } = fakeCtx()
    const timers = fakeTimers()
    apply(ctx as never, { rules: [{ provider: 'deepseek', minutes: 5 }] }, timers)
    const agent = fakeAgent()
    emit('agent/status', { agent, status: 'idle' })
    timers.fireAll()
    await settle()
    assert.deepEqual(executed, [{ agent, line: '/compact', attachments: [] }])
  })

  function agentWithLog(events: Array<{ type: string; data?: { error?: string } }>): IdleAgent {
    return fakeAgent({
      session: {
        header: { id: 'session-1' },
        seq: events.length,
        eventAt: (seq: number) => events[seq],
        requestHeader: () => undefined,
      },
    })
  }

  it('does not autocompact a session whose newest history is a compaction', async () => {
    const { ctx, emit, executed } = fakeCtx()
    const timers = fakeTimers()
    apply(ctx as never, { rules: [{ provider: 'deepseek', minutes: 5 }] }, timers)
    const agent = agentWithLog([{ type: 'turn/end' }, { type: 'compaction/end' }])
    emit('agent/status', { agent, status: 'idle' })
    timers.fireAll()
    await settle()
    assert.deepEqual(executed, [])
  })

  it('autocompacts a session whose last turn closed after its last compaction', async () => {
    const { ctx, emit, executed } = fakeCtx()
    const timers = fakeTimers()
    apply(ctx as never, { rules: [{ provider: 'deepseek', minutes: 5 }] }, timers)
    const agent = agentWithLog([{ type: 'compaction/end' }, { type: 'turn/start' }, { type: 'turn/end' }])
    emit('agent/status', { agent, status: 'idle' })
    timers.fireAll()
    await settle()
    assert.deepEqual(executed, [{ agent, line: '/compact', attachments: [] }])
  })

  it('warns when the command settles as an error', async () => {
    const { ctx, emit, warnings } = fakeCtx({ result: { kind: 'error', text: 'Compaction could not produce a useful summary.' } })
    await fireIdle(ctx, emit)
    assert.match(warnings.join('\n'), /could not produce a useful summary/)
  })

  it('skips quietly when compaction is unavailable because one is running or the agent is busy', async () => {
    const { ctx, emit, warnings } = fakeCtx({
      result: { kind: 'error', text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.' },
    })
    await fireIdle(ctx, emit)
    assert.deepEqual(warnings, [])
  })

  it('warns when no /compact command is registered for the agent', async () => {
    const { ctx, emit, warnings } = fakeCtx('missing')
    await fireIdle(ctx, emit)
    assert.match(warnings.join('\n'), /\/compact/)
  })

  it('logs and swallows a thrown command failure', async () => {
    const { ctx, emit, warnings } = fakeCtx(new Error('boom'))
    await fireIdle(ctx, emit)
    assert.match(warnings.join('\n'), /boom/)
  })

  it('clears timers on plugin unload', () => {
    const { ctx, emit, disposers } = fakeCtx()
    const timers = fakeTimers()
    apply(ctx as never, { rules: [{ provider: 'deepseek', minutes: 5 }] }, timers)
    emit('agent/status', { agent: fakeAgent(), status: 'idle' })
    assert.equal(timers.pending.size, 1)
    for (const dispose of disposers) void dispose()
    assert.equal(timers.pending.size, 0)
  })

  describe('live rules', () => {
    function liveRules(initial: Rule[]) {
      const box = { current: initial }
      return { box, ref: { get: () => box.current } }
    }

    it('reads rules through the volatile reference each time an agent goes idle', () => {
      const { ctx, emit } = fakeCtx()
      const timers = fakeTimers()
      const { box, ref } = liveRules([{ provider: 'deepseek', minutes: 5 }])
      apply(ctx as never, { rules: ref } as never, timers)
      box.current = [{ provider: 'deepseek', minutes: 2 }]
      emit('agent/status', { agent: fakeAgent(), status: 'idle' })
      assert.equal([...timers.pending.values()][0]?.ms, 2 * MINUTE)
    })

    it('re-arms idle agents when the volatile rules change', () => {
      const { ctx, emit } = fakeCtx()
      const timers = fakeTimers()
      const { box, ref } = liveRules([{ provider: 'deepseek', minutes: 5 }])
      apply(ctx as never, { rules: ref } as never, timers)
      emit('agent/status', { agent: fakeAgent(), status: 'idle' })
      box.current = [{ provider: 'deepseek', minutes: 1 }]
      emit('loader/volatile-update', [['rules']])
      assert.equal(timers.pending.size, 1)
      assert.equal([...timers.pending.values()][0]?.ms, MINUTE)
    })

    it('warns and arms nothing when the changed rules are invalid', () => {
      const { ctx, emit, warnings } = fakeCtx()
      const timers = fakeTimers()
      const { box, ref } = liveRules([{ provider: 'deepseek', minutes: 5 }])
      apply(ctx as never, { rules: ref } as never, timers)
      emit('agent/status', { agent: fakeAgent(), status: 'idle' })
      box.current = [{ minutes: 5 }]
      emit('loader/volatile-update', [['rules']])
      assert.equal(timers.pending.size, 0)
      assert.match(warnings.join('\n'), /provider or model/)
    })

    it('rejects an invalid volatile table at load', () => {
      const { ctx } = fakeCtx()
      const { ref } = liveRules([{ minutes: 5 }])
      assert.throws(() => apply(ctx as never, { rules: ref } as never), /provider or model/)
    })
  })

  it('logs the cache usage of every compaction summary, manual or idle', () => {
    const { ctx, emit, infos } = fakeCtx()
    apply(ctx as never)
    const usage = { inputTokens: 240, outputTokens: 500, cacheReadTokens: 11_760 }
    emit('session/event', {}, { type: 'compaction/summary', data: { usage } })
    assert.deepEqual(infos, ['compaction cache: 98% of input read from cache (read 11760, write 0, uncached 240, total 12000)'])
  })

  it('ignores other session events', () => {
    const { ctx, emit, infos } = fakeCtx()
    apply(ctx as never)
    emit('session/event', {}, { type: 'user/message', data: {} })
    assert.deepEqual(infos, [])
  })
})

describe('Config', () => {
  it('marks rules volatile so the Settings form exposes it and edits apply without a reload', () => {
    const rules = (Config as unknown as { dict: Record<string, { meta: { volatile?: boolean } }> }).dict.rules
    assert.equal(rules?.meta.volatile, true)
  })
})
