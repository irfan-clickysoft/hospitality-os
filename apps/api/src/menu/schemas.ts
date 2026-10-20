import { z } from 'zod';
import { money } from '../folio/schemas.js';
import { uuid } from '../property-setup/schemas.js';

export const ALLERGENS = ['NUTS', 'PEANUTS', 'DAIRY', 'EGGS', 'GLUTEN', 'SHELLFISH', 'FISH', 'SOY', 'SESAME', 'MUSTARD', 'CELERY', 'SULPHITES'] as const;
export const DIETARY = ['HALAL', 'KOSHER', 'VEGETARIAN', 'VEGAN', 'GLUTEN_FREE', 'DAIRY_FREE'] as const;
export const OUTLET_KINDS = ['RESTAURANT', 'ROOM_SERVICE', 'CAFE', 'BAR', 'BANQUET', 'OTHER'] as const;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 18:30');
const days = z.array(z.number().int().min(1).max(7)).min(1).max(7);
const list = (max = 40, len = 60) => z.array(z.string().trim().min(1).max(len)).max(max);
const text = (n: number) => z.string().trim().max(n);

export const CreateOutlet = z.object({ name: z.string().trim().min(2).max(80), kind: z.enum(OUTLET_KINDS).default('RESTAURANT'), description: text(500).nullish(), openingNote: text(200).nullish(), sortOrder: z.number().int().min(0).max(999).default(0) });
export const UpdateOutlet = CreateOutlet.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() });
export const CreateMenu = z.object({ name: z.string().trim().min(2).max(80), days: days.default([1, 2, 3, 4, 5, 6, 7]), availableFrom: time.nullish(), availableTo: time.nullish(), sortOrder: z.number().int().min(0).max(999).default(0) })
  .refine((v) => !!v.availableFrom === !!v.availableTo, { message: 'Give both the opening and closing time, or neither', path: ['availableTo'] });
export const UpdateMenu = z.object({ name: z.string().trim().min(2).max(80).optional(), days: days.optional(), availableFrom: time.nullable().optional(), availableTo: time.nullable().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(), sortOrder: z.number().int().min(0).max(999).optional() })
  .refine((v) => v.availableFrom === undefined || v.availableTo === undefined || !!v.availableFrom === !!v.availableTo, { message: 'Give both the opening and closing time, or neither', path: ['availableTo'] });
export const CreateCategory = z.object({ name: z.string().trim().min(2).max(80), nameUr: text(80).nullish(), description: text(300).nullish(), sortOrder: z.number().int().min(0).max(999).default(0) });
export const UpdateCategory = CreateCategory.partial();

const item = z.object({
  categoryId: uuid,
  // identity
  name: z.string().trim().min(2).max(120), nameUr: text(120).nullish(), shortDescription: text(160).nullish(), description: text(2000).nullish(),
  // pricing
  price: money, discountedPrice: money.nullish(),
  // portion and timing
  servingSize: text(60).nullish(), serves: z.number().int().min(1).max(50).nullish(), portionAmount: text(40).nullish(), prepMinMinutes: z.number().int().min(0).max(480).nullish(), prepMaxMinutes: z.number().int().min(0).max(480).nullish(),
  // availability
  availability: z.enum(['AVAILABLE', 'SOLD_OUT', 'LIMITED']).default('AVAILABLE'), limitedQuantity: z.number().int().min(0).max(9999).nullish(), days: days.nullish(), availableFrom: time.nullish(), availableTo: time.nullish(),
  // ingredients, allergens, dietary
  ingredients: list().default([]), removableIngredients: list().default([]), allergensContain: z.array(z.enum(ALLERGENS)).default([]), allergensMay: z.array(z.enum(ALLERGENS)).default([]), dietary: z.array(z.enum(DIETARY)).default([]),
  // nutrition, food details
  calories: z.number().int().min(0).max(5000).nullish(), proteinG: z.number().min(0).max(500).nullish(), carbsG: z.number().min(0).max(500).nullish(), fatG: z.number().min(0).max(500).nullish(), sodiumMg: z.number().int().min(0).max(20000).nullish(),
  spiceLevel: z.number().int().min(0).max(4).nullish(), cuisine: text(60).nullish(), temperature: z.enum(['HOT', 'WARM', 'COLD', 'AMBIENT']).nullish(), pairings: text(200).nullish(),
  // ordering
  minQuantity: z.number().int().min(1).max(99).default(1), maxQuantity: z.number().int().min(1).max(99).default(20), specialInstructions: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
const itemRules = <T extends z.ZodTypeAny>(s: T) => s
  .refine((v: any) => v.prepMinMinutes == null || v.prepMaxMinutes == null || v.prepMinMinutes <= v.prepMaxMinutes, { message: 'The shortest preparation time cannot be longer than the longest', path: ['prepMaxMinutes'] })
  .refine((v: any) => !v.availableFrom === !v.availableTo, { message: 'Give both times, or neither', path: ['availableTo'] })
  .refine((v: any) => (v.availability === 'LIMITED') === (v.limitedQuantity != null), { message: 'Say how many are left for a limited item (and only for a limited item)', path: ['limitedQuantity'] })
  .refine((v: any) => v.minQuantity <= v.maxQuantity, { message: 'The smallest order cannot be bigger than the largest', path: ['maxQuantity'] })
  .refine((v: any) => (v.removableIngredients as string[]).every((r) => (v.ingredients as string[]).some((i) => i.toLowerCase() === r.toLowerCase())), { message: 'Every removable ingredient must be in the ingredient list', path: ['removableIngredients'] });
export const CreateItem = itemRules(item);
export const UpdateItem = z.object({ ...item.partial().shape, active: z.boolean().optional(), version: z.number().int() });

export const CreateVariant = z.object({ name: z.string().trim().min(1).max(60), price: money, serves: z.number().int().min(1).max(50).nullish(), sortOrder: z.number().int().min(0).max(99).default(0) });
export const UpdateVariant = CreateVariant.partial().extend({ active: z.boolean().optional() });
export const CreateGroup = z.object({ name: z.string().trim().min(2).max(80), minSelect: z.number().int().min(0).max(20).default(0), maxSelect: z.number().int().min(1).max(20).default(1) }).refine((v) => v.minSelect <= v.maxSelect, { message: 'The least cannot be more than the most', path: ['maxSelect'] });
export const UpdateGroup = z.object({ name: z.string().trim().min(2).max(80).optional(), minSelect: z.number().int().min(0).max(20).optional(), maxSelect: z.number().int().min(1).max(20).optional(), active: z.boolean().optional() });
export const CreateOption = z.object({ name: z.string().trim().min(1).max(80), priceDelta: money.default('0'), sortOrder: z.number().int().min(0).max(99).default(0) });
export const UpdateOption = CreateOption.partial().extend({ active: z.boolean().optional() });
export const AttachGroups = z.object({ groupIds: z.array(uuid).max(10) });
export const UpdateMedia = z.object({ altText: text(160).nullish(), makePrimary: z.boolean().optional() });
export const TreeQuery = z.object({ all: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });
