import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { D1InventoryRepository } from '../inventory/d1-repository';
import { InventoryService } from '../inventory/service';
import { createItemInput, updateItemInput, stockEventInput, pageInput } from '../inventory/validation';
import { ConflictError } from '../platform/errors';
import { listAuditEvents } from '../platform/audit';
import { assertAuthority } from '../auth/authority';
import { commandContext, failure, mutationInput, permitted, registerTool, subjectId, versionInput, type ToolContext } from './results';

const listInput = pageInput.extend({ query: z.string().max(120).optional(), category: z.string().max(60).optional(), stockLevel: z.enum(['full','okay','low','out']).optional(), archived: z.enum(['exclude','only','include']).default('exclude') });
export function registerInventoryTools(server: McpServer, context: ToolContext) {
  const service = new InventoryService(new D1InventoryRepository(context.env.DB)), household = context.authority.householdId;
  registerTool(server, context, 'inventory_list', 'Search and filter inventory. Count describes this page; follow nextCursor for more.', listInput, true, async input => { const page = await service.listItemsPage(household, input, input); return { ...page, count: page.items.length }; });
  registerTool(server, context, 'inventory_attention', 'Inspect a bounded catalog page for low stock or declared restock due reasons. Empty results with nextCursor do not mean the household needs nothing.', pageInput.extend({ category: z.string().max(60).optional() }), true, async input => {
    const page = await service.listItemsPage(household, { category: input.category, archived: 'exclude' }, input);
    const items = page.items.filter(item => item.attentionReasons?.length);
    return { items, count: items.length, scannedCount: page.items.length, nextCursor: page.nextCursor, complete: page.nextCursor === null };
  });
  const itemPage = pageInput.extend({ itemId: subjectId });
  registerTool(server, context, 'inventory_get', 'Get an item and a bounded page of immutable stock history. Follow eventsNextCursor using inventory_events.', itemPage, true, async input => {
    const [item, history] = await Promise.all([service.getItem(household, input.itemId), service.listEventsPage(household, input.itemId, input)]);
    return { item, events: history.events, nextCursor: history.nextCursor, eventsNextCursor: history.nextCursor };
  });
  registerTool(server, context, 'inventory_events', 'Page immutable stock observations in occurrence and ID order.', itemPage, true, async input => service.listEventsPage(household, input.itemId, input));
  registerTool(server, context, 'inventory_export', 'Export bounded inventory or stock-history pages. Traverse both sections to export all household inventory and history; each section has its own cursor.', pageInput.extend({ section: z.enum(['items','events']).default('items') }), true, async input => {
    if (input.section === 'events') return { section: 'events', ...await service.listEventsPage(household, undefined, input) };
    return { section: 'items', ...await service.listItemsPage(household, { archived: 'include' }, input), historySection: 'events' };
  });
  registerTool(server, context, 'inventory_create', 'Create an inventory declaration using a stable operation ID.', createItemInput.extend(mutationInput.shape).extend({ id: subjectId.optional() }), false, async ({ operationId: _, ...input }, command) => ({ status: 'accepted', item: await service.createItem(command, input) }));
  const mutate = async (id: string, callback: () => Promise<unknown>) => {
    try { return { status: 'accepted', item: await callback() }; }
    catch (error) {
      if (error instanceof ConflictError && error.actualVersion > 0) throw new ConflictError(error.entityType, error.entityId, error.expectedVersion, error.actualVersion, await service.getItem(household, id));
      throw error;
    }
  };
  registerTool(server, context, 'inventory_update', 'Revise item description at the observed version.', updateItemInput.extend(versionInput.shape).extend({ itemId: subjectId }), false, async ({ itemId, operationId: _, expectedVersion: __, ...input }, command) => mutate(itemId, () => service.updateItem(command, itemId, input)));
  registerTool(server, context, 'inventory_stock', 'Consume, restock or mark the level using the existing tracking mode semantics.', stockEventInput.extend(versionInput.shape).extend({ id: subjectId.optional() }).extend({ itemId: subjectId }), false, async ({ itemId, operationId: _, expectedVersion: __, ...input }, command) => mutate(itemId, () => service.applyStockEvent(command, itemId, input)));
  for (const action of ['inventory_archive', 'inventory_restore'] as const) registerTool(server, context, action, 'Archive or restore an item without deleting its stock history.', versionInput.extend({ itemId: subjectId }), false, async (input, command) => mutate(input.itemId, () => action === 'inventory_archive' ? service.archiveItem(command, input.itemId) : service.restoreItem(command, input.itemId)));
  registerTool(server, context, 'activity_list', 'Read bounded household activity, optionally filtered by entity or actor. cursor and legacy after both continue the feed.', pageInput.extend({ after: z.string().max(1024).optional(), entityType: z.string().max(80).optional(), entityId: subjectId.optional(), actorId: subjectId.optional() }), true, async input => {
    const page = await listAuditEvents(context.env.DB, household, { ...input, after: input.cursor ?? input.after });
    return page;
  });
  if (permitted(context, 'inventory_list')) server.registerResource('inventory-catalog', 'home-os://inventory/catalog', { title: 'Home inventory catalog', description: 'First bounded active inventory page. Continue with inventory_list and nextCursor.', mimeType: 'application/json' }, async uri => {
    try {
      await assertAuthority(context.env.DB, commandContext(context, 'inventory_list'), 'inventory_list');
      const page = await service.listItemsPage(household, { archived: 'exclude' }, { limit: 25 });
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ ...page, count: page.items.length, limit: 25, continuationTool: 'inventory_list' }) }] };
    } catch (error) { throw new Error(String(failure(error).structuredContent.message)); }
  });
}
