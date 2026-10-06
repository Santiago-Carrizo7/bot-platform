import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __botPlatformPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.__botPlatformPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__botPlatformPrisma = prisma;
}
