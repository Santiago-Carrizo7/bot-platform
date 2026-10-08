import { describe, expect, it } from 'vitest';
import { getEarlyMorningContext } from '../src/core/tenant/early-morning.js';
import { handleCallback, handleText, type FlowDeps, type ResolutionInfo } from '../src/core/messaging/flow.js';
import { buildKioscoActions } from '../src/templates/kiosco/actions.js';
import { CashService } from '../src/templates/kiosco/domain/cash.service.js';
import { AuditService } from '../src/core/audit/audit.service.js';
import type { MoneyMovement } from '@prisma/client';
import {
  FakeAiUsageRepo,
  FakeAuditRepo,
  FakeBusinessRepo,
  FakeConversationRepo,
  FakeMembershipRepo,
  makeBusiness,
} from './fakes.js';
import type { TenantContext } from '../src/core/tenant/entities.js';

let seq = 0;
const nid = (p: string) => `${p}-${++seq}`;

class FakeCashRepo {
  public movements: MoneyMovement[] = [];

  async addMovement(data: {
    businessId: string;
    userId: string;
    kind: 'IN' | 'OUT';
    amount: number;
    concept: string;
    category?: string;
    date?: Date;
  }) {
    const m = {
      id: nid('mov'),
      businessId: data.businessId,
      userId: data.userId,
      kind: data.kind,
      amount: data.amount as unknown as MoneyMovement['amount'],
      concept: data.concept,
      category: data.category ?? null,
      date: data.date ?? new Date(),
      relatedType: null,
      relatedId: null,
      createdAt: new Date(),
    } as MoneyMovement;
    this.movements.push(m);
    return m;
  }

  async getTotalsByDateRange(businessId: string, start: Date, end: Date) {
    const filtered = this.movements.filter(
      (m) => m.businessId === businessId && m.date >= start && m.date <= end
    );
    const inM = filtered.filter((m) => m.kind === 'IN');
    const outM = filtered.filter((m) => m.kind === 'OUT');
    return {
      totalIn: inM.reduce((acc, m) => acc + Number(m.amount), 0),
      countIn: inM.length,
      totalOut: outM.reduce((acc, m) => acc + Number(m.amount), 0),
      countOut: outM.length,
    };
  }

  async undoLastMovement() {
    return this.movements.pop() ?? null;
  }

  async listRecent() {
    return [...this.movements].reverse();
  }
}

