import { CATEGORY_OPTIONS } from "./categories";
import type { InventoryItem, StockLevel, UpdateItemMetadataInput } from "./inventory";

export const ASSISTANT_HELP = "I can find items, count stock, show what is low or out, and propose names, alternative names, or categories. I will always ask before changing anything.";

export interface AssistantProposal {
  type: "proposal";
  itemID: string;
  itemName: string;
  current: { name: string; alternativeNames: string[]; categories: string[] };
  changes: UpdateItemMetadataInput;
  summary: string;
}

export type AssistantResult =
  | { type: "answer"; message: string; itemIDs: string[] }
  | AssistantProposal
  | { type: "help"; message: string }
  | { type: "unsupported"; message: string };

interface ModelCommand {
  intent?: unknown;
  item?: unknown;
  name?: unknown;
  alternativeNames?: unknown;
  addCategories?: unknown;
  removeCategories?: unknown;
  stockLevel?: unknown;
  category?: unknown;
  location?: unknown;
}

interface SnapshotItem {
  id: string;
  name: string;
  alternativeNames: string[];
  categories: string[];
  location: string;
  stockLevel: StockLevel;
}

const MAX_PROMPT_UTF8_BYTES = 3_800;

export function itemCategories(item: InventoryItem): string[] {
  return item.categories?.length ? item.categories : [item.category];
}

