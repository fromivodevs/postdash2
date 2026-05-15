import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { getMe, postAuthTelegram } from '../api/auth.ts';
import type { AuthProjection } from '../api/types.ts';
import { ApiError } from '../api/client.ts';
import { readInitDataRaw } from './initdata.ts';

export interface Session {
  auth: AuthProjection;
  initData: string;
}

export type SessionStatus = 'pending' | 'no-telegram' | 'error' | 'ready';

interface SessionContextValue {
  status: SessionStatus;
  session: Session | null;
  error: Error | null;
  initData: string | null;
  query: UseQueryResult<AuthProjection, Error>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  children: ReactNode;
  initDataOverride?: string | null;
}

export function SessionProvider({ children, initDataOverride }: SessionProviderProps) {
  const initData = useMemo(
    () => (initDataOverride !== undefined ? initDataOverride : readInitDataRaw()),
    [initDataOverride],
  );

  const query = useQuery<AuthProjection, Error>({
    queryKey: ['session', initData],
    queryFn: async ({ signal }) => {
      if (!initData) throw new Error('initData is missing');
      // Read first: if the Telegram user already has an account, GET /me is
      // a pure read with no DB writes and no idempotency-slot churn. On 404
      // (first-ever login), fall through to POST /auth/telegram which creates
      // the user + workspace inside a transaction.
      try {
        return await getMe(initData, signal);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return postAuthTelegram(initData, signal);
        }
        throw err;
      }
    },
    enabled: Boolean(initData),
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
      return failureCount < 2;
    },
    staleTime: 5 * 60_000,
  });

  const value: SessionContextValue = useMemo(() => {
    if (!initData) {
      return { status: 'no-telegram', session: null, error: null, initData: null, query };
    }
    if (query.data) {
      return {
        status: 'ready',
        session: { auth: query.data, initData },
        error: null,
        initData,
        query,
      };
    }
    if (query.error) {
      return { status: 'error', session: null, error: query.error, initData, query };
    }
    return { status: 'pending', session: null, error: null, initData, query };
  }, [initData, query]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}