describe('Early Morning Context & Caja Comercial Nocturna (00:00 a 05:00)', () => {
  it('detecta correctamente la ventana de madrugada en zona horaria Argentina', () => {
    // 04:45 UTC = 01:45 en Argentina (UTC-3)
    const at0145 = new Date('2026-10-09T04:45:00.000Z');
    const ctx0145 = getEarlyMorningContext(at0145, 'America/Argentina/Buenos_Aires');
    expect(ctx0145.isEarlyMorning).toBe(true);
    expect(ctx0145.timeStr).toBe('01:45 hs');
    expect(ctx0145.todayLabel.toLowerCase()).toContain('viernes 9');
    expect(ctx0145.yesterdayLabel.toLowerCase()).toContain('jueves 8');

    // 03:00 UTC = 00:00 medianoche en Argentina
    const at0000 = new Date('2026-10-09T03:00:00.000Z');
    const ctx0000 = getEarlyMorningContext(at0000, 'America/Argentina/Buenos_Aires');
    expect(ctx0000.isEarlyMorning).toBe(true);
    expect(ctx0000.timeStr).toBe('00:00 hs');

    // 07:59 UTC = 04:59 en Argentina
    const at0459 = new Date('2026-10-09T07:59:00.000Z');
    const ctx0459 = getEarlyMorningContext(at0459, 'America/Argentina/Buenos_Aires');
    expect(ctx0459.isEarlyMorning).toBe(true);

    // 08:00 UTC = 05:00 en Argentina -> Ya no es madrugada comercial
    const at0500 = new Date('2026-10-09T08:00:00.000Z');
    const ctx0500 = getEarlyMorningContext(at0500, 'America/Argentina/Buenos_Aires');
    expect(ctx0500.isEarlyMorning).toBe(false);

    // 18:00 UTC = 15:00 en Argentina
    const at1500 = new Date('2026-10-09T18:00:00.000Z');
    const ctx1500 = getEarlyMorningContext(at1500, 'America/Argentina/Buenos_Aires');
    expect(ctx1500.isEarlyMorning).toBe(false);
  });

  it('flujo en madrugada: pregunta contextual con botones de ayer y hoy, y confirmación a ayer', async () => {
    const fakeCash = new FakeCashRepo();
    const cash = new CashService(fakeCash as any);
    const actions = buildKioscoActions({ cash });

    const business = makeBusiness({ id: 'biz-nocturno', timezone: 'America/Argentina/Buenos_Aires' });
    const tenant: TenantContext = {
      business,
      membership: {
        id: 'm-1',
        businessId: business.id,
        userId: 'u-1',
        role: 'OWNER',
        createdAt: new Date(),
      },
    };

    const resolution: ResolutionInfo = {
      user: { id: 'u-1', telegramId: 'tg-1', createdAt: new Date() },
      tenant,
      justJoined: false,
      memberships: [{ ...tenant.membership, business }],
      needsInvitation: false,
    };

    const conversations = new FakeConversationRepo();
    const auditRepo = new FakeAuditRepo();
    const audit = new AuditService(auditRepo);

    const deps: FlowDeps = {
      template: {
        id: 'kiosco',
        name: 'Kiosco',
        actions,
        menu: [],
      },
      interpreter: {} as any,
      conversations,
      businesses: new FakeBusinessRepo(),
      membershipRepo: new FakeMembershipRepo(),
      audit,
      invitations: {} as any,
      aiUsage: new FakeAiUsageRepo(),
      aiProviderName: 'test',
      aiModel: 'test',
    };

    // 01:30 AM en Argentina (04:30 UTC del 9 de octubre)
    const at0130 = new Date('2026-10-09T04:30:00.000Z');

    // 1. El usuario intenta registrar un lote o venta que entra a confirmación
    // Guardamos estado pendiente (como haría la foto o un comando)
    await conversations.upsert({
      businessId: business.id,
      userId: 'u-1',
      phase: 'CONFIRMING',
      actionName: 'registrar_lote',
      data: {
        items: [
          { tipo: 'VENTA', monto: 12000, nota: 'Cierre turno' },
          { tipo: 'GASTO', monto: 3500, concepto: 'Proveedor Coca' },
        ],
      },
      expiresAt: new Date(at0130.getTime() + 600_000),
      updatedAt: at0130,
    });

    // 2. El usuario presiona el botón "Ayer"
    const reply = await handleCallback(deps, {
      resolution,
      data: 'confirm:yesterday',
      now: at0130,
    });

    expect(reply.text).toContain('Lote registrado con éxito (caja de ayer)');
    expect(fakeCash.movements).toHaveLength(2);

    // La fecha del movimiento debe ser un día anterior al 9 de octubre (8 de octubre)
    const movDate = fakeCash.movements[0].date;
    expect(movDate.toISOString()).toContain('2026-10-08');

    // 3. Consultar resumen de ayer
    const resumenAction = actions.find((a) => a.name === 'consultar_resumen')!;
    const resumenAyer = await resumenAction.handler(
      { tenant, actorUserId: 'u-1', now: at0130 },
      { periodo: 'ayer' }
    );
    expect(resumenAyer.reply).toContain('Resumen de ayer');
    expect(resumenAyer.reply).toContain('12.000');
    expect(resumenAyer.reply).toContain('3.500');
  });

  it('flujo en madrugada: confirmación a hoy registra con la fecha actual', async () => {
    const fakeCash = new FakeCashRepo();
    const cash = new CashService(fakeCash as any);
    const actions = buildKioscoActions({ cash });

    const business = makeBusiness({ id: 'biz-nocturno', timezone: 'America/Argentina/Buenos_Aires' });
    const tenant: TenantContext = {
      business,
      membership: {
        id: 'm-1',
        businessId: business.id,
        userId: 'u-1',
        role: 'OWNER',
        createdAt: new Date(),
      },
    };

    const resolution: ResolutionInfo = {
      user: { id: 'u-1', telegramId: 'tg-1', createdAt: new Date() },
      tenant,
      justJoined: false,
      memberships: [{ ...tenant.membership, business }],
      needsInvitation: false,
    };

    const conversations = new FakeConversationRepo();
    const auditRepo = new FakeAuditRepo();
    const audit = new AuditService(auditRepo);

    const deps: FlowDeps = {
      template: {
        id: 'kiosco',
        name: 'Kiosco',
        actions,
        menu: [],
      },
      interpreter: {} as any,
      conversations,
      businesses: new FakeBusinessRepo(),
      membershipRepo: new FakeMembershipRepo(),
      audit,
      invitations: {} as any,
      aiUsage: new FakeAiUsageRepo(),
      aiProviderName: 'test',
      aiModel: 'test',
    };

    const at0130 = new Date('2026-10-09T04:30:00.000Z');

    await conversations.upsert({
      businessId: business.id,
      userId: 'u-1',
      phase: 'CONFIRMING',
      actionName: 'registrar_venta',
      data: { monto: 4500, nota: 'Kiosco 24hs venta nocturna' },
      expiresAt: new Date(at0130.getTime() + 600_000),
      updatedAt: at0130,
    });

    // El usuario elige "Hoy"
    const reply = await handleCallback(deps, {
      resolution,
      data: 'confirm:today',
      now: at0130,
    });

    expect(reply.text).toContain('Venta registrada');
    expect(fakeCash.movements).toHaveLength(1);
    expect(fakeCash.movements[0].date.toISOString()).toContain('2026-10-09');
  });
});
