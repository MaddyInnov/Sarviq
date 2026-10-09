// SPDX-License-Identifier: Apache-2.0
// Live voice-call panel: push-to-talk conversation with a bot.
//
// Loop: mic in (MediaRecorder) → STT (the @mvp/voice STTProvider interface)
// → `respond(transcript)` (the bot brain) → TTS (the @mvp/voice TTSProvider
// interface) → playback, with a live transcript of every turn.
//
// Mock-first: the default web providers (lib/voice-http.ts) hit the API's
// /api/voice/* routes, which are mock-backed — zero paid usage, no audio
// leaves the demo path. Swap `respond` to wire a real brain.

'use client';

import React from 'react';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { STTProvider, TTSProvider } from '@mvp/voice';
import { useI18n } from '../../lib/i18n';
import { bytesToBase64 } from '../../lib/voice-http';
import {
  browserCaptureDeps,
  startCapture,
  type CaptureDeps,
  type CapturedAudio,
} from '../../lib/voice-notes';
import { runCallTurn, type CallPhase, type CallTurn } from '../../lib/voice-call';

export interface CallPanelProps {
  stt: STTProvider;
  tts: TTSProvider;
  /** The bot brain: transcript → reply text. */
  respond: (transcript: string) => Promise<string> | string;
  botName?: string;
  language?: string;
  /** Injectable browser deps (tests). Defaults to the real browser. */
  deps?: CaptureDeps;
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Play synthesized audio bytes; resolves when playback ends. */
function playAudio(audio: Uint8Array, mimeType: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([audio as BlobPart], { type: mimeType }));
    const el = new Audio(url);
    el.onended = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('call: audio playback failed'));
    };
    el.play().catch(reject);
  });
}

export default function CallPanel({ stt, tts, respond, botName, language, deps }: CallPanelProps) {
  const { t } = useI18n();
  const [inCall, setInCall] = useState(false);
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [turns, setTurns] = useState<CallTurn[]>([]);
  const [error, setError] = useState<string | null>(null);
  const captureRef = useRef<{ stop: () => Promise<CapturedAudio> } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const inCallRef = useRef(false);
  inCallRef.current = inCall;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const cap = captureRef.current;
      captureRef.current = null;
      if (cap) void cap.stop().catch(() => {});
      audioRef.current?.pause();
    };
  }, []);

  // Auto-scroll the transcript on new turns / phase changes.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, phase]);

  const startCall = useCallback(() => {
    setError(null);
    setTurns([]);
    setPhase('idle');
    setInCall(true);
  }, []);

  const endCall = useCallback(() => {
    const cap = captureRef.current;
    captureRef.current = null;
    if (cap) void cap.stop().catch(() => {});
    audioRef.current?.pause();
    audioRef.current = null;
    setPhase('idle');
    setInCall(false);
  }, []);

  const tapToTalk = useCallback(async () => {
    if (!inCallRef.current || phase === 'thinking' || phase === 'speaking') return;
    if (phase === 'listening') {
      // Stop capture → run the full turn.
      const cap = captureRef.current;
      captureRef.current = null;
      if (!cap) {
        setPhase('idle');
        return;
      }
      setPhase('thinking');
      setError(null);
      try {
        const captured = await cap.stop();
        const bytes = new Uint8Array(await captured.blob.arrayBuffer());
        const turn = await runCallTurn({
          stt,
          tts,
          audio: bytes,
          respond,
          language,
          sttOpts: { mimeType: captured.mimeType },
        });
        if (!mountedRef.current || !inCallRef.current) return;
        setTurns((prev) => [...prev, turn]);
        setPhase('speaking');
        try {
          await playAudio(turn.replyAudio.audio, turn.replyAudio.mimeType);
        } finally {
          if (mountedRef.current && inCallRef.current) setPhase('idle');
        }
      } catch (err) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
      return;
    }
    // Start listening.
    try {
      const cap = await startCapture(deps ?? browserCaptureDeps());
      if (!mountedRef.current || !inCallRef.current) {
        await cap.stop().catch(() => {});
        return;
      }
      captureRef.current = cap;
      setError(null);
      setPhase('listening');
    } catch {
      setError(t('voice.micDenied'));
      setPhase('error');
    }
  }, [phase, stt, tts, respond, language, deps, t]);

  const phaseLabel =
    phase === 'listening'
      ? t('call.listening')
      : phase === 'thinking'
        ? t('call.thinking')
        : phase === 'speaking'
          ? t('call.speaking')
          : null;

  return (
    <div className="call-panel card" role="region" aria-label={t('call.title')}>
      <div className="row-between">
        <h3 style={{ margin: 0 }}>
          📞 {t('call.title')}
          {botName ? <span className="small muted"> · {botName}</span> : null}
        </h3>
        {inCall ? (
          <button type="button" className="btn btn-danger btn-sm" onClick={endCall}>
            {t('call.end')}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={startCall}>
            {t('call.start')}
          </button>
        )}
      </div>

      {!inCall && (
        <p className="small muted" style={{ marginTop: 8 }}>
          {t('call.idleHint')}
        </p>
      )}

      {inCall && (
        <>
          <div className="call-status" aria-live="polite">
            <span className={`call-dot phase-${phase}`} aria-hidden="true" />
            <strong>{phaseLabel ?? t('call.tapToTalk')}</strong>
          </div>

          <div className="call-controls">
            <button
              type="button"
              className={`btn ${phase === 'listening' ? 'btn-danger' : 'btn-primary'} mic-big${phase === 'listening' ? ' recording' : ''}`}
              onClick={() => void tapToTalk()}
              disabled={phase === 'thinking' || phase === 'speaking'}
              aria-pressed={phase === 'listening'}
            >
              {phase === 'listening' ? t('call.stopAndSend') : t('call.tapToTalk')}
            </button>
          </div>

          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}

          <div className="call-transcript" ref={transcriptRef} aria-label={t('voice.transcript')}>
            {turns.length === 0 && <p className="small muted">{t('call.empty')}</p>}
            {turns.map((turn) => (
              <div key={turn.id} className="call-turn">
                <div className="call-line you">
                  <span className="call-speaker">{t('call.you')}</span>
                  <span className="call-text">{turn.transcript}</span>
                  <span className="call-time small muted">{fmtTime(turn.at)}</span>
                </div>
                <div className="call-line bot">
                  <span className="call-speaker">{botName ?? t('call.bot')}</span>
                  <span className="call-text">{turn.replyText}</span>
                </div>
              </div>
            ))}
            {phase === 'thinking' && (
              <div className="call-line bot">
                <span className="typing-dots" aria-label={t('call.thinking')}>
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
