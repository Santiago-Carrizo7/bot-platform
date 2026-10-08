import { z } from 'zod';

export const RegistrarVentaInput = z
  .object({
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
  })
  .refine((data) => data.monto !== undefined || (data.ventas && data.ventas.length > 0), {
    message: 'Indicá el monto de la venta',
    path: ['monto'],
  });

export type RegistrarVentaInput = z.infer<typeof RegistrarVentaInput>;

export const RegistrarGastoInput = z.object({
  monto: z.number().positive('El monto debe ser mayor a 0'),
  concepto: z.string().trim().min(1, 'Falta la descripción del gasto'),
  categoria: z.string().trim().optional(),
  fecha: z.string().trim().optional(),
});

export type RegistrarGastoInput = z.infer<typeof RegistrarGastoInput>;

export const CalcularPrecioInput = z.object({
  costo_total: z.number().positive().optional(),
  cantidad: z.number().positive().optional(),
  costo_unitario: z.number().positive().optional(),
  porcentaje: z.number().min(0, 'El porcentaje no puede ser negativo'),
  tipo: z.enum(['margen', 'recargo']).optional(),
});

export type CalcularPrecioInput = z.infer<typeof CalcularPrecioInput>;

export const ConsultarResumenInput = z.object({
  periodo: z.enum(['hoy', 'semana', 'mes']).default('hoy'),
});

export type ConsultarResumenInput = z.infer<typeof ConsultarResumenInput>;

export const ConsultarMovimientosInput = z.object({
  limite: z.number().int().min(1).max(30).default(10),
});

export type ConsultarMovimientosInput = z.infer<typeof ConsultarMovimientosInput>;

export const EmptyInput = z.object({}).strict();
export type EmptyInput = z.infer<typeof EmptyInput>;
