/**
 * Idle autocompact for the DeepSeek Harness.
 *
 * After a session has been idle for N minutes (the minutes configured for the
 * model route it last used), `ctx.compaction.compactNow()` condenses it. Useful
 * when a provider's prompt cache expires after a quiet period: the next turn
 * then starts from a short summary instead of re-reading a long cold history.
 *
 * Rules live in the plugin config (Settings -> Plugins) and match a route by
 * provider, model, or both. The most specific match wins:
 * `provider+model` > `model` > `provider`. `minutes: 0` disables a route that
 * a broader rule would otherwise cover. Unmatched routes are never compacted.
 *
 * @module dsh-autocompact
 */
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'idle-autocompact'

/** The compaction backend this plugin triggers. */
export const inject = ['compaction']

const MINUTE_MS = 60_000

/** One idle rule: a route selector plus the idle minutes before compaction. */
export interface Rule {
  /** Provider route to match; omit to match any provider. */
  provider?: string
  /** Model id to match; omit to match any model. */
  model?: string
  /** Idle minutes before compaction; 0 disables the matched route. */
  minutes: number
}

/** Plugin config: the rules table edited in the Settings UI. */
export interface Config {
  rules?: Rule[]
}

const ruleSchema = z.object({
  provider: z.string().description('Provider route (blank = any provider).'),
  model: z.string().description('Model id (blank = any model).'),
  minutes: z.number().min(0).required().description('Idle minutes before compaction; 0 disables.'),
})

/** Config schema surfaced by the Settings -> Plugins page. */
export const Config: z<Config> = z.object({
  rules: z.array(ruleSchema).description(
    'Idle autocompact rules. Most specific wins: provider+model > model > provider.',
  ),
})

/** Provider/model pair a session last talked to. */
export interface Route {
  provider?: string
  model?: string
}

/** The slice of a DSH `Agent` this plugin reads; also satisfies `ManualCompactAgentContext`. */
export interface IdleAgent {
  status: 'idle' | 'running'
  options: { provider?: string; model?: string }
  session: { requestHeader(): { config: { provider: string; model: string } } | undefined }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** Timer seam so tests can drive time. */
export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms)
    handle.unref()
    return handle
  },
  clear(handle) {
    clearTimeout(handle as NodeJS.Timeout)
  },
}

function selector(rule: Rule): { provider?: string; model?: string } {
  const provider = rule.provider?.trim()
  const model = rule.model?.trim()
  return {
    ...provider ? { provider } : {},
    ...model ? { model } : {},
  }
}

/**
 * Reject a rules table that cannot be resolved unambiguously.
 * @param rules - rows from the plugin config.
 * @throws when a row has no selector, bad minutes, or duplicates another row.
 */
export function validateRules(rules: readonly Rule[]): void {
  const seen = new Set<string>()
  for (const rule of rules) {
    const { provider, model } = selector(rule)
    if (provider === undefined && model === undefined) {
      throw new TypeError('idle-autocompact: each rule needs a provider or model')
    }
    if (!Number.isFinite(rule.minutes) || rule.minutes < 0) {
      throw new TypeError(`idle-autocompact: minutes must be a number >= 0, got ${String(rule.minutes)}`)
    }
    const key = `${provider ?? '*'}/${model ?? '*'}`
    if (seen.has(key)) throw new TypeError(`idle-autocompact: duplicate rule for ${key}`)
    seen.add(key)
  }
}

/**
 * Pick the idle minutes for a route: provider+model, then model, then provider.
 * @param rules - validated rules table.
 * @param route - provider/model the session last used.
 * @returns minutes > 0, or undefined when unmatched or disabled with 0.
 */
export function resolveIdleMinutes(rules: readonly Rule[], route: Route): number | undefined {
  let best: { specificity: number; minutes: number } | undefined
  for (const rule of rules) {
    const { provider, model } = selector(rule)
    if (provider !== undefined && provider !== route.provider) continue
    if (model !== undefined && model !== route.model) continue
    const specificity = provider !== undefined && model !== undefined ? 3 : model !== undefined ? 2 : 1
    if (best === undefined || specificity > best.specificity) best = { specificity, minutes: rule.minutes }
  }
  return best !== undefined && best.minutes > 0 ? best.minutes : undefined
}

