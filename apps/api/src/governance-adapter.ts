// SPDX-License-Identifier: Apache-2.0
// Bridges the real @mvp/governance GovernanceGateway (policy engine over
// tool names) to the GovernanceGateway SURFACE that @mvp/agent-runtime's
// AgentRuntime expects (see agent-runtime/src/governance.ts — a deliberate
// local interface so that package builds without the teammate's code).
//
// Approval-id mapping: the real gateway mints its own approval id inside
// evaluate(). The adapter mints a runtime-facing id at the same moment,
// maps it 1:1, and returns it on the evaluation — the runtime then uses
// that id on its `approval_required` events and in awaitDecision(), so the
// id the UI approves/denies is already mapped. No ordering assumptions,
// no translation race.

import { randomUUID } from 'node:crypto';
import type {
  AuditEntry as RuntimeAuditEntry,
  GovernanceDecision,
  GovernanceEvaluation,
  GovernanceGateway as RuntimeGovernanceGateway,
  ToolCall,
  ToolContext,
} from '@mvp/agent-runtime';
import { GovernanceGateway as RealGovernanceGateway } from '@mvp/governance';

function toEvalContext(ctx: ToolContext): { sessionId: string; botId: string; actor: string } {
  return { sessionId: ctx.sessionId, botId: ctx.botId, actor: ctx.botId };
}

export class GovernanceAdapter implements RuntimeGovernanceGateway {
  private readonly real: RealGovernanceGateway;
  /** Runtime-facing approval id → real gateway approval id. */
  private readonly idMap = new Map<string, string>();

  constructor(real: RealGovernanceGateway) {
    this.real = real;
  }

  /** Translate a runtime-issued approval id to the real gateway id. */
  resolveApprovalId(runtimeOrRealId: string): string {
    return this.idMap.get(runtimeOrRealId) ?? runtimeOrRealId;
  }

  classify(call: ToolCall, _ctx: ToolContext): GovernanceDecision {
    // Side-effect-free static check. Only a fallback in the runtime
    // (`evaluated.decision ?? classified`); the true policy decision comes
    // from evaluate(). Reads auto-allow; everything else needs a human.
    return this.real.classify(call.name) === 'read' ? 'allow' : 'require-approval';
  }

  async evaluate(call: ToolCall, ctx: ToolContext): Promise<GovernanceEvaluation> {
    const res = await this.real.evaluate(call.name, call.args, toEvalContext(ctx));
    if (res.effect === 'require-approval' && res.approvalId) {
      const runtimeId = randomUUID();
      this.idMap.set(runtimeId, res.approvalId);
      // Bound the map: approvals are single-use.
      if (this.idMap.size > 1000) {
        const first = this.idMap.keys().next();
        if (!first.done) this.idMap.delete(first.value);
      }
      return { decision: res.effect, approvalId: runtimeId };
    }
    return { decision: res.effect };
  }

  async awaitDecision(
    approvalId: string,
    opts?: { timeoutMs?: number },
  ): Promise<'approved' | 'denied'> {
    const realId = this.idMap.get(approvalId);
    if (!realId) {
      throw new Error(`no governance approval mapped for "${approvalId}"`);
    }
    return this.real.awaitDecision(realId, opts?.timeoutMs);
  }

  decide(approvalId: string, decision: 'approved' | 'denied'): void {
    this.real.decide(this.resolveApprovalId(approvalId), decision);
  }

  audit(entry: RuntimeAuditEntry): void {
    // The real gateway redacts secrets and JSON-stringifies detail itself.
    this.real.audit(entry.type, {
      actor: entry.botId,
      sessionId: entry.sessionId,
      toolName: entry.call?.name,
      detail: entry.detail,
    });
  }

  async runPreHooks(call: ToolCall, ctx: ToolContext): Promise<void> {
    await this.real.runPreHooks(call.name, call.args, toEvalContext(ctx));
  }

  async runPostHooks(call: ToolCall, result: unknown, ctx: ToolContext): Promise<void> {
    await this.real.runPostHooks(call.name, call.args, result, toEvalContext(ctx));
  }
}
