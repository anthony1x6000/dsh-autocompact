/**
 * Idle autocompact for the DeepSeek Harness.
 *
 * After a session has been idle for N minutes (the minutes configured for the
 * model route it last used), the `/compact` command condenses it. Useful
 * when a provider's prompt cache expires after a quiet period: the next turn
 * then starts from a short summary instead of re-reading a long cold history.
 *
 * Rules live in the plugin config (Plugins -> dsh-autocompact -> idle-autocompact)
 * and match a route by
 * provider, model, or both. The most specific match wins:
 * `provider+model` > `model` > `provider`. `minutes: 0` disables a route that
 * a broader rule would otherwise cover. Unmatched routes are never compacted.
 *
 * @module dsh-autocompact
 */
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'idle-autocompact';
/**
 * The command registry, which is mounted at root in every profile. The
 * compaction backend itself is not: the web profile builds it inside each agent
 * preset, so a root plugin injecting `compaction` would wait forever.
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
    minutes: z.number().min(0).required().description('Idle minutes before compaction; 0 disables.'),
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
        handle.unref();
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
 * @throws when a row has no selector, bad minutes, or duplicates another row.
 */
export function validateRules(rules) {
    const seen = new Set();
    for (const rule of rules) {
        const { provider, model } = selector(rule);
        if (provider === undefined && model === undefined) {
            throw new TypeError('idle-autocompact: each rule needs a provider or model');
        }
        if (!Number.isFinite(rule.minutes) || rule.minutes < 0) {
            throw new TypeError(`idle-autocompact: minutes must be a number >= 0, got ${String(rule.minutes)}`);
        }
        const key = `${provider ?? '*'}/${model ?? '*'}`;
        if (seen.has(key))
            throw new TypeError(`idle-autocompact: duplicate rule for ${key}`);
        seen.add(key);
    }
}
/**
 * Pick the idle minutes for a route: provider+model, then model, then provider.
 * @param rules - validated rules table.
 * @param route - provider/model the session last used.
 * @returns minutes > 0, or undefined when unmatched or disabled with 0.
 */
export function resolveIdleMinutes(rules, route) {
    let best;
    for (const rule of rules) {
        const { provider, model } = selector(rule);
        if (provider !== undefined && provider !== route.provider)
            continue;
        if (model !== undefined && model !== route.model)
            continue;
        const specificity = provider !== undefined && model !== undefined ? 3 : model !== undefined ? 2 : 1;
        if (best === undefined || specificity > best.specificity)
            best = { specificity, minutes: rule.minutes };
    }
    return best !== undefined && best.minutes > 0 ? best.minutes : undefined;
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
 * Watch every agent's lifecycle and compact it after its configured idle time.
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
