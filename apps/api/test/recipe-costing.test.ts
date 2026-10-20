import { describe, expect, it } from 'vitest';
import { batchCost, needs, perUnitCost, toBase, wouldLoop, type Graph } from '../src/recipes/costing.js';

// Karahi (2 portions): 600 g chicken, 200 g of gravy; gravy (1000 g): 500 g tomato with 20 % trimming waste, 100 ml oil
const g: Graph = {
  versions: new Map([
    ['karahi', { kind: 'DISH', yieldQty: 2, lines: [{ stockItemId: 'chicken', subRecipeId: null, qty: 600, wastePct: 0 }, { stockItemId: null, subRecipeId: 'gravy', qty: 200, wastePct: 0 }] }],
    ['gravy', { kind: 'SUB_RECIPE', yieldQty: 1000, lines: [{ stockItemId: 'tomato', subRecipeId: null, qty: 500, wastePct: 20 }, { stockItemId: 'oil', subRecipeId: null, qty: 100, wastePct: 0 }] }],
  ]),
  unitCost: new Map([['chicken', 60], ['tomato', 10], ['oil', 40]]),                   // paisa per g / ml
};

describe('recipe arithmetic', () => {
  it('adds the waste: 500 g of tomato after 20 % trimming means 625 g bought', () => {
    const n = needs(g, 'gravy', 1000);
    expect(n.get('tomato')).toBeCloseTo(625, 6); expect(n.get('oil')).toBeCloseTo(100, 6);
  });
  it('a dish uses its sub-recipe in proportion, per portion ordered', () => {
    const n = needs(g, 'karahi', 3);                                                   // 3 portions of a 2-portion batch
    expect(n.get('chicken')).toBeCloseTo(900, 6);
    expect(n.get('tomato')).toBeCloseTo(625 * 0.2 * 1.5, 6);                           // 200 g of gravy per batch → 0.2 of the gravy batch, 1.5 batches
  });
  it('costs the batch and a unit through the sub-recipe', () => {
    expect(perUnitCost(g, 'gravy')).toBeCloseTo((625 * 10 + 100 * 40) / 1000, 6);
    expect(batchCost(g, 'karahi')).toBeCloseTo(600 * 60 + 0.2 * (625 * 10 + 100 * 40), 6);
  });
  it('leaves out an ingredient the guest asked to leave out', () => {
    expect(needs(g, 'karahi', 2, new Map([['chicken', 'Chicken']]), new Set(['chicken'])).has('chicken')).toBe(false);
  });
  it('stops a recipe from containing itself, directly or through another', () => {
    const edges = new Map([['gravy', ['masala']], ['masala', []]]);
    expect(wouldLoop(edges, 'masala', ['gravy'])).toBe(true);
    expect(wouldLoop(edges, 'karahi', ['gravy'])).toBe(false);
    expect(wouldLoop(edges, 'karahi', ['karahi'])).toBe(true);
  });
  it('converts kg and l, and refuses unit mix-ups', () => {
    expect(toBase(1.5, 'kg', 'g')).toBe(1500); expect(toBase(2, 'l', 'ml')).toBe(2000); expect(toBase(3, 'pcs', 'pcs')).toBe(3);
    expect(toBase(1, 'kg', 'ml')).toBeNull(); expect(toBase(1, 'g', 'pcs')).toBeNull();
  });
});
