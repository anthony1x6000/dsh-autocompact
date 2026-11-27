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
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "idle-autocompact";
/**
 * The command registry, which is mounted at root in every profile. The
 * compaction backend itself is not: the web profile builds it inside each agent
 * preset, so a root plugin injecting `compaction` would wait forever. The token
 * path therefore resolves the backend per agent instead of injecting it: from
 * the agent preset registry when present, else from a root backend.
 */
export declare const inject: string[];
/** One rule: a route selector plus the idle and/or token triggers. */
export interface Rule {
    /** Provider route to match; omit to match any provider. */
    provider?: string;
    /** Model id to match; omit to match any model. */
    model?: string;
    /** Idle minutes before compaction; 0 or absent disables the idle trigger. */
    minutes?: number;
    /** Context-pressure token threshold; 0 or absent disables the token trigger. */
    tokens?: number;
    /**
     * Real context capacity for this route. When the adapter rejects a completed
     * response only because its reported prompt exceeded a smaller declared
     * window, accept it while the prompt fits here. 0 or absent disables.
     */
    contextWindow?: number;
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
    /** Agent-scoped context; the preset registry reads it to find a preset-mounted service. */
    ctx?: unknown;
}
/** Timer seam so tests can drive time. */
export interface Timers {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
}
/**
 * Reject a rules table that cannot be resolved unambiguously.
 * @param rules - rows from the plugin config.
 * @throws when a row has no selector, bad minutes or tokens, or duplicates another row.
 */
export declare function validateRules(rules: readonly Rule[]): void;
/**
 * Idle minutes for a route. A more specific rule replaces, never inherits, the broader one.
 * @param rules - validated rules table.
 * @param route - provider/model the session last used.
 * @returns minutes > 0, or undefined when unmatched or disabled.
 */
export declare function resolveIdleMinutes(rules: readonly Rule[], route: Route): number | undefined;
/**
 * Context-pressure token threshold for a route. Absent on the matched rule, or 0,
 * disables the token trigger there instead of inheriting a broader threshold.
 * @param rules - validated rules table.
 * @param route - provider/model the session last used.
 * @returns tokens > 0, or undefined when unmatched or disabled.
 */
export declare function resolveTokenThreshold(rules: readonly Rule[], route: Route): number | undefined;
/**
 * Declared real capacity for a route whose adapter window was reduced on purpose.
 * Absent on the matched rule, or 0, disables the override there.
 * @param rules - validated rules table.
 * @param route - provider/model the call uses.
 * @returns a positive capacity, or undefined when unmatched or disabled.
 */
export declare function resolveContextWindow(rules: readonly Rule[], route: Route): number | undefined;
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
/** The slice of the harness token meter this plugin reads. */
export interface TokenMeter {
    /** Current request-and-response pressure for one session, at the durable log revision. */
    measure(session: unknown): {
        totalTokens: number;
    };
}
/** What a compaction backend reports for one successful replacement; only logging reads it. */
export interface CompactionOutcome {
    readonly shadowedSeqs?: readonly unknown[];
    readonly shadowedTokenCount?: number;
}
/** The slice of a harness compaction backend this plugin calls. */
export interface CompactionEngine {
    /**
     * Force one useful balanced reduction. The overflow trigger bypasses the
     * backend's own pressure threshold and kept tail, which is what a rule's
     * token trigger wants when that policy is unconfigured or disabled.
     */
    compactIfNeeded(agent: IdleAgent, trigger: 'context-overflow', signal: AbortSignal): Promise<CompactionOutcome | null>;
}
/** Dependencies of {@link TokenCompactor}. */
export interface TokenCompactorDeps<A extends IdleAgent> {
    /** Current rules; read at every step so live edits apply to the next boundary. */
    rules(): readonly Rule[];
    /** Host token meter, or undefined in a composition that mounts none. */
    meter(): TokenMeter | undefined;
    /** The agent's reachable compaction backend, or undefined when none is mounted. */
    engine(agent: A): CompactionEngine | undefined;
    log: Log;
}
/**
 * Compact a session at a step boundary once its measured context pressure
 * reaches the route's token threshold. One attempt is made per crossing:
 * further steps stay quiet until pressure drops below the threshold again,
 * which keeps a partial reduction or an impossible range from retrying every
 * step. A failed attempt is logged and never breaks the turn.
 */
