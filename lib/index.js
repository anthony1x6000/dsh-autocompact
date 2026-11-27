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
export const name = 'idle-autocompact';
/**
 * The command registry, which is mounted at root in every profile. The
 * compaction backend itself is not: the web profile builds it inside each agent
 * preset, so a root plugin injecting `compaction` would wait forever. The token
 * path therefore resolves the backend per agent instead of injecting it: from
 * the agent preset registry when present, else from a root backend.
 */
export const inject = ['commands'];
/** Prefix of the `/compact` error text meaning a compaction is running or the agent is busy. */
const UNAVAILABLE_PREFIX = 'Compaction is unavailable';
const MINUTE_MS = 60_000;
function readRules(source) {
    if (source === undefined)
        return [];
    return Array.isArray(source) ? source : source.get();
}
const ruleSchema = z.object({
    provider: z.string().description('Provider route (blank = any provider).'),
    model: z.string().description('Model id (blank = any model).'),
    minutes: z.number().min(0).description('Idle minutes before compaction; 0 or blank disables.'),
    tokens: z.number().step(1).min(0).description('Compact when measured context pressure reaches this many tokens; 0 or blank disables.'),
    contextWindow: z.number().step(1).min(0).description('Real context capacity; lets a completed response the adapter rejected above a smaller declared window through.'),
});
/**
 * Config schema. `rules` is volatile: the host exposes volatile fields to the
 * Plugins page form and applies edits without remounting the plugin.
 */
export const Config = z.object({
    rules: z.array(ruleSchema).default([]).volatile().description('Idle autocompact rules. Most specific wins: provider+model > model > provider.'),
});
const realTimers = {
    set(fn, ms) {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return handle;
    },
    clear(handle) {
        clearTimeout(handle);
    },
};
function selector(rule) {
    const provider = rule.provider?.trim();
    const model = rule.model?.trim();
    return {
        ...provider ? { provider } : {},
        ...model ? { model } : {},
    };
}
/**
 * Reject a rules table that cannot be resolved unambiguously.
 * @param rules - rows from the plugin config.
 * @throws when a row has no selector, bad minutes or tokens, or duplicates another row.
 */
export function validateRules(rules) {
    const seen = new Set();
    for (const rule of rules) {
        const { provider, model } = selector(rule);
        if (provider === undefined && model === undefined) {
            throw new TypeError('idle-autocompact: each rule needs a provider or model');
        }
        if (rule.minutes !== undefined && (!Number.isFinite(rule.minutes) || rule.minutes < 0)) {
            throw new TypeError(`idle-autocompact: minutes must be a number >= 0, got ${String(rule.minutes)}`);
        }
        if (rule.tokens !== undefined && (!Number.isInteger(rule.tokens) || rule.tokens < 0)) {
            throw new TypeError(`idle-autocompact: tokens must be a whole number >= 0, got ${String(rule.tokens)}`);
        }
        if (rule.contextWindow !== undefined && (!Number.isInteger(rule.contextWindow) || rule.contextWindow < 0)) {
            throw new TypeError(`idle-autocompact: contextWindow must be a whole number >= 0, got ${String(rule.contextWindow)}`);
        }
        const key = `${provider ?? '*'}/${model ?? '*'}`;
        if (seen.has(key))
            throw new TypeError(`idle-autocompact: duplicate rule for ${key}`);
        seen.add(key);
    }
}
/**
 * Pick the most specific rule for a route: provider+model, then model, then provider.
 * Ties keep the first row, though duplicate selectors are rejected.
 * @param rules - validated rules table.
 * @param route - provider/model the session last used.
 * @returns the matching rule, or undefined when nothing matches.
 */
function resolveRule(rules, route) {
    let best;
    for (const rule of rules) {
        const { provider, model } = selector(rule);
        if (provider !== undefined && provider !== route.provider)
            continue;
        if (model !== undefined && model !== route.model)
            continue;
        const specificity = provider !== undefined && model !== undefined ? 3 : model !== undefined ? 2 : 1;
        if (best === undefined || specificity > best.specificity)
            best = { specificity, rule };
    }
    return best?.rule;
}
/**
 * Idle minutes for a route. A more specific rule replaces, never inherits, the broader one.
 * @param rules - validated rules table.
 * @param route - provider/model the session last used.
 * @returns minutes > 0, or undefined when unmatched or disabled.
 */
