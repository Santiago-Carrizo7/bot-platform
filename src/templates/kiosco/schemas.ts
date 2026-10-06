import { z } from 'zod';

const VentaItemSchema = z.object({
  producto: z.string().trim().min(1, 'Falta el nombre del producto'),
  cantidad: z.number().positive('La cantidad debe ser mayor a 0').default(1),
});

export const RegistrarVentaInput = z.object({
  items: z.array(VentaItemSchema).min(1, 'La venta necesita al menos un producto'),
  nota: z.string().trim().optional(),
});
export type RegistrarVentaInput = z.infer<typeof RegistrarVentaInput>;

export const CrearProductoInput = z.object({
  nombre: z.string().trim().min(1, 'Falta el nombre del producto'),
  precio_venta: z.number().positive('El precio debe ser mayor a 0'),
  precio_costo: z.number().positive().optional(),
  stock_inicial: z.number().min(0, 'El stock no puede ser negativo').default(0),
  stock_minimo: z.number().min(0).optional(),
  unidad: z.string().trim().default('unidad'),
});
export type CrearProductoInput = z.infer<typeof CrearProductoInput>;

export const ModificarProductoInput = z.object({
  nombre_actual: z.string().trim().min(1, 'Falta el producto a modificar'),
  nuevo_nombre: z.string().trim().min(1).optional(),
  precio_venta: z.number().positive().optional(),
  precio_costo: z.number().positive().optional(),
  stock_minimo: z.number().min(0).optional(),
  unidad: z.string().trim().optional(),
});
export type ModificarProductoInput = z.infer<typeof ModificarProductoInput>;

export const EliminarProductoInput = z.object({
  nombre: z.string().trim().min(1, 'Falta el producto a eliminar'),
});
export type EliminarProductoInput = z.infer<typeof EliminarProductoInput>;

export const FijarStockInput = z.object({
  producto: z.string().trim().min(1, 'Falta el producto'),
  cantidad: z.number().min(0, 'El stock no puede ser negativo'),
});
export type FijarStockInput = z.infer<typeof FijarStockInput>;

export const RegistrarCompraInput = z
  .object({
    descripcion: z.string().trim().min(1, 'Falta la descripción'),
    monto: z.number().positive('El monto debe ser mayor a 0'),
    producto: z.string().trim().optional(),
    cantidad: z.number().positive().optional(),
  })
  .refine((v) => !v.cantidad || v.producto, {
    message: 'Si indicás cantidad, tenés que indicar el producto',
    path: ['producto'],
  });
export type RegistrarCompraInput = z.infer<typeof RegistrarCompraInput>;

export const RegistrarGastoInput = z.object({
  descripcion: z.string().trim().min(1, 'Falta la descripción'),
  monto: z.number().positive('El monto debe ser mayor a 0'),
});
export type RegistrarGastoInput = z.infer<typeof RegistrarGastoInput>;

export const RegistrarEntradaInput = z.object({
  descripcion: z.string().trim().min(1, 'Falta la descripción'),
  monto: z.number().positive('El monto debe ser mayor a 0'),
});
export type RegistrarEntradaInput = z.infer<typeof RegistrarEntradaInput>;

export const ConsultarStockInput = z.object({
  busqueda: z.string().trim().optional(),
  solo_bajos: z.boolean().default(false),
  limite: z.number().int().min(1).max(50).default(20),
});
export type ConsultarStockInput = z.infer<typeof ConsultarStockInput>;

export const ResumenMesInput = z.object({
  year: z.number().int().min(2000).max(2100).optional(),
  month: z.number().int().min(1).max(12).optional(),
});
export type ResumenMesInput = z.infer<typeof ResumenMesInput>;

export const HistorialVentasInput = z.object({
  limite: z.number().int().min(1).max(20).default(10),
});
export type HistorialVentasInput = z.infer<typeof HistorialVentasInput>;

export const EmptyInput = z.object({}).strict();
export type EmptyInput = z.infer<typeof EmptyInput>;
