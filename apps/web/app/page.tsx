// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  decideApproval,
  getBots,
  getProviders,
  streamChat,
} from '../lib/api';
import type { BotConfig, ProviderInfo, StreamEvent, TokenUsage, ToolCall } from '../lib/api';
import { contextMeter, formatTokens } from '../lib/usage';

type ChatBlock =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean; usage?: TokenUsage }
  | { kind: 'tool'; id: string; call: ToolCall; result?: unknown; denied?: boolean }
  | {
      kind: 'approval';
      id: string;
      approvalId: string;
      call: ToolCall;
      status: 'pending' | 'approved' | 'denied';
    }
  | { kind: 'error'; id: string; text: string };

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

/** Subtle per-turn footer under an assistant message: tokens + context meter. */
function UsageFooter({ usage, contextLength }: { usage: TokenUsage; contextLength?: number }) {
  const meter = contextMeter(usage.totalTokens, contextLength);
  return (
    <div className="small muted mono usage-line">
      ↑ {formatTokens(usage.promptTokens)} in · ↓ {formatTokens(usage.completionTokens)} out · Σ{' '}
      {formatTokens(usage.totalTokens)}
      {meter && (
        <span className={meter.warn ? 'amber' : undefined}>
          {' '}· ctx {formatTokens(meter.used)}/{formatTokens(meter.limit)} ({Math.round(meter.pct)}%)
        </span>
      )}
    </div>
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
  // Per-bot accumulated token usage for the current session (reset on New conversation).
  const [sessionUsage, setSessionUsage] = useState<Record<string, TokenUsage>>({});
  const sessionIds = useRef<Record<string, string>>({});
  const messagesRef = useRef<HTMLDivElement>(null);
  // Current bot id for the done-handler (applyEvent is a stable callback).
  const botIdRef = useRef(selectedBotId);
  botIdRef.current = selectedBotId;

  const selectedBot = bots.find((b) => b.id === selectedBotId);
  const selectedProvider = providers.find((p) => p.id === providerId);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [b, p] = await Promise.all([getBots(), getProviders()]);
        if (cancelled) return;
        setBots(b);
        setProviders(p);
        if (b.length > 0) setSelectedBotId(b[0].id);
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    // 'done' carries the turn's token usage. Handle it outside setBlocks so
    // the session accumulation (a side effect) can't double-fire under
    // StrictMode's double-invoked updaters.
    if (event.type === 'done') {
      const bid = botIdRef.current;
      const usage = event.usage;
      if (usage && bid) {
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
      }
      setBlocks((prev) => {
        const next = [...prev];
        // Attach the turn usage to the last assistant block of this turn.
        for (let i = next.length - 1; i >= 0; i--) {
          const b = next[i];
          if (b && b.kind === 'assistant') {
            next[i] = { ...b, streaming: false, usage: event.usage ?? undefined };
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
          // Close any open assistant block, then add the tool row.
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
        case 'error': {
          next.push({ kind: 'error', id: nextId(), text: event.message });
          break;
        }
      }
      return next;
    });
  }, []);

  const send = async () => {
    const text = input.trim();
    if (!text || sending || !selectedBot) return;
    setInput('');
    setSending(true);
    const userBlock: ChatBlock = { kind: 'user', id: nextId(), text };
    const assistantBlock: ChatBlock = { kind: 'assistant', id: nextId(), text: '', streaming: true };
    setBlocks((prev) => [...prev, userBlock, assistantBlock]);
    try {
      for await (const event of streamChat({
        botId: selectedBot.id,
        message: text,
        sessionId: sessionIdFor(selectedBot.id),
        provider: providerId || undefined,
        model: modelId || undefined,
      })) {
        applyEvent(event);
      }
    } catch (err) {
      setBlocks((prev) => [
        ...prev,
        { kind: 'error', id: nextId(), text: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      // Ensure no block is left in streaming state.
      setBlocks((prev) =>
        prev.map((b) => (b.kind === 'assistant' ? { ...b, streaming: false } : b)),
      );
      setSending(false);
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

  const newConversation = () => {
    if (!selectedBotId) return;
    delete sessionIds.current[selectedBotId];
    setSessionUsage((prev) => {
      const next = { ...prev };
      delete next[selectedBotId];
      return next;
    });
    setBlocks([]);
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

  // Context window of the active model (explicit pick, else the bot's default).
  const activeModelId = modelId || selectedBot?.model || '';
  const contextLength = modelOptions.find((m) => m.id === activeModelId)?.contextLength;
  // Per-session totals for the header meter.
  const botSessionUsage = selectedBotId ? sessionUsage[selectedBotId] : undefined;
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
          >
            <option value="">(bot default)</option>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <div className="spacer" style={{ flex: 1 }} />
          {botSessionUsage && (
            <div
              className="small muted mono"
              title={`Session tokens: ${botSessionUsage.promptTokens} in / ${botSessionUsage.completionTokens} out`}
            >
              Σ {formatTokens(botSessionUsage.totalTokens)}
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
              <p>
                <strong>{selectedBot ? selectedBot.name : 'Select a bot'}</strong>
              </p>
              <p className="small">
                Send a message to start. Tool calls that need a human will pause here with an
                approval card — approve or deny inline and the agent continues.
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
                    {b.text}
                    {b.streaming && <span className="typing"> ▍</span>}
                    {b.usage && <UsageFooter usage={b.usage} contextLength={contextLength} />}
                  </div>
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
                        <button className="btn btn-primary btn-sm" onClick={() => decide(b.id, b.approvalId, 'approved')}>
                          Approve
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => decide(b.id, b.approvalId, 'denied')}>
                          Deny
                        </button>
                      </div>
                    ) : (
                      <div className="small muted mt">
                        {b.status === 'approved' ? 'Approved — the agent continues.' : 'Denied.'}
                      </div>
                    )}
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

        <div className="chat-input">
          <input
            className="input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={selectedBot ? `Message ${selectedBot.name}…` : 'Select a bot first…'}
            disabled={sending || !selectedBot}
          />
          <button className="btn btn-primary" onClick={() => void send()} disabled={sending || !input.trim()}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