export function resolveIdleMinutes(rules, route) {
    const minutes = resolveRule(rules, route)?.minutes ?? 0;
    return minutes > 0 ? minutes : undefined;
}
/**
 * Context-pressure token threshold for a route. Absent on the matched rule, or 0,
 * disables the token trigger there instead of inheriting a broader threshold.
 * @param rules - validated rules table.
 * @param route - provider/model the session last used.
 * @returns tokens > 0, or undefined when unmatched or disabled.
 */
export function resolveTokenThreshold(rules, route) {
    const tokens = resolveRule(rules, route)?.tokens ?? 0;
    return tokens > 0 ? tokens : undefined;
}
/**
 * Declared real capacity for a route whose adapter window was reduced on purpose.
 * Absent on the matched rule, or 0, disables the override there.
 * @param rules - validated rules table.
 * @param route - provider/model the call uses.
 * @returns a positive capacity, or undefined when unmatched or disabled.
 */
export function resolveContextWindow(rules, route) {
    const contextWindow = resolveRule(rules, route)?.contextWindow ?? 0;
    return contextWindow > 0 ? contextWindow : undefined;
}
/**
 * The route a session last used: the latest request header, else the agent options.
 * @param agent - agent whose session is inspected.
 * @returns provider/model, either possibly undefined.
 */
export function routeOf(agent) {
    const header = agent.session.requestHeader()?.config;
    return header !== undefined
        ? { provider: header.provider, model: header.model }
        : { provider: agent.options.provider, model: agent.options.model };
}
/**
 * Describe how much of a compaction request was served from the provider's prompt cache.
 * @param usage - usage the summarization call reported, if any.
 * @returns a one-line summary with the cache-read share and the raw counts.
 */
export function formatCacheUsage(usage) {
    if (usage === undefined)
        return 'usage not reported by provider';
    const read = usage.cacheReadTokens ?? 0;
    const write = usage.cacheWriteTokens ?? 0;
    const total = usage.inputTokens + read + write;
    const percent = total === 0 ? 0 : Math.round(read / total * 100);
    return `${percent}% of input read from cache (read ${read}, write ${write}, uncached ${usage.inputTokens}, total ${total})`;
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
export function historyEndsWithCompaction(session) {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
        const event = session.eventAt(seq);
        if (event === undefined)
            return false;
        if (event.type === 'turn/end')
            return false;
        if (event.type === 'compaction/end' && event.data?.error === undefined)
            return true;
    }
    return false;
}
/**
 * Compact a session at a step boundary once its measured context pressure
 * reaches the route's token threshold. One attempt is made per crossing:
 * further steps stay quiet until pressure drops below the threshold again,
 * which keeps a partial reduction or an impossible range from retrying every
 * step. A failed attempt is logged and never breaks the turn.
 */
