import type { RotiseriaProduct } from '@prisma/client';
import type { ActionDef, ActionContext, BotReply, InlineButton } from '../../../core/actions/registry.js';
import type { IConversationRepository, ILogAuditData } from '../../../core/persistence/repositories.js';
import type { ConversationState } from '../../../core/tenant/entities.js';
import { AppError } from '../../../core/errors/errors.js';
import { CatalogService } from '../domain/catalog.service.js';
import { GestionarCatalogoInput, ProductoNuevoInput } from '../schemas.js';
import { esc, formatCurrency, getCategoryIcon } from '../format.js';

export interface RotiseriaAdminDeps {
  catalog: CatalogService;
}

export function formatProductAdminCard(p: RotiseriaProduct, note?: string): { text: string; inlineKeyboard: InlineButton[][] } {
  const statusIcon = p.isActive ? '🟢' : '🔴';
  const statusLabel = p.isActive ? '🟢 Activo (visible en la carta)' : '🔴 Inactivo (dado de baja / oculto)';
  const catIcon = getCategoryIcon(p.category);

  const lines = [
    ...(note ? [`${note}`, ''] : []),
    `📦 *${esc(p.name)}*`,
    `• Categoría: ${catIcon} *${esc(p.category)}*`,
    `• Estado: *${statusLabel}*`,
    `• Precio unitario: *${formatCurrency(Number(p.priceUnit))}*`,
  ];

  if (p.priceHalfDozen) {
    lines.push(`• Media docena: *${formatCurrency(Number(p.priceHalfDozen))}*`);
  }
  if (p.priceDozen) {
    lines.push(`• Docena: *${formatCurrency(Number(p.priceDozen))}*`);
  }

  const buttons: InlineButton[][] = [
    [
      {
        text: p.isActive ? '🔴 Dar de baja' : '🟢 Activar',
        callbackData: `rotiseria:prod:toggle:${p.id}`,
      },
      {
        text: '✏️ Modificar categoría',
        callbackData: `rotiseria:prod:edit_cat:${p.id}`,
      },
    ],
    [
      {
        text: '💲 Cambiar precio',
        callbackData: `rotiseria:prod:edit_price:${p.id}`,
      },
      {
        text: '↩️ Volver al catálogo',
        callbackData: 'rotiseria:catalogo',
      },
    ],
  ];

  return {
    text: lines.join('\n'),
    inlineKeyboard: buttons,
  };
}

export async function formatCatalogView(
  catalog: CatalogService,
  businessId: string
): Promise<{ text: string; inlineKeyboard: InlineButton[][] }> {
  const grouped = await catalog.listAllProductsGrouped(businessId);

  if (grouped.size === 0) {
    return {
      text: [
        '📦 *Administración de Catálogo*',
        '',
        'Todavía no tenés productos cargados en el catálogo.',
        'Podés crear uno nuevo con /producto_nuevo o tocando el botón de abajo:',
      ].join('\n'),
      inlineKeyboard: [
        [{ text: '➕ Crear producto nuevo', callbackData: 'rotiseria:prod:nuevo' }],
      ],
    };
  }

  let totalCount = 0;
  let activeCount = 0;
  let inactiveCount = 0;

  for (const prods of grouped.values()) {
    for (const p of prods) {
      totalCount++;
      if (p.isActive) activeCount++;
      else inactiveCount++;
    }
  }

  const lines: string[] = [
    '📦 *Administración de Catálogo y Productos*',
    `_Total: ${totalCount} productos (${activeCount} activos, ${inactiveCount} inactivos)_`,
    '',
    'Seleccioná un producto para activar/desactivar, cambiar categoría o modificar precios:',
    '',
  ];

  const rows: InlineButton[][] = [
    [{ text: '➕ Cargar producto nuevo', callbackData: 'rotiseria:prod:nuevo' }],
  ];

  for (const [cat, prods] of grouped.entries()) {
    const icon = getCategoryIcon(cat);
    lines.push(`${icon} *${esc(cat.toUpperCase())}:*`);

    for (const p of prods) {
      const statusIcon = p.isActive ? '🟢' : '🔴';
      const docStr = p.priceDozen ? ` (doc. ${formatCurrency(Number(p.priceDozen))})` : '';
      lines.push(`  • ${esc(p.name)}: *${formatCurrency(Number(p.priceUnit))}*${docStr} [${statusIcon}]`);

      rows.push([
        {
          text: `${statusIcon} ${p.name} — ${formatCurrency(Number(p.priceUnit))}`,
          callbackData: `rotiseria:prod:ver:${p.id}`,
        },
      ]);
    }
    lines.push('');
  }

  rows.push([{ text: '❌ Cerrar', callbackData: 'rotiseria:catalogo:cerrar' }]);

  return {
    text: lines.join('\n').trim(),
    inlineKeyboard: rows,
  };
}

export function buildCatalogAdminActions(deps: RotiseriaAdminDeps): ActionDef<unknown>[] {
  const { catalog } = deps;

  const gestionarCatalogo: ActionDef<GestionarCatalogoInput> = {
    name: 'gestionar_catalogo',
    description:
      'Administra el catálogo completo de productos: ver activos e inactivos, dar de baja o activar, cambiar categoría y modificar precios.',
    kind: 'read',
    roles: ['OWNER'],
    input: GestionarCatalogoInput,
    handler: async (ctx, input) => {
      if (ctx.tenant.membership?.role !== 'OWNER') {
        return {
          reply: '⚠️ Solo el dueño del negocio puede administrar el catálogo.',
        };
      }

      const businessId = ctx.tenant.business.id;
      const targetCategory = input._newCategoryName || input.nueva_categoria;
      let targetProductId = input.producto_id;

      if (!targetProductId && input.nombre) {
        const found = await catalog.findProductByName(businessId, input.nombre);
        if (found) {
          targetProductId = found.id;
        } else {
          return {
            reply: `⚠️ No se encontró el producto *${esc(input.nombre)}* en el catálogo.`,
          };
        }
      }

      if (targetProductId && targetCategory) {
        const updated = await catalog.updateProductCategory(targetProductId, targetCategory);
        const card = formatProductAdminCard(
          updated,
          `✅ Categoría de *${esc(updated.name)}* actualizada a *${esc(updated.category)}*.`
        );
        return {
          reply: card.text,
          inlineKeyboard: card.inlineKeyboard,
          audit: {
            action: 'product.category_updated',
            entityType: 'rotiseria_product',
            entityId: updated.id,
            metadata: { name: updated.name, category: updated.category },
          },
        };
      }

      if (targetProductId && input._priceUnit !== undefined) {
        const updated = await catalog.updateProductPrice(targetProductId, {
          priceUnit: input._priceUnit,
          priceDozen: input._priceDozen,
        });
        const card = formatProductAdminCard(
          updated,
          `✅ Precio de *${esc(updated.name)}* actualizado a *${formatCurrency(Number(updated.priceUnit))}*.`
        );
        return {
          reply: card.text,
          inlineKeyboard: card.inlineKeyboard,
          audit: {
            action: 'product.price_updated',
            entityType: 'rotiseria_product',
            entityId: updated.id,
            metadata: { name: updated.name, priceUnit: Number(updated.priceUnit) },
          },
        };
      }

      if (targetProductId && !targetCategory && input._priceUnit === undefined) {
        const prod = await catalog.findProductById(targetProductId, businessId);
        if (prod) {
          const categories = await catalog.listCategories(businessId);
          const rows: InlineButton[][] = [];
          for (const cat of categories) {
            const icon = getCategoryIcon(cat);
            rows.push([
              {
                text: `${icon} ${cat}`,
                callbackData: `rotiseria:cat_set:${encodeURIComponent(cat)}`,
              },
            ]);
          }
          rows.push([
            { text: '➕ Escribir nueva categoría', callbackData: 'rotiseria:cat_new' },
          ]);
          rows.push([
            { text: '↩️ Volver', callbackData: `rotiseria:prod:ver:${prod.id}` },
          ]);

          return {
            reply: [
              `✏️ *Modificar categoría de ${esc(prod.name)}*`,
              `Categoría actual: *${esc(prod.category)}*`,
              '',
              'Elegí una categoría existente o escribí el nombre de una nueva en el chat:',
            ].join('\n'),
            inlineKeyboard: rows,
            continueInAction: {
              name: 'gestionar_catalogo',
              data: { _awaitingCategoryForId: prod.id, productName: prod.name },
            },
          };
        }
      }

      const view = await formatCatalogView(catalog, businessId);
      return {
        reply: view.text,
        inlineKeyboard: view.inlineKeyboard,
      };
    },
  };

  const productoNuevo: ActionDef<ProductoNuevoInput> = {
    name: 'producto_nuevo',
    description:
      'Flujo conversacional guiado para crear un producto nuevo en el catálogo: 1. Nombre, 2. Categoría, 3. Precio unitario, 4. Opcional precio docena/media docena.',
    kind: 'read',
    roles: ['OWNER'],
    input: ProductoNuevoInput,
    handler: async (ctx, input) => {
      if (ctx.tenant.membership?.role !== 'OWNER') {
        return {
          reply: '⚠️ Solo el dueño del negocio puede agregar productos al catálogo.',
        };
      }

      const businessId = ctx.tenant.business.id;

      // 1. Si ya viene con nombre y precio_unitario y _step === 'done' o no hay _step (ejecución directa o finalizada)
      if (input.nombre && input.precio_unitario && (input._step === 'done' || !input._step)) {
        const p = await catalog.createProduct(businessId, {
          name: input.nombre,
          category: input.categoria,
          priceUnit: input.precio_unitario,
          priceDozen: input.precio_docena,
          priceHalfDozen: input.precio_media_docena,
        });

        const halfStr = p.priceHalfDozen ? `\n• Media docena: *${formatCurrency(Number(p.priceHalfDozen))}*` : '';
        const dozenStr = p.priceDozen ? `\n• Docena: *${formatCurrency(Number(p.priceDozen))}*` : '';
        const catIcon = getCategoryIcon(p.category);

        return {
          reply: [
            '✅ *¡Producto creado con éxito!*',
            '',
            `📦 *${esc(p.name)}*`,
            `• Categoría: ${catIcon} *${esc(p.category)}*`,
            `• Precio unitario: *${formatCurrency(Number(p.priceUnit))}*${halfStr}${dozenStr}`,
            '',
            'Ya está disponible en la carta y en el catálogo.',
          ].join('\n'),
          inlineKeyboard: [
            [
              { text: '📦 Ver catálogo', callbackData: 'rotiseria:catalogo' },
              { text: '➕ Cargar otro producto', callbackData: 'rotiseria:prod:nuevo' },
            ],
          ],
          audit: {
            action: 'product.created',
            entityType: 'rotiseria_product',
            entityId: p.id,
            metadata: {
              name: p.name,
              category: p.category,
              priceUnit: Number(p.priceUnit),
            },
          },
        };
      }

      // 2. Si está en el Paso 2: Selección de categoría
      if (input._step === 'categoria' && input.nombre) {
        const categories = await catalog.listCategories(businessId);
        const rows: InlineButton[][] = [];

        for (const cat of categories) {
          const icon = getCategoryIcon(cat);
          rows.push([
            {
              text: `${icon} ${cat}`,
              callbackData: `rotiseria:prod_nuevo:cat:${encodeURIComponent(cat)}`,
            },
          ]);
        }

        rows.push([
          { text: '➕ Nueva categoría (escribir)', callbackData: 'rotiseria:prod_nuevo:cat_new' },
        ]);
        rows.push([{ text: '❌ Cancelar', callbackData: 'rotiseria:prod_nuevo:cancel' }]);

        return {
          reply: [
            `📦 Producto: *${esc(input.nombre)}*`,
            '',
            '*Paso 2/4:* ¿A qué *categoría* pertenece?',
            '',
            'Elegí una existente o escribí el nombre de una nueva:',
          ].join('\n'),
          inlineKeyboard: rows,
          continueInAction: {
            name: 'producto_nuevo',
            data: {
              nombre: input.nombre,
              _step: 'categoria',
            },
          },
        };
      }

      // 3. Si está en el Paso 3: Precio unitario
      if (input._step === 'precio_unitario' && input.nombre && input.categoria) {
        const catIcon = getCategoryIcon(input.categoria);
        return {
          reply: [
            `📦 *${esc(input.nombre)}* (${catIcon} ${esc(input.categoria)})`,
            '',
            '*Paso 3/4:* ¿Cuál es el *precio unitario*?',
            '_(Ejemplo: 3500 o 3.500)_',
          ].join('\n'),
          inlineKeyboard: [
            [{ text: '❌ Cancelar', callbackData: 'rotiseria:prod_nuevo:cancel' }],
          ],
          continueInAction: {
            name: 'producto_nuevo',
            data: {
              nombre: input.nombre,
              categoria: input.categoria,
              _step: 'precio_unitario',
            },
          },
        };
      }

      // 4. Si está en el Paso 4: Precios por docena / media docena
      if (input._step === 'precios_docena' && input.nombre && input.categoria && input.precio_unitario) {
        return {
          reply: [
            `📦 *${esc(input.nombre)}* — ${formatCurrency(input.precio_unitario)}`,
            '',
            '*Paso 4/4 (Opcional):* ¿Tiene precio por docena o media docena?',
            '_(Ideal para empanadas o productos por cantidad)_',
            '',
            '• Con ambos precios: *"media docena 8000, docena 15000"* (o *"8000 / 15000"*).',
            '• Solo docena: *"15000"*.',
            '• Si NO tiene precios por cantidad, tocá *Omitir* o escribí *no*.',
          ].join('\n'),
          inlineKeyboard: [
            [
              { text: '⏭️ Omitir (sin precios por docena)', callbackData: 'rotiseria:prod_nuevo:skip_dozen' },
              { text: '❌ Cancelar', callbackData: 'rotiseria:prod_nuevo:cancel' },
            ],
          ],
          continueInAction: {
            name: 'producto_nuevo',
            data: {
              nombre: input.nombre,
              categoria: input.categoria,
              precio_unitario: input.precio_unitario,
              _step: 'precios_docena',
            },
          },
        };
      }

      // 5. Paso 1 inicial: Pedir nombre del producto
      return {
        reply: [
          '📦 *Alta de Producto Nuevo*',
          '',
          '*Paso 1/4:* ¿Cómo se llama el producto?',
          '_(Ejemplo: Empanada Criolla, Pizza Napolitana, Picada Especial)_',
        ].join('\n'),
        inlineKeyboard: [
          [{ text: '❌ Cancelar', callbackData: 'rotiseria:prod_nuevo:cancel' }],
        ],
        continueInAction: {
          name: 'producto_nuevo',
          data: { _step: 'nombre' },
        },
      };
    },
  };

  return [gestionarCatalogo, productoNuevo] as unknown as ActionDef<unknown>[];
}

