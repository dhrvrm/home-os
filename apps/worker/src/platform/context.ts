export type ActorType = "member" | "mcp" | "automation" | "import";
export type CommandSource = "pwa" | "mcp" | "automation" | "import";

export interface CommandContext {
  householdId: string;
  actorId: string;
  actorType: ActorType;
  source: CommandSource;
  operationId: string;
  expectedVersion?: number;
  deviceId?: string;
  clientTime?: string;
  mcpClientId?: string;
  mcpTool?: string;
}