export class TokenCompactor {
    overThreshold = new WeakSet();
    meterWarned = false;
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Check one step boundary and compact when the route's threshold is crossed.
     * @param agent - agent whose request is about to be prepared.
     * @param signal - the open turn's cancellation signal.
     * @returns true when a compaction was started and returned a result.
     */
    async check(agent, signal) {
        if (signal.aborted)
            return false;
        const route = routeOf(agent);
        const threshold = resolveTokenThreshold(this.deps.rules(), route);
        if (threshold === undefined) {
            this.overThreshold.delete(agent);
            return false;
        }
        const meter = this.deps.meter();
        if (meter === undefined) {
            if (!this.meterWarned) {
                this.meterWarned = true;
                this.deps.log.warn('token autocompact: no token meter is mounted; token thresholds are ignored');
            }
            return false;
        }
        let total;
        try {
            total = meter.measure(agent.session).totalTokens;
        }
        catch (error) {
            this.deps.log.warn(`token autocompact: token measurement failed: ${messageOf(error)}`);
            return false;
        }
        if (!Number.isFinite(total) || total < threshold) {
            this.overThreshold.delete(agent);
            return false;
        }
        if (this.overThreshold.has(agent))
            return false;
        this.overThreshold.add(agent);
        const label = `${route.provider ?? '?'}/${route.model ?? '?'}`;
        const engine = this.deps.engine(agent);
        if (engine === undefined) {
            this.deps.log.warn(`token autocompact: ${label} reached ${total} tokens (threshold ${threshold}) `
                + 'but no compaction backend is reachable; the step continues');
            return false;
        }
        try {
            const result = await engine.compactIfNeeded(agent, 'context-overflow', signal);
            if (result === null) {
                this.deps.log.warn(`token autocompact: ${label} reached ${total} tokens (threshold ${threshold}) `
                    + 'but no safe compactable range was found; the step continues');
                return false;
            }
            const nodes = result.shadowedSeqs?.length ?? 0;
            const shadowed = result.shadowedTokenCount ?? 0;
            this.deps.log.info(`token autocompact: ${label} at ${total} tokens (threshold ${threshold}); `
                + `compacted ${nodes} surface nodes (~${shadowed} tokens)`);
            return true;
        }
        catch (error) {
            if (!signal.aborted) {
                this.deps.log.warn(`token autocompact: compaction failed: ${messageOf(error)}; the step continues`);
            }
            return false;
        }
    }
}
/** Failure code the adapter uses when a request or response exceeds the declared window. */
const OVERFLOW_CODE = 'CONTEXT_WINDOW_EXCEEDED';
/**
 * Prompt tokens a usage record bills: the counts are disjoint, so the prompt is
 * their sum.
 * @param usage - usage the adapter reported, if any.
 * @returns the billed prompt size, or 0 when nothing was reported.
 */
