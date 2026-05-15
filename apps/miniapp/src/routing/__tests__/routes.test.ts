import { describe, expect, it } from 'vitest';
import { isRegisteredRoute, isRootTabPath, startParamToPath, ROUTES } from '../routes.ts';

describe('startParamToPath', () => {
  it('returns null for empty/missing param', () => {
    expect(startParamToPath(undefined)).toBe(null);
    expect(startParamToPath(null)).toBe(null);
    expect(startParamToPath('')).toBe(null);
  });

  it('maps onboarding', () => {
    expect(startParamToPath('onboarding')).toBe(ROUTES.onboarding);
  });

  it('maps radar_high_score to the score filter', () => {
    expect(startParamToPath('radar_high_score')).toBe('/radar?filter=score_7plus');
  });

  it('maps draft_<id> to the draft editor route', () => {
    expect(startParamToPath('draft_abc123')).toBe('/drafts/abc123');
  });

  it('url-encodes the draft id', () => {
    expect(startParamToPath('draft_a b')).toBe('/drafts/a%20b');
  });

  it('maps connect_<code> to the channel route with a code query', () => {
    expect(startParamToPath('connect_XYZ')).toBe('/channel?code=XYZ');
  });

  it('returns null for unknown params', () => {
    expect(startParamToPath('totally_unknown')).toBe(null);
    expect(startParamToPath('draft_')).toBe(null);
  });

  it('rejects an over-long draft id from untrusted start_param', () => {
    const longId = 'a'.repeat(65);
    expect(startParamToPath(`draft_${longId}`)).toBe(null);
    // A 64-char id is still within bounds.
    const maxId = 'b'.repeat(64);
    expect(startParamToPath(`draft_${maxId}`)).toBe(`/drafts/${maxId}`);
  });

  it('rejects an over-long connect code from untrusted start_param', () => {
    const longCode = 'c'.repeat(65);
    expect(startParamToPath(`connect_${longCode}`)).toBe(null);
  });
});

describe('isRootTabPath', () => {
  it('treats "/" as the Radar root tab', () => {
    expect(isRootTabPath('/')).toBe(true);
  });

  it('recognises every tab root', () => {
    expect(isRootTabPath('/radar')).toBe(true);
    expect(isRootTabPath('/drafts')).toBe(true);
    expect(isRootTabPath('/sources')).toBe(true);
    expect(isRootTabPath('/channel')).toBe(true);
    expect(isRootTabPath('/settings')).toBe(true);
  });

  it('rejects non-root paths', () => {
    expect(isRootTabPath('/onboarding')).toBe(false);
    expect(isRootTabPath('/drafts/123')).toBe(false);
  });
});

describe('deep-link targets land on a registered route', () => {
  it('every startParamToPath result matches a route AppShell registers', () => {
    const params = ['onboarding', 'radar_high_score', 'draft_abc123', 'draft_a b', 'connect_XYZ'];
    for (const param of params) {
      const target = startParamToPath(param);
      expect(target, `start_param "${param}" must resolve`).not.toBe(null);
      expect(isRegisteredRoute(target as string), `target "${target}" must be registered`).toBe(true);
    }
  });

  it('isRegisteredRoute matches param routes and ignores the query string', () => {
    expect(isRegisteredRoute('/drafts/abc123')).toBe(true);
    expect(isRegisteredRoute('/channel?code=XYZ')).toBe(true);
    expect(isRegisteredRoute('/radar?filter=score_7plus')).toBe(true);
  });

  it('registers the /radar/:matchId news-detail route (§10)', () => {
    expect(isRegisteredRoute('/radar/match-123')).toBe(true);
  });

  it('registers the /sources/new add-source route (§10)', () => {
    expect(isRegisteredRoute('/sources/new')).toBe(true);
  });

  it('isRegisteredRoute rejects unknown paths', () => {
    expect(isRegisteredRoute('/nope')).toBe(false);
    expect(isRegisteredRoute('/drafts/abc/extra')).toBe(false);
  });
});
