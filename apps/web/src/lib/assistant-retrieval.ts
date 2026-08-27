import type { InventoryItem } from "./inventory";

export type InventoryEvidenceField = "name" | "alternativeName" | "category" | "location" | "stockLevel" | "unit";

export interface InventoryEvidence {
  item: InventoryItem;
  score: number;
  matchedFields: InventoryEvidenceField[];
}

export interface InventoryRetrieval {
  evidence: InventoryEvidence[];
  totalItems: number;
  omittedItems: number;
  normalizedTerms: string[];
  strategy: "ranked" | "attention-fallback";
}

const DEFAULT_LIMIT = 12;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "at", "can", "do", "for", "from", "how", "i", "in", "is", "it", "left", "me", "much",
  "of", "on", "our", "please", "show", "the", "to", "we", "what", "where", "which", "with", "you",
]);

const FIELD_WEIGHTS: Record<InventoryEvidenceField, number> = {
  name: 18,
  alternativeName: 16,
  category: 10,
  location: 8,
  stockLevel: 9,
  unit: 5,
};

interface RankedEvidence extends InventoryEvidence {
  index: number;
}

export function retrieveInventory(request: string, items: InventoryItem[], limit = DEFAULT_LIMIT): InventoryRetrieval {
  const safeLimit = Math.max(0, Math.min(DEFAULT_LIMIT, Math.floor(limit)));
  const normalizedRequest = fold(request);
  const normalizedTerms = tokens(request);
  const stockFacets = requestedStockLevels(normalizedRequest, normalizedTerms);
  const ranked = items.map((item, index) => scoreItem(item, index, normalizedRequest, normalizedTerms, stockFacets));
  const matches = ranked
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const strategy = matches.length > 0 ? "ranked" : "attention-fallback";
  const selected = matches.length > 0
    ? matches
    : ranked.sort((left, right) => attentionRank(left.item) - attentionRank(right.item) || left.index - right.index);

  const evidence = selected.slice(0, safeLimit).map(({ item, score, matchedFields }) => ({
    item,
    score,
    matchedFields: [...matchedFields],
  }));
  return {
    evidence,
    totalItems: items.length,
    omittedItems: Math.max(0, items.length - evidence.length),
    normalizedTerms,
    strategy,
  };
}

function scoreItem(
  item: InventoryItem,
  index: number,
  request: string,
  queryTerms: string[],
  stockFacets: Set<InventoryItem["stockLevel"]>,
): RankedEvidence {
  let score = 0;
  const matchedFields: InventoryEvidenceField[] = [];
  const fields: Array<{ field: InventoryEvidenceField; values: string[] }> = [
    { field: "name", values: [item.name] },
    { field: "alternativeName", values: item.alternativeNames ?? [] },
    { field: "category", values: item.categories?.length ? item.categories : [item.category] },
    { field: "location", values: [item.location] },
    { field: "unit", values: [item.unit] },
  ];

  for (const { field, values } of fields) {
    const foldedValues = values.map(fold).filter(Boolean);
    const fieldTerms = new Set(values.flatMap(tokens));
    const overlap = queryTerms.filter((term) => fieldTerms.has(term)).length;
    const phraseMatch = foldedValues.some((value) => value.length > 1 && request.includes(value));
    if (overlap === 0 && !phraseMatch) continue;
    matchedFields.push(field);
    score += overlap * FIELD_WEIGHTS[field];
    if (phraseMatch) score += field === "name" ? 60 : field === "alternativeName" ? 54 : 18;
  }

  if (stockFacets.has(item.stockLevel)) {
    matchedFields.push("stockLevel");
    score += FIELD_WEIGHTS.stockLevel + (item.stockLevel === "out" ? 3 : 0);
  }

  return { item, index, score, matchedFields: dedupeFields(matchedFields) };
}

function tokens(value: string): string[] {
  const matches = fold(value).match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  const result: string[] = [];
  for (const match of matches) {
    const token = stem(match);
    if (!token || STOP_WORDS.has(token) || result.includes(token)) continue;
    result.push(token);
  }
  return result;
}

function requestedStockLevels(request: string, queryTerms: string[]): Set<InventoryItem["stockLevel"]> {
  const levels = new Set<InventoryItem["stockLevel"]>();
  if (/\b(out of stock|stocked out|completely empty|empty)\b/.test(request) || queryTerms.includes("out")) levels.add("out");
  if (/\b(running low|low stock|almost empty|almost finished)\b/.test(request) || queryTerms.includes("low")) levels.add("low");
  if (/\b(full|fully stocked)\b/.test(request)) levels.add("full");
  if (/\b(okay|ok|enough)\b/.test(request)) levels.add("okay");
  return levels;
}

function attentionRank(item: InventoryItem): number {
  switch (item.stockLevel) {
    case "out": return 0;
    case "low": return 1;
    case "okay": return 2;
    case "full": return 3;
  }
}

function dedupeFields(fields: InventoryEvidenceField[]): InventoryEvidenceField[] {
  return fields.filter((field, index) => fields.indexOf(field) === index);
}

function stem(token: string): string {
  if (/^[a-z]+$/.test(token) && token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function fold(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
