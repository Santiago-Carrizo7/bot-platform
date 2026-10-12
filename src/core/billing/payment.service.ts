import type { ManualPayment } from '../tenant/entities.js';
import type { CreateManualPaymentData, IPaymentRepository } from '../persistence/repositories.js';

/**
 * Cobros manuales (sin pasarela). Reglas:
 * - Un pago registrado NO cambia el estado del negocio (lo hace un operador
 *   aparte con `setStatus`, auditado).
 * - Sin borrado: los errores se corrigen anulando (`VOID` + motivo).
 * - Anti doble-envío: `idempotencyKey` único por negocio; si ya existe se
 *   devuelve el registro original sin crear otro.
 */
export class PaymentService {
  constructor(private readonly payments: IPaymentRepository) {}

  async register(data: CreateManualPaymentData): Promise<{ payment: ManualPayment; duplicate: boolean }> {
    const existing = await this.payments.findByIdempotency(data.businessId, data.idempotencyKey);
    if (existing) return { payment: existing, duplicate: true };
    const payment = await this.payments.create(data);
    return { payment, duplicate: false };
  }

  async listByBusiness(businessId: string, limit = 100): Promise<ManualPayment[]> {
    return this.payments.listByBusiness(businessId, limit);
  }

  async listRecent(limit = 50): Promise<ManualPayment[]> {
    return this.payments.listRecent(limit);
  }

  async getById(id: string): Promise<ManualPayment | null> {
    return this.payments.findById(id);
  }

  async void(id: string, reason: string): Promise<ManualPayment> {
    return this.payments.voidPayment(id, reason);
  }
}
