import { z } from 'zod';
import { money } from '../folio/schemas.js';
import { uuid } from '../property-setup/schemas.js';

export const CreateItem = z.object({ category: z.string().trim().min(2).max(60), name: z.string().trim().min(2).max(120), nameUr: z.string().trim().max(120).nullish(), price: money, sortOrder: z.number().int().min(0).max(9999).default(0) });
export const UpdateItem = CreateItem.partial().extend({ active: z.boolean().optional(), version: z.number().int() });
export const CreateOrder = z.object({
  reservationRoomId: uuid, payDigitally: z.boolean().default(false), note: z.string().trim().max(300).nullish(),
  lines: z.array(z.object({ menuItemId: uuid, quantity: z.number().int().min(1).max(99).default(1), note: z.string().trim().max(160).nullish() })).min(1).max(40),
});
export const Cancel = z.object({ reason: z.string().trim().min(3).max(300) });
export const QueueQuery = z.object({ status: z.enum(['OPEN', 'DELIVERED', 'CANCELLED', 'ALL']).default('OPEN'), limit: z.coerce.number().int().min(1).max(200).default(100) });
export const MenuQuery = z.object({ all: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });
