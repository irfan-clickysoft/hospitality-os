import { z } from 'zod';
import { businessDate, uuid } from '../property-setup/schemas.js';

const note = z.string().trim().min(3).max(300);
const at = z.string().datetime().optional();                    // when it really happened (set by the app when it was offline)
export const TASK_TYPES = ['CHECKOUT_CLEAN', 'STAYOVER', 'ARRIVAL_PREP', 'DEEP_CLEAN', 'ON_DEMAND'] as const;
export const ISSUE_CATEGORIES = ['PLUMBING', 'ELECTRICAL', 'AC', 'FURNITURE', 'APPLIANCE', 'CLEANLINESS', 'OTHER'] as const;

export const BoardQuery = z.object({ date: businessDate.optional() });
export const MyTasksQuery = z.object({ includeDone: z.enum(['true', 'false']).default('false') });
export const CreateTask = z.object({ roomId: uuid, taskType: z.enum(['ON_DEMAND', 'DEEP_CLEAN']).default('ON_DEMAND'), priority: z.number().int().min(1).max(4).default(3), notes: z.string().trim().max(300).nullish(), assignTo: uuid.optional() });
export const AssignTasks = z.object({ taskIds: z.array(uuid).min(1).max(100), assigneeId: uuid.nullable() });
export const StartTask = z.object({ at });
export const FinishTask = z.object({ at, notes: z.string().trim().max(300).nullish() });
export const SkipTask = z.object({ reason: note, at });
export const CancelTask = z.object({ reason: note });
export const InspectTask = z.object({ pass: z.boolean(), note: z.string().trim().max(300).nullish() });
export const SetDnd = z.object({ dnd: z.boolean() });
export const Settings = z.object({ requireInspection: z.boolean() });
export const ReportIssue = z.object({
  roomId: uuid.optional(), area: z.string().trim().min(2).max(80).optional(), category: z.enum(ISSUE_CATEGORIES), description: z.string().trim().min(3).max(500), priority: z.number().int().min(1).max(4).default(3),
}).refine((v) => v.roomId || v.area, { message: 'give a room or an area' });
export const ResolveIssue = z.object({ note: z.string().trim().max(300).nullish() });
export const IssuesQuery = z.object({ status: z.enum(['OPEN', 'RESOLVED']).default('OPEN') });
export const LostFoundCreate = z.object({ roomId: uuid.optional(), location: z.string().trim().max(120).optional(), item: z.string().trim().min(2).max(200), description: z.string().trim().max(500).optional() });
export const LostFoundClose = z.object({ status: z.enum(['RETURNED', 'DISPOSED']), note: z.string().trim().max(300).nullish() });
export const LostFoundQuery = z.object({ status: z.enum(['FOUND', 'RETURNED', 'DISPOSED']).default('FOUND') });
export const OverrideStatus = z.object({ status: z.enum(['CLEAN', 'DIRTY', 'INSPECTED']) });
