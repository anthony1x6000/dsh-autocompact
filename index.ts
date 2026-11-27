/**
 * Idle and token autocompact for the DeepSeek Harness.
 *
 * After a session has been idle for N minutes (the minutes configured for the
 * model route it last used), the `/compact` command condenses it. Useful
 * when a provider's prompt cache expires after a quiet period: the next turn
 * then starts from a short summary instead of re-reading a long cold history.
 *
 * A rule may instead (or also) set a token threshold. At every step boundary,
 * a session whose measured context pressure reaches the route's threshold is
 * compacted mid-turn, through the agent's own compaction backend. This keeps a
 * long single turn below the window even when the backend's own pressure policy
 * is unconfigured or disabled. One attempt is made per threshold crossing.
 *
 * Every compaction (manual, idle or automatic) also logs how much of the
 * summarization request was read from the provider's prompt cache.
 *
 * A session whose newest history activity is already a compaction is left
 * alone, so a manual `/compact` during an idle stretch is not compacted again.
 *
 * Rules live in the plugin config (Plugins -> dsh-autocompact -> idle-autocompact)
 * and match a route by
 * provider, model, or both. The most specific match wins:
 * `provider+model` > `model` > `provider`. `minutes: 0` and `tokens: 0`
 * disable one trigger on a route that a broader rule would otherwise cover;
 * a more specific rule does not inherit the broader rule's triggers. Unmatched
 * routes are never compacted. Sessions in the host's archive set are never
 * compacted either.
 *
 * @module dsh-autocompact
 */
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'idle-autocompact'

/**
 * The command registry, which is mounted at root in every profile. The
 * compaction backend itself is not: the web profile builds it inside each agent
 * preset, so a root plugin injecting `compaction` would wait forever. The token
 * path therefore resolves the backend per agent instead of injecting it: from
 * the agent preset registry when present, else from a root backend.
 */
export const inject = ['commands']

/** Prefix of the `/compact` error text meaning a compaction is running or the agent is busy. */
const UNAVAILABLE_PREFIX = 'Compaction is unavailable'

const MINUTE_MS = 60_000

/** One rule: a route selector plus the idle and/or token triggers. */
export interface Rule {
  /** Provider route to match; omit to match any provider. */
  provider?: string
  /** Model id to match; omit to match any model. */
  model?: string
  /** Idle minutes before compaction; 0 or absent disables the idle trigger. */
  minutes?: number
  /** Context-pressure token threshold; 0 or absent disables the token trigger. */
  tokens?: number
}

/** A rules table, or a live volatile reference to one (what the loader hands a `.volatile()` field). */
export type RulesSource = Rule[] | { get(): Rule[] }

/** Plugin config: the rules table edited on the Plugins page. */
export interface Config {
  rules?: RulesSource
}

function readRules(source: RulesSource | undefined): Rule[] {
  if (source === undefined) return []
  return Array.isArray(source) ? source : source.get()
}

const ruleSchema = z.object({
  provider: z.string().description('Provider route (blank = any provider).'),
  model: z.string().description('Model id (blank = any model).'),
  minutes: z.number().min(0).description('Idle minutes before compaction; 0 or blank disables.'),
  tokens: z.number().step(1).min(0).description(
    'Compact when measured context pressure reaches this many tokens; 0 or blank disables.',
  ),
})

/**
 * Config schema. `rules` is volatile: the host exposes volatile fields to the
 * Plugins page form and applies edits without remounting the plugin.
 */
export const Config = z.object({
  rules: z.array(ruleSchema).default([]).volatile().description(
    'Idle autocompact rules. Most specific wins: provider+model > model > provider.',
  ),
}) as unknown as z<Config>

/** Provider/model pair a session last talked to. */
export interface Route {
  provider?: string
  model?: string
}

/** The session-log slice a compaction check reads. A harness `Session` satisfies it. */
export interface CompactionLog {
  /** The log length: one past the newest seq. */
  readonly seq: number
  /** One event by seq, or undefined past the end of the log. */
  eventAt(seq: number): { type: string; data?: { error?: string } } | undefined
}

