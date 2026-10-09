// SPDX-License-Identifier: Apache-2.0
/**
 * System-1 decision head — EXPERIMENTAL SPIKE (research only, not production).
 *
 * Idea (inspired by the *other* Laya, NandhaKishorM/laya — adapted, not
 * copied): a tiny local classifier (~400M params) that makes fast
 * intent/tool-routing decisions with zero tokens, acting as a "System 1"
 * (fast, intuitive) head in front of the slower heuristic/LLM "System 2"
 * router.
 *
 * STATUS: interface + env gate + stub only. No weights are downloaded, no
 * ONNX runtime is added, and no hard dependency exists. `SYSTEM1_ENABLED`
 * defaults to OFF; while disabled (or when the backend reports unavailable)
 * routing falls back to the existing heuristic router (`routeModel`) with
 * ZERO behavior change.
 *
 * ---------------------------------------------------------------------------
 * EXPECTED LOCAL-BACKEND CONTRACT (for whoever implements the real backend):
 *
 * Model artifact:  `system1-intent.onnx` (+ `system1-labels.json`), loaded
 *   once at startup from the bot/data dir or a configured weights dir.
 * Input features:  float32 vector, dim 4096 — hashed character 3–5-grams +
 *   word unigrams of the user message (FeatureHasher, seed 42), L2-normalized.
 *   Pure CPU featurization, no tokenizer download.
 * Output:          softmax over `candidateLabels` → (label, confidence).
 * Latency target:  ~33ms p50 on a single CPU thread (featurize + ONNX infer);
 *   slower than that and System 2 should just run instead.
 * Labels:          intent/tool labels the platform supports (e.g. the
 *   TaskType set: 'code' | 'chat' | 'reasoning' | 'simple-qa', or tool names
 *   for tool routing). Unknown labels MUST fall back to System 2.
 * Failure mode:    any load/infer error → `available === false`, and
 *   System1Router silently uses the existing router. Never throw into the
 *   turn path.
 * ---------------------------------------------------------------------------
 *
 * Tests cover the adapter + flag behavior only (no weights, no ONNX).
 */

import { routeModel, type RouteModelInput, type RouteModelResult, type TaskType } from './routing.js';

/** Env flag gating the System-1 head. Default OFF. */
export const SYSTEM1_ENABLED_ENV_VAR = 'SYSTEM1_ENABLED';

/** True when SYSTEM1_ENABLED=1/true. Anything else (including unset) = off. */
export function system1Enabled(): boolean {
  const raw = process.env[SYSTEM1_ENABLED_ENV_VAR];
  return raw === '1' || (typeof raw === 'string' && raw.toLowerCase() === 'true');
}

/** Input features for the System-1 classifier (see contract above). */
export interface System1Features {
  /** Raw user text to classify. */
  text: string;
  /** Task-type hint from the caller, if any. */
  taskType?: TaskType;
  /** Labels the backend is allowed to return. */
  candidateLabels: string[];
}

/** One System-1 decision. */
export interface System1Decision {
  label: string;
  /** 0..1. */
  confidence: number;
  /** End-to-end classify latency in ms (featurize + infer). */
  latencyMs: number;
  /** Backend name (for audit/debug). */
  backend: string;
}

/**
 * Adapter interface for a local System-1 backend. Implementations own the
 * weights/model lifecycle; the router only calls `classify` and honors
 * `available`.
 */
export interface System1Backend {
  /** Human-readable backend name, e.g. 'system1-onnx'. */
  readonly name: string;
  /**
   * False when the backend cannot serve (no weights, load failed, too slow).
   * The router treats unavailable as "use System 2" — never an error.
   */
  readonly available: boolean;
  classify(features: System1Features): Promise<System1Decision>;
}

/**
 * Stub local backend. Documents the ONNX/weights contract (see module
 * header) but serves nothing: `available` is false and `classify` throws an
 * explanatory error. A real backend (ONNX Runtime + weights) implements
 * `System1Backend` and reports `available === true` once loaded.
 */
export class StubSystem1Backend implements System1Backend {
  readonly name = 'system1-stub';
  readonly available = false;

  async classify(_features: System1Features): Promise<System1Decision> {
    throw new Error(
      'System-1 stub backend: no local model is wired up. ' +
        'Implement System1Backend against the ONNX contract documented in src/system1.ts ' +
        '(system1-intent.onnx, 4096-dim hashed n-gram features → label, ~33ms CPU target) ' +
        'and pass it to System1Router.',
    );
  }
}

/** Map a backend label onto the router's task types. Unknown labels → undefined (fall back). */
const LABEL_TO_TASK_TYPE: Record<string, TaskType> = {
  code: 'code',
  chat: 'chat',
  reasoning: 'reasoning',
  'simple-qa': 'simple-qa',
  simpleqa: 'simple-qa',
  qa: 'simple-qa',
};

export interface System1RouterOptions {
  /** Backend to use when enabled. Defaults to the (unavailable) stub. */
  backend?: System1Backend;
  /**
   * Defaults to `system1Enabled()` (the SYSTEM1_ENABLED env flag). Explicit
   * true + an unavailable backend still falls back to the existing router.
   */
  enabled?: boolean;
}

export interface System1RouteInput extends RouteModelInput {
  /** User message text handed to the System-1 backend as features. */
  message?: string;
}

/**
 * Experimental System-1 routing head.
 *
 * - Disabled (default) → delegates to `routeModel(input)` untouched: zero
 *   behavior change vs. the existing router.
 * - Enabled + backend available → asks the backend for an intent label,
 *   maps it to a task type, and routes with that task type (explicit
 *   overrides and the free-only guard in `routeModel` still apply).
 * - Enabled + backend unavailable (incl. the stub) → falls back to
 *   `routeModel(input)` untouched.
 */
export class System1Router {
  private readonly backend: System1Backend;
  private readonly enabled: boolean;

  constructor(opts: System1RouterOptions = {}) {
    this.backend = opts.backend ?? new StubSystem1Backend();
    this.enabled = opts.enabled ?? system1Enabled();
  }

  /** Whether the System-1 head will actually be consulted on `route()`. */
  get active(): boolean {
    return this.enabled && this.backend.available;
  }

  get backendName(): string {
    return this.backend.name;
  }

  async route(input: System1RouteInput): Promise<RouteModelResult> {
    if (!this.active) {
      // EXPERIMENTAL gate closed (or no backend): existing router, zero behavior change.
      return routeModel(input);
    }
    const started = Date.now();
    let decision: System1Decision;
    try {
      decision = await this.backend.classify({
        text: input.message ?? '',
        taskType: input.taskType,
        candidateLabels: Object.keys(LABEL_TO_TASK_TYPE),
      });
    } catch {
      // Backend failed mid-flight: fail soft to System 2, never break the turn.
      return routeModel(input);
    }
    const mapped = LABEL_TO_TASK_TYPE[decision.label.toLowerCase()];
    if (!mapped) {
      return routeModel(input); // unknown label: System 2 decides
    }
    const result = routeModel({ ...input, taskType: mapped });
    return {
      ...result,
      reason: `${result.reason} (System-1 head "${this.backend.name}" labeled it "${decision.label}" @ ${(
        decision.confidence * 100
      ).toFixed(0)}% in ${Date.now() - started}ms — experimental.)`,
    };
  }
}

/** Convenience: build a router honoring the env flag (stub backend unless given one). */
export function createSystem1Router(opts: System1RouterOptions = {}): System1Router {
  return new System1Router(opts);
}
