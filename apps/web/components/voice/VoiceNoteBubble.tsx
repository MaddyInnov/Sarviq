// SPDX-License-Identifier: Apache-2.0
// Voice-note bubble: renders a recorded note in the chat transcript with
// playback controls (play/pause + progress + duration) and its transcript.

'use client';

import React from 'react';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../lib/i18n';

export interface VoiceNoteBubbleProps {
  audioDataUrl: string;
  mimeType?: string;
  durationMs?: number;
  transcript?: string;
  /** 'user' | 'assistant' — styles the bubble like the matching message side. */
  from?: 'user' | 'assistant';
}

function fmtDuration(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return '0:00';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export default function VoiceNoteBubble({
  audioDataUrl,
  mimeType,
  durationMs,
  transcript,
  from = 'user',
}: VoiceNoteBubbleProps) {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      const d = audio.duration;
      setProgress(Number.isFinite(d) && d > 0 ? audio.currentTime / d : 0);
    };
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
    };
    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('ended', onEnd);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('ended', onEnd);
      audio.pause();
    };
  }, [audioDataUrl]);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play().catch(() => setPlaying(false));
      setPlaying(true);
    }
  }, [playing]);

  return (
    <div className={`voice-note ${from}`} role="group" aria-label={t('voice.voiceNote')}>
      <audio ref={audioRef} src={audioDataUrl} preload="metadata" />
      <button
        type="button"
        className="icon-btn vn-play"
        onClick={toggle}
        aria-label={playing ? t('voice.pause') : t('voice.play')}
        title={playing ? t('voice.pause') : t('voice.play')}
      >
        <span aria-hidden="true">{playing ? '⏸' : '▶'}</span>
      </button>
      <div className="vn-track" aria-hidden="true">
        <div className="vn-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <span className="vn-duration mono small" aria-label={t('voice.duration', { duration: fmtDuration(durationMs) })}>
        {fmtDuration(durationMs)}
      </span>
      {transcript && (
        <details className="vn-transcript">
          <summary className="small">{t('voice.transcript')}</summary>
          <p className="small" style={{ margin: '4px 0 0' }}>
            {transcript}
          </p>
        </details>
      )}
      {mimeType && (
        <span className="vn-mime" aria-hidden="true" style={{ display: 'none' }}>
          {mimeType}
        </span>
      )}
    </div>
  );
}