/** The slice of a DSH `Agent` this plugin reads; also satisfies `ManualCompactAgentContext`. */
export interface IdleAgent {
  status: 'idle' | 'running'
  options: { provider?: string; model?: string }
  session: CompactionLog & {
    /** Durable session identity; the host archive set is keyed by `header.id`. */
    header: { id: string }
    requestHeader(): { config: { provider: string; model: string } } | undefined
  }
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  /** Agent-scoped context; the preset registry reads it to find a preset-mounted service. */
  ctx?: unknown
}

/** Timer seam so tests can drive time. */
export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const realTimers: Timers = {
  set(fn, ms) {
    const handle = setTimeout(fn, ms) as unknown as { unref?: () => void }
    handle.unref?.()
    return handle
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
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
 * @throws when a row has no selector, bad minutes or tokens, or duplicates another row.
 */
export function validateRules(rules: readonly Rule[]): void {
  const seen = new Set<string>()
  for (const rule of rules) {
    const { provider, model } = selector(rule)
    if (provider === undefined && model === undefined) {
      throw new TypeError('idle-autocompact: each rule needs a provider or model')
    }
    if (rule.minutes !== undefined && (!Number.isFinite(rule.minutes) || rule.minutes < 0)) {
      throw new TypeError(`idle-autocompact: minutes must be a number >= 0, got ${String(rule.minutes)}`)
    }
    if (rule.tokens !== undefined && (!Number.isInteger(rule.tokens) || rule.tokens < 0)) {
      throw new TypeError(`idle-autocompact: tokens must be a whole number >= 0, got ${String(rule.tokens)}`)
    }
    const key = `${provider ?? '*'}/${model ?? '*'}`
    if (seen.has(key)) throw new TypeError(`idle-autocompact: duplicate rule for ${key}`)
    seen.add(key)
  }
}

/**
 * Pick the most specific rule for a route: provider+model, then model, then provider.
 * Ties keep the first row, though duplicate selectors are rejected.
 * @param rules - validated rules table.
 * @param route - provider/model the session last used.
 * @returns the matching rule, or undefined when nothing matches.
 */
function resolveRule(rules: readonly Rule[], route: Route): Rule | undefined {
  let best: { specificity: number; rule: Rule } | undefined
  for (const rule of rules) {
    const { provider, model } = selector(rule)
    if (provider !== undefined && provider !== route.provider) continue
    if (model !== undefined && model !== route.model) continue
    const specificity = provider !== undefined && model !== undefined ? 3 : model !== undefined ? 2 : 1
    if (best === undefined || specificity > best.specificity) best = { specificity, rule }
  }
  return best?.rule
}

/**
 * Idle minutes for a route. A more specific rule replaces, never inherits, the broader one.
 * @param rules - validated rules table.
 * @param route - provider/model the session last used.
 * @returns minutes > 0, or undefined when unmatched or disabled.
 */
export function resolveIdleMinutes(rules: readonly Rule[], route: Route): number | undefined {
  const minutes = resolveRule(rules, route)?.minutes ?? 0
  return minutes > 0 ? minutes : undefined
}

/**
 * Context-pressure token threshold for a route. Absent on the matched rule, or 0,
 * disables the token trigger there instead of inheriting a broader threshold.
 * @param rules - validated rules table.
 * @param route - provider/model the session last used.
 * @returns tokens > 0, or undefined when unmatched or disabled.
 */
export function resolveTokenThreshold(rules: readonly Rule[], route: Route): number | undefined {
  const tokens = resolveRule(rules, route)?.tokens ?? 0
  return tokens > 0 ? tokens : undefined
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

/** The slice of the harness `TokenUsage`: counts are disjoint, so total input = uncached + read + write. */
export interface CacheUsage {
  inputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * Describe how much of a compaction request was served from the provider's prompt cache.
 * @param usage - usage the summarization call reported, if any.
 * @returns a one-line summary with the cache-read share and the raw counts.
 */
export function formatCacheUsage(usage: CacheUsage | undefined): string {
  if (usage === undefined) return 'usage not reported by provider'
  const read = usage.cacheReadTokens ?? 0
  const write = usage.cacheWriteTokens ?? 0
  const total = usage.inputTokens + read + write
  const percent = total === 0 ? 0 : Math.round(read / total * 100)
  return `${percent}% of input read from cache (read ${read}, write ${write}, uncached ${usage.inputTokens}, total ${total})`
}

/**
 * Whether the session's newest history activity is a completed compaction.
 * Walks back from the newest event: a `turn/end` means a turn closed after any
 * older compaction, while a successful `compaction/end` (`error` absent) means
 * the compaction is still the newest thing that happened. A manual `/compact`
 * runs between turns, so it reports true until the next turn closes; a failed
 * attempt, the in-flight `compaction/start` bracket, and every other event are
 * walked past.
 *
 * The scan ends at the first deciding event, so it reads only the events since
 * the newest turn boundary — a handful for the idle sessions this plugin fires on.
 * @param session - session whose history tail is inspected.
 * @returns true when the newest turn/compaction event is a successful compaction.
 */
export function historyEndsWithCompaction(session: CompactionLog): boolean {
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined) return false
    if (event.type === 'turn/end') return false
    if (event.type === 'compaction/end' && event.data?.error === undefined) return true
  }
  return false
}

/** The slice of the harness token meter this plugin reads. */
export interface TokenMeter {
  /** Current request-and-response pressure for one session, at the durable log revision. */
  measure(session: unknown): { totalTokens: number }
}

/** What a compaction backend reports for one successful replacement; only logging reads it. */
export interface CompactionOutcome {
  readonly shadowedSeqs?: readonly unknown[]
  readonly shadowedTokenCount?: number
}

/** The slice of a harness compaction backend this plugin calls. */
export interface CompactionEngine {
  /**
   * Force one useful balanced reduction. The overflow trigger bypasses the
   * backend's own pressure threshold and kept tail, which is what a rule's
   * token trigger wants when that policy is unconfigured or disabled.
   */
  compactIfNeeded(
    agent: IdleAgent,
    trigger: 'context-overflow',
    signal: AbortSignal,
  ): Promise<CompactionOutcome | null>
}

/** Dependencies of {@link TokenCompactor}. */
export interface TokenCompactorDeps<A extends IdleAgent> {
  /** Current rules; read at every step so live edits apply to the next boundary. */
  rules(): readonly Rule[]
  /** Host token meter, or undefined in a composition that mounts none. */
  meter(): TokenMeter | undefined
  /** The agent's reachable compaction backend, or undefined when none is mounted. */
  engine(agent: A): CompactionEngine | undefined
  log: Log
}

/**
 * Compact a session at a step boundary once its measured context pressure
 * reaches the route's token threshold. One attempt is made per crossing:
 * further steps stay quiet until pressure drops below the threshold again,
 * which keeps a partial reduction or an impossible range from retrying every
 * step. A failed attempt is logged and never breaks the turn.
 */
export class TokenCompactor<A extends IdleAgent> {
  private readonly overThreshold = new WeakSet<A>()
  private meterWarned = false
  private readonly deps: TokenCompactorDeps<A>

  constructor(deps: TokenCompactorDeps<A>) {
    this.deps = deps
  }

  /**
   * Check one step boundary and compact when the route's threshold is crossed.
   * @param agent - agent whose request is about to be prepared.
   * @param signal - the open turn's cancellation signal.
   * @returns true when a compaction was started and returned a result.
   */
  async check(agent: A, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false
    const route = routeOf(agent)
    const threshold = resolveTokenThreshold(this.deps.rules(), route)
    if (threshold === undefined) {
      this.overThreshold.delete(agent)
      return false
    }
    const meter = this.deps.meter()
    if (meter === undefined) {
      if (!this.meterWarned) {
        this.meterWarned = true
        this.deps.log.warn('token autocompact: no token meter is mounted; token thresholds are ignored')
      }
      return false
    }
    let total: number
    try {
      total = meter.measure(agent.session).totalTokens
    } catch (error: unknown) {
      this.deps.log.warn(`token autocompact: token measurement failed: ${messageOf(error)}`)
      return false
    }
    if (!Number.isFinite(total) || total < threshold) {
      this.overThreshold.delete(agent)
      return false
    }
    if (this.overThreshold.has(agent)) return false
    this.overThreshold.add(agent)

    const label = `${route.provider ?? '?'}/${route.model ?? '?'}`
    const engine = this.deps.engine(agent)
    if (engine === undefined) {
      this.deps.log.warn(
        `token autocompact: ${label} reached ${total} tokens (threshold ${threshold}) `
        + 'but no compaction backend is reachable; the step continues',
      )
      return false
    }
    try {
      const result = await engine.compactIfNeeded(agent, 'context-overflow', signal)
      if (result === null) {
        this.deps.log.warn(
          `token autocompact: ${label} reached ${total} tokens (threshold ${threshold}) `
          + 'but no safe compactable range was found; the step continues',
        )
        return false
      }
      const nodes = result.shadowedSeqs?.length ?? 0
      const shadowed = result.shadowedTokenCount ?? 0
      this.deps.log.info(
        `token autocompact: ${label} at ${total} tokens (threshold ${threshold}); `
        + `compacted ${nodes} surface nodes (~${shadowed} tokens)`,
      )
      return true
    } catch (error: unknown) {
      if (!signal.aborted) {
        this.deps.log.warn(`token autocompact: compaction failed: ${messageOf(error)}; the step continues`)
      }
      return false
    }
  }
}

/** Render an unknown thrown value for one log line. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Logger subset used for diagnostics. */
export interface Log {
  info(message: string): void
  warn(message: string): void
}

/** Dependencies of {@link IdleCompactor}. */
export interface IdleCompactorDeps<A extends IdleAgent> {
  /** Current rules; read on every arm so live edits apply to the next idle period. */
  rules(): readonly Rule[]
  compact(agent: A, signal: AbortSignal): Promise<unknown>
  /**
   * Whether the agent's session is archived. Archived sessions are skipped at
   * fire time, and their idle period is consumed like any other skipped fire.
   */
  archived?(agent: A): boolean
  /**
   * Whether the agent's history already ends with a compaction. Read at fire
   * time, so a `/compact` that lands during the idle stretch is honored; a
   * skipped fire consumes the idle period like any other.
   */
  compacted?(agent: A): boolean
  /**
   * Whether the route's token threshold is already reached. Read when the agent
   * becomes idle and on every refresh, so a session that crossed its threshold
   * is condensed right away instead of waiting for its idle minutes.
   */
  tokenDue?(agent: A): boolean
  log: Log
  timers?: Timers
}

/** One idle timer per agent; fires one compaction per idle period. */
export class IdleCompactor<A extends IdleAgent> {
  private readonly handles = new Map<A, unknown>()
  /** Agents inside an idle period that has not compacted yet. */
  private readonly idle = new Set<A>()
  private readonly inflight = new Set<AbortController>()
  private readonly timers: Timers
  private readonly deps: IdleCompactorDeps<A>

  constructor(deps: IdleCompactorDeps<A>) {
    this.deps = deps
    this.timers = deps.timers ?? realTimers
  }

  /** Start (or restart) the idle countdown for an agent that just became idle. */
  arm(agent: A): void {
    this.disarm(agent)
    this.idle.add(agent)
    if (this.deps.tokenDue?.(agent) === true) {
      void this.fire(agent)
      return
    }
    this.schedule(agent)
  }

  /** Cancel the countdown (agent got busy or was disposed). */
  disarm(agent: A): void {
    this.idle.delete(agent)
    this.clearTimer(agent)
  }

  /** Restart the countdown of every agent still in an uncompacted idle period, after the rules changed. */
  refresh(): void {
    for (const agent of this.idle) {
      this.clearTimer(agent)
      if (this.deps.tokenDue?.(agent) === true) {
        void this.fire(agent)
        continue
      }
      this.schedule(agent)
    }
  }

  private schedule(agent: A): void {
    const minutes = resolveIdleMinutes(this.deps.rules(), routeOf(agent))
    if (minutes === undefined) return
    this.handles.set(agent, this.timers.set(() => void this.fire(agent), minutes * MINUTE_MS))
  }

  private clearTimer(agent: A): void {
    const handle = this.handles.get(agent)
    if (handle === undefined) return
    this.timers.clear(handle)
    this.handles.delete(agent)
  }

  /** Clear every countdown and abort compactions still running. */
  dispose(): void {
    for (const handle of this.handles.values()) this.timers.clear(handle)
    this.handles.clear()
    this.idle.clear()
    for (const controller of this.inflight) controller.abort()
    this.inflight.clear()
  }

  private async fire(agent: A): Promise<void> {
    this.handles.delete(agent)
    this.idle.delete(agent)
    if (agent.status !== 'idle') return
    if (this.deps.archived?.(agent) === true) return
    if (this.deps.compacted?.(agent) === true) return
    const controller = new AbortController()
    this.inflight.add(controller)
    try {
      await this.deps.compact(agent, controller.signal)
    } catch (error: unknown) {
      if (!controller.signal.aborted) {
        this.deps.log.warn(`idle compaction failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      this.inflight.delete(controller)
    }
  }
}

/** The slice of the host `WorkspaceRegistry` this plugin reads. */
export interface WorkspaceArchive {
  /** Sessions in the registry-global archive set, hidden from every grouping surface. */
  readonly archivedSessionIds: readonly string[]
}

/** Minimal Cordis context surface this plugin touches. */
export interface PluginContext {
  commands: {
    execute(
      agent: IdleAgent,
      line: string,
      attachments: readonly never[],
      signal: AbortSignal,
    ): Promise<{ result: { kind: 'success' | 'error'; text?: string } } | undefined>
  }
  /**
   * Service lookup. The workspace registry is optional: a profile that mounts
   * none archives nothing, so every session there stays compactable. The token
   * meter, compaction backend and preset registry are optional too, so a
   * composition that mounts none keeps the idle command path only.
   */
  get(name: 'workspaceRegistry'): WorkspaceArchive | undefined
  get(name: 'tokenMeter'): TokenMeter | undefined
  get(name: 'compaction'): CompactionEngine | undefined
  get(name: 'agentPresets'): AgentPresets | undefined
  logger: Log
  on(event: 'agent/created', handler: (payload: { agent: IdleAgent }) => void): unknown
  on(event: 'agent/status', handler: (payload: { agent: IdleAgent; status: 'idle' | 'running' }) => void): unknown
  on(event: 'agent/disposed', handler: (payload: { agent: IdleAgent }) => void): unknown
  on(
    event: 'agent/pre-step',
    handler: (
      payload: { agent: IdleAgent; signal: AbortSignal },
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
  ): unknown
  on(
    event: 'session/event',
    handler: (session: unknown, event: { type: string; data: { usage?: CacheUsage } }) => void,
  ): unknown
  on(event: 'loader/volatile-update', handler: (paths: readonly (readonly string[])[]) => void): unknown
  effect(factory: () => Generator<() => unknown>, name?: string): unknown
}

/** The slice of the agent preset registry that reaches a preset-mounted service. */
export interface AgentPresets {
  /**
   * Resolve a service supplied inside an agent's isolated preset composition.
   * Ordinary `ctx.get()` from the profile root cannot see it.
   */
  serviceFor(agent: { ctx?: unknown }, name: 'compaction'): CompactionEngine | undefined
}

/**
 * The compaction backend for one agent. The web profile builds the backend
 * inside the agent preset, so ask the preset registry first; a composition that
 * mounts a root backend (the CLI base) answers through ordinary lookup.
 * @param ctx - plugin context.
 * @param agent - agent about to take a step.
 * @returns the reachable backend, or undefined.
 */
function compactionFor(ctx: PluginContext, agent: IdleAgent): CompactionEngine | undefined {
  try {
    const scoped = ctx.get('agentPresets')?.serviceFor(agent, 'compaction')
    if (scoped !== undefined) return scoped
  } catch {
    // A preset registry that is not started yet must not fail the step.
  }
  try {
    return ctx.get('compaction')
  } catch {
    return undefined
  }
}

/**
 * Whether the agent route's token threshold is already reached.
 * @param ctx - plugin context.
 * @param rules - validated rules table.
 * @param agent - idle agent to price.
 * @returns true only when a threshold applies and measured pressure reaches it.
 */
function tokenThresholdReached(ctx: PluginContext, rules: readonly Rule[], agent: IdleAgent): boolean {
  try {
    const threshold = resolveTokenThreshold(rules, routeOf(agent))
    if (threshold === undefined) return false
    const meter = ctx.get('tokenMeter')
    if (meter === undefined) return false
    return meter.measure(agent.session).totalTokens >= threshold
  } catch {
    return false
  }
}

/**
 * The host's archive set, read fresh on every fire so an archive or unarchive
 * during the countdown is honored. Read defensively: a timer fires without an
 * awaiter, and a registry that is not started yet (or a profile with no
 * registry at all) must not turn an idle tick into a process-killing rejection.
 * @param ctx - plugin context.
 * @returns the archived session ids; empty when nothing is archived or readable.
 */
function archivedSessionIds(ctx: PluginContext): readonly string[] {
  try {
    return ctx.get('workspaceRegistry')?.archivedSessionIds ?? []
  } catch {
    return []
  }
}

/**
 * Whether the agent's session history already ends with a compaction. Read
 * defensively: a timer fires without an awaiter, and a session shape that
 * cannot be read must not turn an idle tick into a process-killing rejection.
 * @param agent - agent whose session is inspected.
 * @returns true when the newest history activity is a completed compaction.
 */
function sessionEndsWithCompaction(agent: IdleAgent): boolean {
  try {
    return historyEndsWithCompaction(agent.session)
  } catch {
    return false
  }
}

/**
 * Watch every agent's lifecycle and compact it after its configured idle time,
 * and at every step boundary once the route's token threshold is reached.
 * @param ctx - plugin context; `ctx.commands` must be mounted.
 * @param config - rules table from the plugin config.
 * @param timers - timer seam, replaced only by tests.
 */
export function apply(ctx: PluginContext, config: Config = {}, timers?: Timers): void {
  validateRules(readRules(config.rules))
  let rulesValid = true
  const rules = (): Rule[] => rulesValid ? readRules(config.rules) : []
  const compactor = new IdleCompactor<IdleAgent>({
    rules,
    ...timers !== undefined ? { timers } : {},
    log: ctx.logger,
    archived: (agent) => archivedSessionIds(ctx).includes(agent.session.header.id),
    compacted: sessionEndsWithCompaction,
    tokenDue: (agent) => tokenThresholdReached(ctx, rules(), agent),
    async compact(agent, signal) {
      const execution = await ctx.commands.execute(agent, '/compact', [], signal)
      if (execution === undefined) throw new Error('no /compact command is registered for this agent')
      const { kind, text } = execution.result
      if (kind === 'success') {
        if (text !== undefined) ctx.logger.info(`idle compaction: ${text}`)
      } else if (!text?.startsWith(UNAVAILABLE_PREFIX)) {
        throw new Error(text ?? '/compact failed')
      }
    },
  })
  ctx.on('agent/created', ({ agent }) => compactor.arm(agent))
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') compactor.arm(agent)
    else compactor.disarm(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => compactor.disarm(agent))

  const tokens = new TokenCompactor<IdleAgent>({
    rules,
    meter: () => {
      try {
        return ctx.get('tokenMeter')
      } catch {
        return undefined
      }
    },
    engine: (agent) => compactionFor(ctx, agent),
    log: ctx.logger,
  })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    try {
      await tokens.check(agent, signal)
    } catch (error: unknown) {
      ctx.logger.warn(`token autocompact check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  })
  ctx.on('session/event', (_session, event) => {
    if (event.type === 'compaction/summary') ctx.logger.info(`compaction cache: ${formatCacheUsage(event.data.usage)}`)
  })
  ctx.on('loader/volatile-update', () => {
    try {
      validateRules(readRules(config.rules))
      rulesValid = true
    } catch (error: unknown) {
      rulesValid = false
      ctx.logger.warn(`idle compaction rules ignored: ${error instanceof Error ? error.message : String(error)}`)
    }
    compactor.refresh()
  })
  ctx.effect(function* () {
    yield () => compactor.dispose()
  }, 'idle-autocompact lifecycle')
}
