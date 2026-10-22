import { z } from 'zod';
import { uuid } from '../property-setup/schemas.js';

const text = (n: number) => z.string().trim().max(n);
const cost = z.string().regex(/^\d{1,9}(\.\d{1,4})?$/, 'An amount like 600 or 0.55');
const qty = z.number().positive().max(1_000_000);
export const UNITS = ['g', 'kg', 'ml', 'l', 'pcs'] as const;

export const CreateStock = z.object({ name: z.string().trim().min(2).max(80), unit: z.enum(['g', 'ml', 'pcs']), cost: cost.default('0'), costPer: z.enum(UNITS).optional(), reorderLevel: z.number().min(0).max(1_000_000).nullish() });
export const UpdateStock = z.object({ name: z.string().trim().min(2).max(80).optional(), cost: cost.optional(), costPer: z.enum(UNITS).optional(), reorderLevel: z.number().min(0).max(1_000_000).nullable().optional(), active: z.boolean().optional(), version: z.number().int() });
export const Movement = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('RECEIVE'), qty, unit: z.enum(UNITS).optional(), cost: cost.optional(), costPer: z.enum(UNITS).optional(), note: text(200).nullish() }),
  z.object({ kind: z.literal('WASTE'), qty, unit: z.enum(UNITS).optional(), note: text(200).min(3, 'Say what happened') }),
  z.object({ kind: z.literal('ADJUST'), counted: z.number().min(0).max(1_000_000), unit: z.enum(UNITS).optional(), note: text(200).min(3, 'Say why the count changed') }),
]);

export const CreateRecipe = z.object({ name: z.string().trim().min(2).max(120), kind: z.enum(['DISH', 'SUB_RECIPE']), menuItemId: uuid.nullish() });
export const UpdateRecipe = z.object({ name: z.string().trim().min(2).max(120).optional(), menuItemId: uuid.nullable().optional(), active: z.boolean().optional() });

export const RecipeLine = z.object({ stockItemId: uuid.nullish(), subRecipeId: uuid.nullish(), qty, unit: z.enum(UNITS).optional(), wastePct: z.number().min(0).max(90).default(0), note: text(120).nullish() })
  .refine((l) => !!l.stockItemId !== !!l.subRecipeId, { message: 'A line is either a stock item or another recipe', path: ['stockItemId'] });
export const VersionContent = z.object({
  yieldQty: z.number().positive().max(1_000_000), yieldUnit: z.enum(['portion', 'g', 'ml', 'pcs']),
  prepMinutes: z.number().int().min(0).max(1440).nullish(), cookMinutes: z.number().int().min(0).max(1440).nullish(),
  steps: z.array(text(600).min(1)).max(40).default([]), equipment: z.array(text(80).min(1)).max(30).default([]),
  cookingMethod: text(200).nullish(), temperature: text(100).nullish(), plating: text(1000).nullish(), foodSafety: text(1000).nullish(), changeNote: text(300).nullish(),
  lines: z.array(RecipeLine).max(60).default([]),
});
export const Period = z.object({ versionId: uuid.optional() });
