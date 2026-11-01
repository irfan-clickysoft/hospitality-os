import { z } from 'zod';
import { uuid } from '../property-setup/schemas.js';

export const PERIODS = ['CLOSED_DAY', 'LAST_7', 'LAST_30', 'MONTH_TO_DATE', 'PREVIOUS_MONTH', 'NEXT_7', 'NEXT_30', 'NEXT_90'] as const;
const param = z.string().trim().max(30).regex(/^[A-Za-z0-9_-]*$/);
export const ScheduleInput = z.object({
  reportId: z.string().trim().min(2).max(60), name: z.string().trim().min(2).max(120), basis: param.optional(),
  params: z.object({ view: param.optional(), group: param.optional(), compare: param.optional() }).strict().default({}),
  period: z.enum(PERIODS), frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY']),
  weekday: z.number().int().min(0).max(6).optional(), monthDay: z.number().int().min(0).max(28).optional(),
  alert: z.object({ kpi: z.string().trim().min(1).max(40), op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']), value: z.number().finite() }).strict().nullish(),
  recipientIds: z.array(uuid).min(1).max(20),
}).strict().refine((v) => (v.frequency === 'WEEKLY') === (v.weekday !== undefined), { message: 'Choose the weekday for a weekly report', path: ['weekday'] })
  .refine((v) => (v.frequency === 'MONTHLY') === (v.monthDay !== undefined), { message: 'Choose the day of the month for a monthly report', path: ['monthDay'] });
export const ScheduleUpdate = z.object({ active: z.boolean().optional() }).strict();
