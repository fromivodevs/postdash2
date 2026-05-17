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
    // Unicode lookaround boundaries treat any non-letter/non-digit as a
    // "word edge", so a keyword wrapped in punctuation (e.g. `(parens)`)
    // matches when the haystack surrounds it with non-word chars. The
    // regex MUST stay safe (no throw, no catastrophic backtracking) when
    // crafted from user input.
    expect(() => matchNegativeKeyword('the (parens) here', ['(parens)'])).not.toThrow();
    expect(matchNegativeKeyword('plain word', ['word'])).toBe('word');
  });
  it('skips empty keywords', () => {
    expect(matchNegativeKeyword('hello', ['  ', '', 'hello'])).toBe('hello');
  });
  // Unicode-aware boundary tests (Russian-first product; ASCII \b fails on
  // Cyrillic-Cyrillic boundaries — see matchNegativeKeyword docstring).
  it('does NOT whole-word match Cyrillic substring inside a longer Cyrillic word', () => {
    expect(matchNegativeKeyword('криптовалюта рулит', ['крипто'])).toBeNull();
  });
  it('matches a Cyrillic keyword on space + EOL boundaries', () => {
    expect(matchNegativeKeyword('я люблю крипто', ['крипто'])).toBe('крипто');
  });
  it('does NOT match when the right boundary is a Latin letter', () => {
    expect(matchNegativeKeyword('криптоnews сегодня', ['крипто'])).toBeNull();
  });
  // Zero-width joiner (U+200D) and other Cf characters used to slip past the
  // \p{L}\p{N} lookarounds because they are neither letters nor digits. We
  // pre-strip Cf so `крипто<ZWJ>рулит` behaves the same as `крипторулит` —
  // i.e. `крипто` followed by a Cyrillic letter, which is NOT a whole-word
  // match.
  it('strips ZWJ and does NOT match the keyword followed by a Cyrillic letter', () => {
    const zwj = String.fromCodePoint(0x200d);
    expect(matchNegativeKeyword(`крипто${zwj}рулит`, ['крипто'])).toBeNull();
  });
  // A keyword that consists ONLY of \p{Cf} (e.g. ZWJ) collapses to the empty
  // string after the strip-format-chars step. Without the empty-guard the
  // lookaround regex would match every non-letter boundary in the haystack
  // and flag ALL news items as filtered_negative for that workspace.
  it('returns null for a keyword that is only ZWJ (empty after normalize)', () => {
    const zwj = String.fromCodePoint(0x200d);
    expect(matchNegativeKeyword('any news here', [zwj])).toBeNull();
  });
  // NFD vs NFC normalization. `caf` + COMBINING ACUTE (U+0301) renders the
  // same as the precomposed `café` (U+00E9), but the two byte sequences are
  // unequal. We construct both forms via codepoints so the test source-file
  // encoding can't coerce them into the same form behind our back.
  it('normalizes NFD haystack to NFC before matching', () => {
    const nfd = 'caf' + String.fromCodePoint(0x65, 0x0301);
    const nfc = 'caf' + String.fromCodePoint(0x00e9);
    expect(nfd.length).toBe(5);
    expect(nfc.length).toBe(4);
    expect(matchNegativeKeyword(nfd, [nfc])).toBe(nfc);
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
