import { registerHouseholdTools } from './household-tools';
import { registerAccessTools } from './access-tools';
import { McpServer } from '@modelcontextprotocol/server';
import type { VerifiedAuthority } from '../auth/authority';
import type { Env } from '../env';
import { registerInventoryTools } from './inventory-tools';
import { registerLedgerTools } from './ledger-tools';
import { registerExpenseTools } from './expense-tools';
export function createHomeOSMcpServer(env: Env, authority: VerifiedAuthority, clientId: string): McpServer {
  const server = new McpServer({ name: 'home-os', version: '0.1.0' });
  const context = { env, authority, clientId };
  registerInventoryTools(server, context);
  registerExpenseTools(server, context);
  registerLedgerTools(server, context);
  registerHouseholdTools(server, context);
  registerAccessTools(server, context);
  return server;
}
