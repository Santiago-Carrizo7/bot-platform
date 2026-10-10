import { z } from 'zod';

const VentaItemSchema = z.object({
  nombre: z.string().trim().min(1, 'Falta el nombre del producto o promo'),
  cantidad: z.number().positive('La cantidad debe ser mayor a 0').default(1),
});

const NoReconocidoSchema = z.object({
  texto: z.string().trim().min(1),
  cantidad: z.number().optional(),
});

export const RegistrarVentaInput = z
  .object({
    items: z.array(VentaItemSchema).default([]),
    no_reconocidos: z.array(NoReconocidoSchema).optional(),
    nota: z.string().trim().optional(),
    fecha: z.string().trim().optional(), // 'YYYY-MM-DD'
    _modifying: z.boolean().optional(),
    _awaitingCustomDate: z.boolean().optional(),
    _futureDate: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    if (data._futureDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fecha'],
        message: '⚠️ La fecha no puede ser futura. Ingresá una fecha igual o anterior a la jornada actual (DD/MM/AAAA):',
      });
      return;
    }
    if (data.items.length === 0) {
      if (data.no_reconocidos && data.no_reconocidos.length > 0) {
        const bullets = data.no_reconocidos.map((n) => `• ${n.texto}`).join('\n');
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `⚠️ No reconocí estos productos en la carta:\n${bullets}\n\nPor favor repetí el pedido usando los nombres del menú o consultá /menu.`,
        });
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: 'La venta necesita al menos un producto o promo',
      });
    }
  });
export type RegistrarVentaInput = z.infer<typeof RegistrarVentaInput>;

export const AnularVentaInput = z.object({
  sale_id: z.string().trim().optional(),
  motivo: z.string().trim().optional(),
});
export type AnularVentaInput = z.infer<typeof AnularVentaInput>;

export const CambiarPrecioInput = z
  .object({
    product_id: z.string().trim().optional(),
    nombre: z.string().trim().optional(),
    precio_unitario: z.number().positive('El precio debe ser mayor a 0').optional(),
    precio_docena: z.number().positive('El precio de la docena debe ser mayor a 0').optional(),
  })
  .refine(
    (v) =>
      (!v.nombre && !v.product_id) ||
      v.precio_unitario !== undefined ||
      v.precio_docena !== undefined,
    {
      message: 'Tenés que indicar al menos un precio nuevo (unitario o docena)',
      path: ['precio_unitario'],
    }
  );
export type CambiarPrecioInput = z.infer<typeof CambiarPrecioInput>;

export const ControlDiasInput = z.object({
  fecha: z.string().trim().optional(), // 'hoy', 'ayer', o 'YYYY-MM-DD'
});
export type ControlDiasInput = z.infer<typeof ControlDiasInput>;

export const ConsultarEstadisticasInput = z.object({
  periodo: z.string().trim().default('esta_semana'),
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
