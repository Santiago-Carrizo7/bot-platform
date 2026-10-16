import { z } from 'zod';

const MAX_MONEY = 999_999_999.99;
const MAX_MONEY_MSG = 'El monto supera el límite permitido';

const VentaItemSchema = z.preprocess((val: any) => {
  if (typeof val === 'object' && val !== null) {
    return {
      nombre: val.nombre ?? val.name,
      cantidad: val.cantidad ?? val.quantity,
      precio_unitario: val.precio_unitario ?? val.unitPrice ?? val.unit_price,
    };
  }
  return val;
}, z.object({
  nombre: z.string().trim().min(1, 'Falta el nombre del producto o promo'),
  cantidad: z.number().positive('La cantidad debe ser mayor a 0').default(1),
  precio_unitario: z.number().min(0).max(MAX_MONEY, MAX_MONEY_MSG).nullable().optional(),
}));

const NoReconocidoSchema = z.object({
  texto: z.string().trim().min(1),
  cantidad: z.number().optional(),
  sugerencia: z.string().trim().nullable().optional(),
});

export const RegistrarVentaInput = z
  .object({
    items: z.array(VentaItemSchema).default([]),
    no_reconocidos: z.array(NoReconocidoSchema).optional(),
    zona_envio: z.string().trim().nullable().optional(),
    flete_monto: z.number().min(0).max(MAX_MONEY, MAX_MONEY_MSG).nullable().optional(),
    zona_no_reconocida: z.string().trim().nullable().optional(),
    nota: z.string().trim().nullable().optional(),
    fecha: z.string().trim().optional(), // 'YYYY-MM-DD'
    _modifying: z.boolean().optional(),
    _awaitingCustomDate: z.boolean().optional(),
    _awaitingManualFee: z.boolean().optional(),
    _awaitingDelivery: z.boolean().optional(),
    _awaitingItemPriceIndex: z.number().int().min(0).nullable().optional(),
    _awaitingItemPriceFor: z.string().trim().nullable().optional(),
    _uncataloguedZeroItems: z.array(z.any()).optional(),
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
      const GENERIC_QUANTIFIERS = new Set(['docena', 'una docena', '1 docena', 'media docena', 'docenas', 'empanada', 'empanadas']);
      const filteredNoRec = data.no_reconocidos?.filter(
        (n) => !GENERIC_QUANTIFIERS.has(n.texto.trim().toLowerCase())
      );
      if (filteredNoRec && filteredNoRec.length > 0) {
        const hasSuggestion = filteredNoRec.some((n) => n.sugerencia != null && n.sugerencia.trim() !== '');
        if (!hasSuggestion) {
          const bullets = filteredNoRec.map((n) => `• ${n.texto}`).join('\n');
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `⚠️ No reconocí estos productos en la carta:\n${bullets}\n\nPor favor repetí el pedido usando los nombres del menú o consultá /menu.`,
          });
          return;
        }
        // Si hay al menos una sugerencia, se permite continuar a CONFIRMING para ofrecer desambiguación.
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

export const CrearEditarPromoInput = z.object({
  promo_id: z.string().trim().optional(),
  nombre: z.string().trim().optional(),
  precio: z.number().positive().max(MAX_MONEY, MAX_MONEY_MSG).optional(),
  descripcion: z.string().trim().optional(),
});
export type CrearEditarPromoInput = z.infer<typeof CrearEditarPromoInput>;

export const AnularVentaInput = z.object({
  sale_id: z.string().trim().optional(),
  motivo: z.string().trim().optional(),
});
export type AnularVentaInput = z.infer<typeof AnularVentaInput>;

export const CambiarPrecioInput = z
  .object({
    product_id: z.string().trim().optional(),
    nombre: z.string().trim().optional(),
    precio_unitario: z.number().positive('El precio debe ser mayor a 0').max(MAX_MONEY, MAX_MONEY_MSG).optional(),
    precio_docena: z.number().positive('El precio de la docena debe ser mayor a 0').max(MAX_MONEY, MAX_MONEY_MSG).optional(),
    precio_media_docena: z.number().positive('El precio de media docena debe ser mayor a 0').max(MAX_MONEY, MAX_MONEY_MSG).optional(),
  })
  .refine(
    (v) =>
      (!v.nombre && !v.product_id) ||
      v.precio_unitario !== undefined ||
      v.precio_docena !== undefined ||
      v.precio_media_docena !== undefined,
    {
      message: 'Tenés que indicar al menos un precio nuevo (unitario, media docena o docena)',
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
  precio_unitario: z.number().positive('El precio unitario debe ser mayor a 0').max(MAX_MONEY, MAX_MONEY_MSG),
  precio_docena: z.number().positive('El precio de docena debe ser mayor a 0').max(MAX_MONEY, MAX_MONEY_MSG).optional(),
  precio_media_docena: z.number().positive('El precio de media docena debe ser mayor a 0').max(MAX_MONEY, MAX_MONEY_MSG).optional(),
  categoria: z.string().trim().default('empanadas'),
});
export type CrearProductoInput = z.infer<typeof CrearProductoInput>;

export const CrearPromoInput = z.object({
  nombre: z.string().trim().min(1, 'Falta el nombre de la promo'),
  precio: z.number().positive('El precio debe ser mayor a 0').max(MAX_MONEY, MAX_MONEY_MSG),
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

export const ZonaEnvioLoteItemSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre de la zona es obligatorio'),
  precio: z.number().min(0, 'El precio no puede ser negativo').max(MAX_MONEY, MAX_MONEY_MSG),
  barrios: z.array(z.string().trim().toLowerCase()).default([]),
});
export type ZonaEnvioLoteItemSchema = z.infer<typeof ZonaEnvioLoteItemSchema>;

export const ConfigurarEnviosLoteInput = z.object({
  zonas: z.array(ZonaEnvioLoteItemSchema).min(1, 'Debe incluir al menos una zona de envío'),
});
export type ConfigurarEnviosLoteInput = z.infer<typeof ConfigurarEnviosLoteInput>;

export const GestionarEnviosInput = z.object({
  zone_id: z.string().trim().optional(),
  nuevo_precio: z.number().min(0).max(MAX_MONEY, MAX_MONEY_MSG).optional(),
});
export type GestionarEnviosInput = z.infer<typeof GestionarEnviosInput>;

export const BebidaLoteItemSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre de la bebida es obligatorio'),
  precio: z.number().positive('El precio debe ser mayor a 0').max(MAX_MONEY, MAX_MONEY_MSG),
});
export type BebidaLoteItemSchema = z.infer<typeof BebidaLoteItemSchema>;

