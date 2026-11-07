import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  apply,
  Config,
  formatCacheUsage,
  historyEndsWithCompaction,
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
  function setup(rules: Rule[], compact = async () => ({})) {
    const timers = fakeTimers()
    const compacted: IdleAgent[] = []
    const warnings: string[] = []
    const compactor = new IdleCompactor<IdleAgent>({
      rules: () => rules,
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
        return name === 'workspaceRegistry' ? workspace : undefined
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
