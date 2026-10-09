// SPDX-License-Identifier: Apache-2.0
'use client';

import { useCallback, useEffect, useState } from 'react';
import { getBots, getPersonas, setBotPersona, setBotWorkspace, updateBotPolicy } from '../../lib/api';
import type { BotConfig, BotPolicyEffect, BotPolicyRule, PersonaInfo } from '../../lib/api';

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

export default function BotsPage() {  const [bots, setBots] = useState<BotConfig[]>([]);
  const [selectedBotId, setSelectedBotId] = useState('');
  const [error, setError] = useState('');

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
              <PersonaPicker key={`persona-${selectedBot.id}`} bot={selectedBot} onSaved={onPersonaSaved} />
              <WorkspacePicker key={`workspace-${selectedBot.id}`} bot={selectedBot} onSaved={onWorkspaceSaved} />
              <RulesEditor key={selectedBot.id} bot={selectedBot} onSaved={onSaved} />
            </>
          ) : (
            <p className="muted">Select a bot to edit its policy.</p>
          )}
        </div>
      </div>
    </div>
  );
}
