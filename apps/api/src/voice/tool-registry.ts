/**
 * A provider wraps one family of tools; the registry filters by need and
 * granted scope and merges their tools in `order`. The context type is a
 * parameter so the device turn and web chat can bind tools differently in the
 * open. Nothing here logs.
 */
import type { Tool } from 'ai';

/** What a provider may touch. Declared in the provider, enforced by `resolve`, not by the model. */
type ToolScope = 'timers' | 'reminders' | 'tasks' | 'notes' | 'calendar' | 'memory'
  | 'device.control' | 'voice.query' | 'games' | 'space.read' | 'space.write' | 'bob-apps';

/**
 * `early` tools lead the tool list; `late` tools follow memory in the cache-v1
 * prompt layout. The caller places the two groups; the registry orders within one.
 */
type ToolSlot = 'early' | 'late';

export interface ToolProvider<Ctx> {
  /** Namespaced, e.g. `bob.timers`. */
  readonly id: string;
  readonly scopes: readonly ToolScope[];
  readonly slot: ToolSlot;
  /** Position within the slot; lower first. */
  readonly order: number;
  /** False when the context lacks something this provider requires: it is skipped and never throws. */
  needs(ctx: Ctx): boolean;
  createTools(ctx: Ctx): Record<string, Tool> | Promise<Record<string, Tool>>;
}

interface ResolveOptions {
  /** When set, only providers whose every scope is granted are used. Omitted: all scopes granted. */
  granted?: readonly ToolScope[];
}

export interface ToolRegistry<Ctx> {
  resolve(ctx: Ctx, slot: ToolSlot, options?: ResolveOptions): Promise<Record<string, Tool>>;
  /** Same as `resolve` for callers that are synchronous today; throws if a provider in the slot is async. */
  resolveSync(ctx: Ctx, slot: ToolSlot, options?: ResolveOptions): Record<string, Tool>;
}

/** Builds a registry over `providers`; throws on a duplicate provider id (a wiring bug, at boot). */
export function createToolRegistry<Ctx>(providers: readonly ToolProvider<Ctx>[]): ToolRegistry<Ctx> {
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new Error(`duplicate tool provider id: ${provider.id}`);
    seen.add(provider.id);
  }
  // Stable: providers of equal order keep registration order.
  const sorted = [...providers].sort((a, b) => a.order - b.order);
  const selected = (ctx: Ctx, slot: ToolSlot, options: ResolveOptions): ToolProvider<Ctx>[] => {
    const granted = options.granted === undefined ? null : new Set<ToolScope>(options.granted);
    return sorted.filter((provider) => provider.slot === slot
      && (granted === null || provider.scopes.every((scope) => granted.has(scope)))
      && provider.needs(ctx));
  };
  return {
    async resolve(ctx, slot, options = {}) {
      const tools: Record<string, Tool> = {};
      for (const provider of selected(ctx, slot, options)) Object.assign(tools, await provider.createTools(ctx));
      return tools;
    },
    resolveSync(ctx, slot, options = {}) {
      const tools: Record<string, Tool> = {};
      for (const provider of selected(ctx, slot, options)) {
        const made = provider.createTools(ctx);
        if (made instanceof Promise) throw new Error(`tool provider ${provider.id} is async; use resolve`);
        Object.assign(tools, made);
      }
      return tools;
    },
  };
}
