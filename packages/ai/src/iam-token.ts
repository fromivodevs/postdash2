/**
 * Yandex IAM token cache + refresh.
 *
 * Token exchange flow (Phase 4 implementation; Phase 0 was a stub):
 *
 *   1. Worker reads `system_state(key='ya_iam_token')` at boot. If unexpired,
 *      use it. (Avoids N concurrent workers each minting a new token at
 *      cold-start.)
 *   2. On cache miss / near-expiry: sign a JWT with the service account
 *      private key (PS256), POST to iam.api.cloud.yandex.net/iam/v1/tokens
 *      with `{ "jwt": <token> }`. Response: `{ iamToken, expiresAt }`.
 *   3. Writethrough into system_state via the injected `IAMTokenStore` so
 *      other worker processes see the fresh token at their next cold-start.
 *
 * Single-flight: concurrent `getToken()` calls share one in-flight refresh
 * promise. Prevents the cold-start thundering-herd problem (10 workers boot
 * at once, all see no cached token, all 10 hit IAM = needless cost).
 *
 * Crypto: we use node:crypto's `createPrivateKey` + `createSign('RSA-SHA256')`
 * with RSA-PSS padding (PS256 per JWA) directly — no `jsonwebtoken` dep. The
 * JWT is small and the structure is stable.
 *
 * See tg_mvp_plan/11-AI-PROVIDER.md §5 and architecture/global-ingestion.md.
 */

import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { AIProviderError } from './provider.js';

const IAM_TOKEN_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';
const REFRESH_MARGIN_MS = 60 * 60 * 1000; // refresh if <1h to expiry (token lives 12h)
const JWT_TTL_SECONDS = 3600;

interface TokenState {
  token: string;
  expiresAt: number; // ms timestamp
}

/**
 * Service-account key as exported by Yandex Cloud Console / yc CLI.
 * Loaded from YA_SA_KEY_JSON env var (raw JSON string).
 */
interface ServiceAccountKey {
  id: string;
  service_account_id: string;
  private_key: string;
}

/**
 * Optional persistence layer for cross-process token sharing. Injected by
 * the worker; tests can leave it undefined and rely solely on the in-memory
 * cache. Keeping persistence injectable preserves the rule
 * "packages/ai does not import packages/db".
 */
export interface IAMTokenStore {
  read(): Promise<{ token: string; expiresAt: Date } | null>;
  write(token: string, expiresAt: Date): Promise<void>;
}

export interface IAMTokenCacheOptions {
  /**
   * `fetch` impl. Defaults to globalThis.fetch. Tests inject a mock so
   * the cache can be unit-tested without hitting iam.api.cloud.yandex.net.
   */
  fetch?: typeof globalThis.fetch;
  /** Cross-process writethrough store. Optional — in-memory-only if omitted. */
  store?: IAMTokenStore;
  /** Inject a clock for deterministic tests. */
  now?: () => number;
}

export class IAMTokenCache {
  private state: TokenState | null = null;
  private refreshPromise: Promise<string> | null = null;
  private parsedKey: ServiceAccountKey | null = null;
  private privateKey: KeyObject | null = null;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly store: IAMTokenStore | undefined;
  private readonly now: () => number;

  constructor(
    private readonly serviceAccountKeyJson: string,
    opts: IAMTokenCacheOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.store = opts.store;
    this.now = opts.now ?? (() => Date.now());
  }