export function runDeterministicQuery(request: string, items: InventoryItem[]): AssistantResult | null {
  const query = fold(request);
  if (!query) return null;
  if (/^(help|what can you do|how can you help)[?.!]*$/.test(query)) {
    return { type: "help", message: ASSISTANT_HELP };
  }
  if (/(running low|low stock|need(?:s)? attention|almost (?:empty|finished))/.test(query)) {
    return answerForItems(items.filter((item) => item.stockLevel === "low" || item.stockLevel === "out"), "need attention");
  }
  if (/(out of stock|stocked out|completely empty)/.test(query)) {
    return answerForItems(items.filter((item) => item.stockLevel === "out"), "are out");
  }
  if (/^(how many|count|number of)(?: items)?[?.!]*$/.test(query) || /how many items (?:do we have|are tracked)/.test(query)) {
    return { type: "answer", message: `${items.length} ${items.length === 1 ? "item is" : "items are"} tracked at home.`, itemIDs: items.map((item) => item.id) };
  }

  const explicitCategoryMatch = query.match(/^(?:what(?:'s| is)|show(?: me)?(?: items)?)\s+(?:in|under) (?:the )?(.+?) category[?.!]*$/);
  if (explicitCategoryMatch) {
    const category = availableCategories(items).find((value) => fold(value) === explicitCategoryMatch[1].trim());
    return category
      ? answerForItems(items.filter((item) => itemCategories(item).some((value) => fold(value) === fold(category))), `are in the ${category} category`)
      : { type: "answer", message: "No inventory items match that category.", itemIDs: [] };
  }

  const explicitLocationMatch = query.match(/^(?:what(?:'s| is) (?:in|at)|show (?:me )?(?:items )?in)\s+(.+?) location[?.!]*$/);
  if (explicitLocationMatch) {
    const location = explicitLocationMatch[1].trim();
    const matches = items.filter((item) => fold(item.location) === location || fold(item.location).includes(location));
    return answerForItems(matches, `are in ${titleFromMatch(matches[0]?.location, location)}`);
  }

  const categoryMatch = query.match(/^(?:what(?:'s| is)|show(?: me)?(?: items)?)\s+(?:in|under) (?:the )?(.+?)[?.!]*$/);
  if (categoryMatch) {
    const reference = categoryMatch[1].trim();
    const knownCategory = availableCategories(items).find((value) => fold(value) === reference);
    const knownLocation = items.find((item) => fold(item.location) === reference)?.location;
    if (knownCategory && knownLocation) {
      return { type: "unsupported", message: `${knownCategory} is both a category and a location. Say “category” or “location” so I do not guess.` };
    }
    if (knownCategory) {
      return answerForItems(items.filter((item) => itemCategories(item).some((value) => fold(value) === fold(knownCategory))), `are in the ${knownCategory} category`);
    }
  }

  const locationMatch = query.match(/^(?:what(?:'s| is) (?:in|at)|show (?:me )?(?:items )?in)\s+(.+?)(?: location)?[?.!]*$/);
  if (locationMatch) {
    const location = locationMatch[1].trim();
    const matches = items.filter((item) => fold(item.location) === location || fold(item.location).includes(location));
    return answerForItems(matches, `are in ${titleFromMatch(matches[0]?.location, location)}`);
  }

  const whereMatch = query.match(/^where (?:is|are)\s+(.+?)[?.!]*$/);
  if (whereMatch) {
    const matches = findItems(whereMatch[1], items);
    if (matches.length === 1) {
      return { type: "answer", message: `${matches[0].name} is in ${matches[0].location}.`, itemIDs: [matches[0].id] };
    }
    if (matches.length > 1) return { type: "unsupported", message: "I found more than one matching item. Use its exact name so I do not choose the wrong one." };
  }

  const itemMatch = query.match(/^(?:show|find|what about|what is the status of)\s+(.+?)[?.!]*$/);
  if (itemMatch) {
    const matches = findItems(itemMatch[1], items);
    if (matches.length === 1) return answerForItems(matches, "matches");
    if (matches.length > 1) return { type: "unsupported", message: "I found more than one matching item. Use its exact primary name." };
  }

  return null;
}

export function buildAssistantPrompt(request: string, items: InventoryItem[]): { system: string; user: string } {
  const boundedRequest = truncate(request, 280);
  const candidates: SnapshotItem[] = prioritizeItems(boundedRequest, items).map((item) => ({
    id: item.id,
    name: truncate(item.name, 80),
    alternativeNames: prioritizeValues(boundedRequest, item.alternativeNames ?? []).slice(0, 2).map((value) => truncate(value, 40)),
    categories: prioritizeValues(boundedRequest, itemCategories(item)).slice(0, 5).map((value) => truncate(value, 24)),
    location: truncate(item.location, 40),
    stockLevel: item.stockLevel,
  }));
  const snapshot: SnapshotItem[] = [];
  for (const candidate of candidates) {
    const next = [...snapshot, candidate];
    const nextPrompt = composePrompt(boundedRequest, next, items.length);
    if (utf8Length(nextPrompt.system) + utf8Length(nextPrompt.user) > MAX_PROMPT_UTF8_BYTES) break;
    snapshot.push(candidate);
  }
  return composePrompt(boundedRequest, snapshot, items.length);
}

export function parseModelCommand(text: string, items: InventoryItem[]): AssistantResult {
  let command: ModelCommand;
  try {
    command = parseFirstJSONObject(text);
  } catch {
    return unsupported("The local model did not return a safe command. Try a shorter request with the exact item name.");
  }
  if (!isPlainObject(command) || typeof command.intent !== "string") return unsupported("I could not identify a supported inventory action.");

  const allowedKeys: Record<string, string[]> = {
    help: ["intent"],
    find: ["intent", "item", "stockLevel", "category", "location"],
    rename: ["intent", "item", "name", "alternativeNames"],
    aliases: ["intent", "item", "alternativeNames"],
    categorize: ["intent", "item", "addCategories", "removeCategories"],
  };
  const keys = allowedKeys[command.intent];
  if (keys && Object.keys(command).some((key) => !keys.includes(key))) return unsupported("The local model included fields outside the safe command schema.");

  switch (command.intent) {
    case "help":
      return { type: "help", message: ASSISTANT_HELP };
    case "find":
      return parseFind(command, items);
    case "rename":
    case "aliases":
    case "categorize":
      return parseMutation(command.intent, command, items);
    default:
      return unsupported("That action is not available. I can find, rename, add alternative names, or categorize inventory items.");
  }
}

export function proposalInput(proposal: AssistantProposal): UpdateItemMetadataInput {
  return { ...proposal.changes };
}

function parseFind(command: ModelCommand, items: InventoryItem[]): AssistantResult {
  let matches = [...items];
  if (command.item !== undefined) {
    if (typeof command.item !== "string") return unsupported("The item reference was not valid.");
    matches = findItems(command.item, matches);
  }
  if (command.stockLevel !== undefined) {
    if (!isStockLevel(command.stockLevel)) return unsupported("The stock level was not valid.");
    matches = matches.filter((item) => item.stockLevel === command.stockLevel);
  }
  if (command.category !== undefined) {
    if (typeof command.category !== "string") return unsupported("The category was not valid.");
    matches = matches.filter((item) => itemCategories(item).some((category) => fold(category) === fold(command.category as string)));
  }
  if (command.location !== undefined) {
    if (typeof command.location !== "string") return unsupported("The location was not valid.");
    matches = matches.filter((item) => fold(item.location).includes(fold(command.location as string)));
  }
  return answerForItems(matches, "match");
}

function parseMutation(intent: "rename" | "aliases" | "categorize", command: ModelCommand, items: InventoryItem[]): AssistantResult {
  if (typeof command.item !== "string") return unsupported("Use the exact item name so I know what to change.");
  const matches = findItems(command.item, items);
  if (matches.length !== 1) {
    return unsupported(matches.length === 0
      ? "I could not find that item. Use a name already in the inventory."
      : "I found more than one matching item. Use its exact primary name.");
  }
  const item = matches[0];
  const changes: UpdateItemMetadataInput = {};

  if (intent === "rename") {
    if (typeof command.name !== "string") return unsupported("The proposed name was missing.");
    const name = command.name.trim();
    if (!name || Array.from(name).length > 120) return unsupported("The proposed name was not valid.");
    changes.name = name;
    if (command.alternativeNames !== undefined) {
      const aliases = normalizeStringArray(command.alternativeNames, 8, 120);
      if (!aliases) return unsupported("The proposed alternative names were not valid.");
      changes.alternativeNames = aliases.filter((alias) => fold(alias) !== fold(name));
    }
  }

  if (intent === "aliases") {
    const aliases = normalizeStringArray(command.alternativeNames, 8, 120);
    if (!aliases) return unsupported("The proposed alternative names were not valid.");
    changes.alternativeNames = aliases.filter((alias) => fold(alias) !== fold(item.name));
  }

  if (intent === "categorize") {
    const add = normalizeStringArray(command.addCategories ?? [], 9, 60);
    const remove = normalizeStringArray(command.removeCategories ?? [], 9, 60);
    if (!add || !remove) return unsupported("The proposed categories were not valid.");
    const allowed = availableCategories(items);
    const canonicalAdd = canonicalCategories(add, allowed);
    const canonicalRemove = canonicalCategories(remove, allowed);
    if (canonicalAdd.length !== add.length || canonicalRemove.length !== remove.length) return unsupported("The model proposed a category outside the allowed list.");
    const removed = new Set(canonicalRemove.map(fold));
    const categories = dedupe([...itemCategories(item).filter((category) => !removed.has(fold(category))), ...canonicalAdd]);
    if (categories.length === 0) return unsupported("An item must keep at least one category.");
    changes.categories = categories;
  }

  if (Object.keys(changes).length === 0) return unsupported("There was no safe change to propose.");
  return {
    type: "proposal",
    itemID: item.id,
    itemName: item.name,
    current: { name: item.name, alternativeNames: [...(item.alternativeNames ?? [])], categories: [...itemCategories(item)] },
    changes,
    summary: summarizeChanges(item, changes),
  };
}

function findItems(reference: string, items: InventoryItem[]): InventoryItem[] {
  const needle = fold(reference).replace(/[?.!]+$/, "").trim();
  if (!needle) return [];
  const exact = items.filter((item) => item.id === reference || [item.name, ...(item.alternativeNames ?? [])].some((name) => fold(name) === needle));
  if (exact.length > 0) return exact;
  return items.filter((item) => [item.name, ...(item.alternativeNames ?? [])].some((name) => fold(name).includes(needle)));
}

function answerForItems(items: InventoryItem[], predicate: string): AssistantResult {
  if (items.length === 0) return { type: "answer", message: `No inventory items ${predicate}.`, itemIDs: [] };
  const names = items.slice(0, 8).map((item) => item.name);
  const remainder = items.length - names.length;
  return {
    type: "answer",
    message: `${names.join(", ")}${remainder > 0 ? `, and ${remainder} more` : ""} ${items.length === 1 ? "matches" : "match"}.`,
    itemIDs: items.map((item) => item.id),
  };
}

function availableCategories(items: InventoryItem[]): string[] {
  return dedupe([...CATEGORY_OPTIONS, ...items.flatMap(itemCategories)]);
}

function canonicalCategories(values: string[], allowed: string[]): string[] {
  return values.flatMap((value) => {
    const match = allowed.find((category) => fold(category) === fold(value));
    return match ? [match] : [];
  });
}

function normalizeStringArray(value: unknown, maxCount: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxCount) return null;
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const trimmed = entry.trim();
    if (!trimmed || Array.from(trimmed).length > maxLength) return null;
    if (!strings.some((existing) => fold(existing) === fold(trimmed))) strings.push(trimmed);
  }
  return strings;
}

function summarizeChanges(item: InventoryItem, changes: UpdateItemMetadataInput): string {
  const parts: string[] = [];
  if (changes.name) parts.push(`rename ${item.name} to ${changes.name}`);
  if (changes.alternativeNames) parts.push(`set alternative names to ${changes.alternativeNames.length ? changes.alternativeNames.join(", ") : "none"}`);
  if (changes.categories) parts.push(`set categories to ${changes.categories.join(", ")}`);
  return `${parts.join("; ")}.`;
}

function balancedJSONObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function parseFirstJSONObject(text: string): ModelCommand {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const candidate = balancedJSONObjectAt(text, start);
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // Continue to the next balanced object.
    }
  }
  throw new Error("missing valid JSON object");
}

function prioritizeItems(request: string, items: InventoryItem[]): InventoryItem[] {
  const needle = fold(request);
  return items.map((item, index) => {
    const terms = [item.name, ...(item.alternativeNames ?? []), ...itemCategories(item), item.location];
    const score = terms.reduce((total, term) => total + (needle.includes(fold(term)) ? 1 : 0), 0);
    return { item, index, score };
  }).sort((left, right) => right.score - left.score || left.index - right.index).map(({ item }) => item);
}

function composePrompt(request: string, snapshot: SnapshotItem[], totalItems: number): { system: string; user: string } {
  return {
    system: [
      "You are the private Home OS inventory command parser. Return exactly one compact JSON object and no markdown.",
      "Supported intents:",
      '{"intent":"find","stockLevel":"low|out|full|okay","category":"category","location":"location","item":"existing item name or id"}',
      '{"intent":"rename","item":"existing item name or id","name":"new primary name","alternativeNames":["optional aliases"]}',
      '{"intent":"aliases","item":"existing item name or id","alternativeNames":["complete desired alias list"]}',
      '{"intent":"categorize","item":"existing item name or id","addCategories":["category"],"removeCategories":["category"]}',
      '{"intent":"help"}',
      "Use only fields shown for the selected intent. Never invent an item id. Preserve the user's language and script.",
      `Allowed categories: ${CATEGORY_OPTIONS.join(", ")}; exact existing custom categories shown in inventory are also allowed.`,
    ].join("\n"),
    user: JSON.stringify({ request, inventory: snapshot, omittedItemCount: totalItems - snapshot.length }),
  };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncate(value: string, maxCodePoints: number): string {
  return Array.from(value).slice(0, maxCodePoints).join("");
}

function prioritizeValues(request: string, values: string[]): string[] {
  const needle = fold(request);
  return values.map((value, index) => ({ value, index, score: needle.includes(fold(value)) ? 1 : 0 }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ value }) => value);
}

function dedupe(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) if (!result.some((existing) => fold(existing) === fold(value))) result.push(value);
  return result;
}

function fold(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function titleFromMatch(actual: string | undefined, fallback: string): string {
  return actual || fallback;
}

function isPlainObject(value: unknown): value is ModelCommand {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStockLevel(value: unknown): value is StockLevel {
  return value === "full" || value === "okay" || value === "low" || value === "out";
}

function unsupported(message: string): AssistantResult {
  return { type: "unsupported", message };
}
