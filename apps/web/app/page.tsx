// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  allowTool,
  decideApproval,
  deleteSlashCommand,
  getApiBase,
  getBots,
  getModels,
  getProviders,
  getSlashCommands,
  saveSlashCommand,
  streamChat,
} from '../lib/api';
import type {
  BotConfig,
  ModelPriceInfo,
  ProviderInfo,
  SlashCommand,
  StreamEvent,
  TokenUsage,
  ToolCall,
} from '../lib/api';
import { COST_ESTIMATE_TOOLTIP, contextMeter, costOfUsage, formatTokens, formatUsd } from '../lib/usage';
import { WidgetRenderer, validateWidget } from '../components/widgets';
import type { Widget, WidgetAction } from '../components/widgets';

type ChatBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; usage?: TokenUsage; costUsd?: number }
  | { kind: 'tool'; id: string; call: ToolCall; result?: unknown; denied?: boolean }
  | {
      kind: 'approval';
      id: string;
      approvalId: string;
      call: ToolCall;
      status: 'pending' | 'approved' | 'denied';
      remembering?: boolean;
    }
  | { kind: 'widget'; id: string; widget: Widget }
  | { kind: 'error'; id: string; text: string }
  | { kind: 'interrupted'; id: string; text: string };

let blockSeq = 0;
const nextId = () => `b${Date.now()}_${blockSeq++}`;

interface ProviderOverride {
  provider: string;
  model: string;
}

function loadOverride(botId: string): ProviderOverride | null {
  try {
    const raw = localStorage.getItem(`mvp:provider:${botId}`);
    return raw ? (JSON.parse(raw) as ProviderOverride) : null;
  } catch {
    return null;
  }
}

function saveOverride(botId: string, o: ProviderOverride): void {
  try {
    localStorage.setItem(`mvp:provider:${botId}`, JSON.stringify(o));
  } catch {
    // ignore
  }
}

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** Subtle per-turn footer under an assistant message: tokens + $ cost + context meter. */
function UsageFooter({
  usage,
  contextLength,
  costUsd,
}: {
  usage: TokenUsage;
  contextLength?: number;
  costUsd?: number;
}) {
  const meter = contextMeter(usage.totalTokens, contextLength);
  return (
    <div className="small muted mono usage-line">
      ↑ {formatTokens(usage.promptTokens)} in · ↓ {formatTokens(usage.completionTokens)} out · Σ{' '}
      {formatTokens(usage.totalTokens)}
      {costUsd !== undefined && (
        <span title={COST_ESTIMATE_TOOLTIP}> · ≈{formatUsd(costUsd)}</span>
      )}
      {meter && (
        <span className={meter.warn ? 'amber' : undefined}>
          {' '}· ctx {formatTokens(meter.used)}/{formatTokens(meter.limit)} ({Math.round(meter.pct)}%)
        </span>
      )}
    </div>
  );
}

/** Find a /api/models price entry: exact providerId/modelId, then bare modelId fallback. */
function lookupPrice(
  models: ModelPriceInfo[],
  providerId: string,
  modelId: string,
): ModelPriceInfo | undefined {
  return (
    models.find((m) => m.providerId === providerId && m.id === modelId) ??
    models.find((m) => m.id === modelId)
  );
}

/** Clay toggle switch. */
function ClayToggle({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      className="clay-toggle"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      title={title}
    >
      <span className="track" aria-hidden="true">
        <span className="knob" aria-hidden="true" />
      </span>
      <span className="tlabel">{label}</span>
    </button>
  );
}

