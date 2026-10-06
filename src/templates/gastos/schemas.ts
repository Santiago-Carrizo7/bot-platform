import { z } from 'zod';

/** Contrato de lo que la IA debe extraer para registrar un gasto. */
export const RegistrarGastoInput = z.object({
  amount: z.number({ invalid_type_error: 'El monto debe ser un número' }).positive('El monto debe ser mayor a 0'),
  description: z.string({ invalid_type_error: 'La descripción debe ser texto' }).trim().min(1, 'Falta la descripción'),
  category: z.string().trim().toLowerCase().min(1).default('otros'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe estar en formato YYYY-MM-DD').optional(),
  installments: z.number().int().min(1).default(1),
  currency: z.string().trim().toUpperCase().default('ARS'),
});

export type RegistrarGastoInput = z.infer<typeof RegistrarGastoInput>;

export const FijarPresupuestoInput = z.object({
  category: z.string().trim().toLowerCase().min(1, 'Falta la categoría'),
  amount: z.number({ invalid_type_error: 'El monto debe ser un número' }).positive('El monto debe ser mayor a 0'),
  currency: z.string().trim().toUpperCase().default('ARS'),
});

export type FijarPresupuestoInput = z.infer<typeof FijarPresupuestoInput>;

export const ResumenInput = z.object({
  year: z.number().int().min(2000).max(2100).optional(),
  month: z.number().int().min(1).max(12).optional(),
});

export type ResumenInput = z.infer<typeof ResumenInput>;

export const UltimosInput = z.object({
  limit: z.number().int().min(1).max(10).default(5),
});

export type UltimosInput = z.infer<typeof UltimosInput>;

/** Acciones sin parámetros. */
export const EmptyInput = z.object({}).strict();
export type EmptyInput = z.infer<typeof EmptyInput>;

export const EliminarGastoInput = z.object({
  id: z.string().min(1, 'Falta el identificador del gasto'),
});
export type EliminarGastoInput = z.infer<typeof EliminarGastoInput>;
