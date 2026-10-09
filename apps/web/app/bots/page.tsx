// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useState } from 'react';
import { getBots, getPersonas, getRedteamReports, runRedteamSuite, setBotPersona, setBotWorkspace, updateBotPolicy } from '../../lib/api';
import type { BotConfig, BotPolicyEffect, BotPolicyRule, PersonaInfo, RedteamReport } from '../../lib/api';
import { useUxMode } from '../../lib/ux-mode';

const EFFECTS: BotPolicyEffect[] = ['allow', 'deny', 'require-approval'];

function newRule(): BotPolicyRule {
  return {
    id: `rule-${Date.now().toString(36)}`,
    toolPattern: '^run_command$',
    effect: 'require-approval',
    reason: '',
  };
}

function validPattern(pattern: string): boolean {
  try {
    new RegExp(pattern, 'i');
    return true;
  } catch {
    return false;
  }
}

function RulesEditor({
  bot,
  onSaved,
}: {
  bot: BotConfig;
  onSaved: (botId: string, rules: BotPolicyRule[]) => void;
}) {
  const [rules, setRules] = useState<BotPolicyRule[]>(() => bot.policy?.rules ?? []);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');

  // Reset the editor when switching bots.
  useEffect(() => {
    setRules(bot.policy?.rules ?? []);
    setError('');
    setSavedAt('');
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const setRule = (idx: number, patch: Partial<BotPolicyRule>) => {
    setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const save = async () => {
    setError('');
    const ids = new Set<string>();
    for (const r of rules) {
      if (!r.id.trim()) {
        setError('Every rule needs an id.');
        return;
      }
      if (ids.has(r.id.trim())) {
        setError(`Duplicate rule id "${r.id.trim()}".`);
        return;
      }
      ids.add(r.id.trim());
      if (!validPattern(r.toolPattern)) {
        setError(`Rule "${r.id}": "${r.toolPattern}" is not a valid regular expression.`);
        return;
      }
    }
    const payload = rules.map((r) => ({
      id: r.id.trim(),
      toolPattern: r.toolPattern,
      effect: r.effect,
      ...(r.reason?.trim() ? { reason: r.reason.trim() } : {}),
    }));
    setSaving(true);
    try {
      const res = await updateBotPolicy(bot.id, payload);
      setSavedAt(new Date().toLocaleTimeString());
      onSaved(bot.id, res.policy.rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="row-between">
        <strong>Policy rules — {bot.name}</strong>
        <span className="small muted mono">{bot.id}</span>
      </div>
      <p className="small muted">
        Bot rules are checked <strong>before</strong> the global policy (first match wins). A bot
        rule can tighten the global floor (deny something the global policy allows) or loosen it
        (allow something the global policy gates). No rules → the global policy applies unchanged.
      </p>
      {rules.length === 0 && (
        <p className="small muted">No per-bot rules — the global policy applies.</p>
      )}
      {rules.map((r, i) => (
        <div key={i} className="grid-2" style={{ marginBottom: 8 }}>
          <div className="field">
            <label className="label">Rule id</label>
            <input
              className="input mono"
              value={r.id}
              onChange={(e) => setRule(i, { id: e.target.value })}
              placeholder="allow-fetch"
            />
          </div>
          <div className="field">
            <label className="label">Effect</label>
            <select
              className="select"
              value={r.effect}
              onChange={(e) => setRule(i, { effect: e.target.value as BotPolicyEffect })}
            >
              {EFFECTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label">Tool pattern (regex, case-insensitive)</label>
            <input
              className="input mono"
              style={validPattern(r.toolPattern) ? undefined : { borderColor: '#ef4444' }}
              value={r.toolPattern}
              onChange={(e) => setRule(i, { toolPattern: e.target.value })}
              placeholder="^mcp:fetch:"
              title="Matched against the tool name; first matching rule wins"
            />
          </div>
          <div className="field">
            <label className="label">Reason (optional)</label>
            <input
              className="input"
              value={r.reason ?? ''}
              onChange={(e) => setRule(i, { reason: e.target.value })}
              placeholder="Why this rule exists"
            />
          </div>
          <div>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn btn-sm" onClick={() => setRules((prev) => [...prev, newRule()])}>
          Add rule
        </button>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save policy'}
        </button>
        {savedAt && <span className="small muted">Saved at {savedAt}.</span>}
      </div>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function PersonaPicker({
  bot,
  onSaved,
}: {
  bot: BotConfig;
  onSaved: (botId: string, persona: string | null) => void;
}) {
  const [personas, setPersonas] = useState<PersonaInfo[]>([]);
  const [selected, setSelected] = useState<string>(bot.persona ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSelected(bot.persona ?? '');
    setError('');
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    getPersonas().then((r) => setPersonas(r.personas)).catch(() => undefined);
  }, []);

  const active = personas.find((p) => p.type === selected);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await setBotPersona(bot.id, selected || null);
      onSaved(bot.id, res.persona);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Personality</h3>
      <p className="small muted">
        Give this bot an MBTI persona. It shapes tone and working style — the bot&apos;s own
        instructions always come first.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select
          className="select"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="MBTI persona"
        >
          <option value="">No persona</option>
          {personas.map((p) => (
            <option key={p.type} value={p.type}>
              {p.type} — {p.name}
            </option>
          ))}
        </select>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save persona'}
        </button>
      </div>
      {active && (
        <p className="small muted" style={{ marginTop: 8 }}>
          <strong>{active.name}:</strong> {active.traits.join(' · ')} — {active.communicationStyle}
        </p>
      )}
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function WorkspacePicker({
  bot,
  onSaved,
}: {
  bot: BotConfig;
  onSaved: (botId: string, workspace: string | null) => void;
}) {
  const [value, setValue] = useState<string>(bot.workspace ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setValue(bot.workspace ?? '');
    setError('');
  }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await setBotWorkspace(bot.id, value.trim() || null);
      onSaved(bot.id, res.workspace);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ marginTop: 0 }}>Workspace</h3>
      <p className="small muted">
        Give this bot its own workspace directory (Octop-style isolation) so two bots
        working at once don&apos;t collide on files. Leave empty for the shared
        workspace. Relative names resolve under the server data dir
        (e.g. <code>coder</code>).
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="default (shared)"
          aria-label="Bot workspace"
          style={{ minWidth: 220 }}
        />
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Save workspace'}
        </button>
      </div>
      {error && <div className="error-box" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

function RobustnessPanel({ bot }: { bot: BotConfig }) {
  const [reports, setReports] = useState<RedteamReport[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [openAttack, setOpenAttack] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await getRedteamReports(bot.id);
      setReports(r.reports);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [bot.id]);

  useEffect(() => {
    setReports([]);
    setOpenAttack(null);
    void refresh();
  }, [refresh]);

  const run = async () => {
    setRunning(true);
    setError('');
    try {
      await runRedteamSuite(bot.id, 'core');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const latest = reports.length > 0 ? reports[reports.length - 1] : null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row-between">
        <h3 style={{ margin: 0 }}>Robustness</h3>
        <button className="btn btn-primary btn-sm" disabled={running} onClick={() => void run()}>
          {running ? 'Running suite…' : 'Run robustness suite'}
        </button>
      </div>
      <p className="small muted">
        Defensive red-team suite for this bot&apos;s own defenses: direct/indirect injection,
        prompt extraction, persona hijack, obfuscation, multi-turn manipulation, and
        tool-abuse probes against the catastrophic-command hard floors. Score = % of
        attacks blocked. Internal testing harness — not a user-facing feature.
      </p>
      {error && <div className="error-box">{error}</div>}
      {reports.length === 0 && !error && (
        <p className="small muted">{running ? 'Suite running…' : 'No runs yet — run the suite to get a baseline.'}</p>
      )}
      {reports.length > 0 && (
        <>
          <h4 style={{ margin: '12px 0 8px' }}>Score history</h4>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[...reports].reverse().map((r) => (
              <span
                key={r.reportId}
                className="mono small"
                title={`${r.blocked}/${r.total} blocked · ${new Date(r.ts).toLocaleString()}`}
                style={{
                  padding: '4px 10px',
                  borderRadius: 999,
                  border: '1px solid var(--border, #e5e7eb)',
                  background: r.score >= 80 ? '#ecfdf5' : r.score >= 50 ? '#fffbeb' : '#fef2f2',
                  color: r.score >= 80 ? '#065f46' : r.score >= 50 ? '#92400e' : '#991b1b',
                }}
              >
                {r.score} · {new Date(r.ts).toLocaleDateString()}
              </span>
            ))}
          </div>
        </>
      )}
      {latest && (
        <>
          <h4 style={{ margin: '16px 0 8px' }}>
            Last run — {latest.blocked}/{latest.total} blocked (score {latest.score})
            <span className="small muted" style={{ marginLeft: 8 }}>
              {new Date(latest.ts).toLocaleString()} · suite {latest.suite}
            </span>
          </h4>
          <div>
            {latest.results.map((r) => (
              <div key={r.attackId} style={{ marginBottom: 6 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span
                    className="mono small"
                    style={{
                      padding: '2px 8px',
                      borderRadius: 4,
                      background: r.verdict === 'blocked' ? '#ecfdf5' : '#fef2f2',
                      color: r.verdict === 'blocked' ? '#065f46' : '#991b1b',
                      fontWeight: 600,
                    }}
                  >
                    {r.verdict === 'blocked' ? 'PASS' : 'FAIL'}
                  </span>
                  <button
                    className="btn btn-sm"
                    style={{ padding: '2px 8px' }}
                    onClick={() => setOpenAttack((cur) => (cur === r.attackId ? null : r.attackId))}
                    aria-expanded={openAttack === r.attackId}
                  >
                    {r.name}
                  </button>
                  <span className="small muted mono">{r.attackId} · {r.category}</span>
                </div>
                {openAttack === r.attackId && (
                  <div
                    className="small"
                    style={{
                      marginTop: 6,
                      padding: 10,
                      border: '1px solid var(--border, #e5e7eb)',
                      borderRadius: 8,
                      background: 'var(--surface, #fafafa)',
                    }}
                  >
                    {r.matchedSignals.length > 0 && (
                      <p className="mono" style={{ margin: '0 0 8px' }}>
                        signals: {r.matchedSignals.join(', ')}
                      </p>
                    )}
                    {r.verdict === 'succeeded' && r.hardeningNote && (
                      <p style={{ margin: '0 0 8px' }}>
                        <strong>Hardening:</strong> {r.hardeningNote}
                      </p>
                    )}
                    {r.transcript.map((t, i) => (
                      <div key={i} style={{ marginBottom: 8 }}>
                        <div className="mono muted" style={{ fontSize: 11 }}>
                          {t.role === 'attacker' ? '▶ attack' : '● bot'}
                          {t.toolCalls && t.toolCalls.length > 0 && (
                            <span>
                              {' '}
                              · tools:{' '}
                              {t.toolCalls.map((c) => `${c.name}(${c.outcome})`).join(', ')}
                            </span>
                          )}
                        </div>
                        <div className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
                          {t.text.length > 600 ? `${t.text.slice(0, 600)}…` : t.text}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function BotsPage() {  const [bots, setBots] = useState<BotConfig[]>([]);
  const [selectedBotId, setSelectedBotId] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'policy' | 'robustness'>('policy');
  const [mode] = useUxMode();
  const tabs = [
    { id: 'policy' as const, label: 'Policy' },
    // Pro surface: hidden in Simple mode.
    ...(mode === 'pro' ? [{ id: 'robustness' as const, label: 'Robustness' }] : []),
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'policy';

  const refresh = useCallback(async () => {
    try {
      const b = await getBots();
      setBots(b);
      setError('');
      if (b.length > 0) setSelectedBotId((cur) => cur || b[0].id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSaved = (botId: string, rules: BotPolicyRule[]) => {
    setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, policy: { rules } } : b)));
  };

  const onPersonaSaved = (botId: string, persona: string | null) => {
    setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, persona } : b)));
  };

  const onWorkspaceSaved = (botId: string, workspace: string | null) => {
    setBots((prev) => prev.map((b) => (b.id === botId ? { ...b, workspace: workspace ?? undefined } : b)));
  };

  const selectedBot = bots.find((b) => b.id === selectedBotId);

  return (
    <div>
      <h1 className="page-title">Bots</h1>
      <p className="page-sub">
        Per-bot governance policies. Tool calls are evaluated against the bot&apos;s rules first,
        then the global policy.
      </p>
      {error && <div className="error-box">{error}</div>}
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
              <div className="bot-desc">
                {b.policy?.rules.length
                  ? `${b.policy.rules.length} custom rule${b.policy.rules.length === 1 ? '' : 's'}`
                  : 'global policy'}
              </div>
            </button>
          ))}
          {bots.length === 0 && !error && <div className="small muted">Loading bots…</div>}
        </aside>
        <div className="chat-main">
          {selectedBot ? (
            <>
              <div className="tabs" role="tablist" aria-label="Bot sections" style={{ marginBottom: 12 }}>
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={activeTab === t.id}
                    className={`tab${activeTab === t.id ? ' active' : ''}`}
                    onClick={() => setTab(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {activeTab === 'policy' ? (
                <>
                  <PersonaPicker key={`persona-${selectedBot.id}`} bot={selectedBot} onSaved={onPersonaSaved} />
                  <WorkspacePicker key={`workspace-${selectedBot.id}`} bot={selectedBot} onSaved={onWorkspaceSaved} />
                  <RulesEditor key={selectedBot.id} bot={selectedBot} onSaved={onSaved} />
                </>
              ) : (
                <RobustnessPanel key={`robustness-${selectedBot.id}`} bot={selectedBot} />
              )}
            </>
          ) : (
            <p className="muted">Select a bot to edit its policy.</p>
          )}
        </div>
      </div>
    </div>
  );
}