export async function handleAdminCallback(
  ctx: ActionContext,
  data: string,
  activeState: ConversationState | null,
  conversations?: IConversationRepository,
  audit?: { log: (entry: ILogAuditData) => Promise<unknown> },
  deps?: RotiseriaAdminDeps
): Promise<BotReply | null> {
  if (!deps) return null;
  const { catalog } = deps;
  const businessId = ctx.tenant.business.id;

  // Verificación de rol OWNER para cualquier callback de administración
  if (
    data.startsWith('rotiseria:catalogo') ||
    data.startsWith('rotiseria:prod:') ||
    data.startsWith('rotiseria:prod_nuevo:') ||
    data.startsWith('rotiseria:cat_')
  ) {
    if (ctx.tenant.membership?.role !== 'OWNER') {
      return {
        text: '⚠️ Solo el dueño del negocio puede administrar el catálogo de productos.',
        parseMode: 'Markdown',
      };
    }
  }

  // 1. Mostrar o volver al catálogo
  if (data === 'rotiseria:catalogo') {
    if (conversations) {
      await conversations.clear(businessId, ctx.actorUserId);
    }
    const view = await formatCatalogView(catalog, businessId);
    return {
      text: view.text,
      parseMode: 'Markdown',
      inlineKeyboard: view.inlineKeyboard,
    };
  }

  // 2. Cerrar vista de catálogo
  if (data === 'rotiseria:catalogo:cerrar') {
    if (conversations) {
      await conversations.clear(businessId, ctx.actorUserId);
    }
    return {
      text: '📦 Administración de catálogo cerrada.',
      parseMode: 'Markdown',
    };
  }

  // 3. Ver detalle de un producto
  if (data.startsWith('rotiseria:prod:ver:')) {
    const id = data.slice('rotiseria:prod:ver:'.length);
    const prod = await catalog.findProductById(id, businessId);
    if (!prod) {
      return { text: '⚠️ Producto no encontrado.', parseMode: 'Markdown' };
    }
    const card = formatProductAdminCard(prod);
    return {
      text: card.text,
      parseMode: 'Markdown',
      inlineKeyboard: card.inlineKeyboard,
    };
  }

  // 4. Alternar estado activo / inactivo (dar de baja o activar)
  if (data.startsWith('rotiseria:prod:toggle:')) {
    const id = data.slice('rotiseria:prod:toggle:'.length);
    const updated = await catalog.toggleProductStatus(id);

    if (audit) {
      await audit.log({
        businessId,
        actorUserId: ctx.actorUserId,
        action: updated.isActive ? 'product.activated' : 'product.deactivated',
        entityType: 'rotiseria_product',
        entityId: updated.id,
        metadata: { name: updated.name, isActive: updated.isActive },
      });
    }

    const notice = updated.isActive
      ? '✅ *Producto reactivado con éxito.* Ahora vuelve a aparecer en la carta.'
      : '⚠️ *Producto dado de baja.* Ya no aparecerá en la carta, pero se conserva en el historial.';

    const card = formatProductAdminCard(updated, notice);
    return {
      text: card.text,
      parseMode: 'Markdown',
      inlineKeyboard: card.inlineKeyboard,
    };
  }

  // 5. Modificar categoría: mostrar lista de categorías
  if (data.startsWith('rotiseria:prod:edit_cat:')) {
    const id = data.slice('rotiseria:prod:edit_cat:'.length);
    const prod = await catalog.findProductById(id, businessId);
    if (!prod) {
      return { text: '⚠️ Producto no encontrado.', parseMode: 'Markdown' };
    }

    if (conversations) {
      await conversations.upsert({
        businessId,
        userId: ctx.actorUserId,
        phase: 'COLLECTING',
        actionName: 'gestionar_catalogo',
        data: { _awaitingCategoryForId: id, productName: prod.name },
        expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
        updatedAt: ctx.now,
      });
    }

    const categories = await catalog.listCategories(businessId);
    const rows: InlineButton[][] = [];

    for (const cat of categories) {
      const icon = getCategoryIcon(cat);
      rows.push([
        {
          text: `${icon} ${cat}`,
          callbackData: `rotiseria:cat_set:${encodeURIComponent(cat)}`,
        },
      ]);
    }

    rows.push([
      { text: '➕ Escribir nueva categoría', callbackData: 'rotiseria:cat_new' },
    ]);
    rows.push([
      { text: '↩️ Volver', callbackData: `rotiseria:prod:ver:${id}` },
    ]);

    return {
      text: [
        `✏️ *Modificar categoría de ${esc(prod.name)}*`,
        `Categoría actual: *${esc(prod.category)}*`,
        '',
        'Elegí una categoría existente o escribí el nombre de una nueva en el chat:',
      ].join('\n'),
      parseMode: 'Markdown',
      inlineKeyboard: rows,
    };
  }

  // 6. Asignar categoría existente
  if (data.startsWith('rotiseria:cat_set:') || data.startsWith('rotiseria:prod:set_cat:')) {
    let cat = '';
    let prodId: string | null = null;

    if (data.startsWith('rotiseria:cat_set:')) {
      cat = decodeURIComponent(data.slice('rotiseria:cat_set:'.length));
      prodId = activeState?.data?._awaitingCategoryForId ? String(activeState.data._awaitingCategoryForId) : null;
    } else {
      const parts = data.slice('rotiseria:prod:set_cat:'.length).split(':');
      prodId = parts[0];
      cat = decodeURIComponent(parts[1] || 'general');
    }

    if (!prodId) {
      return {
        text: '⚠️ No se pudo determinar el producto a modificar. Volvé a seleccionarlo desde /catalogo.',
        parseMode: 'Markdown',
      };
    }

    const updated = await catalog.updateProductCategory(prodId, cat);

    if (conversations) {
      await conversations.clear(businessId, ctx.actorUserId);
    }

    if (audit) {
      await audit.log({
        businessId,
        actorUserId: ctx.actorUserId,
        action: 'product.category_updated',
        entityType: 'rotiseria_product',
        entityId: updated.id,
        metadata: { name: updated.name, category: updated.category },
      });
    }

    const notice = `✅ Categoría de *${esc(updated.name)}* actualizada a *${esc(updated.category)}*.`;
    const card = formatProductAdminCard(updated, notice);
    return {
      text: card.text,
      parseMode: 'Markdown',
      inlineKeyboard: card.inlineKeyboard,
    };
  }

  // 7. Prompt para escribir nueva categoría
  if (data === 'rotiseria:cat_new' || data.startsWith('rotiseria:prod:new_cat_prompt:')) {
    let id = activeState?.data?._awaitingCategoryForId ? String(activeState.data._awaitingCategoryForId) : '';
    if (data.startsWith('rotiseria:prod:new_cat_prompt:')) {
      id = data.slice('rotiseria:prod:new_cat_prompt:'.length);
    }

    const prod = id ? await catalog.findProductById(id, businessId) : null;
    if (!prod) {
      return { text: '⚠️ Producto no encontrado. Volvé a seleccionarlo desde /catalogo.', parseMode: 'Markdown' };
    }

    if (conversations) {
      await conversations.upsert({
        businessId,
        userId: ctx.actorUserId,
        phase: 'COLLECTING',
        actionName: 'gestionar_catalogo',
        data: { _awaitingCategoryForId: id, productName: prod.name },
        expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
        updatedAt: ctx.now,
      });
    }

    return {
      text: [
        `✏️ *Nueva categoría para ${esc(prod.name)}*`,
        '',
        'Escribí el nombre de la categoría (ej: *"picadas"*, *"postres"*, *"pastas"*):',
      ].join('\n'),
      parseMode: 'Markdown',
      inlineKeyboard: [
        [{ text: '❌ Cancelar', callbackData: `rotiseria:prod:ver:${id}` }],
      ],
    };
  }

  // 8. Prompt para cambiar precio
  if (data.startsWith('rotiseria:prod:edit_price:')) {
    const id = data.slice('rotiseria:prod:edit_price:'.length);
    const prod = await catalog.findProductById(id, businessId);
    if (!prod) {
      return { text: '⚠️ Producto no encontrado.', parseMode: 'Markdown' };
    }

    if (conversations) {
      await conversations.upsert({
        businessId,
        userId: ctx.actorUserId,
        phase: 'COLLECTING',
        actionName: 'gestionar_catalogo',
        data: { _awaitingPriceForId: id, productName: prod.name },
        expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
        updatedAt: ctx.now,
      });
    }

    const docStr = prod.priceDozen ? `\n• Docena: ${formatCurrency(Number(prod.priceDozen))}` : '';
    const halfStr = prod.priceHalfDozen ? `\n• Media docena: ${formatCurrency(Number(prod.priceHalfDozen))}` : '';

    return {
      text: [
        `💲 *Cambiar precio de ${esc(prod.name)}*`,
        '',
        `Precios actuales:`,
        `• Unidad: *${formatCurrency(Number(prod.priceUnit))}*${halfStr}${docStr}`,
        '',
        'Escribí el nuevo precio unitario (o *"unitario / docena"*, ej: *1800* o *1800 / 18000*):',
      ].join('\n'),
      parseMode: 'Markdown',
      inlineKeyboard: [
        [{ text: '❌ Cancelar', callbackData: `rotiseria:prod:ver:${id}` }],
      ],
    };
  }

  // 9. Iniciar alta guiada de producto nuevo
  if (data === 'rotiseria:prod:nuevo') {
    if (conversations) {
      await conversations.upsert({
        businessId,
        userId: ctx.actorUserId,
        phase: 'COLLECTING',
        actionName: 'producto_nuevo',
        data: { _step: 'nombre' },
        expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
        updatedAt: ctx.now,
      });
    }
    return {
      text: [
        '📦 *Alta de Producto Nuevo*',
        '',
        '*Paso 1/4:* ¿Cómo se llama el producto?',
        '_(Ejemplo: Empanada Criolla, Pizza Fugazzeta, Picada Especial)_',
      ].join('\n'),
      parseMode: 'Markdown',
      inlineKeyboard: [
        [{ text: '❌ Cancelar', callbackData: 'rotiseria:prod_nuevo:cancel' }],
      ],
    };
  }

  // 10. Seleccionar categoría existente en producto nuevo (Paso 2)
  if (data.startsWith('rotiseria:prod_nuevo:cat:')) {
    const cat = decodeURIComponent(data.slice('rotiseria:prod_nuevo:cat:'.length));
    const currentName = String(activeState?.data?.nombre || '');

    if (conversations) {
      await conversations.upsert({
        businessId,
        userId: ctx.actorUserId,
        phase: 'COLLECTING',
        actionName: 'producto_nuevo',
        data: {
          nombre: currentName,
          categoria: cat,
          _step: 'precio_unitario',
        },
        expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
        updatedAt: ctx.now,
      });
    }

    const catIcon = getCategoryIcon(cat);
    return {
      text: [
        `📦 *${esc(currentName)}* (${catIcon} ${esc(cat)})`,
        '',
        '*Paso 3/4:* ¿Cuál es el *precio unitario*?',
        '_(Ejemplo: 3500 o 3.500)_',
      ].join('\n'),
      parseMode: 'Markdown',
      inlineKeyboard: [
        [{ text: '❌ Cancelar', callbackData: 'rotiseria:prod_nuevo:cancel' }],
      ],
    };
  }

  // 11. Escribir categoría nueva en producto nuevo (Paso 2)
  if (data === 'rotiseria:prod_nuevo:cat_new') {
    const currentName = String(activeState?.data?.nombre || '');
    if (conversations) {
      await conversations.upsert({
        businessId,
        userId: ctx.actorUserId,
        phase: 'COLLECTING',
        actionName: 'producto_nuevo',
        data: {
          nombre: currentName,
          _step: 'categoria',
          _awaitingNewCategoryText: true,
        },
        expiresAt: new Date(ctx.now.getTime() + 10 * 60_000),
        updatedAt: ctx.now,
      });
    }
    return {
      text: [
        `📦 *${esc(currentName)}*`,
        '',
        '*Paso 2/4:* Escribí el nombre de la nueva categoría:',
        '_(Ejemplo: picadas, postres, pastas, etc.)_',
      ].join('\n'),
      parseMode: 'Markdown',
      inlineKeyboard: [
        [{ text: '❌ Cancelar', callbackData: 'rotiseria:prod_nuevo:cancel' }],
      ],
    };
  }

  // 12. Omitir precios por docena (Paso 4) y guardar
  if (data === 'rotiseria:prod_nuevo:skip_dozen') {
    const current = (activeState?.data ?? {}) as Record<string, unknown>;
    const nombre = String(current.nombre || '').trim();
    const categoria = String(current.categoria || 'general').trim();
    const precioUnitario = Number(current.precio_unitario || 0);

    if (!nombre || precioUnitario <= 0) {
      return { text: '⚠️ Datos incompletos para crear el producto.', parseMode: 'Markdown' };
    }

    const created = await catalog.createProduct(businessId, {
      name: nombre,
      category: categoria,
      priceUnit: precioUnitario,
      priceDozen: null,
      priceHalfDozen: null,
    });

    if (conversations) {
      await conversations.clear(businessId, ctx.actorUserId);
    }

    if (audit) {
      await audit.log({
        businessId,
        actorUserId: ctx.actorUserId,
        action: 'product.created',
        entityType: 'rotiseria_product',
        entityId: created.id,
        metadata: {
          name: created.name,
          category: created.category,
          priceUnit: Number(created.priceUnit),
        },
      });
    }

    const catIcon = getCategoryIcon(created.category);
    return {
      text: [
        '✅ *¡Producto creado con éxito!*',
        '',
        `📦 *${esc(created.name)}*`,
        `• Categoría: ${catIcon} *${esc(created.category)}*`,
        `• Precio unitario: *${formatCurrency(Number(created.priceUnit))}*`,
        '',
        'Ya está disponible en la carta y catálogo.',
      ].join('\n'),
      parseMode: 'Markdown',
      inlineKeyboard: [
        [
          { text: '📦 Ver catálogo', callbackData: 'rotiseria:catalogo' },
          { text: '➕ Cargar otro producto', callbackData: 'rotiseria:prod:nuevo' },
        ],
      ],
    };
  }

  // 13. Cancelar creación de producto nuevo
  if (data === 'rotiseria:prod_nuevo:cancel') {
    if (conversations) {
      await conversations.clear(businessId, ctx.actorUserId);
    }
    return {
      text: 'Operación cancelada.',
      parseMode: 'Markdown',
    };
  }

  return null;
}

