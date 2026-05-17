import { describe, expect, it } from 'vitest';
import { matchNegativeKeyword, __testables } from '../handlers/match-news-to-workspaces.js';
import { buildTopicText } from '../handlers/recompute-topic-embedding.js';

const { cosineSim, parseEmbedding } = __testables;

describe('matchNegativeKeyword', () => {
  it('whole-word matches case-insensitively', () => {
    expect(matchNegativeKeyword('I love crypto art', ['Crypto'])).toBe('Crypto');
    expect(matchNegativeKeyword('cryptocurrency rules', ['crypto'])).toBeNull();
  });
  it('returns null when no keywords are configured', () => {
    expect(matchNegativeKeyword('anything', [])).toBeNull();
  });
  it('does not blow up on regex metacharacters in keywords', () => {
    // `\b` doesn't fire on punctuation boundaries, so a bracketed keyword
    // won't whole-word match — but the regex MUST stay safe (no throw, no
    // catastrophic backtracking) when crafted from user input.
    expect(() => matchNegativeKeyword('the (parens) here', ['(parens)'])).not.toThrow();
    // A literal dot keyword still matches on word-char boundaries.
    expect(matchNegativeKeyword('the .org list', ['.org'])).toBeNull();
    expect(matchNegativeKeyword('plain word', ['word'])).toBe('word');
  });
  it('skips empty keywords', () => {
    expect(matchNegativeKeyword('hello', ['  ', '', 'hello'])).toBe('hello');
  });
});

describe('cosineSim', () => {
  it('orthogonal vectors have similarity 0', () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });
  it('identical unit vectors have similarity 1', () => {
    const v = [0.5, 0.5, 0.5, 0.5];
    expect(cosineSim(v, v)).toBeCloseTo(1, 5);
  });
  it('opposite vectors have similarity -1', () => {
    expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });
  it('zero norm returns 0', () => {
    expect(cosineSim([0, 0], [1, 0])).toBe(0);
  });
});

describe('parseEmbedding', () => {
  it('accepts an array', () => {
    expect(parseEmbedding([1, 2, 3])).toEqual([1, 2, 3]);
  });
  it('parses a pgvector string', () => {
    expect(parseEmbedding('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3]);
  });
  it('rejects non-finite numbers', () => {
    expect(() => parseEmbedding('[1,NaN,3]')).toThrow(/non-finite/);
  });
});

describe('buildTopicText', () => {
  it('joins topics and keywords with separator', () => {
    expect(buildTopicText(['AI coding', 'tools'], ['cursor'])).toBe(
      'Topics: AI coding, tools. Keywords: cursor',
    );
  });
  it('omits sections when empty', () => {
    expect(buildTopicText(['AI'], [])).toBe('Topics: AI');
    expect(buildTopicText([], ['cursor'])).toBe('Keywords: cursor');
  });
  it('returns empty string when both lists are empty', () => {
    expect(buildTopicText([], [])).toBe('');
  });
  it('trims and skips blank entries', () => {
    expect(buildTopicText(['  ', 'AI ', ''], ['cursor'])).toBe('Topics: AI. Keywords: cursor');
  });
});