export declare class TokenCompactor<A extends IdleAgent> {
    private readonly overThreshold;
    private meterWarned;
    private readonly deps;
    constructor(deps: TokenCompactorDeps<A>);
    /**
     * Check one step boundary and compact when the route's threshold is crossed.
     * @param agent - agent whose request is about to be prepared.
     * @param signal - the open turn's cancellation signal.
     * @returns true when a compaction was started and returned a result.
     */
    check(agent: A, signal: AbortSignal): Promise<boolean>;
}
/** Provider-reported token counts this plugin reads; counts are disjoint. */
export interface LlmUsageLike {
    inputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
/** The terminal chunk shape the window override inspects; other chunks pass through untouched. */
export interface StreamFinishLike {
    type: 'finish';
    reason: {
        kind: string;
        failure?: {
            code?: string;
        };
    };
    /** Adapter-private successful-response metadata; only a completed provider response carries it. */
    replayState?: unknown;
}
/** What the stream showed before its terminal finish. */
export interface FinishObservation {
    /** Usage the adapter emitted just before the finish. */
    usage?: LlmUsageLike;
    /** Every started block also ended; an interrupted stream leaves this false. */
    balanced: boolean;
    /** At least one block completed. */
    sawBlockEnd: boolean;
    /** A completed tool-call block appeared. */
    sawToolCall: boolean;
}
/**
 * Prompt tokens a usage record bills: the counts are disjoint, so the prompt is
 * their sum.
 * @param usage - usage the adapter reported, if any.
 * @returns the billed prompt size, or 0 when nothing was reported.
 */
export declare function promptTokens(usage: LlmUsageLike | undefined): number;
/**
 * Restore a successful finish the adapter rejected only because the reported
 * prompt exceeded the route's smaller declared window.
 *
 * Only a completed provider response qualifies: `replayState` marks the
 * adapter's `done` event, balanced blocks prove the content arrived whole, and
 * the prompt must stay below the declared real capacity, leaving room for the
 * response. A genuine overflow, an interrupted stream, or an error the provider
 * raised keeps its failure.
 * @param finish - terminal chunk to inspect.
 * @param observation - content and usage the stream emitted before it.
 * @param contextWindow - real capacity override for the route.
 * @returns the restored finish, or undefined to keep the original.
 */
export declare function restoreSuccessfulFinish(finish: StreamFinishLike, observation: FinishObservation, contextWindow: number | undefined): StreamFinishLike | undefined;
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
    /**
     * Whether the route's token threshold is already reached. Read when the agent
     * becomes idle and on every refresh, so a session that crossed its threshold
     * is condensed right away instead of waiting for its idle minutes.
     */
    tokenDue?(agent: A): boolean;
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
     * none archives nothing, so every session there stays compactable. The token
     * meter, compaction backend and preset registry are optional too, so a
     * composition that mounts none keeps the idle command path only.
     */
    get(name: 'workspaceRegistry'): WorkspaceArchive | undefined;
    get(name: 'tokenMeter'): TokenMeter | undefined;
    get(name: 'compaction'): CompactionEngine | undefined;
    get(name: 'agentPresets'): AgentPresets | undefined;
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
    on(event: 'agent/pre-step', handler: (payload: {
        agent: IdleAgent;
        signal: AbortSignal;
    }, next: () => Promise<unknown>) => Promise<unknown>): unknown;
    on(event: 'llm/stream', handler: (options: {
        provider: string;
        model: string;
    }, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>): unknown;
    on(event: 'session/event', handler: (session: unknown, event: {
        type: string;
        data: {
            usage?: CacheUsage;
        };
    }) => void): unknown;
    on(event: 'loader/volatile-update', handler: (paths: readonly (readonly string[])[]) => void): unknown;
    effect(factory: () => Generator<() => unknown>, name?: string): unknown;
}
/** The slice of the agent preset registry that reaches a preset-mounted service. */
export interface AgentPresets {
    /**
     * Resolve a service supplied inside an agent's isolated preset composition.
     * Ordinary `ctx.get()` from the profile root cannot see it.
     */
    serviceFor(agent: {
        ctx?: unknown;
    }, name: 'compaction'): CompactionEngine | undefined;
}
/**
 * Watch every agent's lifecycle and compact it after its configured idle time,
 * and at every step boundary once the route's token threshold is reached.
 * @param ctx - plugin context; `ctx.commands` must be mounted.
 * @param config - rules table from the plugin config.
 * @param timers - timer seam, replaced only by tests.
 */
export declare function apply(ctx: PluginContext, config?: Config, timers?: Timers): void;
