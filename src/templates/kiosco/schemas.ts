import { z } from 'zod';

export const RegistrarVentaInput = z.object({
  monto: z.number().positive('El monto debe ser mayor a 0').optional(),
  nota: z.string().trim().optional(),
  fecha: z.string().trim().optional(),
  ventas: z
    .array(
      z.object({
        monto: z.number().positive('El monto debe ser mayor a 0'),
        nota: z.string().trim().optional(),
      })
    )
    .optional(),
});

export type RegistrarVentaInput = z.infer<typeof RegistrarVentaInput>;

export const RegistrarGastoInput = z.object({
  monto: z.number().positive('El monto debe ser mayor a 0').optional(),
  concepto: z.string().trim().optional(),
  categoria: z.string().trim().optional(),
  fecha: z.string().trim().optional(),
  gastos: z
    .array(
      z.object({
        monto: z.number().positive('El monto debe ser mayor a 0'),
        concepto: z.string().trim().min(1, 'Falta la descripción del gasto'),
        categoria: z.string().trim().optional(),
      })
    )
    .optional(),
});

export type RegistrarGastoInput = z.infer<typeof RegistrarGastoInput>;

export const CalcularPrecioInput = z.object({
  costo_total: z.number().positive().optional(),
  cantidad: z.number().positive().optional(),
  costo_unitario: z.number().positive().optional(),
  porcentaje: z.number().min(0, 'El porcentaje no puede ser negativo').optional(),
  tipo: z.enum(['margen', 'recargo']).optional(),
});

export type CalcularPrecioInput = z.infer<typeof CalcularPrecioInput>;

export const ConsultarResumenInput = z.object({
  periodo: z.enum(['hoy', 'ayer', 'semana', 'mes', 'categorias', 'movimientos', 'menu']).default('hoy'),
});

export type ConsultarResumenInput = z.infer<typeof ConsultarResumenInput>;

export const ConsultarMovimientosInput = z.object({
  limite: z.number().int().min(1).max(30).default(10),
});

export type ConsultarMovimientosInput = z.infer<typeof ConsultarMovimientosInput>;

export const RegistrarLoteInput = z.object({
  fecha: z.string().trim().optional(),
  items: z
    .array(
      z.object({
        tipo: z.enum(['VENTA', 'GASTO']),
        monto: z.number().positive('El monto debe ser mayor a 0'),
        concepto: z.string().trim().optional(),
        categoria: z.string().trim().optional(),
        nota: z.string().trim().optional(),
      })
    )
    .min(1, 'Debe haber al menos un movimiento en el lote'),
  _editingItemIndex: z.number().int().optional(),
  _awaitingCorrection: z.boolean().optional(),
});

export type RegistrarLoteInput = z.infer<typeof RegistrarLoteInput>;

export const EmptyInput = z.object({}).strict();
export type EmptyInput = z.infer<typeof EmptyInput>;
