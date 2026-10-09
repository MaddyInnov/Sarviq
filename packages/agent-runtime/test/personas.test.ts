// SPDX-License-Identifier: Apache-2.0
// Tests for MBTI personas:
// - all 16 types resolve with name/traits/style/addendum
// - resolvePersona handles null/invalid/case-insensitivity
// - quiz scoring maps answers to the right type

import { describe, expect, it } from 'vitest';
import { MBTI_TYPES, PERSONAS, QUIZ_QUESTIONS, resolvePersona, scoreQuiz } from '../src/personas.js';

describe('personas', () => {
  it('defines all 16 MBTI types', () => {
    expect(MBTI_TYPES).toHaveLength(16);
    const expected = [
      'INTJ', 'INTP', 'ENTJ', 'ENTP',
      'INFJ', 'INFP', 'ENFJ', 'ENFP',
      'ISTJ', 'ISFJ', 'ESTJ', 'ESFJ',
      'ISTP', 'ISFP', 'ESTP', 'ESFP',
    ];
    expect([...MBTI_TYPES].sort()).toEqual([...expected].sort());
  });

  it('every template has name, traits, communication style, and addendum', () => {
    for (const t of MBTI_TYPES) {
      const p = PERSONAS[t];
      expect(p.type).toBe(t);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.traits.length).toBeGreaterThanOrEqual(3);
      expect(p.communicationStyle.length).toBeGreaterThan(10);
      expect(p.systemPromptAddendum.length).toBeGreaterThan(50);
    }
  });

  it('resolvePersona returns null for unset/invalid, template for valid', () => {
    expect(resolvePersona(null)).toBeNull();
    expect(resolvePersona(undefined)).toBeNull();
    expect(resolvePersona('')).toBeNull();
    expect(resolvePersona('XXXX')).toBeNull();
    expect(resolvePersona('intj')?.name).toBe('The Architect');
    expect(resolvePersona('ENFP')?.type).toBe('ENFP');
  });

  it('quiz has 4 questions covering the 4 dichotomies', () => {
    expect(QUIZ_QUESTIONS).toHaveLength(4);
    expect(QUIZ_QUESTIONS.map((q) => q.id)).toEqual(['energy', 'information', 'decisions', 'lifestyle']);
  });

  it('scoreQuiz maps answers to types', () => {
    expect(scoreQuiz({ energy: 1, information: 1, decisions: 0, lifestyle: 0 })).toBe('INTJ');
    expect(scoreQuiz({ energy: 0, information: 0, decisions: 1, lifestyle: 1 })).toBe('ESFP');
    expect(scoreQuiz({})).toBe('ESTJ'); // defaults to first options
    expect(scoreQuiz({ energy: 1, information: 1, decisions: 1, lifestyle: 1 })).toBe('INFP');
  });
});
