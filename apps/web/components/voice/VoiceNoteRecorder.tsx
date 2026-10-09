// SPDX-License-Identifier: Apache-2.0
// Voice-note recorder: the mic button on the chat composer.
//
// Toggle to start/stop a MediaRecorder capture; on stop the audio is
// transcribed through the injected STTProvider (the @mvp/voice interface —
// mock-backed in dev) and the finished note is handed to `onVoiceNote`.
// Browser globals are injectable via `deps` for unit tests.

'use client';

import React from 'react';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { STTProvider } from '@mvp/voice';
import { useI18n } from '../../lib/i18n';
import {
  browserCaptureDeps,
  startCapture,
  transcribeCapture,
  type CaptureDeps,
  type VoiceNote,
} from '../../lib/voice-notes';

export interface VoiceNoteRecorderProps {
  stt: STTProvider;
  disabled?: boolean;
  onVoiceNote: (note: VoiceNote) => void;
  onError?: (message: string) => void;
  /** Injectable browser deps (tests). Defaults to the real browser. */
  deps?: CaptureDeps;
  language?: string;
}

type RecState = 'idle' | 'recording' | 'working';

export default function VoiceNoteRecorder({
  stt,
  disabled,
  onVoiceNote,
  onError,
  deps,
  language,
}: VoiceNoteRecorderProps) {
  const { t } = useI18n();
  const [state, setState] = useState<RecState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const captureRef = useRef<{ stop: () => Promise<import('../../lib/voice-notes').CapturedAudio> } | null>(null);
  const timerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      // Best-effort: stop an in-flight capture on unmount.
      const cap = captureRef.current;
      captureRef.current = null;
      if (cap) void cap.stop().catch(() => {});
    };
  }, []);

  const fail = useCallback(
    (message: string) => {
      onError?.(message);
      if (mountedRef.current) setState('idle');
    },
    [onError],
  );

  const toggle = useCallback(async () => {
    if (disabled) return;
    if (state === 'recording') {
      // Stop → transcribe → emit.
      const cap = captureRef.current;
      captureRef.current = null;
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      if (!cap) {
        setState('idle');
        return;
      }
      setState('working');
      try {
        const captured = await cap.stop();
        const transcript = await transcribeCapture(stt, captured, { language });
        if (!mountedRef.current) return;
        setState('idle');
        setElapsed(0);
        onVoiceNote({
          audioDataUrl: captured.dataUrl,
          mimeType: captured.mimeType,
          durationMs: captured.durationMs,
          transcript,
        });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (state !== 'idle') return;
    // Start recording.
    try {
      const cap = await startCapture(deps ?? browserCaptureDeps());
      if (!mountedRef.current) {
        await cap.stop().catch(() => {});
        return;
      }
      captureRef.current = cap;
      setState('recording');
      setElapsed(0);
      const started = Date.now();
      timerRef.current = window.setInterval(() => {
        if (mountedRef.current) setElapsed(Date.now() - started);
      }, 250);
    } catch (err) {
      fail(t('voice.micDenied'));
    }
  }, [disabled, state, stt, deps, language, onVoiceNote, fail, t]);

  const label =
    state === 'recording'
      ? t('voice.micRecording')
      : state === 'working'
        ? t('voice.transcribing')
        : t('voice.micStart');

  return (
    <button
      type="button"
      className={`icon-btn mic-btn${state === 'recording' ? ' recording' : ''}`}
      onClick={() => void toggle()}
      disabled={disabled || state === 'working'}
      title={label}
      aria-label={state === 'recording' ? t('voice.micStop') : t('voice.micStart')}
      aria-pressed={state === 'recording'}
    >
      <span aria-hidden="true">{state === 'recording' ? '⏺' : '🎙️'}</span>
      {state === 'recording' && (
        <span className="mic-elapsed" aria-hidden="true">
          {Math.floor(elapsed / 1000)}s
        </span>
      )}
    </button>
  );
}
