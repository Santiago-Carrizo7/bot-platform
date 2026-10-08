import { z } from 'zod';

const VentaItemSchema = z.object({
  nombre: z.string().trim().min(1, 'Falta el nombre del producto o promo'),
  cantidad: z.number().positive('La cantidad debe ser mayor a 0').default(1),
});

export const RegistrarVentaInput = z.object({
  items: z.array(VentaItemSchema).min(1, 'La venta necesita al menos un producto o promo'),
  nota: z.string().trim().optional(),
});
export type RegistrarVentaInput = z.infer<typeof RegistrarVentaInput>;

export const AnularVentaInput = z.object({
  sale_id: z.string().trim().optional(),
  motivo: z.string().trim().optional(),
});
export type AnularVentaInput = z.infer<typeof AnularVentaInput>;

export const CambiarPrecioInput = z
  .object({
    nombre: z.string().trim().min(1, 'Falta el nombre del producto o promo'),
    precio_unitario: z.number().positive('El precio debe ser mayor a 0').optional(),
    precio_docena: z.number().positive('El precio de la docena debe ser mayor a 0').optional(),
  })
  .refine((v) => v.precio_unitario !== undefined || v.precio_docena !== undefined, {
    message: 'Tenés que indicar al menos un precio nuevo (unitario o docena)',
    path: ['precio_unitario'],
  });
export type CambiarPrecioInput = z.infer<typeof CambiarPrecioInput>;

export const ControlDiasInput = z.object({
  fecha: z.string().trim().optional(), // 'hoy', 'ayer', o 'YYYY-MM-DD'
});
export type ControlDiasInput = z.infer<typeof ControlDiasInput>;

export const ConsultarEstadisticasInput = z.object({
  periodo: z.enum(['semana', 'mes']).default('semana'),
});
export type ConsultarEstadisticasInput = z.infer<typeof ConsultarEstadisticasInput>;

export const CrearProductoInput = z.object({
  nombre: z.string().trim().min(1, 'Falta el nombre del producto'),
  precio_unitario: z.number().positive('El precio unitario debe ser mayor a 0'),
  precio_docena: z.number().positive('El precio de docena debe ser mayor a 0').optional(),
  categoria: z.string().trim().default('empanadas'),
});
export type CrearProductoInput = z.infer<typeof CrearProductoInput>;

export const CrearPromoInput = z.object({
  nombre: z.string().trim().min(1, 'Falta el nombre de la promo'),
  precio: z.number().positive('El precio debe ser mayor a 0'),
  descripcion: z.string().trim().optional(),
});
export type CrearPromoInput = z.infer<typeof CrearPromoInput>;

export const ConsultarMenuInput = z.object({
  categoria: z.string().trim().optional(),
});
export type ConsultarMenuInput = z.infer<typeof ConsultarMenuInput>;

export const HistorialVentasInput = z.object({
  limite: z.number().int().min(1).max(20).default(10),
});
export type HistorialVentasInput = z.infer<typeof HistorialVentasInput>;

export const EmptyInput = z.object({}).strict();
export type EmptyInput = z.infer<typeof EmptyInput>;
