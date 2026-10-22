/**
 * Recipe arithmetic, kept free of the database so the screen, the costing and the stock deduction all agree. Quantities are in each stock item's own unit (g, ml, pieces);
 * a sub-recipe line is in the sub-recipe's yield unit. A line's waste is the share lost in trimming: to end up with 100 g after 20 % waste, 125 g is used.
 */
export interface Line { stockItemId: string | null; subRecipeId: string | null; qty: number; wastePct: number }
export interface Version { kind: 'DISH' | 'SUB_RECIPE'; yieldQty: number; lines: Line[] }
export interface Graph { versions: Map<string, Version>; unitCost: Map<string, number> }

const used = (l: Line) => l.qty / (1 - l.wastePct / 100);
export const MAX_DEPTH = 6;

/** Which stock items, and how much of each, are needed to make `qty` of a recipe's output (portions for a dish). Skips lines named in `leaveOut` (an ingredient the guest asked to leave out). */
export function needs(g: Graph, recipeId: string, qty: number, names: Map<string, string> = new Map(), leaveOut: ReadonlySet<string> = new Set(), depth = 0, into = new Map<string, number>()): Map<string, number> {
  const v = g.versions.get(recipeId);
  if (!v || depth > MAX_DEPTH) return into;
  const batches = qty / v.yieldQty;
  for (const l of v.lines) {
    if (l.stockItemId) {
      if (depth === 0 && leaveOut.has((names.get(l.stockItemId) ?? '').toLowerCase())) continue;
      into.set(l.stockItemId, (into.get(l.stockItemId) ?? 0) + used(l) * batches);
    } else if (l.subRecipeId) needs(g, l.subRecipeId, used(l) * batches, names, leaveOut, depth + 1, into);
  }
  return into;
}

/** Cost of the whole batch a recipe's yield describes, in the smallest currency unit (fractions kept until the caller rounds). */
export function batchCost(g: Graph, recipeId: string): number {
  let total = 0;
  for (const [item, q] of needs(g, recipeId, g.versions.get(recipeId)?.yieldQty ?? 0)) total += q * (g.unitCost.get(item) ?? 0);
  return total;
}
export const perUnitCost = (g: Graph, recipeId: string): number => { const v = g.versions.get(recipeId); return v ? batchCost(g, recipeId) / v.yieldQty : 0; };

/** True if adding `subId` as an ingredient of `recipeId` would make a recipe contain itself, however deep. `edges` maps a recipe to the sub-recipes its latest content uses. */
export function wouldLoop(edges: Map<string, string[]>, recipeId: string, subIds: string[]): boolean {
  const seen = new Set<string>();
  const walk = (id: string): boolean => { if (id === recipeId) return true; if (seen.has(id)) return false; seen.add(id); return (edges.get(id) ?? []).some(walk); };
  return subIds.some(walk);
}

/** Converts a typed quantity to the stock unit, or null when the units do not match (grams cannot be turned into millilitres). */
export function toBase(qty: number, from: string, to: 'g' | 'ml' | 'pcs'): number | null {
  if (from === to) return qty;
  if (from === 'kg' && to === 'g') return qty * 1000;
  if (from === 'l' && to === 'ml') return qty * 1000;
  return null;
}