  async getToken(): Promise<string> {
    const now = this.now();
    if (this.state && this.state.expiresAt - REFRESH_MARGIN_MS > now) {
      return this.state.token;
    }
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.refreshChain(now).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  /**
   * Force a refresh regardless of cache state. Called on 401 from
   * Foundation Models API: the token might have been revoked / rotated
   * server-side even though our local clock says it's still valid.
   */
  async forceRefresh(): Promise<string> {
    this.state = null;
    return this.getToken();
  }

  private async refreshChain(now: number): Promise<string> {
    // 1. Try the cross-process store first (cold-start path: another worker
    //    may have refreshed in the last minute).
    if (this.store) {
      const stored = await this.store.read();
      if (stored && stored.expiresAt.getTime() - REFRESH_MARGIN_MS > now) {
        this.state = { token: stored.token, expiresAt: stored.expiresAt.getTime() };
        return stored.token;
      }
    }

    // 2. Mint a fresh token via IAM exchange.
    const { token, expiresAt } = await this.exchange();
    this.state = { token, expiresAt: expiresAt.getTime() };

    // 3. Writethrough so other processes see it. Failure is logged but not
    //    fatal — the in-memory copy is still valid for this process.
    if (this.store) {
      try {
        await this.store.write(token, expiresAt);
      } catch {
        // intentional swallow: persistence is a best-effort optimization.
      }
    }
    return token;
  }

  private async exchange(): Promise<{ token: string; expiresAt: Date }> {
    if (this.serviceAccountKeyJson.trim().length === 0) {
      throw new AIProviderError(
        'IAMTokenCache: YA_SA_KEY_JSON is empty; cannot mint token',
        'auth_error',
      );
    }

    const key = this.parseKey();
    const jwt = this.signJwt(key);

    let response: Response;
    try {
      response = await this.fetchImpl(IAM_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jwt }),
      });
    } catch (err) {
      throw new AIProviderError(
        `IAM exchange network error: ${(err as Error).message ?? String(err)}`,
        'server_error',
        err,
      );
    }
    if (!response.ok) {
      // Avoid logging the body verbatim — it may echo our JWT in the error.
      throw new AIProviderError(
        `IAM exchange failed: HTTP ${response.status}`,
        response.status === 401 ? 'auth_error' : 'server_error',
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      throw new AIProviderError('IAM exchange returned non-JSON body', 'parse_error', err);
    }
    if (
      !body ||
      typeof body !== 'object' ||
      typeof (body as { iamToken?: unknown }).iamToken !== 'string' ||
      typeof (body as { expiresAt?: unknown }).expiresAt !== 'string'
    ) {
      throw new AIProviderError(
        'IAM exchange returned unexpected shape (missing iamToken / expiresAt)',
        'parse_error',
      );
    }
    const { iamToken, expiresAt } = body as { iamToken: string; expiresAt: string };
    const expDate = new Date(expiresAt);
    if (Number.isNaN(expDate.getTime())) {
      throw new AIProviderError(
        `IAM exchange returned invalid expiresAt: ${expiresAt}`,
        'parse_error',
      );
    }
    return { token: iamToken, expiresAt: expDate };
  }

  private parseKey(): ServiceAccountKey {
    if (this.parsedKey) return this.parsedKey;
    let raw: unknown;
    try {
      raw = JSON.parse(this.serviceAccountKeyJson);
    } catch (err) {
      throw new AIProviderError('YA_SA_KEY_JSON is not valid JSON', 'auth_error', err);
    }
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof (raw as { id?: unknown }).id !== 'string' ||
      typeof (raw as { service_account_id?: unknown }).service_account_id !== 'string' ||
      typeof (raw as { private_key?: unknown }).private_key !== 'string'
    ) {
      throw new AIProviderError(
        'YA_SA_KEY_JSON missing required fields (id, service_account_id, private_key)',
        'auth_error',
      );
    }
    this.parsedKey = raw as ServiceAccountKey;
    return this.parsedKey;
  }

  private signJwt(key: ServiceAccountKey): string {
    if (!this.privateKey) {
      try {
        this.privateKey = createPrivateKey({ key: key.private_key, format: 'pem' });
      } catch (err) {
        throw new AIProviderError(
          'YA_SA_KEY_JSON private_key is not a valid PEM',
          'auth_error',
          err,
        );
      }
    }
    const nowSec = Math.floor(this.now() / 1000);
    const header = { typ: 'JWT', alg: 'PS256', kid: key.id };
    const payload = {
      iss: key.service_account_id,
      aud: IAM_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + JWT_TTL_SECONDS,
    };
    const encHeader = base64url(Buffer.from(JSON.stringify(header), 'utf8'));
    const encPayload = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
    const signingInput = `${encHeader}.${encPayload}`;
    // Yandex requires PS256 (RSASSA-PSS), NOT RS256. The padding scheme is
    // RSA-PSS with MGF1+SHA-256 and a salt length of 32 (digest size).
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign({
      key: this.privateKey,
      padding: 6, // RSA_PKCS1_PSS_PADDING
      saltLength: 32,
    });
    return `${signingInput}.${base64url(signature)}`;
  }

  /** Test seam — bypasses exchange. */
  public _setForTest(token: string, expiresAtMs: number): void {
    this.state = { token, expiresAt: expiresAtMs };
  }

  /** Test seam — observe cache state without forcing a refresh. */
  public _peek(): TokenState | null {
    return this.state;
  }

  public hasKey(): boolean {
    return this.serviceAccountKeyJson.trim().length > 0;
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
