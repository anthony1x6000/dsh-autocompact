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
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "idle-autocompact";
/** The compaction backend this plugin triggers. */
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
/** Plugin config: the rules table edited in the Settings UI. */
export interface Config {
    rules?: Rule[];
}
/** Config schema surfaced by the Settings -> Plugins page. */
export declare const Config: z<Config>;
/** Provider/model pair a session last talked to. */
export interface Route {
    provider?: string;
    model?: string;
}
/** The slice of a DSH `Agent` this plugin reads; also satisfies `ManualCompactAgentContext`. */
export interface IdleAgent {
    status: 'idle' | 'running';
    options: {
        provider?: string;
        model?: string;
    };
    session: {
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
/** Logger subset used for diagnostics. */
export interface Log {
    info(message: string): void;
    warn(message: string): void;
}
/** Dependencies of {@link IdleCompactor}. */
export interface IdleCompactorDeps<A extends IdleAgent> {
    rules: readonly Rule[];
    compact(agent: A, signal: AbortSignal): Promise<unknown>;
    log: Log;
    timers?: Timers;
}
/** One idle timer per agent; fires one compaction per idle period. */
export declare class IdleCompactor<A extends IdleAgent> {
    private readonly handles;
    private readonly inflight;
    private readonly timers;
    private readonly deps;
    constructor(deps: IdleCompactorDeps<A>);
    /** Start (or restart) the idle countdown for an agent that just became idle. */
    arm(agent: A): void;
    /** Cancel the countdown (agent got busy or was disposed). */
    disarm(agent: A): void;
    /** Clear every countdown and abort compactions still running. */
    dispose(): void;
    private fire;
}
/** Minimal Cordis context surface this plugin touches. */
export interface PluginContext {
    compaction: {
        compactNow(agent: IdleAgent, signal: AbortSignal): Promise<{
            shadowedSeqs: readonly unknown[];
            shadowedTokenCount: number;
        } | null>;
    };
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
    effect(factory: () => Generator<() => unknown>, name?: string): unknown;
}
/**
 * Watch every agent's lifecycle and compact it after its configured idle time.
 * @param ctx - plugin context; `ctx.compaction` must be mounted.
 * @param config - rules table from the plugin config.
 * @param timers - timer seam, replaced only by tests.
 */
export declare function apply(ctx: PluginContext, config?: Config, timers?: Timers): void;
