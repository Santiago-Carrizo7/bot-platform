import type { User } from '../tenant/entities.js';
import type { IUserRepository } from '../persistence/repositories.js';

export class UserService {
  constructor(private readonly users: IUserRepository) {}

  async getOrCreateByTelegramId(telegramId: string): Promise<User> {
    const existing = await this.users.findByTelegramId(telegramId);
    if (existing) return existing;
    return this.users.create(telegramId);
  }

  async getById(id: string): Promise<User | null> {
    return this.users.findById(id);
  }
}
