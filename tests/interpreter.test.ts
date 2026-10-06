import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ActionInterpreter } from '../src/core/ai/interpreter.js';
import type { IAIProvider } from '../src/core/ai/types.js';
import type { ActionDef } from '../src/core/actions/registry.js';

const testAction: ActionDef<{ amount: number }> = {
  name: 'registrar_gasto',
  description: 'Registra un gasto con monto y descripción.',
  kind: 'write',
  input: z.object({ amount: z.number().positive(), description: z.string().min(1) }),
  summarize: (i) => `Gasto de ${i.amount}`,
  handler: async () => ({ reply: 'ok' }),
};

function mockProvider(responses: string[]): IAIProvider {
  const queue = [...responses];
  return {
    name: 'Mock',
    completePrompt: vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error('sin respuestas mockeadas');
      return next;
    }),
  };
}

describe('ActionInterpreter', () => {
  it('interpreta JSON válido', async () => {
    const provider = mockProvider(['{"action":"registrar_gasto","params":{"amount":5000,"description":"Saeta"}}']);
    const interp = new ActionInterpreter(provider);
    const r = await interp.interpret('prompt base', [testAction], 'Gasté 5000 en Saeta');
    expect(r.action.name).toBe('registrar_gasto');
    expect(r.params).toMatchObject({ amount: 5000 });
  });

  it('extrae JSON envuelto en markdown', async () => {
    const provider = mockProvider(['```json\n{"action":"registrar_gasto","params":{"amount":1,"description":"x"}}\n```']);
    const interp = new ActionInterpreter(provider);
    const r = await interp.interpret('prompt base', [testAction], 'texto');
    expect(r.action.name).toBe('registrar_gasto');
  });

  it('si la primera respuesta no es JSON, reintenta una vez', async () => {
    const provider = mockProvider([
      'No entendí, ¿me repetís?',
      '{"action":"registrar_gasto","params":{"amount":2,"description":"y"}}',
    ]);
    const interp = new ActionInterpreter(provider);
    const r = await interp.interpret('prompt base', [testAction], 'texto');
    expect(r.action.name).toBe('registrar_gasto');
    expect(provider.completePrompt).toHaveBeenCalledTimes(2);
  });

  it('si sigue sin JSON válido, lanza error de interpretación', async () => {
    const provider = mockProvider(['bla bla', 'más bla']);
    const interp = new ActionInterpreter(provider);
    await expect(interp.interpret('prompt base', [testAction], 'texto')).rejects.toThrow(/interpretar/);
  });

  it('acción fuera del registry: lanza (el modelo no decide qué ejecutar)', async () => {
    const provider = mockProvider(['{"action":"borrar_todo","params":{}}']);
    const interp = new ActionInterpreter(provider);
    await expect(interp.interpret('prompt base', [testAction], 'texto')).rejects.toThrow(/ninguna función/);
  });

  it('fallo del provider se convierte en AIProviderError', async () => {
    const provider: IAIProvider = { name: 'Roto', completePrompt: async () => { throw new Error('timeout'); } };
    const interp = new ActionInterpreter(provider);
    await expect(interp.interpret('prompt base', [testAction], 'texto')).rejects.toThrow(/modelo de IA/);
  });
});
