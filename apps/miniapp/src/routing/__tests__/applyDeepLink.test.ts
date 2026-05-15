import { describe, expect, it, vi } from 'vitest';
import { applyDeepLinkToHistory, type HistoryLike } from '../applyDeepLink.ts';
import type { TelegramWebApp } from '../../telegram/webapp.ts';

function fakeHistory(): HistoryLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    replaceState: (_data, _unused, url) => {
      calls.push(url);
    },
  };
}

function webAppWithStartParam(startParam: string | undefined): TelegramWebApp {
  // Build initDataUnsafe conditionally: under exactOptionalPropertyTypes an
  // explicit `start_param: undefined` is not assignable to `start_param?: string`.
  return { initDataUnsafe: startParam === undefined ? {} : { start_param: startParam } };
}

describe('applyDeepLinkToHistory', () => {
  it('does nothing and returns null when there is no WebApp', () => {
    const history = fakeHistory();
    expect(applyDeepLinkToHistory(null, history)).toBe(null);
    expect(history.calls).toEqual([]);
  });

  it('does nothing when start_param is absent', () => {
    const history = fakeHistory();
    expect(applyDeepLinkToHistory(webAppWithStartParam(undefined), history)).toBe(null);
    expect(history.calls).toEqual([]);
  });

  it('does nothing for an unknown start_param', () => {
    const history = fakeHistory();
    expect(applyDeepLinkToHistory(webAppWithStartParam('totally_unknown'), history)).toBe(null);
    expect(history.calls).toEqual([]);
  });

  it('rewrites history to the resolved route for a draft deep-link', () => {
    const history = fakeHistory();
    const target = applyDeepLinkToHistory(webAppWithStartParam('draft_abc123'), history);
    expect(target).toBe('/drafts/abc123');
    expect(history.calls).toEqual(['/drafts/abc123']);
  });

  it('rewrites history for a connect deep-link (query preserved)', () => {
    const history = fakeHistory();
    const target = applyDeepLinkToHistory(webAppWithStartParam('connect_XYZ'), history);
    expect(target).toBe('/channel?code=XYZ');
    expect(history.calls).toEqual(['/channel?code=XYZ']);
  });

  it('uses replaceState (not pushState) so the deep-link is not a back-step', () => {
    const replaceState = vi.fn();
    applyDeepLinkToHistory(webAppWithStartParam('onboarding'), { replaceState });
    expect(replaceState).toHaveBeenCalledOnce();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/onboarding');
  });
});
