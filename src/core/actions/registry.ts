import type { z } from 'zod';
import type { MembershipRole, TenantContext } from '../tenant/entities.js';

/** 'read' no necesita confirmación; 'write' siempre la requiere. */
export type ActionKind = 'read' | 'write';

export interface ActionContext {
  tenant: TenantContext;
  /** Usuario que ejecuta (actor, para auditoría). */
  actorUserId: string;
  now: Date;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface ContinuousStepResult {
  reply: {
    text: string;
    parseMode?: 'Markdown';
    inlineKeyboard?: InlineButton[][];
  };
  updatedData?: Record<string, unknown>;
  finished?: boolean;
}

export interface ActionResult {
  /** Texto de respuesta al usuario (Markdown permitido). */
  reply: string;
  inlineKeyboard?: InlineButton[][];
  audit?: {
    action: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  };
}

export interface ActionDef<TInput = unknown> {
  /** Nombre interno, whitelist estricta. Ej: 'registrar_venta'. */
  name: string;
  /** Descripción para el modelo de IA (qué hace y qué datos necesita). */
  description: string;
  kind: ActionKind;
  /**
   * Contrato validado SIEMPRE por código. Se tipa como ZodType<unknown> porque
   * los schemas con .default()/.optional() tienen Input distinto de Output.
   */
  input: z.ZodType<unknown>;
  /** Roles permitidos (por defecto ambos). */
  roles?: MembershipRole[];
  /** Texto introductorio al iniciar por menú/comando. */
  intro?: string;
  /** Prompts por campo faltante (clave = nombre del campo). */
  fieldPrompts?: Record<string, string>;
  /** Resumen de lo entendido, para la confirmación (obligatorio si write). */
  summarize?: (input: TInput) => string;
  handler: (ctx: ActionContext, input: TInput) => Promise<ActionResult>;
  /** Modo continuo: registro rápido secuencial sin confirmación individual. */
  isContinuous?: boolean;
  handleContinuousStep?: (
    ctx: ActionContext,
    text: string,
    data: Record<string, unknown>
  ) => Promise<ContinuousStepResult>;
}

export interface CommandDef {
  command: string;
  description: string;
  /** Acción que inicia (sin datos → pide lo necesario). */
  action?: string;
  /** Respuesta estática (si no hay acción). */
  reply?: string;
}

export interface MenuItem {
  label: string;
  action: string;
}

/**
 * Atajo del teclado persistente (reply keyboard). El tap llega como texto
 * y se mapea por igualdad exacta a la acción (determinístico, sin IA).
 */
export interface ReplyMenuItem {
  label: string;
  action: string;
}

export interface TemplateDefinition {
  id: string;
  label: string;
  welcome: (businessName: string, firstName?: string) => string;
  /**
   * Prompt de sistema para freestyle. `hints` trae contexto dinámico del negocio
   * (ej. categorías o productos disponibles), resuelto por `resolveHints`.
   */
  systemPrompt: (businessName: string, referenceDate: string, hints: string) => string;
  /**
   * Contexto dinámico por negocio para el prompt (opcional). Se ejecuta antes de
   * cada interpretación IA. Ej: "Categorías disponibles: comida, transporte, …".
   */
  resolveHints?: (tenant: TenantContext) => Promise<string>;
  actions: ActionDef<unknown>[];
  commands: CommandDef[];
  /**
   * Pista contextual que se agrega al /start, /menu y /ayuda (opcional).
   * Ej: guiar el alta inicial si el negocio todavía no tiene datos.
   */
  welcomeHint?: (tenant: TenantContext) => Promise<string | null>;
  menu: MenuItem[];
  /**
   * Barra persistente de atajos (reply keyboard). Pocos botones (4-6), con las
   * acciones más usadas en lenguaje del usuario. Si no se define, no hay barra.
   */
  replyMenu?: ReplyMenuItem[];
  /** Comandos que aparecen en el botón Menú de Telegram (base + template). */
  menuCommands?: { command: string; description: string }[];
}

export class ActionRegistry {
  private readonly byName = new Map<string, ActionDef<unknown>>();

  constructor(actions: ActionDef<unknown>[]) {
    for (const action of actions) {
      if (this.byName.has(action.name)) {
        throw new Error(`Acción duplicada en registry: ${action.name}`);
      }
      if (action.kind === 'write' && typeof action.summarize !== 'function') {
        throw new Error(`La acción de escritura '${action.name}' debe definir summarize()`);
      }
      this.byName.set(action.name, action);
    }
  }

  get(name: string): ActionDef<unknown> | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  list(): ActionDef<unknown>[] {
    return [...this.byName.values()];
  }
}
