// SPDX-License-Identifier: Apache-2.0
// Plugin hook system (OpenCode parity).
//
// OpenCode's extensibility comes from plugins: modules that register hooks on
// runtime events (tool calls, sessions, file changes). Until now agent-runtime
// only had injected single-shot callbacks (summarizer hook, checkpoint hook)
// and a GovernanceGateway interface — no pluggable event bus and no plugin
// loader. This module provides both:
//
//   - HookBus: a typed event bus. Handlers run serially, in registration
//     order. A `tool.before` handler may cancel the tool call (fail-closed:
//     the runtime returns a cancellation instead of executing).
//   - loadPlugins(dir, bus): loads plugin modules from a directory. A plugin
//     is any ESM module whose default export (or `activate` named export) is
//     a function `(bus) => void | Promise<void>`, optionally with
//     `name`/`version` metadata attached. Only `.js`/`.mjs` files are loaded;
//     subdirectories are skipped. Load failures are collected, not thrown,
//     so one broken plugin cannot take the host down.

export type HookEventName = 'session.created' | 'tool.before' | 'tool.after';

export interface SessionCreatedPayload {
  sessionId: string;
  botId: string;
}

export interface ToolBeforePayload {
  sessionId: string;
  botId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolAfterPayload extends ToolBeforePayload {
  ok: boolean;
  durationMs: number;
  error?: string;
}

/** A `tool.before` handler cancels the call by returning { cancel: true }. */
export interface HookCancel {
  cancel: true;
  /** Human-readable reason surfaced to the model and the audit trail. */
  reason?: string;
}

export type HookHandler<T = unknown> = (payload: T) => void | Promise<void> | HookCancel | Promise<HookCancel>;

function isCancel(v: unknown): v is HookCancel {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { cancel?: unknown }).cancel === true
  );
}

export interface HookEmitResult {
  /** True when a `tool.before` handler returned { cancel: true }. */
  cancelled: boolean;
  /** First cancellation reason, if any. */
  reason?: string;
  /** Errors thrown by handlers — always collected, never propagated. */
  errors: Array<{ event: HookEventName; message: string }>;
}

/**
 * Typed event bus. Emit is serial and best-effort: handler errors are
 * collected into the result (and never thrown), so a buggy plugin cannot
 * break a turn. Cancellation is only honored for `tool.before`.
 */
export class HookBus {
  private readonly handlers = new Map<HookEventName, HookHandler[]>();

  /** Register a handler; returns an unsubscribe function. */
  on<T = unknown>(event: HookEventName, fn: HookHandler<T>): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(fn as HookHandler);
    this.handlers.set(event, list);
    return () => {
      const cur = this.handlers.get(event) ?? [];
      const i = cur.indexOf(fn as HookHandler);
      if (i !== -1) cur.splice(i, 1);
    };
  }

  /** Register a handler that runs at most once. */
  once<T = unknown>(event: HookEventName, fn: HookHandler<T>): () => void {
    const wrapped: HookHandler<T> = (payload) => {
      unsub();
      return fn(payload);
    };
    const unsub = this.on(event, wrapped);
    return unsub;
  }

  handlerCount(event: HookEventName): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  async emit<T = unknown>(event: HookEventName, payload: T): Promise<HookEmitResult> {
    const result: HookEmitResult = { cancelled: false, errors: [] };
    const list = [...(this.handlers.get(event) ?? [])];
    for (const fn of list) {
      try {
        const v = await fn(payload);
        if (event === 'tool.before' && isCancel(v)) {
          result.cancelled = true;
          if (result.reason === undefined) result.reason = v.reason;
          // Keep running remaining handlers (they may clean up), but the
          // call is cancelled regardless.
        }
      } catch (err) {
        result.errors.push({ event, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Plugin loading
// ---------------------------------------------------------------------------

export interface LoadedPlugin {
  name: string;
  version?: string;
  file: string;
}

export interface PluginLoadReport {
  loaded: LoadedPlugin[];
  /** Files that failed to load or had no activate export — { file, error }. */
  failed: Array<{ file: string; error: string }>;
}

interface PluginModule {
  default?: unknown;
  activate?: unknown;
  name?: unknown;
  version?: unknown;
}

function pickActivate(mod: PluginModule): ((bus: HookBus) => void | Promise<void>) | undefined {
  if (typeof mod.activate === 'function') return mod.activate as (bus: HookBus) => void | Promise<void>;
  if (typeof mod.default === 'function') return mod.default as (bus: HookBus) => void | Promise<void>;
  return undefined;
}

function pickMeta(mod: PluginModule, activate: (bus: HookBus) => void | Promise<void>, file: string): LoadedPlugin {
  const attached = (activate as { pluginName?: unknown; pluginVersion?: unknown }) ?? {};
  const name =
    typeof mod.name === 'string'
      ? mod.name
      : typeof attached.pluginName === 'string'
        ? attached.pluginName
        : file;
  const version = typeof mod.version === 'string' ? mod.version : undefined;
  return { name, version, file };
}

/**
 * Load every `.js`/`.mjs` plugin module in `dir` and call its activate
 * function with the bus. Activation errors are collected into the report;
 * the bus keeps working for the plugins that did load.
 */
export async function loadPlugins(dir: string, bus: HookBus): Promise<PluginLoadReport> {
  const report: PluginLoadReport = { loaded: [], failed: [] };
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    const { readdirSync } = await import('node:fs');
    entries = readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isFile(): boolean }>;
  } catch {
    return report; // missing dir => nothing to load, not an error
  }
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !/\.(mjs|js)$/.test(e.name)) continue;
    const file = join(dir, e.name);
    try {
      const mod = (await import(pathToFileURL(file).href)) as PluginModule;
      const activate = pickActivate(mod);
      if (!activate) {
        report.failed.push({ file, error: 'no activate function (default or named export)' });
        continue;
      }
      await activate(bus);
      report.loaded.push(pickMeta(mod, activate, e.name));
    } catch (err) {
      report.failed.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
