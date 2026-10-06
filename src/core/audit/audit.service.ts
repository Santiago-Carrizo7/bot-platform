import type { AuditEntry } from '../tenant/entities.js';
import type { IAuditRepository, ILogAuditData } from '../persistence/repositories.js';

export class AuditService {
  constructor(private readonly audit: IAuditRepository) {}

  async log(entry: ILogAuditData): Promise<AuditEntry> {
    return this.audit.log(entry);
  }

  async listByBusiness(businessId: string, limit = 50): Promise<AuditEntry[]> {
    return this.audit.listByBusiness(businessId, limit);
  }
}
