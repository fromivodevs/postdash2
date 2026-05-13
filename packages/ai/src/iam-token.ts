import { AIProviderError } from './provider.js';

const IAM_TOKEN_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';
const REFRESH_MARGIN_MS = 60 * 60 * 1000; // refresh за час до истечения (token живёт 12h)

interface TokenState {
  token: string;
  expiresAt: number; // ms timestamp
}

/**
 * Кеш и refresh IAM-токена для Yandex AI Studio.
 *
 * Phase 0: только структура. Реальная имплементация JWT-подписи + HTTP — Phase 4.
 *
 * См. tg_mvp_plan/11-AI-PROVIDER.md §5.
 */
export class IAMTokenCache {
  private state: TokenState | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(private readonly serviceAccountKeyJson: string) {}

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.state && this.state.expiresAt - REFRESH_MARGIN_MS > now) {
      return this.state.token;
    }
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = this.refresh().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refresh(): Promise<string> {
    throw new AIProviderError(
      `IAM token refresh not implemented in Phase 0 (endpoint: ${IAM_TOKEN_URL})`,
      'not_implemented',
    );
  }

  /** Только для тестов: установить токен напрямую. */
  public _setForTest(token: string, expiresAtMs: number): void {
    this.state = { token, expiresAt: expiresAtMs };
  }

  /** Проверка, что service account key выглядит валидно (структура, не подпись). */
  public hasKey(): boolean {
    return this.serviceAccountKeyJson.trim().length > 0;
  }
}
