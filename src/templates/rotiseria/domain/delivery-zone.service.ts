import type { RotiseriaDeliveryZone } from '@prisma/client';
import type { DeliveryZoneRepository } from '../persistence/delivery-zone.repo.js';
import type {
  CreateDeliveryZoneData,
  DeliveryZoneItem,
  DeliveryZoneMatchResult,
  UpdateDeliveryZoneData,
} from '../types.js';
import { round2 } from '../format.js';
import { normalizeDeliveryText } from '../persistence/delivery-zone.repo.js';

export function mapZoneToItem(zone: RotiseriaDeliveryZone): DeliveryZoneItem {
  return {
    id: zone.id,
    name: zone.name,
    price: round2(Number(zone.price)),
    barrios: zone.barrios,
    isActive: zone.isActive,
  };
}

export class DeliveryZoneService {
  constructor(private readonly repo: DeliveryZoneRepository) {}

  async listActive(businessId: string): Promise<DeliveryZoneItem[]> {
    const zones = await this.repo.listActive(businessId);
    return zones.map(mapZoneToItem);
  }

  async findById(id: string, businessId: string): Promise<DeliveryZoneItem | null> {
    const zone = await this.repo.findById(id, businessId);
    return zone ? mapZoneToItem(zone) : null;
  }

  async updateZonePrice(id: string, businessId: string, price: number): Promise<DeliveryZoneItem> {
    return this.updateZone(id, businessId, { price });
  }

  async listFormatted(businessId: string): Promise<string> {
    const zones = await this.listActive(businessId);
    if (zones.length === 0) {
      return 'Todavía no tenés zonas de envío configuradas.';
    }
    const lines: string[] = ['🛵 *Zonas y Tarifas de Envíos*', ''];
    for (const z of zones) {
      const feeStr = z.price === 0 ? '¡GRATIS! ($0)' : `$ ${new Intl.NumberFormat('es-AR').format(z.price)}`;
      lines.push(`• *${z.name}* — ${feeStr}`);
      if (z.barrios.length > 0) {
        const capitalizedBarrios = z.barrios
          .map((b) => b.charAt(0).toUpperCase() + b.slice(1))
          .join(', ');
        lines.push(`  Barrios: ${capitalizedBarrios}`);
      }
    }
    return lines.join('\n');
  }

  async findMatching(businessId: string, query: string): Promise<DeliveryZoneItem | null> {
    const zone = await this.repo.findMatching(businessId, query);
    return zone ? mapZoneToItem(zone) : null;
  }

  async matchZoneWithDetails(
    businessId: string,
    query: string
  ): Promise<DeliveryZoneMatchResult | null> {
    const normalizedTarget = normalizeDeliveryText(query);
    if (!normalizedTarget) return null;

    const zones = await this.repo.listActive(businessId);

    // 1. Exact match on zone name
    const exactNameMatch = zones.find(
      (z) => normalizeDeliveryText(z.name) === normalizedTarget
    );
    if (exactNameMatch) {
      return {
        zone: mapZoneToItem(exactNameMatch),
        matchedBy: 'name',
        matchedTerm: exactNameMatch.name,
      };
    }

    // 2. Exact match on a barrio
    for (const z of zones) {
      const matchedBarrio = z.barrios.find(
        (b) => normalizeDeliveryText(b) === normalizedTarget
      );
      if (matchedBarrio) {
        return {
          zone: mapZoneToItem(z),
          matchedBy: 'barrio',
          matchedTerm: matchedBarrio,
        };
      }
    }

    // 3. Substring match on zone name
    const subNameMatch = zones.find(
      (z) =>
        normalizedTarget.includes(normalizeDeliveryText(z.name)) ||
        normalizeDeliveryText(z.name).includes(normalizedTarget)
    );
    if (subNameMatch) {
      return {
        zone: mapZoneToItem(subNameMatch),
        matchedBy: 'name',
        matchedTerm: subNameMatch.name,
      };
    }

    // 4. Substring match on barrio
    for (const z of zones) {
      const matchedBarrio = z.barrios.find(
        (b) =>
          normalizedTarget.includes(normalizeDeliveryText(b)) ||
          normalizeDeliveryText(b).includes(normalizedTarget)
      );
      if (matchedBarrio) {
        return {
          zone: mapZoneToItem(z),
          matchedBy: 'barrio',
          matchedTerm: matchedBarrio,
        };
      }
    }

    return null;
  }

  async upsertBatch(
    businessId: string,
    zones: Array<{ name?: string; nombre?: string; price?: number; precio?: number; barrios?: string[] }>
  ): Promise<DeliveryZoneItem[]> {
    const normalizedZones = zones.map((z) => ({
      name: (z.name ?? z.nombre ?? '').trim(),
      price: z.price ?? z.precio ?? 0,
      barrios: z.barrios ?? [],
    }));
    const updated = await this.repo.upsertBatch(businessId, normalizedZones);
    return updated.map(mapZoneToItem);
  }

  async createZone(data: CreateDeliveryZoneData): Promise<DeliveryZoneItem> {
    const created = await this.repo.createZone(data);
    return mapZoneToItem(created);
  }

  async updateZone(
    id: string,
    businessId: string,
    data: UpdateDeliveryZoneData
  ): Promise<DeliveryZoneItem> {
    const updated = await this.repo.updateZone(id, businessId, data);
    return mapZoneToItem(updated);
  }

  async deactivate(id: string, businessId: string): Promise<DeliveryZoneItem> {
    const deactivated = await this.repo.deactivate(id, businessId);
    return mapZoneToItem(deactivated);
  }
}
