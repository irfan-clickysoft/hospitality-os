import { z } from 'zod';
import { uuid } from '../property-setup/schemas.js';
import { CHANNELS, EVENTS } from './templates.js';

export const SaveTemplate = z.object({ subject: z.string().trim().max(200).nullish(), body: z.string().trim().min(10).max(4000) }).strict();
export const Compose = z.object({
  event: z.enum(EVENTS), channel: z.enum(CHANNELS).default('WHATSAPP'), reservationId: uuid, paymentId: uuid.optional(),
  salutation: z.enum(['Mr.', 'Mrs.']).optional(),
  /** The page address guests open (the hotel's own site), so the link in the message points at the right place. */
  origin: z.string().url().max(200).optional(),
  /** Values for the kinds of message the system cannot work out yet (a service order's name, details and time). */
  extra: z.record(z.string().max(40), z.string().max(300)).default({}),
}).strict();
