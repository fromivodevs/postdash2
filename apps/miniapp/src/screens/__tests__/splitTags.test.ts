import { describe, expect, it } from 'vitest';
import { splitTags } from '../SettingsScreen.tsx';

describe('splitTags', () => {
  it('returns empty array for empty input', () => {
    expect(splitTags('')).toEqual([]);
    expect(splitTags('   ')).toEqual([]);
  });

  it('splits comma-separated string into trimmed tags', () => {
    expect(splitTags('ai, llm, gpt')).toEqual(['ai', 'llm', 'gpt']);
  });

  it('drops empty tags from consecutive commas', () => {
    expect(splitTags('a,,b, ,c')).toEqual(['a', 'b', 'c']);
  });

  it('preserves spaces within a tag', () => {
    expect(splitTags('artificial intelligence, machine learning')).toEqual([
      'artificial intelligence',
      'machine learning',
    ]);
  });
});
