import { describe, expect, it, vi } from 'vitest';
import { FallbackAIProvider } from '../src/infrastructure/ai/fallback.provider.js';
import type { CompletePromptParams, IAIProvider } from '../src/core/ai/types.js';
import { AIProviderError } from '../src/core/errors/errors.js';
import { buildAIProvider } from '../src/app/container.js';
import type { AppConfig } from '../src/core/config/config.js';

describe('FallbackAIProvider (cascada de IA)', () => {
  it('devuelve el resultado del primer proveedor si es exitoso', async () => {
    const p1: IAIProvider = {
      name: 'P1',
      completePrompt: vi.fn().mockResolvedValue('{"action":"registrar_venta"}'),
    };
    const p2: IAIProvider = {
      name: 'P2',
      completePrompt: vi.fn().mockResolvedValue('{"action":"otro"}'),
    };

    const fallback = new FallbackAIProvider([p1, p2]);
    const result = await fallback.completePrompt({
      systemPrompt: 'sys',
      userPrompt: 'usr',
    });

    expect(result).toBe('{"action":"registrar_venta"}');
    expect(p1.completePrompt).toHaveBeenCalledTimes(1);
    expect(p2.completePrompt).not.toHaveBeenCalled();
  });

  it('salta al segundo proveedor si el primero lanza error (ej. rate limit 429)', async () => {
    const p1: IAIProvider = {
      name: 'Groq',
      completePrompt: vi.fn().mockRejectedValue(new Error('Rate limit exceeded (429)')),
    };
    const p2: IAIProvider = {
      name: 'OpenRouter',
      completePrompt: vi.fn().mockResolvedValue('{"action":"registrar_venta","params":{"monto":5000}}'),
    };

    const fallback = new FallbackAIProvider([p1, p2]);
    const result = await fallback.completePrompt({
      systemPrompt: 'sys',
      userPrompt: 'usr',
    });

    expect(result).toBe('{"action":"registrar_venta","params":{"monto":5000}}');
    expect(p1.completePrompt).toHaveBeenCalledTimes(1);
    expect(p2.completePrompt).toHaveBeenCalledTimes(1);
  });

  it('salta al segundo proveedor si la respuesta del primero no supera validateOutput (ej. "User Safety: safe")', async () => {
    const p1: IAIProvider = {
      name: 'OpenRouter-LlamaGuard',
      completePrompt: vi.fn().mockResolvedValue('User Safety: safe'),
    };
    const p2: IAIProvider = {
      name: 'OpenRouter-Gemini',
      completePrompt: vi.fn().mockResolvedValue('{"action":"registrar_gasto"}'),
    };

    const fallback = new FallbackAIProvider([p1, p2]);
    const params: CompletePromptParams = {
      systemPrompt: 'sys',
      userPrompt: 'usr',
      validateOutput: (raw) => raw.includes('{') && raw.includes('}'),
    };

    const result = await fallback.completePrompt(params);

    expect(result).toBe('{"action":"registrar_gasto"}');
    expect(p1.completePrompt).toHaveBeenCalledTimes(1);
    expect(p2.completePrompt).toHaveBeenCalledTimes(1);
  });

  it('lanza AIProviderError si todos los proveedores fallan', async () => {
    const p1: IAIProvider = {
      name: 'P1',
      completePrompt: vi.fn().mockRejectedValue(new Error('Error de cuota')),
    };
    const p2: IAIProvider = {
      name: 'P2',
      completePrompt: vi.fn().mockRejectedValue(new Error('503 Service Unavailable')),
    };

    const fallback = new FallbackAIProvider([p1, p2]);
    await expect(
      fallback.completePrompt({
        systemPrompt: 'sys',
        userPrompt: 'usr',
      })
    ).rejects.toThrow(AIProviderError);
  });
});

describe('buildAIProvider (composición según config)', () => {
  const baseConfig: AppConfig = {
    NODE_ENV: 'test',
    PORT: 3000,
    API_SECRET: 'secreto-de-prueba-largo-12345',
    DATABASE_URL: 'postgres://localhost/test',
    AI_PROVIDER: 'fallback',
    OPENROUTER_MODEL: 'test-model',
    STT_PROVIDER: 'groq',
    STT_API_KEY: 'gsk_test_groq_key_whisper',
    STT_MODEL: 'whisper-large-v3-turbo',
    GROQ_MODEL: 'llama-3.3-70b-versatile',
    GEMINI_MODEL: 'gemini-2.0-flash',
    TRIAL_DAYS: 10,
    GRACE_DAYS: 7,
    TELEGRAM_POLLING: 'off',
  };

  it('compone Groq (reutilizando STT_API_KEY) + OpenRouter en cascada', () => {
    const config: AppConfig = {
      ...baseConfig,
      OPENROUTER_API_KEY: 'sk-or-test-key',
    };

    const { provider, modelDescription } = buildAIProvider(config);
    expect(provider).toBeInstanceOf(FallbackAIProvider);
    expect(modelDescription).toBe('Groq -> OpenRouter');
    expect(provider.name).toContain('Groq');
    expect(provider.name).toContain('OpenRouter');
  });

  it('si solo está OpenRouter, usa únicamente OpenRouter sin overhead de fallback', () => {
    const config: AppConfig = {
      ...baseConfig,
      STT_PROVIDER: 'disabled',
      STT_API_KEY: undefined,
      OPENROUTER_API_KEY: 'sk-or-test-key',
    };

    const { provider, modelDescription } = buildAIProvider(config);
    expect(provider).not.toBeInstanceOf(FallbackAIProvider);
    expect(provider.name).toBe('OpenRouter');
    expect(modelDescription).toBe('test-model');
  });

  it('si se configura GEMINI_API_KEY se suma a la cascada', () => {
    const config: AppConfig = {
      ...baseConfig,
      OPENROUTER_API_KEY: 'sk-or-test-key',
      GEMINI_API_KEY: 'gemini-test-key',
    };

    const { provider, modelDescription } = buildAIProvider(config);
    expect(provider).toBeInstanceOf(FallbackAIProvider);
    expect(modelDescription).toBe('Groq -> OpenRouter -> Google Gemini');
  });
});