/**
 * The route a session last used: the latest request header, else the agent options.
 * @param agent - agent whose session is inspected.
 * @returns provider/model, either possibly undefined.
 */
export function routeOf(agent: IdleAgent): Route {
  const header = agent.session.requestHeader()?.config
  return header !== undefined
    ? { provider: header.provider, model: header.model }
    : { provider: agent.options.provider, model: agent.options.model }
}

/** Logger subset used for diagnostics. */
export interface Log {
  info(message: string): void
  warn(message: string): void
}

/** Dependencies of {@link IdleCompactor}. */
export interface IdleCompactorDeps<A extends IdleAgent> {
  rules: readonly Rule[]
  compact(agent: A, signal: AbortSignal): Promise<unknown>
  log: Log
  timers?: Timers
}

/** One idle timer per agent; fires one compaction per idle period. */
export class IdleCompactor<A extends IdleAgent> {
  private readonly handles = new Map<A, unknown>()
  private readonly inflight = new Set<AbortController>()
  private readonly timers: Timers

  constructor(private readonly deps: IdleCompactorDeps<A>) {
    this.timers = deps.timers ?? realTimers
  }

  /** Start (or restart) the idle countdown for an agent that just became idle. */
  arm(agent: A): void {
    this.disarm(agent)
    const minutes = resolveIdleMinutes(this.deps.rules, routeOf(agent))
    if (minutes === undefined) return
    this.handles.set(agent, this.timers.set(() => void this.fire(agent), minutes * MINUTE_MS))
  }

  /** Cancel the countdown (agent got busy or was disposed). */
  disarm(agent: A): void {
    const handle = this.handles.get(agent)
    if (handle === undefined) return
    this.timers.clear(handle)
    this.handles.delete(agent)
  }

  /** Clear every countdown and abort compactions still running. */
  dispose(): void {
    for (const handle of this.handles.values()) this.timers.clear(handle)
    this.handles.clear()
    for (const controller of this.inflight) controller.abort()
    this.inflight.clear()
  }

  private async fire(agent: A): Promise<void> {
    this.handles.delete(agent)
    if (agent.status !== 'idle') return
    const controller = new AbortController()
    this.inflight.add(controller)
    try {
      await this.deps.compact(agent, controller.signal)
    } catch (error: unknown) {
      if (!controller.signal.aborted && !isBusy(error)) {
        this.deps.log.warn(`idle compaction failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      this.inflight.delete(controller)
    }
  }
}

function isBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'ManualCompactionError'
    && (error as { code?: unknown }).code === 'busy'
}

/** Minimal Cordis context surface this plugin touches. */
export interface PluginContext {
  compaction: {
    compactNow(
      agent: IdleAgent,
      signal: AbortSignal,
    ): Promise<{ shadowedSeqs: readonly unknown[]; shadowedTokenCount: number } | null>
  }
  logger: Log
  on(event: 'agent/created', handler: (payload: { agent: IdleAgent }) => void): unknown
  on(event: 'agent/status', handler: (payload: { agent: IdleAgent; status: 'idle' | 'running' }) => void): unknown
  on(event: 'agent/disposed', handler: (payload: { agent: IdleAgent }) => void): unknown
  effect(factory: () => Generator<() => unknown>, name?: string): unknown
}

/**
 * Watch every agent's lifecycle and compact it after its configured idle time.
 * @param ctx - plugin context; `ctx.compaction` must be mounted.
 * @param config - rules table from the plugin config.
 * @param timers - timer seam, replaced only by tests.
 */
export function apply(ctx: PluginContext, config: Config = {}, timers?: Timers): void {
  const rules = config.rules ?? []
  validateRules(rules)
  const compactor = new IdleCompactor<IdleAgent>({
    rules,
    ...timers !== undefined ? { timers } : {},
    log: ctx.logger,
    async compact(agent, signal) {
      const result = await ctx.compaction.compactNow(agent, signal)
      if (result !== null) {
        ctx.logger.info(
          `idle compaction: shadowed ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens)`,
        )
      }
      return result
    },
  })
  ctx.on('agent/created', ({ agent }) => compactor.arm(agent))
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') compactor.arm(agent)
    else compactor.disarm(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => compactor.disarm(agent))
  ctx.effect(function* () {
    yield () => compactor.dispose()
  }, 'idle-autocompact lifecycle')
}
