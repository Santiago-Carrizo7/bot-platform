import { describe, expect, it } from 'vitest';
import {
  RegistrarVentaInput as KioscoVentaInput,
  RegistrarGastoInput as KioscoGastoInput,
  CalcularPrecioInput as KioscoPrecioInput,
  RegistrarLoteInput as KioscoLoteInput,
} from '../src/templates/kiosco/schemas.js';
import {
  RegistrarVentaInput as RotiseriaVentaInput,
  CrearProductoInput as RotiseriaProductoInput,
  CrearPromoInput as RotiseriaPromoInput,
  CambiarPrecioInput as RotiseriaPrecioInput,
} from '../src/templates/rotiseria/schemas.js';
import {
  RegistrarGastoInput as GastosInput,
  FijarPresupuestoInput as GastosPresupuestoInput,
} from '../src/templates/gastos/schemas.js';

describe('DATA-02: Límites numéricos máximos en Schemas Zod', () => {
  const OVERFLOW_AMOUNT = 1_000_000_000;
  const MAX_VALID_AMOUNT = 999_999_999.99;

  describe('Kiosco schemas', () => {
    it('rechaza montos mayores a 999_999_999.99 en venta directa y por array', () => {
      const resDirect = KioscoVentaInput.safeParse({ monto: OVERFLOW_AMOUNT });
      expect(resDirect.success).toBe(false);
      if (!resDirect.success) {
        expect(resDirect.error.issues[0].message).toContain('El monto supera el límite permitido');
      }

      const resArray = KioscoVentaInput.safeParse({ ventas: [{ monto: OVERFLOW_AMOUNT }] });
      expect(resArray.success).toBe(false);

      const resValid = KioscoVentaInput.safeParse({ monto: MAX_VALID_AMOUNT });
      expect(resValid.success).toBe(true);
    });

    it('rechaza montos en gasto y lote', () => {
      const resGasto = KioscoGastoInput.safeParse({ monto: OVERFLOW_AMOUNT });
      expect(resGasto.success).toBe(false);

      const resLote = KioscoLoteInput.safeParse({
        items: [{ tipo: 'VENTA', monto: OVERFLOW_AMOUNT }],
      });
      expect(resLote.success).toBe(false);

      const resCalc = KioscoPrecioInput.safeParse({ costo_total: OVERFLOW_AMOUNT });
      expect(resCalc.success).toBe(false);
    });
  });

  describe('Rotisería schemas', () => {
    it('rechaza precio unitario y flete que superen el límite en RegistrarVentaInput', () => {
      const resItem = RotiseriaVentaInput.safeParse({
        items: [{ nombre: 'Empanada', cantidad: 1, precio_unitario: OVERFLOW_AMOUNT }],
      });
      expect(resItem.success).toBe(false);

      const resFlete = RotiseriaVentaInput.safeParse({
        items: [{ nombre: 'Empanada', cantidad: 1, precio_unitario: 1000 }],
        flete_monto: OVERFLOW_AMOUNT,
      });
      expect(resFlete.success).toBe(false);
    });

    it('rechaza precio excesivo en creación de producto y promo', () => {
      const resProd = RotiseriaProductoInput.safeParse({
        nombre: 'Pizza',
        precio_unitario: OVERFLOW_AMOUNT,
      });
      expect(resProd.success).toBe(false);

      const resPromo = RotiseriaPromoInput.safeParse({
        nombre: 'Promo 1',
        precio: OVERFLOW_AMOUNT,
      });
      expect(resPromo.success).toBe(false);

      const resCambiar = RotiseriaPrecioInput.safeParse({
        nombre: 'Pizza',
        precio_unitario: OVERFLOW_AMOUNT,
      });
      expect(resCambiar.success).toBe(false);
    });
  });

  describe('Gastos schemas', () => {
    it('rechaza montos superiores al límite en RegistrarGastoInput y FijarPresupuestoInput', () => {
      const resGasto = GastosInput.safeParse({
        amount: OVERFLOW_AMOUNT,
        description: 'Super gasto',
      });
      expect(resGasto.success).toBe(false);
      if (!resGasto.success) {
        expect(resGasto.error.issues[0].message).toContain('El monto supera el límite permitido');
      }

      const resPresupuesto = GastosPresupuestoInput.safeParse({
        category: 'comida',
        amount: OVERFLOW_AMOUNT,
      });
      expect(resPresupuesto.success).toBe(false);

      const resValido = GastosInput.safeParse({
        amount: MAX_VALID_AMOUNT,
        description: 'Gasto legal',
      });
      expect(resValido.success).toBe(true);
    });
  });
});
