import { Hono } from 'hono';
import { z } from 'zod';
import type { LedgerCommand } from '../ledger/model';
import type { Action } from '../auth/permissions';
import { assertAuthority } from '../auth/authority';
import type { Env } from '../env';
import { parseQuery } from '../ledger/query-validation';
import { financialInput, commentCommandInput, postCommandInput } from '../ledger/validation';
import type { CommandContext } from '../platform/context';
import { ValidationError } from '../platform/errors';
import { boundedLedgerJSON } from './body';
import { commandContext, requiredOperationCommandContext } from './request-context';
import { success } from './envelope';
import { ledgerQueries, ledgerService, previewLedger } from '../ledger/application';

export async function executeLedger(env: Env, command: CommandContext, input: LedgerCommand) {
  const actions: Record<LedgerCommand['action'], Action> = { create: 'ledger_create', correct: 'ledger_correct', void: 'ledger_void', restore: 'ledger_restore', comment: 'ledger_comment', post: 'ledger_post' };
  const action = actions[input.action];
  try { return await ledgerService(env).execute(command, input); }
  finally { await assertAuthority(env.DB, command, action); }
}
const commentInput = z.object({ text: commentCommandInput.shape.text }).strict();
const postingInput = z.object((({ action: _action, operationId: _operationId, ...shape }) => shape)(postCommandInput.shape)).strict();

export function createLedgerRoutes(): Hono<{ Bindings: Env }> {
  const routes = new Hono<{ Bindings: Env }>();
  routes.get('/entries', async c => success(c, await ledgerQueries(c.env).entries(commandContext(c), query(c.req.queries()))));
  routes.get('/entries/:id', async c => success(c, await ledgerQueries(c.env).getEntry(commandContext(c), c.req.param('id'))));
  routes.get('/entries/:id/comments', async c => success(c, await ledgerQueries(c.env).comments(commandContext(c), c.req.param('id'), query(c.req.queries()))));
  routes.get('/entries/:id/history', async c => success(c, await ledgerQueries(c.env).history(commandContext(c), c.req.param('id'), query(c.req.queries()))));
  routes.get('/balances', async c => success(c, await ledgerQueries(c.env).balances(commandContext(c), query(c.req.queries()))));
  routes.get('/repayments', async c => success(c, await ledgerQueries(c.env).repayments(commandContext(c), query(c.req.queries()))));
  routes.get('/summaries', async c => success(c, await ledgerQueries(c.env).summaries(commandContext(c), query(c.req.queries()))));
  routes.get('/statements', async c => success(c, await ledgerQueries(c.env).statement(commandContext(c), query(c.req.queries()))));
  routes.get('/export', async c => success(c, await ledgerQueries(c.env).export(commandContext(c), query(c.req.queries()))));
  routes.get('/operations/:operationId', async c => success(c, await ledgerQueries(c.env).operationStatus(commandContext(c), c.req.param('operationId'))));
  routes.post('/preview', async c => success(c, await previewLedger(c.env, commandContext(c), await boundedLedgerJSON(c.req.raw))));
  for (const [path, kind] of [['expenses', 'expense'], ['refunds', 'refund'], ['payments', 'payment']] as const) {
    routes.post(`/${path}`, async c => {
      const command = requiredOperationCommandContext(c);
      const entry = parseQuery(financialInput, await boundedLedgerJSON(c.req.raw));
      if (entry.kind !== kind) throw new ValidationError('kind', `must be ${kind}`);
      return success(c, { status: 'accepted', entry: await executeLedger(c.env, command, { action: 'create', operationId: command.operationId, entry }) }, 201);
    });
  }
  routes.put('/entries/:id', async c => {
    const command = requiredOperationCommandContext(c);
    const entry = parseQuery(financialInput, await boundedLedgerJSON(c.req.raw));
    return success(c, { status: 'accepted', entry: await executeLedger(c.env, command, { action: 'correct', operationId: command.operationId, entryId: c.req.param('id'), expectedVersion: requiredVersion(command), entry }) });
  });
  for (const action of ['void', 'restore'] as const) routes.post(`/entries/:id/${action}`, async c => {
    const command = requiredOperationCommandContext(c);
    parseQuery(z.object({}).strict(), await boundedLedgerJSON(c.req.raw, true));
    return success(c, { status: 'accepted', entry: await executeLedger(c.env, command, { action, operationId: command.operationId, entryId: c.req.param('id'), expectedVersion: requiredVersion(command) }) });
  });
  routes.post('/entries/:id/comments', async c => {
    const command = requiredOperationCommandContext(c);
    const input = parseQuery(commentInput, await boundedLedgerJSON(c.req.raw));
    return success(c, { status: 'accepted', comment: await executeLedger(c.env, command, { action: 'comment', operationId: command.operationId, entryId: c.req.param('id'), expectedVersion: requiredVersion(command), ...input }) }, 201);
  });
  routes.post('/rule-postings', async c => {
    const command = requiredOperationCommandContext(c);
    const input = parseQuery(postingInput, await boundedLedgerJSON(c.req.raw));
    return success(c, { status: 'accepted', entry: await executeLedger(c.env, command, { action: 'post', operationId: command.operationId, ...input }) }, 201);
  });
  return routes;
}
function requiredVersion(command: CommandContext): number {
  if (command.expectedVersion === undefined) throw new ValidationError('If-Match', 'provide the observed entry version');
  return command.expectedVersion;
}
function query(raw: Record<string, string[]>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, entries] of Object.entries(raw)) {
    if (entries.length !== 1) throw new ValidationError('query', 'Each query parameter must occur once');
    values[key] = key === 'limit' ? Number(entries[0]) : entries[0];
  }
  return values;
}