export function promptTokens(usage) {
    if (usage === undefined)
        return 0;
    return (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}
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
export function restoreSuccessfulFinish(finish, observation, contextWindow) {
    if (contextWindow === undefined || contextWindow <= 0)
        return undefined;
    if (finish.reason.kind !== 'error' || finish.reason.failure?.code !== OVERFLOW_CODE)
        return undefined;
    if (finish.replayState === undefined)
        return undefined;
    if (!observation.balanced || !observation.sawBlockEnd)
        return undefined;
    const prompt = promptTokens(observation.usage);
    if (prompt <= 0 || prompt >= contextWindow)
        return undefined;
    return {
        ...finish,
        reason: { kind: observation.sawToolCall ? 'tool-calls' : 'stop' },
    };
}
function isFinishChunk(chunk) {
    if (typeof chunk !== 'object' || chunk === null)
        return false;
    const raw = chunk;
    if (raw.type !== 'finish')
        return false;
    return typeof raw.reason === 'object'
        && raw.reason !== null
        && typeof raw.reason.kind === 'string';
}
/**
 * Pass a model stream through, restoring one false-overflow finish when the
 * route declares a larger real capacity than its adapter window.
 * @param stream - adapter chunks from the next listener.
 * @param contextWindow - real capacity override, or undefined to pass through.
 * @param label - route label for the log line.
 * @param log - logger.
 */
async function* recoverOverWindowStream(stream, contextWindow, label, log) {
    if (contextWindow === undefined) {
        yield* stream;
        return;
    }
    const started = new Set();
    const ended = new Set();
    let usage;
    let sawToolCall = false;
    for await (const chunk of stream) {
        if (typeof chunk === 'object' && chunk !== null) {
            const raw = chunk;
            switch (raw.type) {
                case 'usage':
                    if (typeof raw.usage === 'object' && raw.usage !== null)
                        usage = raw.usage;
                    break;
                case 'block-start':
                    if (typeof raw.index === 'number')
                        started.add(raw.index);
                    break;
                case 'block-end':
                    if (typeof raw.index === 'number')
                        ended.add(raw.index);
                    if (raw.block?.type === 'tool-call')
                        sawToolCall = true;
                    break;
            }
        }
        if (isFinishChunk(chunk)) {
            const recovered = restoreSuccessfulFinish(chunk, {
                usage,
                balanced: started.size === ended.size && [...started].every((index) => ended.has(index)),
                sawBlockEnd: ended.size > 0,
                sawToolCall,
            }, contextWindow);
            if (recovered !== undefined) {
                log.info(`context override: ${label} reported ${promptTokens(usage)} prompt tokens above its declared window; `
                    + `accepted the completed response within the ${contextWindow}-token override`);
                yield recovered;
                continue;
            }
        }
        yield chunk;
    }
}
/** Render an unknown thrown value for one log line. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** One idle timer per agent; fires one compaction per idle period. */
export class IdleCompactor {
    handles = new Map();
    /** Agents inside an idle period that has not compacted yet. */
    idle = new Set();
    inflight = new Set();
    timers;
    deps;
    constructor(deps) {
        this.deps = deps;
        this.timers = deps.timers ?? realTimers;
    }
    /** Start (or restart) the idle countdown for an agent that just became idle. */
    arm(agent) {
        this.disarm(agent);
        this.idle.add(agent);
        if (this.deps.tokenDue?.(agent) === true) {
            void this.fire(agent);
            return;
        }
        this.schedule(agent);
    }
    /** Cancel the countdown (agent got busy or was disposed). */
    disarm(agent) {
        this.idle.delete(agent);
        this.clearTimer(agent);
    }
    /** Restart the countdown of every agent still in an uncompacted idle period, after the rules changed. */
    refresh() {
        for (const agent of this.idle) {
            this.clearTimer(agent);
            if (this.deps.tokenDue?.(agent) === true) {
                void this.fire(agent);
                continue;
            }
            this.schedule(agent);
        }
    }
    schedule(agent) {
        const minutes = resolveIdleMinutes(this.deps.rules(), routeOf(agent));
        if (minutes === undefined)
            return;
        this.handles.set(agent, this.timers.set(() => void this.fire(agent), minutes * MINUTE_MS));
    }
    clearTimer(agent) {
        const handle = this.handles.get(agent);
        if (handle === undefined)
            return;
        this.timers.clear(handle);
        this.handles.delete(agent);
    }
    /** Clear every countdown and abort compactions still running. */
    dispose() {
        for (const handle of this.handles.values())
            this.timers.clear(handle);
        this.handles.clear();
        this.idle.clear();
        for (const controller of this.inflight)
            controller.abort();
        this.inflight.clear();
    }
    async fire(agent) {
        this.handles.delete(agent);
        this.idle.delete(agent);
        if (agent.status !== 'idle')
            return;
        if (this.deps.archived?.(agent) === true)
            return;
        if (this.deps.compacted?.(agent) === true)
            return;
        const controller = new AbortController();
        this.inflight.add(controller);
        try {
            await this.deps.compact(agent, controller.signal);
        }
        catch (error) {
            if (!controller.signal.aborted) {
                this.deps.log.warn(`idle compaction failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        finally {
            this.inflight.delete(controller);
        }
    }
}
/**
 * The compaction backend for one agent. The web profile builds the backend
 * inside the agent preset, so ask the preset registry first; a composition that
 * mounts a root backend (the CLI base) answers through ordinary lookup.
 * @param ctx - plugin context.
 * @param agent - agent about to take a step.
 * @returns the reachable backend, or undefined.
 */
function compactionFor(ctx, agent) {
    try {
        const scoped = ctx.get('agentPresets')?.serviceFor(agent, 'compaction');
        if (scoped !== undefined)
            return scoped;
    }
    catch {
        // A preset registry that is not started yet must not fail the step.
    }
    try {
        return ctx.get('compaction');
    }
    catch {
        return undefined;
    }
}
/**
 * Whether the agent route's token threshold is already reached.
 * @param ctx - plugin context.
 * @param rules - validated rules table.
 * @param agent - idle agent to price.
 * @returns true only when a threshold applies and measured pressure reaches it.
 */
function tokenThresholdReached(ctx, rules, agent) {
    try {
        const threshold = resolveTokenThreshold(rules, routeOf(agent));
        if (threshold === undefined)
            return false;
        const meter = ctx.get('tokenMeter');
        if (meter === undefined)
            return false;
        return meter.measure(agent.session).totalTokens >= threshold;
    }
    catch {
        return false;
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
function archivedSessionIds(ctx) {
    try {
        return ctx.get('workspaceRegistry')?.archivedSessionIds ?? [];
    }
    catch {
        return [];
    }
}
/**
 * Whether the agent's session history already ends with a compaction. Read
 * defensively: a timer fires without an awaiter, and a session shape that
 * cannot be read must not turn an idle tick into a process-killing rejection.
 * @param agent - agent whose session is inspected.
 * @returns true when the newest history activity is a completed compaction.
 */
function sessionEndsWithCompaction(agent) {
    try {
        return historyEndsWithCompaction(agent.session);
    }
    catch {
        return false;
    }
}
/**
 * Watch every agent's lifecycle and compact it after its configured idle time,
 * and at every step boundary once the route's token threshold is reached.
 * @param ctx - plugin context; `ctx.commands` must be mounted.
 * @param config - rules table from the plugin config.
 * @param timers - timer seam, replaced only by tests.
 */
export function apply(ctx, config = {}, timers) {
    validateRules(readRules(config.rules));
    let rulesValid = true;
    const rules = () => rulesValid ? readRules(config.rules) : [];
    const compactor = new IdleCompactor({
        rules,
        ...timers !== undefined ? { timers } : {},
        log: ctx.logger,
        archived: (agent) => archivedSessionIds(ctx).includes(agent.session.header.id),
        compacted: sessionEndsWithCompaction,
        tokenDue: (agent) => tokenThresholdReached(ctx, rules(), agent),
        async compact(agent, signal) {
            const execution = await ctx.commands.execute(agent, '/compact', [], signal);
            if (execution === undefined)
                throw new Error('no /compact command is registered for this agent');
            const { kind, text } = execution.result;
            if (kind === 'success') {
                if (text !== undefined)
                    ctx.logger.info(`idle compaction: ${text}`);
            }
            else if (!text?.startsWith(UNAVAILABLE_PREFIX)) {
                throw new Error(text ?? '/compact failed');
            }
        },
    });
    ctx.on('agent/created', ({ agent }) => compactor.arm(agent));
    ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle')
            compactor.arm(agent);
        else
            compactor.disarm(agent);
    });
    ctx.on('agent/disposed', ({ agent }) => compactor.disarm(agent));
    const tokens = new TokenCompactor({
        rules,
        meter: () => {
            try {
                return ctx.get('tokenMeter');
            }
            catch {
                return undefined;
            }
        },
        engine: (agent) => compactionFor(ctx, agent),
        log: ctx.logger,
    });
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        try {
            await tokens.check(agent, signal);
        }
        catch (error) {
            ctx.logger.warn(`token autocompact check failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        return next();
    });
    ctx.on('llm/stream', (options, next) => {
        const override = resolveContextWindow(rules(), { provider: options.provider, model: options.model });
        return recoverOverWindowStream(next(), override, `${options.provider}/${options.model}`, ctx.logger);
    });
    ctx.on('session/event', (_session, event) => {
        if (event.type === 'compaction/summary')
            ctx.logger.info(`compaction cache: ${formatCacheUsage(event.data.usage)}`);
    });
    ctx.on('loader/volatile-update', () => {
        try {
            validateRules(readRules(config.rules));
            rulesValid = true;
        }
        catch (error) {
            rulesValid = false;
            ctx.logger.warn(`idle compaction rules ignored: ${error instanceof Error ? error.message : String(error)}`);
        }
        compactor.refresh();
    });
    ctx.effect(function* () {
        yield () => compactor.dispose();
    }, 'idle-autocompact lifecycle');
}
