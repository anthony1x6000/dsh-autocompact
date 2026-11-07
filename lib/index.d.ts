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
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "idle-autocompact";
/**
 * The command registry, which is mounted at root in every profile. The
 * compaction backend itself is not: the web profile builds it inside each agent
 * preset, so a root plugin injecting `compaction` would wait forever.
 */
export declare const inject: string[];
/** One idle rule: a route selector plus the idle minutes before compaction. */
export interface Rule {
    /** Provider route to match; omit to match any provider. */
    provider?: string;
    /** Model id to match; omit to match any model. */
    model?: string;
    /** Idle minutes before compaction; 0 disables the matched route. */
    minutes: number;
}
/** A rules table, or a live volatile reference to one (what the loader hands a `.volatile()` field). */
export type RulesSource = Rule[] | {
    get(): Rule[];
};
/** Plugin config: the rules table edited on the Plugins page. */
export interface Config {
    rules?: RulesSource;
}
/**
 * Config schema. `rules` is volatile: the host exposes volatile fields to the
 * Plugins page form and applies edits without remounting the plugin.
 */
export declare const Config: z<Config>;
/** Provider/model pair a session last talked to. */
export interface Route {
    provider?: string;
    model?: string;
}
/** The session-log slice a compaction check reads. A harness `Session` satisfies it. */
export interface CompactionLog {
    /** The log length: one past the newest seq. */
    readonly seq: number;
    /** One event by seq, or undefined past the end of the log. */
    eventAt(seq: number): {
        type: string;
        data?: {
            error?: string;
        };
    } | undefined;
}
/** The slice of a DSH `Agent` this plugin reads; also satisfies `ManualCompactAgentContext`. */
export interface IdleAgent {
    status: 'idle' | 'running';
    options: {
        provider?: string;
        model?: string;
    };
    session: CompactionLog & {
        /** Durable session identity; the host archive set is keyed by `header.id`. */
        header: {
            id: string;
        };
        requestHeader(): {
            config: {
                provider: string;
                model: string;
            };
        } | undefined;
    };
    runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
/** Timer seam so tests can drive time. */
export interface Timers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}
/**
 * Reject a rules table that cannot be resolved unambiguously.
 * @param rules - rows from the plugin config.
 * @throws when a row has no selector, bad minutes, or duplicates another row.
 */
export declare function validateRules(rules: readonly Rule[]): void;
/**
 * Pick the idle minutes for a route: provider+model, then model, then provider.
 * @param rules - validated rules table.
 * @param route - provider/model the session last used.
 * @returns minutes > 0, or undefined when unmatched or disabled with 0.
 */
export declare function resolveIdleMinutes(rules: readonly Rule[], route: Route): number | undefined;
/**
 * The route a session last used: the latest request header, else the agent options.
 * @param agent - agent whose session is inspected.
 * @returns provider/model, either possibly undefined.
 */
export declare function routeOf(agent: IdleAgent): Route;
/** The slice of the harness `TokenUsage`: counts are disjoint, so total input = uncached + read + write. */
export interface CacheUsage {
    inputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
/**
 * Describe how much of a compaction request was served from the provider's prompt cache.
 * @param usage - usage the summarization call reported, if any.
 * @returns a one-line summary with the cache-read share and the raw counts.
 */
export declare function formatCacheUsage(usage: CacheUsage | undefined): string;
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
export declare function historyEndsWithCompaction(session: CompactionLog): boolean;
/** Logger subset used for diagnostics. */
export interface Log {
    info(message: string): void;
    warn(message: string): void;
}
/** Dependencies of {@link IdleCompactor}. */
export interface IdleCompactorDeps<A extends IdleAgent> {
    /** Current rules; read on every arm so live edits apply to the next idle period. */
    rules(): readonly Rule[];
    compact(agent: A, signal: AbortSignal): Promise<unknown>;
    /**
     * Whether the agent's session is archived. Archived sessions are skipped at
     * fire time, and their idle period is consumed like any other skipped fire.
     */
    archived?(agent: A): boolean;
    /**
     * Whether the agent's history already ends with a compaction. Read at fire
     * time, so a `/compact` that lands during the idle stretch is honored; a
     * skipped fire consumes the idle period like any other.
     */
    compacted?(agent: A): boolean;
    log: Log;
    timers?: Timers;
}
/** One idle timer per agent; fires one compaction per idle period. */
export declare class IdleCompactor<A extends IdleAgent> {
    private readonly handles;
    /** Agents inside an idle period that has not compacted yet. */
    private readonly idle;
    private readonly inflight;
    private readonly timers;
    private readonly deps;
    constructor(deps: IdleCompactorDeps<A>);
    /** Start (or restart) the idle countdown for an agent that just became idle. */
    arm(agent: A): void;
    /** Cancel the countdown (agent got busy or was disposed). */
    disarm(agent: A): void;
    /** Restart the countdown of every agent still in an uncompacted idle period, after the rules changed. */
    refresh(): void;
    private schedule;
    private clearTimer;
    /** Clear every countdown and abort compactions still running. */
    dispose(): void;
    private fire;
}
/** The slice of the host `WorkspaceRegistry` this plugin reads. */
export interface WorkspaceArchive {
    /** Sessions in the registry-global archive set, hidden from every grouping surface. */
    readonly archivedSessionIds: readonly string[];
}
/** Minimal Cordis context surface this plugin touches. */
export interface PluginContext {
    commands: {
        execute(agent: IdleAgent, line: string, attachments: readonly never[], signal: AbortSignal): Promise<{
            result: {
                kind: 'success' | 'error';
                text?: string;
            };
        } | undefined>;
    };
    /**
     * Service lookup. The workspace registry is optional: a profile that mounts
     * none archives nothing, so every session there stays compactable.
     */
    get(name: 'workspaceRegistry'): WorkspaceArchive | undefined;
    logger: Log;
    on(event: 'agent/created', handler: (payload: {
        agent: IdleAgent;
    }) => void): unknown;
    on(event: 'agent/status', handler: (payload: {
        agent: IdleAgent;
        status: 'idle' | 'running';
    }) => void): unknown;
    on(event: 'agent/disposed', handler: (payload: {
        agent: IdleAgent;
    }) => void): unknown;
    on(event: 'session/event', handler: (session: unknown, event: {
        type: string;
        data: {
            usage?: CacheUsage;
        };
    }) => void): unknown;
    on(event: 'loader/volatile-update', handler: (paths: readonly (readonly string[])[]) => void): unknown;
    effect(factory: () => Generator<() => unknown>, name?: string): unknown;
}
/**
 * Watch every agent's lifecycle and compact it after its configured idle time.
 * @param ctx - plugin context; `ctx.commands` must be mounted.
 * @param config - rules table from the plugin config.
 * @param timers - timer seam, replaced only by tests.
 */
export declare function apply(ctx: PluginContext, config?: Config, timers?: Timers): void;