export function handleAdminDirectInput(
  text: string,
  activeActionName?: string | null,
  activeData?: Record<string, unknown>
): { actionName: string; params: Record<string, unknown> } | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Atajos directos a comandos de catálogo
  if (
    lower === 'catalogo' ||
    lower === '/catalogo' ||
    lower === 'catálogo' ||
    lower === '/catálogo' ||
    lower === 'cambiar categoria' ||
    lower === 'cambiar categoría' ||
    lower === 'cambiar de categoria' ||
    lower === 'cambiar de categoría' ||
    lower === 'modificar categoria' ||
    lower === 'modificar categoría'
  ) {
    return { actionName: 'gestionar_catalogo', params: {} };
  }

  // Patrón "cambiar categoría de X a Y" o "cambiar categoria de X a Y"
  const mChangeCat = trimmed.match(
    /^(?:cambiar|modificar)(?:\s+de)?\s+categor[ií]a(?:\s+de)?\s+(.+?)\s+a\s+(.+)$/i
  );
  if (mChangeCat) {
    return {
      actionName: 'gestionar_catalogo',
      params: {
        nombre: mChangeCat[1].trim(),
        nueva_categoria: mChangeCat[2].trim().toLowerCase(),
      },
    };
  }

  // Patrón "mover X a [la] [categoría] Y"
  const mMover = trimmed.match(
    /^mover\s+(.+?)\s+a(?:\s+la)?(?:\s+categor[ií]a)?\s+(.+)$/i
  );
  if (mMover) {
    return {
      actionName: 'gestionar_catalogo',
      params: {
        nombre: mMover[1].trim(),
        nueva_categoria: mMover[2].trim().toLowerCase(),
      },
    };
  }

  if (
    lower === 'producto_nuevo' ||
    lower === '/producto_nuevo' ||
    lower === 'nuevo_producto' ||
    lower === '/nuevo_producto' ||
    lower === 'cargar producto' ||
    lower === 'nuevo producto'
  ) {
    return { actionName: 'producto_nuevo', params: {} };
  }

  // 1. Entrada de texto cuando se está en gestionar_catalogo
  if (activeActionName === 'gestionar_catalogo') {
    // A. Ingreso de nueva categoría
    if (activeData?._awaitingCategoryForId) {
      const prodId = String(activeData._awaitingCategoryForId);
      return {
        actionName: 'gestionar_catalogo',
        params: {
          producto_id: prodId,
          _newCategoryName: trimmed.toLowerCase(),
        },
      };
    }

    // B. Ingreso de nuevo precio
    if (activeData?._awaitingPriceForId) {
      const prodId = String(activeData._awaitingPriceForId);
      const parts = trimmed.split('/');
      const unitStr = parts[0].replace(/[^0-9.,]/g, '').replace(',', '.');
      const unitVal = parseFloat(unitStr);

      if (!isNaN(unitVal) && unitVal > 0) {
        let dozenVal: number | undefined;
        if (parts[1]) {
          const dozenStr = parts[1].replace(/[^0-9.,]/g, '').replace(',', '.');
          const dVal = parseFloat(dozenStr);
          if (!isNaN(dVal) && dVal > 0) dozenVal = dVal;
        }

        return {
          actionName: 'gestionar_catalogo',
          params: {
            producto_id: prodId,
            _priceUnit: unitVal,
            _priceDozen: dozenVal,
          },
        };
      }
    }
  }

  // 2. Entrada de texto en flujo guiado de producto_nuevo
  if (activeActionName === 'producto_nuevo') {
    const step = activeData?._step;

    // Paso 1: Nombre del producto
    if (step === 'nombre') {
      if (trimmed.length >= 2) {
        return {
          actionName: 'producto_nuevo',
          params: {
            nombre: trimmed,
            _step: 'categoria',
          },
        };
      }
    }

    // Paso 2: Categoría
    if (step === 'categoria' || activeData?._awaitingNewCategoryText) {
      if (trimmed.length >= 2) {
        return {
          actionName: 'producto_nuevo',
          params: {
            nombre: String(activeData?.nombre || ''),
            categoria: trimmed.toLowerCase(),
            _step: 'precio_unitario',
          },
        };
      }
    }

    // Paso 3: Precio unitario
    if (step === 'precio_unitario') {
      const cleanNum = trimmed.replace(/[^0-9.,]/g, '').replace(',', '.');
      const val = parseFloat(cleanNum);
      if (!isNaN(val) && val > 0) {
        return {
          actionName: 'producto_nuevo',
          params: {
            nombre: String(activeData?.nombre || ''),
            categoria: String(activeData?.categoria || 'general'),
            precio_unitario: val,
            _step: 'precios_docena',
          },
        };
      }
    }

    // Paso 4: Docena / media docena (o no/omitir)
    if (step === 'precios_docena') {
      const lower = trimmed.toLowerCase();
      if (
        lower === 'no' ||
        lower === 'omitir' ||
        lower === 'ninguno' ||
        lower === 'ninguna' ||
        lower === '-' ||
        lower === '0'
      ) {
        return {
          actionName: 'producto_nuevo',
          params: {
            nombre: String(activeData?.nombre || ''),
            categoria: String(activeData?.categoria || 'general'),
            precio_unitario: Number(activeData?.precio_unitario || 0),
            precio_docena: null,
            precio_media_docena: null,
          },
        };
      }

      // Detectar si mandó números para docena / media docena
      let dozenVal: number | null = null;
      let halfDozenVal: number | null = null;

      const mBoth = lower.match(/(?:media\s*docena|media)\s*[:=]?\s*(\d+(?:[.,]\d+)?).*?(?:docena)\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i);
      if (mBoth) {
        halfDozenVal = parseFloat(mBoth[1].replace(',', '.'));
        dozenVal = parseFloat(mBoth[2].replace(',', '.'));
      } else if (lower.includes('/')) {
        const parts = lower.split('/');
        const p1 = parseFloat(parts[0].replace(/[^0-9.,]/g, '').replace(',', '.'));
        const p2 = parseFloat(parts[1].replace(/[^0-9.,]/g, '').replace(',', '.'));
        if (!isNaN(p1) && !isNaN(p2)) {
          halfDozenVal = p1;
          dozenVal = p2;
        }
      } else {
        const clean = lower.replace(/[^0-9.,]/g, '').replace(',', '.');
        const num = parseFloat(clean);
        if (!isNaN(num) && num > 0) {
          dozenVal = num;
        }
      }

      return {
        actionName: 'producto_nuevo',
        params: {
          nombre: String(activeData?.nombre || ''),
          categoria: String(activeData?.categoria || 'general'),
          precio_unitario: Number(activeData?.precio_unitario || 0),
          precio_docena: dozenVal,
          precio_media_docena: halfDozenVal,
        },
      };
    }
  }

  return null;
}
