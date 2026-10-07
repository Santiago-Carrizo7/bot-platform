import type { Business, BusinessStatus } from './entities.js';
import type { CreateBusinessData, IBusinessRepository } from '../persistence/repositories.js';

export class BusinessService {
  constructor(private readonly businesses: IBusinessRepository) {}

  async getById(id: string): Promise<Business | null> {
    return this.businesses.findById(id);
  }

  /** Todos los negocios (uso interno del admin web, nunca por tenant). */
  async listAll(): Promise<Business[]> {
    return this.businesses.listAll();
  }

  async create(data: CreateBusinessData): Promise<Business> {
    return this.businesses.create(data);
  }

  async markTrialStarted(id: string, at: Date = new Date()): Promise<void> {
    await this.businesses.markTrialStarted(id, at);
  }

  async setStatus(id: string, status: BusinessStatus): Promise<void> {
    await this.businesses.setStatus(id, status);
  }
}
