// SPDX-License-Identifier: Apache-2.0
'use client';

// Code rendering components: syntax-highlighted code blocks, line diffs,
// and unified-diff views. Styled with the theme's CSS variables
// (claymorphism + glassmorphism design system).

import React, { useMemo } from 'react';
import { langFromPath, lineDiff, parseUnifiedDiff, tokenize, type Token } from './highlight';

const TOKEN_CLASS: Record<Token['t'], string> = {
  keyword: 'tk-kw',
  string: 'tk-str',
  comment: 'tk-com',
  number: 'tk-num',
  punct: 'tk-punct',
  fn: 'tk-fn',
  plain: '',
};

function renderTokens(tokens: Token[]): React.ReactNode[] {
  return tokens.map((tok, i) =>
    tok.t === 'plain' ? (
      <React.Fragment key={i}>{tok.v}</React.Fragment>
    ) : (
      <span key={i} className={TOKEN_CLASS[tok.t]}>
        {tok.v}
      </span>
    ),
  );
}

export function CodeBlock({
  code,
  lang,
  path,
  maxHeight,
}: {
  code: string;
  lang?: string;
  path?: string;
  maxHeight?: number;
}) {
  const language = lang ?? (path ? langFromPath(path) : 'plain');
  const nodes = useMemo(() => renderTokens(tokenize(code, language)), [code, language]);
  return (
    <div className="code-block">
      {path && (
        <div className="code-block-head">
          <span className="mono small">{path}</span>
          <span className="code-lang">{language}</span>
        </div>
      )}
      <pre className="code-pre" style={maxHeight ? { maxHeight } : undefined}>
        <code>{nodes}</code>
      </pre>
    </div>
  );
}

/** Side-by-side-ish line diff: old lines red (-), new lines green (+). */
export function LineDiffView({
  oldText,
  newText,
  path,
}: {
  oldText: string;
  newText: string;
  path?: string;
}) {
  const language = path ? langFromPath(path) : 'plain';
  const lines = useMemo(() => lineDiff(oldText, newText), [oldText, newText]);
  return (
    <div className="code-block">
      {path && (
        <div className="code-block-head">
          <span className="mono small">{path}</span>
          <span className="code-lang diff-badge">diff</span>
        </div>
      )}
      <pre className="code-pre diff-pre">
        <code>
          {lines.map((l, i) => (
            <div key={i} className={`diff-line diff-${l.kind}`}>
              <span className="diff-gutter">{l.kind === 'del' ? '−' : l.kind === 'add' ? '+' : ' '}</span>
              <span className="diff-text">{renderTokens(tokenize(l.text || ' ', language))}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

/** Render a unified diff (for `patch` tool calls). */
export function UnifiedDiffView({ diff }: { diff: string }) {
  const lines = useMemo(() => parseUnifiedDiff(diff), [diff]);
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="mono small">patch</span>
        <span className="code-lang diff-badge">unified diff</span>
      </div>
      <pre className="code-pre diff-pre">
        <code>
          {lines.map((l, i) => (
            <div key={i} className={`diff-line diff-${l.kind === 'ctx' ? 'same' : l.kind}`}>
              <span className="diff-gutter">
                {l.kind === 'del' ? '−' : l.kind === 'add' ? '+' : l.kind === 'hunk' ? '§' : ' '}
              </span>
              <span className="diff-text">{l.text || ' '}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
