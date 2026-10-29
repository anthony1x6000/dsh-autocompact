import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  apply,
  IdleCompactor,
  inject,
  resolveIdleMinutes,
  routeOf,
  validateRules,
  type IdleAgent,
  type Rule,
} from './index.ts'

const MINUTE = 60_000

function fakeAgent(overrides: Partial<IdleAgent> = {}): IdleAgent {
  return {
    status: 'idle',
    options: { provider: 'deepseek', model: 'deepseek-chat' },
    session: { requestHeader: () => undefined },
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

describe('validateRules', () => {
  it('accepts a well-formed table', () => {
    assert.doesNotThrow(() => validateRules([{ provider: 'p', minutes: 5 }, { model: 'm', minutes: 0 }]))
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
      session: { requestHeader: () => ({ config: { provider: 'hdr-p', model: 'hdr-m' } }) },
    })
    assert.deepEqual(routeOf(agent), { provider: 'hdr-p', model: 'hdr-m' })
  })

  it('falls back to agent options before any request was made', () => {
    assert.deepEqual(routeOf(fakeAgent()), { provider: 'deepseek', model: 'deepseek-chat' })
  })
})

describe('IdleCompactor', () => {
  function setup(rules: Rule[], compact = async () => ({})) {
    const timers = fakeTimers()
    const compacted: IdleAgent[] = []
    const warnings: string[] = []
    const compactor = new IdleCompactor<IdleAgent>({
      rules,
      timers,
      compact: async (agent, signal) => {
        compacted.push(agent)
        return compact(agent, signal)
      },
      log: { info: () => {}, warn: (message: string) => warnings.push(message) },
    })
    return { timers, compacted, warnings, compactor }
  }

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
})

describe('apply', () => {
  type Execution = { result: { kind: 'success' | 'error'; text?: string } } | undefined

  function fakeCtx(outcome: Execution | Error | 'missing' = { result: { kind: 'success', text: 'Compacted 3 history items (~900 tokens).' } }) {
    const handlers = new Map<string, (payload: never) => unknown>()
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
      logger: { info: (m: string) => infos.push(m), warn: (m: string) => warnings.push(m) },
      on(event: string, handler: (payload: never) => unknown) {
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
    const emit = (event: string, payload: unknown) => handlers.get(event)?.(payload as never)
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
})
