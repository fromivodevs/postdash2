import { describe, expect, it } from 'vitest';
import { parseApiEnv } from '../env.js';

describe('parseApiEnv — webhook secret guard', () => {
  it('accepts empty webhook secret in development', () => {
    const env = parseApiEnv({
      NODE_ENV: 'development',
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_WEBHOOK_SECRET: '',
    } as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe('development');
    expect(env.TELEGRAM_WEBHOOK_SECRET).toBe('');
  });

  it('accepts empty webhook secret in production when bot token is also empty', () => {
    const env = parseApiEnv({
      NODE_ENV: 'production',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_WEBHOOK_SECRET: '',
      MINIAPP_URL: 'https://app.example.com',
    } as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe('production');
  });

  it('rejects empty webhook secret in production when bot token is set', () => {
    expect(() =>
      parseApiEnv({
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: '123:abc',
        TELEGRAM_WEBHOOK_SECRET: '',
      } as NodeJS.ProcessEnv),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('rejects too-short webhook secret in production', () => {
    expect(() =>
      parseApiEnv({
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: '123:abc',
        TELEGRAM_WEBHOOK_SECRET: 'short',
      } as NodeJS.ProcessEnv),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('accepts a 16+ char webhook secret in production', () => {
    const env = parseApiEnv({
      NODE_ENV: 'production',
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_WEBHOOK_SECRET: 'sixteen-chars-or-longer',
      MINIAPP_URL: 'https://app.example.com',
    } as NodeJS.ProcessEnv);
    expect(env.TELEGRAM_WEBHOOK_SECRET).toBe('sixteen-chars-or-longer');
  });

  it('rejects an all-identical-character webhook secret (placeholder footgun)', () => {
    expect(() =>
      parseApiEnv({
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: '123:abc',
        TELEGRAM_WEBHOOK_SECRET: 'aaaaaaaaaaaaaaaa',
        MINIAPP_URL: 'https://app.example.com',
      } as NodeJS.ProcessEnv),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('rejects an empty webhook secret whenever TELEGRAM_WEBHOOK_URL is set, even in development', () => {
    expect(() =>
      parseApiEnv({
        NODE_ENV: 'development',
        TELEGRAM_BOT_TOKEN: '123:abc',
        TELEGRAM_WEBHOOK_URL: 'https://api.example.com',
        TELEGRAM_WEBHOOK_SECRET: '',
      } as NodeJS.ProcessEnv),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('rejects a too-short webhook secret when TELEGRAM_WEBHOOK_URL is set', () => {
    expect(() =>
      parseApiEnv({
        NODE_ENV: 'development',
        TELEGRAM_BOT_TOKEN: '123:abc',
        TELEGRAM_WEBHOOK_URL: 'https://api.example.com',
        TELEGRAM_WEBHOOK_SECRET: 'short',
      } as NodeJS.ProcessEnv),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it('accepts a 16+ char webhook secret when TELEGRAM_WEBHOOK_URL is set in development', () => {
    const env = parseApiEnv({
      NODE_ENV: 'development',
      TELEGRAM_BOT_TOKEN: '123:abc',
      TELEGRAM_WEBHOOK_URL: 'https://api.example.com',
      TELEGRAM_WEBHOOK_SECRET: 'sixteen-chars-or-longer',
    } as NodeJS.ProcessEnv);
    expect(env.TELEGRAM_WEBHOOK_URL).toBe('https://api.example.com');
    expect(env.TELEGRAM_WEBHOOK_SECRET).toBe('sixteen-chars-or-longer');
  });
});

describe('parseApiEnv — MINIAPP_URL https guard', () => {
  it('accepts http MINIAPP_URL in development', () => {
    const env = parseApiEnv({
      NODE_ENV: 'development',
      MINIAPP_URL: 'http://localhost:5173',
    } as NodeJS.ProcessEnv);
    expect(env.MINIAPP_URL).toBe('http://localhost:5173');
  });

  it('rejects http MINIAPP_URL in production', () => {
    expect(() =>
      parseApiEnv({
        NODE_ENV: 'production',
        TELEGRAM_BOT_TOKEN: '',
        MINIAPP_URL: 'http://app.example.com',
      } as NodeJS.ProcessEnv),
    ).toThrow(/MINIAPP_URL/);
  });

  it('accepts https MINIAPP_URL in production', () => {
    const env = parseApiEnv({
      NODE_ENV: 'production',
      TELEGRAM_BOT_TOKEN: '',
      MINIAPP_URL: 'https://app.example.com',
    } as NodeJS.ProcessEnv);
    expect(env.MINIAPP_URL).toBe('https://app.example.com');
  });
});
