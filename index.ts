/**
 * Idle autocompact for the DeepSeek Harness.
 *
 * After a session has been idle for N minutes (the minutes configured for the
 * model route it last used), the `/compact` command condenses it. Useful
 * when a provider's prompt cache expires after a quiet period: the next turn
 * then starts from a short summary instead of re-reading a long cold history.
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
 * `provider+model` > `model` > `provider`. `minutes: 0` disables a route that
 * a broader rule would otherwise cover. Unmatched routes are never compacted.
 * Sessions in the host's archive set are never compacted either.
 *
 * @module dsh-autocompact
 */
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'idle-autocompact'

/**
 * The command registry, which is mounted at root in every profile. The
 * compaction backend itself is not: the web profile builds it inside each agent
 * preset, so a root plugin injecting `compaction` would wait forever.
 */
export const inject = ['commands']

/** Prefix of the `/compact` error text meaning a compaction is running or the agent is busy. */
const UNAVAILABLE_PREFIX = 'Compaction is unavailable'

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
  minutes: z.number().min(0).required().description('Idle minutes before compaction; 0 disables.'),
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
   * none archives nothing, so every session there stays compactable.
   */
  get(name: 'workspaceRegistry'): WorkspaceArchive | undefined
  logger: Log
  on(event: 'agent/created', handler: (payload: { agent: IdleAgent }) => void): unknown
  on(event: 'agent/status', handler: (payload: { agent: IdleAgent; status: 'idle' | 'running' }) => void): unknown
  on(event: 'agent/disposed', handler: (payload: { agent: IdleAgent }) => void): unknown
  on(
    event: 'session/event',
    handler: (session: unknown, event: { type: string; data: { usage?: CacheUsage } }) => void,
  ): unknown
  on(event: 'loader/volatile-update', handler: (paths: readonly (readonly string[])[]) => void): unknown
  effect(factory: () => Generator<() => unknown>, name?: string): unknown
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
 * Watch every agent's lifecycle and compact it after its configured idle time.
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