export const ConfigurarBebidasLoteInput = z.object({
  bebidas: z.array(BebidaLoteItemSchema).min(1, 'Debe incluir al menos una bebida'),
});
export type ConfigurarBebidasLoteInput = z.infer<typeof ConfigurarBebidasLoteInput>;

export const GestionarBebidasInput = z.object({
  product_id: z.string().trim().optional(),
  nuevo_precio: z.number().positive().max(MAX_MONEY, MAX_MONEY_MSG).optional(),
});
export type GestionarBebidasInput = z.infer<typeof GestionarBebidasInput>;

export const GestionarCatalogoInput = z.object({
  categoria: z.string().trim().optional(),
  producto_id: z.string().trim().optional(),
  nombre: z.string().trim().optional(),
  nueva_categoria: z.string().trim().optional(),
  _newCategoryName: z.string().trim().optional(),
  _priceUnit: z.number().positive().max(MAX_MONEY, MAX_MONEY_MSG).optional(),
  _priceDozen: z.number().positive().max(MAX_MONEY, MAX_MONEY_MSG).nullable().optional(),
});
export type GestionarCatalogoInput = z.infer<typeof GestionarCatalogoInput>;

export const ProductoNuevoInput = z.object({
  nombre: z.string().trim().optional(),
  categoria: z.string().trim().optional(),
  precio_unitario: z.number().positive('El precio unitario debe ser mayor a 0').max(MAX_MONEY, MAX_MONEY_MSG).optional(),
  precio_docena: z.number().positive('El precio de docena debe ser mayor a 0').max(MAX_MONEY, MAX_MONEY_MSG).nullable().optional(),
  precio_media_docena: z.number().positive('El precio de media docena debe ser mayor a 0').max(MAX_MONEY, MAX_MONEY_MSG).nullable().optional(),
  _step: z.string().optional(),
  _awaitingNewCategoryText: z.boolean().optional(),
});
export type ProductoNuevoInput = z.infer<typeof ProductoNuevoInput>;


