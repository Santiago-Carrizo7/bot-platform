import type { Prisma, PrismaClient, RotiseriaDeliveryZone } from '@prisma/client';
import type { CreateDeliveryZoneData, UpdateDeliveryZoneData } from '../types.js';

type Db = PrismaClient | Prisma.TransactionClient;

export function normalizeDeliveryText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export class DeliveryZoneRepository {
  constructor(private readonly db: PrismaClient) {}

  private client(tx?: Prisma.TransactionClient): Db {
    return tx ?? this.db;
  }

  async createZone(data: CreateDeliveryZoneData, tx?: Prisma.TransactionClient): Promise<RotiseriaDeliveryZone> {
    return this.client(tx).rotiseriaDeliveryZone.create({
      data: {
        businessId: data.businessId,
        name: data.name.trim(),
        price: data.price,
        barrios: data.barrios?.map((b) => b.trim().toLowerCase()).filter(Boolean) ?? [],
        isActive: true,
      },
    });
  }

  async upsertBatch(
    businessId: string,
    zones: Array<{ name: string; price: number; barrios: string[] }>,
    tx?: Prisma.TransactionClient
  ): Promise<RotiseriaDeliveryZone[]> {
    const results: RotiseriaDeliveryZone[] = [];
    const client = this.client(tx);

    for (const z of zones) {
      const normalizedBarrios = z.barrios.map((b) => b.trim().toLowerCase()).filter(Boolean);
      const res = await client.rotiseriaDeliveryZone.upsert({
        where: {
          businessId_name: {
            businessId,
            name: z.name.trim(),
          },
        },
        create: {
          businessId,
          name: z.name.trim(),
          price: z.price,
          barrios: normalizedBarrios,
          isActive: true,
        },
        update: {
          price: z.price,
          barrios: normalizedBarrios,
          isActive: true,
        },
      });
      results.push(res);
    }

    return results;
  }

  async listActive(businessId: string, tx?: Prisma.TransactionClient): Promise<RotiseriaDeliveryZone[]> {
    return this.client(tx).rotiseriaDeliveryZone.findMany({
      where: {
        businessId,
        isActive: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async findByName(
    businessId: string,
    name: string,
    tx?: Prisma.TransactionClient
  ): Promise<RotiseriaDeliveryZone | null> {
    return this.client(tx).rotiseriaDeliveryZone.findFirst({
      where: {
        businessId,
        name: { equals: name.trim(), mode: 'insensitive' },
        isActive: true,
      },
    });
  }

  async findById(
    id: string,
    businessId: string,
    tx?: Prisma.TransactionClient
  ): Promise<RotiseriaDeliveryZone | null> {
    return this.client(tx).rotiseriaDeliveryZone.findFirst({
      where: { id, businessId },
    });
  }

  async findMatching(
    businessId: string,
    query: string,
    tx?: Prisma.TransactionClient
  ): Promise<RotiseriaDeliveryZone | null> {
    const normalizedTarget = normalizeDeliveryText(query);
    if (!normalizedTarget) return null;

    const activeZones = await this.listActive(businessId, tx);

    // 1. Coincidencia exacta con el nombre de la zona
    const exactNameMatch = activeZones.find(
      (z) => normalizeDeliveryText(z.name) === normalizedTarget
    );
    if (exactNameMatch) return exactNameMatch;

    // 2. Coincidencia exacta con alguno de los barrios
    const exactBarrioMatch = activeZones.find((z) =>
      z.barrios.some((b) => normalizeDeliveryText(b) === normalizedTarget)
    );
    if (exactBarrioMatch) return exactBarrioMatch;

    // 3. Substring match en nombre de la zona
    const subNameMatch = activeZones.find(
      (z) =>
        normalizedTarget.includes(normalizeDeliveryText(z.name)) ||
        normalizeDeliveryText(z.name).includes(normalizedTarget)
    );
    if (subNameMatch) return subNameMatch;

    // 4. Substring match en alguno de los barrios
    const subBarrioMatch = activeZones.find((z) =>
      z.barrios.some(
        (b) =>
          normalizedTarget.includes(normalizeDeliveryText(b)) ||
          normalizeDeliveryText(b).includes(normalizedTarget)
      )
    );
    if (subBarrioMatch) return subBarrioMatch;

    return null;
  }

  async updateZone(
    id: string,
    businessId: string,
    data: UpdateDeliveryZoneData,
    tx?: Prisma.TransactionClient
  ): Promise<RotiseriaDeliveryZone> {
    return this.client(tx).rotiseriaDeliveryZone.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name.trim() } : {}),
        ...(data.price !== undefined ? { price: data.price } : {}),
        ...(data.barrios !== undefined
          ? { barrios: data.barrios.map((b) => b.trim().toLowerCase()).filter(Boolean) }
          : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
  }

  async deactivate(id: string, businessId: string, tx?: Prisma.TransactionClient): Promise<RotiseriaDeliveryZone> {
    return this.client(tx).rotiseriaDeliveryZone.update({
      where: { id },
      data: { isActive: false },
    });
  }
}