export default function ChatPage() {
  const [bots, setBots] = useState<BotConfig[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [selectedBotId, setSelectedBotId] = useState<string>('');
  const [providerId, setProviderId] = useState<string>('');
  const [modelId, setModelId] = useState<string>('');
  const [blocks, setBlocks] = useState<ChatBlock[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [sessionUsage, setSessionUsage] = useState<Record<string, TokenUsage>>({});
  const [sessionCost, setSessionCost] = useState<Record<string, number>>({});
  const [modelPrices, setModelPrices] = useState<ModelPriceInfo[]>([]);
  // New run controls.
  const [autoApprove, setAutoApprove] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [maxBudget, setMaxBudget] = useState('');
  const [slashCommands, setSlashCommands] = useState<Record<string, SlashCommand>>({});
  const [slashHl, setSlashHl] = useState(0);
  const [slashMgrOpen, setSlashMgrOpen] = useState(false);
  const [slashDraft, setSlashDraft] = useState({ name: '', description: '', prompt: '' });
  const [slashError, setSlashError] = useState('');
  const sessionIds = useRef<Record<string, string>>({});
  const messagesRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const turnSeq = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const botIdRef = useRef(selectedBotId);
  botIdRef.current = selectedBotId;
  const providerIdRef = useRef(providerId);
  providerIdRef.current = providerId;
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  const modelPricesRef = useRef(modelPrices);
  modelPricesRef.current = modelPrices;
  const autoApproveRef = useRef(autoApprove);
  autoApproveRef.current = autoApprove;
  const planModeRef = useRef(planMode);
  planModeRef.current = planMode;
  const maxBudgetRef = useRef(maxBudget);
  maxBudgetRef.current = maxBudget;

  const selectedBot = bots.find((b) => b.id === selectedBotId);
  const selectedProvider = providers.find((p) => p.id === providerId);
  const selectedBotRef = useRef(selectedBot);
  selectedBotRef.current = selectedBot;

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [b, p, m, sc] = await Promise.all([getBots(), getProviders(), getModels(), getSlashCommands()]);
        if (cancelled) return;
        setBots(b);
        setProviders(p);
        setModelPrices(m);
        setSlashCommands(sc.commands ?? {});
        if (b.length > 0) setSelectedBotId(b[0].id);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Restore run-control prefs.
  useEffect(() => {
    setAutoApprove(loadFlag('mvp:autoApprove'));
    setPlanMode(loadFlag('mvp:planMode'));
    try {
      setMaxBudget(localStorage.getItem('mvp:maxBudget') ?? '');
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('mvp:autoApprove', autoApprove ? '1' : '0');
    } catch { /* ignore */ }
  }, [autoApprove]);
  useEffect(() => {
    try {
      localStorage.setItem('mvp:planMode', planMode ? '1' : '0');
    } catch { /* ignore */ }
  }, [planMode]);
  useEffect(() => {
    try {
      localStorage.setItem('mvp:maxBudget', maxBudget);
    } catch { /* ignore */ }
  }, [maxBudget]);

  // When the bot changes, restore its provider/model override (or defaults).
  useEffect(() => {
    if (!selectedBot) return;
    const override = loadOverride(selectedBot.id);
    const prov = override?.provider || selectedBot.provider;
    setProviderId(prov);
    setModelId(override?.model || selectedBot.model || '');
  }, [selectedBotId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist overrides.
  useEffect(() => {
    if (!selectedBotId || !providerId) return;
    saveOverride(selectedBotId, { provider: providerId, model: modelId });
  }, [selectedBotId, providerId, modelId]);

  // Auto-scroll on new blocks.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const sessionIdFor = (botId: string): string => {
    if (!sessionIds.current[botId]) {
      sessionIds.current[botId] =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `s${Date.now()}`;
    }
    return sessionIds.current[botId];
  };

  const applyEvent = useCallback((event: StreamEvent) => {
    if (event.type === 'done') {
      const bid = botIdRef.current;
      const usage = event.usage;
      let costUsd: number | undefined;
      if (usage && bid) {
        const turnModel = modelIdRef.current || selectedBotRef.current?.model || '';
        const price = lookupPrice(modelPricesRef.current, providerIdRef.current, turnModel);
        costUsd = costOfUsage(price, usage).total;
        setSessionUsage((prev) => {
          const cur = prev[bid] ?? emptyUsage();
          return {
            ...prev,
            [bid]: {
              promptTokens: cur.promptTokens + usage.promptTokens,
              completionTokens: cur.completionTokens + usage.completionTokens,
              totalTokens: cur.totalTokens + usage.totalTokens,
            },
          };
        });
        setSessionCost((prev) => ({ ...prev, [bid]: (prev[bid] ?? 0) + (costUsd ?? 0) }));
      }
      setBlocks((prev) => {
        const next = [...prev];
        for (let i = next.length - 1; i >= 0; i--) {
          const b = next[i];
          if (b && b.kind === 'assistant') {
            next[i] = { ...b, streaming: false, usage: event.usage ?? undefined, costUsd };
            break;
          }
        }
        return next;
      });
      return;
    }
    setBlocks((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      switch (event.type) {
        case 'token': {
          if (last && last.kind === 'assistant' && last.streaming) {
            next[next.length - 1] = { ...last, text: last.text + event.content };
          } else {
            next.push({ kind: 'assistant', id: nextId(), text: event.content, streaming: true });
          }
          break;
        }
        case 'tool_call': {
          if (last && last.kind === 'assistant') {
            next[next.length - 1] = { ...last, streaming: false };
          }
          next.push({ kind: 'tool', id: nextId(), call: event.call });
          break;
        }
        case 'tool_result': {
          const idx = next.findIndex(
            (b) => b.kind === 'tool' && b.call.id === event.call.id,
          );
          if (idx >= 0) {
            const b = next[idx];
            if (b.kind === 'tool') next[idx] = { ...b, result: event.result, denied: event.denied };
          } else {
            next.push({ kind: 'tool', id: nextId(), call: event.call, result: event.result });
          }
          break;
        }
        case 'approval_required': {
          if (last && last.kind === 'assistant') {
            next[next.length - 1] = { ...last, streaming: false };
          }
          next.push({
            kind: 'approval',
            id: nextId(),
            approvalId: event.approvalId,
            call: event.call,
            status: 'pending',
          });
          break;
        }
        case 'interrupted': {
          next.push({ kind: 'interrupted', id: nextId(), text: event.reason || 'Turn interrupted.' });
          break;
        }
        case 'error': {
          next.push({ kind: 'error', id: nextId(), text: event.message });
          break;
        }
        case 'widget': {
          const validated = validateWidget(event.widget);
          if (validated.ok) {
            next.push({ kind: 'widget', id: nextId(), widget: validated.widget });
          } else {
            next.push({
              kind: 'error',
              id: nextId(),
              text: `Widget failed validation: ${validated.error}`,
            });
          }
          break;
        }
      }
      return next;
    });
  }, []);

  const stopTurn = useCallback(() => {
    const c = abortRef.current;
    if (c) {
      c.abort();
      abortRef.current = null;
    }
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || !selectedBot) return;
    // A new message supersedes any in-flight turn on this session
    // (backend aborts the previous turn; we drop our old reader).
    stopTurn();
    const seq = ++turnSeq.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setInput('');
    setSending(true);
    const userBlock: ChatBlock = { kind: 'user', id: nextId(), text };
    const assistantBlock: ChatBlock = { kind: 'assistant', id: nextId(), text: '', streaming: true };
    setBlocks((prev) => [...prev, userBlock, assistantBlock]);
    const budget = parseFloat(maxBudgetRef.current);
    try {
      for await (const event of streamChat({
        botId: selectedBot.id,
        message: text,
        sessionId: sessionIdFor(selectedBot.id),
        provider: providerIdRef.current || undefined,
        model: modelIdRef.current || undefined,
        autoApprove: autoApproveRef.current,
        planMode: planModeRef.current,
        maxBudgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : undefined,
        signal: controller.signal,
      })) {
        if (turnSeq.current !== seq) break; // superseded by a newer turn
        applyEvent(event);
      }
    } catch (err) {
      if (turnSeq.current !== seq) return; // superseded; the new turn owns the UI
      const aborted = err instanceof DOMException && err.name === 'AbortError';
      setBlocks((prev) => [
        ...prev,
        aborted
          ? { kind: 'interrupted', id: nextId(), text: 'Stopped. Send a new message to continue.' }
          : { kind: 'error', id: nextId(), text: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      if (turnSeq.current === seq) {
        // Ensure no block is left in streaming state.
        setBlocks((prev) =>
          prev.map((b) => (b.kind === 'assistant' ? { ...b, streaming: false } : b)),
        );
        if (abortRef.current === controller) abortRef.current = null;
        setSending(false);
      }
    }
  };

  const decide = async (blockId: string, approvalId: string, decision: 'approved' | 'denied') => {
    setBlocks((prev) =>
      prev.map((b) => (b.kind === 'approval' && b.id === blockId ? { ...b, status: decision } : b)),
    );
    try {
      await decideApproval(approvalId, decision);
    } catch (err) {
      setBlocks((prev) => [
        ...prev,
        { kind: 'error', id: nextId(), text: err instanceof Error ? err.message : String(err) },
      ]);
    }
  };

  /** "Always allow <tool>": persist an allow rule, then approve the pending card. */
  const alwaysAllow = async (blockId: string, approvalId: string, toolName: string) => {
    const botId = botIdRef.current;
    if (!botId) return;
    setBlocks((prev) =>
      prev.map((b) => (b.kind === 'approval' && b.id === blockId ? { ...b, remembering: true } : b)),
    );
    try {
      await allowTool(botId, toolName);
      await decideApproval(approvalId, 'approved', `User chose "always allow ${toolName}"`);
      setBlocks((prev) =>
        prev.map((b) =>
          b.kind === 'approval' && b.id === blockId
            ? { ...b, status: 'approved', remembering: false }
            : b,
        ),
      );
    } catch (err) {
      setBlocks((prev) => [
        ...prev,
        { kind: 'error', id: nextId(), text: err instanceof Error ? err.message : String(err) },
      ]);
      setBlocks((prev) =>
        prev.map((b) => (b.kind === 'approval' && b.id === blockId ? { ...b, remembering: false } : b)),
      );
    }
  };

  /** POST a widget action button back to the API, then note the outcome in chat. */
  const handleWidgetAction = async (action: WidgetAction, widget: Widget) => {
    const endpoint = action.endpoint ?? '/api/widget-action';
    try {
      const res = await fetch(`${getApiBase()}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          actionId: action.id,
          widgetKind: widget.kind,
          payload: action.payload ?? {},
        }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          detail = ((await res.json()) as { error?: string }).error ?? '';
        } catch {
          // ignore
        }
        throw new Error(`API ${res.status}: ${detail || res.statusText}`);
      }
      setBlocks((prev) => [
        ...prev,
        { kind: 'assistant', id: nextId(), text: `✓ ${action.label}`, streaming: false },
      ]);
    } catch (err) {
      setBlocks((prev) => [
        ...prev,
        {
          kind: 'error',
          id: nextId(),
          text: `Action "${action.label}" failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    }
  };

  const newConversation = () => {
    if (!selectedBotId) return;
    stopTurn();
    turnSeq.current++;
    delete sessionIds.current[selectedBotId];
    setSessionUsage((prev) => {
      const next = { ...prev };
      delete next[selectedBotId];
      return next;
    });
    setSessionCost((prev) => {
      const next = { ...prev };
      delete next[selectedBotId];
      return next;
    });
    setBlocks([]);
  };

  // ---- slash commands ----
  const slashNames = Object.keys(slashCommands).sort();
  const slashQuery = input.startsWith('/') ? input.slice(1).split(/\s/)[0] ?? '' : null;
  const slashMatches =
    slashQuery !== null
      ? slashNames.filter((n) => n.startsWith(slashQuery.toLowerCase()))
      : [];
  const showSlashPop = slashQuery !== null && slashMatches.length > 0 && !sending;

  const pickSlash = (name: string) => {
    const qlen = slashQuery !== null ? slashQuery.length : 0;
    const rest = input.slice(1 + qlen);
    setInput(`/${name}${rest.startsWith(' ') ? '' : ' '}${rest.replace(/^\s+/, '')}`);
    setSlashHl(0);
    inputRef.current?.focus();
  };

  const refreshSlash = async () => {
    try {
      const sc = await getSlashCommands();
      setSlashCommands(sc.commands ?? {});
      setSlashError('');
    } catch (err) {
      setSlashError(err instanceof Error ? err.message : String(err));
    }
  };

  const saveSlash = async () => {
    const name = slashDraft.name.trim().toLowerCase();
    if (!/^[a-z0-9-]{1,32}$/.test(name)) {
      setSlashError('Name: 1–32 chars, lowercase letters, digits, hyphens.');
      return;
    }
    if (!slashDraft.prompt.trim()) {
      setSlashError('Prompt template is required. Use {args} for the typed arguments.');
      return;
    }
    try {
      const res = await saveSlashCommand(name, {
        description: slashDraft.description.trim(),
        prompt: slashDraft.prompt,
      });
      setSlashCommands(res.commands ?? {});
      setSlashDraft({ name: '', description: '', prompt: '' });
      setSlashError('');
    } catch (err) {
      setSlashError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeSlash = async (name: string) => {
    try {
      await deleteSlashCommand(name);
      await refreshSlash();
    } catch (err) {
      setSlashError(err instanceof Error ? err.message : String(err));
    }
  };

  const editSlash = (name: string) => {
    const c = slashCommands[name];
    if (!c) return;
    setSlashDraft({ name, description: c.description, prompt: c.prompt });
  };

  if (loadError) {
    return (
      <div>
        <h1 className="page-title">Chat</h1>
        <div className="error-box">
          Could not reach the API: {loadError}. Is it running? (see api: label in the top bar)
        </div>
      </div>
    );
  }

  const modelOptions = selectedProvider?.models ?? [];
  const activeModelId = modelId || selectedBot?.model || '';
  const contextLength = modelOptions.find((m) => m.id === activeModelId)?.contextLength;
  const botSessionUsage = selectedBotId ? sessionUsage[selectedBotId] : undefined;
  const botSessionCost = selectedBotId ? sessionCost[selectedBotId] : undefined;
  const sessionMeter = botSessionUsage ? contextMeter(botSessionUsage.totalTokens, contextLength) : null;

  return (
    <div className="chat-layout">
      <aside className="bot-roster">
        <h3>Bots</h3>
        {bots.map((b) => (
          <button
            key={b.id}
            className={`bot-item${b.id === selectedBotId ? ' selected' : ''}`}
            onClick={() => setSelectedBotId(b.id)}
          >
            <div className="bot-name">{b.name}</div>
            {b.description && <div className="bot-desc">{b.description}</div>}
          </button>
        ))}
        {bots.length === 0 && <div className="small muted">Loading bots…</div>}
      </aside>

      <div className="chat-main">
        <div className="chat-header">
          <select
            className="select"
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              setModelId('');
            }}
            aria-label="Provider"
            title="Provider (applies to the next message)"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.configured ? '' : ' (no key)'}
              </option>
            ))}
          </select>
          <select
            className="select"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            aria-label="Model"
            title="Model — switch mid-conversation, applies to the next message"
          >
            <option value="">(bot default)</option>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <div className="chat-modes">
            <ClayToggle
              checked={autoApprove}
              onChange={setAutoApprove}
              label="Auto-approve"
              title="Auto-approve this session: approval cards are skipped and tools run immediately (audited). Manual approval is the default."
            />
            <ClayToggle
              checked={planMode}
              onChange={setPlanMode}
              label="Plan mode"
              title="Plan mode: read-only exploration. File writes, shell commands and network calls are blocked."
            />
            <label className="budget-wrap" title="Fail-closed cap on estimated spend for one turn (USD).">
              Max $
              <input
                className="input"
                value={maxBudget}
                onChange={(e) => setMaxBudget(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="—"
                inputMode="decimal"
                aria-label="Max dollars per turn"
              />
            </label>
            <button className="btn btn-sm" onClick={() => setSlashMgrOpen(true)} title="Create and manage /commands">
              / Commands
            </button>
          </div>
          <div className="spacer" style={{ flex: 1 }} />
          {autoApprove && <span className="mode-badge auto">AUTO-APPROVE ON</span>}
          {planMode && <span className="mode-badge plan">PLAN MODE</span>}
          {botSessionUsage && (
            <div
              className="small muted mono"
              title={`Session tokens: ${botSessionUsage.promptTokens} in / ${botSessionUsage.completionTokens} out`}
            >
              Σ {formatTokens(botSessionUsage.totalTokens)}
              {botSessionCost !== undefined && (
                <span title={COST_ESTIMATE_TOOLTIP}> · ≈{formatUsd(botSessionCost)}</span>
              )}
              {sessionMeter && (
                <span className={sessionMeter.warn ? 'amber' : undefined}>
                  {' '}· ctx {formatTokens(sessionMeter.used)}/{formatTokens(sessionMeter.limit)} (
                  {Math.round(sessionMeter.pct)}%)
                </span>
              )}
            </div>
          )}
          <button className="btn btn-sm" onClick={newConversation} disabled={sending}>
            New conversation
          </button>
        </div>

        <div className="chat-messages" ref={messagesRef}>
          {blocks.length === 0 && (
            <div className="empty-state">
              <div className="empty-icon" aria-hidden="true">✨</div>
              <p>
                <strong>{selectedBot ? selectedBot.name : 'Select a bot'}</strong>
              </p>
              <p className="small">
                Send a message to start. Tool calls that need a human will pause here with an
                approval card — approve or deny inline and the agent continues.
              </p>
              <p className="small">
                Tip: type <span className="mono">/</span> to invoke a slash command, flip on{' '}
                <strong>Auto-approve</strong> for hands-free runs, or use <strong>Plan mode</strong>{' '}
                to explore without changing anything.
              </p>
            </div>
          )}
          {blocks.map((b) => {
            switch (b.kind) {
              case 'user':
                return (
                  <div key={b.id} className="msg user">
                    {b.text}
                  </div>
                );
              case 'assistant':
                return (
                  <div key={b.id} className="msg assistant">
                    {b.streaming && b.text.length === 0 ? (
                      <span className="typing-dots" aria-label="Thinking">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      <>
                        {b.text}
                        {b.streaming && <span className="stream-caret" aria-hidden="true" />}
                      </>
                    )}
                    {b.usage && (
                      <UsageFooter usage={b.usage} contextLength={contextLength} costUsd={b.costUsd} />
                    )}
                  </div>
                );
              case 'widget':
                return (
                  <WidgetRenderer
                    key={b.id}
                    widget={b.widget}
                    onAction={(a, w) => void handleWidgetAction(a, w)}
                  />
                );
              case 'tool':
                return (
                  <details key={b.id} className="tool-row">
                    <summary>
                      <span className={`chip${b.denied ? ' red' : b.result !== undefined ? ' green' : ' gray'}`}>
                        {b.denied ? 'denied' : b.result !== undefined ? 'done' : 'running'}
                      </span>
                      <span className="mono">{b.call.name}</span>
                    </summary>
                    <div className="tool-body">
                      <div className="label">Arguments</div>
                      <pre className="mono small">{prettyJson(b.call.args)}</pre>
                      {b.result !== undefined && (
                        <>
                          <div className="label mt">Result</div>
                          <pre className="mono small">{prettyJson(b.result)}</pre>
                        </>
                      )}
                    </div>
                  </details>
                );
              case 'approval':
                return (
                  <div key={b.id} className="approval-card">
                    <h4>Approval required — <span className="mono">{b.call.name}</span></h4>
                    <pre>{prettyJson(b.call.args)}</pre>
                    {b.status === 'pending' ? (
                      <div className="approval-actions">
                        <button className="btn btn-primary btn-sm" disabled={b.remembering} onClick={() => decide(b.id, b.approvalId, 'approved')}>
                          Approve
                        </button>
                        <button className="btn btn-danger btn-sm" disabled={b.remembering} onClick={() => decide(b.id, b.approvalId, 'denied')}>
                          Deny
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={b.remembering}
                          onClick={() => void alwaysAllow(b.id, b.approvalId, b.call.name)}
                          title={`Never ask for ${b.call.name} again on this bot — saves a persistent allow rule, then approves this call.`}
                        >
                          {b.remembering ? 'Saving…' : `Always allow ${b.call.name}`}
                        </button>
                      </div>
                    ) : (
                      <div className="small muted mt">
                        {b.status === 'approved' ? 'Approved — the agent continues.' : 'Denied.'}
                      </div>
                    )}
                  </div>
                );
              case 'interrupted':
                return (
                  <div key={b.id} className="msg interrupted">
                    ⏹ {b.text}
                  </div>
                );
              case 'error':
                return (
                  <div key={b.id} className="msg error">
                    {b.text}
                  </div>
                );
            }
          })}
        </div>

        <div className="chat-input-wrap">
          {showSlashPop && (
            <div className="slash-pop" role="listbox" aria-label="Slash commands">
              {slashMatches.map((name, i) => (
                <button
                  key={name}
                  role="option"
                  aria-selected={i === slashHl}
                  className={`slash-opt${i === slashHl ? ' hl' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSlash(name);
                  }}
                  onMouseEnter={() => setSlashHl(i)}
                >
                  <span className="cmd">/{name}</span>
                  <span className="desc">{slashCommands[name]?.description || '—'}</span>
                </button>
              ))}
            </div>
          )}
          <div className="chat-input">
            <input
              ref={inputRef}
              className="input"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setSlashHl(0);
              }}
              onKeyDown={(e) => {
                if (showSlashPop && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault();
                  setSlashHl((h) =>
                    e.key === 'ArrowDown'
                      ? (h + 1) % slashMatches.length
                      : (h - 1 + slashMatches.length) % slashMatches.length,
                  );
                  return;
                }
                if (showSlashPop && e.key === 'Tab') {
                  e.preventDefault();
                  pickSlash(slashMatches[slashHl] ?? slashMatches[0] ?? '');
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={selectedBot ? `Message ${selectedBot.name}…  ( / for commands )` : 'Select a bot first…'}
              disabled={!selectedBot}
              aria-label="Chat message"
            />
            {sending ? (
              <button className="btn btn-stop" onClick={stopTurn} title="Stop the running turn">
                ⏹ Stop
              </button>
            ) : (
              <button className="btn btn-primary" onClick={() => void send()} disabled={!input.trim()}>
                Send
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Slash command manager */}
      {slashMgrOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
            background: 'rgba(10,10,15,0.45)',
          }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSlashMgrOpen(false);
          }}
        >
          <div className="card" style={{ width: 560, maxWidth: '100%', maxHeight: '86vh', overflowY: 'auto' }} role="dialog" aria-label="Slash commands">
            <div className="row-between">
              <h3 style={{ margin: 0 }}>Slash commands</h3>
              <button className="icon-btn" aria-label="Close" onClick={() => setSlashMgrOpen(false)}>✕</button>
            </div>
            <p className="small muted">
              Type <span className="mono">/name args</span> in chat to run one. Use{' '}
              <span className="mono">{'{args}'}</span> in the prompt for the typed arguments.
            </p>
            {slashError && <div className="error-box">{slashError}</div>}
            <div className="slash-list">
              {slashNames.length === 0 && <p className="small muted">No commands yet — create the first below.</p>}
              {slashNames.map((name) => (
                <div key={name} className="card slash-item" style={{ padding: '12px 14px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span className="cmd">/{name}</span>
                    <div className="small muted truncate">{slashCommands[name]?.description || '—'}</div>
                  </div>
                  <button className="btn btn-sm" onClick={() => editSlash(name)}>Edit</button>
                  <button className="btn btn-sm btn-danger" onClick={() => void removeSlash(name)}>Delete</button>
                </div>
              ))}
            </div>
            <h4 className="mt">{slashDraft.name && slashCommands[slashDraft.name] ? 'Edit command' : 'New command'}</h4>
            <div className="field">
              <label className="label" htmlFor="slash-name">Name</label>
              <input
                id="slash-name"
                className="input"
                value={slashDraft.name}
                onChange={(e) => setSlashDraft((d) => ({ ...d, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }))}
                placeholder="work"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="slash-desc">Description</label>
              <input
                id="slash-desc"
                className="input"
                value={slashDraft.description}
                onChange={(e) => setSlashDraft((d) => ({ ...d, description: e.target.value }))}
                placeholder="Implement the feature end-to-end"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="slash-prompt">Prompt template (use {'{args}'})</label>
              <textarea
                id="slash-prompt"
                className="textarea"
                rows={5}
                value={slashDraft.prompt}
                onChange={(e) => setSlashDraft((d) => ({ ...d, prompt: e.target.value }))}
                placeholder="Implement this feature completely: {args}. Write the code, add tests, and summarize."
              />
            </div>
            <div className="approval-actions">
              <button className="btn btn-primary btn-sm" onClick={() => void saveSlash()}>Save command</button>
              <button className="btn btn-sm" onClick={() => { setSlashDraft({ name: '', description: '', prompt: '' }); setSlashError(''); }}>Clear</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
