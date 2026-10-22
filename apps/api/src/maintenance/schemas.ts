import { z } from 'zod';
import { money } from '../folio/schemas.js';
import { businessDate, uuid } from '../property-setup/schemas.js';

const note = z.string().trim().min(3).max(300);
export const CATEGORIES = ['PLUMBING', 'ELECTRICAL', 'AC', 'FURNITURE', 'APPLIANCE', 'CLEANLINESS', 'SAFETY', 'FUMIGATION', 'OTHER'] as const;
export const KINDS = ['CORRECTIVE', 'PREVENTIVE'] as const;
export const TRADES = ['GENERAL', 'PLUMBING', 'ELECTRICAL', 'AC', 'FURNITURE', 'APPLIANCE', 'CLEANLINESS', 'SAFETY', 'FUMIGATION', 'OTHER'] as const;
export const CreateOrder = z.object({
  title: z.string().trim().min(3).max(160), description: z.string().trim().max(2000).nullish(), category: z.enum(CATEGORIES), kind: z.enum(KINDS).default('CORRECTIVE'), estimatedCost: money.nullish(), priority: z.number().int().min(1).max(4).default(3),
  roomId: uuid.nullish(), area: z.string().trim().max(80).nullish(), issueId: uuid.nullish(), dueDate: businessDate.nullish(), assignedTo: uuid.nullish(), vendorId: uuid.nullish(),
  /** The room cannot be sold while this is open: takes it out of order for these dates (the end date is the day it is expected back). */
  outOfOrder: z.object({ startDate: businessDate, endDate: businessDate, type: z.enum(['OUT_OF_ORDER', 'OUT_OF_SERVICE']).default('OUT_OF_ORDER'), acknowledgeOversell: z.boolean().default(false) }).optional(),
}).refine((v) => !v.outOfOrder || !!v.roomId, { message: 'Choose the room to take out of order', path: ['roomId'] });
const outOfOrder = z.object({ startDate: businessDate, endDate: businessDate, type: z.enum(['OUT_OF_ORDER', 'OUT_OF_SERVICE']).default('OUT_OF_ORDER'), acknowledgeOversell: z.boolean().default(false) });
/** Give the job to an in-house technician or to a third-party contractor — not both. */
export const Assign = z.object({ assignedTo: uuid.optional(), vendorId: uuid.optional(), dueDate: businessDate.nullish(), estimatedCost: money.nullish() })
  .refine((v) => (v.assignedTo ? 1 : 0) + (v.vendorId ? 1 : 0) === 1, { message: 'Choose a technician or a contractor', path: ['assignedTo'] });
/** Approving can also assign and set the estimate, priority and (for a room) take it out of order, so a manager does it in one step. */
export const Approve = z.object({ assignedTo: uuid.optional(), vendorId: uuid.optional(), dueDate: businessDate.nullish(), priority: z.number().int().min(1).max(4).optional(), estimatedCost: money.nullish(), note: z.string().trim().max(300).nullish(), outOfOrder: outOfOrder.optional() })
  .refine((v) => !(v.assignedTo && v.vendorId), { message: 'Choose a technician or a contractor, not both', path: ['assignedTo'] });
export const Reject = z.object({ reason: note });
export const CreateVendor = z.object({
  name: z.string().trim().min(2).max(120), trade: z.enum(TRADES).default('GENERAL'), contactName: z.string().trim().max(120).nullish(), phone: z.string().trim().max(30).nullish(), email: z.string().trim().email().max(200).nullish(),
  contractRef: z.string().trim().max(80).nullish(), contractStart: businessDate.nullish(), contractEnd: businessDate.nullish(),
  slaResponseHours: z.number().int().min(1).max(720).nullish(), slaFixHours: z.number().int().min(1).max(2160).nullish(), notes: z.string().trim().max(1000).nullish(),
});
export const UpdateVendor = CreateVendor.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() });
export const SummaryQuery = z.object({ by: z.enum(['kind', 'vendor', 'technician', 'category']).default('kind') });
export const Wait = z.object({ reason: note });
export const Done = z.object({ note, cost: money.optional(), vendor: z.string().trim().max(120).nullish() });
export const Verify = z.object({ note: z.string().trim().max(300).nullish() });
export const Reopen = z.object({ reason: note });
export const Cancel = z.object({ reason: note });
export const AddNote = z.object({ note });
export const ListQuery = z.object({ status: z.enum(['REQUESTED', 'OPEN', 'ACTIVE', 'DONE', 'ALL']).default('ACTIVE'), kind: z.enum(KINDS).optional(), vendorId: uuid.optional(), assignedTo: uuid.optional(), category: z.enum(CATEGORIES).optional(), mine: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'), roomId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) });

export const BillCreate = z.object({ vendorId: uuid.nullish(), payee: z.string().trim().min(2).max(120).nullish(), billNo: z.string().trim().min(1).max(60), billDate: businessDate, dueDate: businessDate.nullish(), amount: money, note: z.string().trim().max(300).nullish() });
export const BillApprove = z.object({ note: z.string().trim().max(300).nullish() });
export const BillReject = z.object({ reason: note });
export const BillPay = z.object({ method: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'OTHER']), ref: z.string().trim().max(80).nullish() });
export const BillQuery = z.object({ status: z.enum(['OPEN', 'RECEIVED', 'APPROVED', 'REJECTED', 'PAID', 'ALL']).default('OPEN'), vendorId: uuid.optional(), limit: z.coerce.number().int().min(1).max(300).default(150) });
export const MediaCaption = z.object({ caption: z.string().trim().max(160).nullable() });

const schedule = z.object({
  title: z.string().trim().min(3).max(160), description: z.string().trim().max(2000).nullish(), category: z.enum(CATEGORIES), priority: z.number().int().min(1).max(4).default(3),
  roomIds: z.array(uuid).max(200).default([]), area: z.string().trim().max(80).nullish(),
  everyN: z.number().int().min(1).max(365), unit: z.enum(['DAY', 'WEEK', 'MONTH', 'YEAR']), firstDue: businessDate, leadDays: z.number().int().min(0).max(60).default(7),
  assignedTo: uuid.nullish(), vendorId: uuid.nullish(), estimatedCost: money.nullish(),
});
export const ScheduleCreate = schedule.refine((v) => !(v.assignedTo && v.vendorId), { message: 'Choose a technician or a contractor, not both', path: ['assignedTo'] });
export const ScheduleUpdate = z.object({
  title: schedule.shape.title.optional(), description: schedule.shape.description, priority: schedule.shape.priority.optional(), area: schedule.shape.area,
  everyN: schedule.shape.everyN.optional(), unit: schedule.shape.unit.optional(), nextDue: businessDate.optional(), leadDays: schedule.shape.leadDays.optional(),
  assignedTo: uuid.nullable().optional(), vendorId: uuid.nullable().optional(), estimatedCost: money.nullable().optional(), active: z.boolean().optional(),
});
