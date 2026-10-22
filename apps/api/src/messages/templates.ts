/** The wording guests receive, and how a template is filled in. Pure functions: no database, easy to test. */

export const EVENTS = ['RESERVATION_CONFIRMED', 'CHECK_IN', 'PAYMENT_RECEIVED', 'SERVICE_ORDER', 'CHECK_OUT', 'REFUND', 'DOCUMENT', 'MAINTENANCE_ASSIGNED'] as const;
export type MessageEvent = (typeof EVENTS)[number];
export const CHANNELS = ['WHATSAPP', 'EMAIL'] as const;
export type Channel = (typeof CHANNELS)[number];

const COMMON = ['guest_name', 'property_name', 'property_address', 'property_contact', 'manager_name', 'booking_reference', 'secure_link'] as const;
const STAY = ['check_in_date_time', 'check_out_date_time', 'maps_link'] as const;
const MONEY = ['currency', 'amount', 'balance'] as const;
/** The placeholders each kind of message may use. A template naming anything else is refused when saved. */
export const VARIABLES: Record<MessageEvent, readonly string[]> = {
  RESERVATION_CONFIRMED: [...COMMON, ...STAY],
  CHECK_IN: [...COMMON, ...STAY],
  PAYMENT_RECEIVED: [...COMMON, ...MONEY, 'payment_method', 'payment_date', 'receipt_number'],
  SERVICE_ORDER: [...COMMON, ...MONEY, 'service_name', 'order_number', 'service_details', 'service_time'],
  CHECK_OUT: [...COMMON, ...MONEY, 'check_out_date_time'],
  REFUND: [...COMMON, ...MONEY, 'payment_method', 'payment_date', 'receipt_number'],
  DOCUMENT: [...COMMON, ...MONEY, 'document_title', 'reference_number', 'transaction_date', 'description'],
  MAINTENANCE_ASSIGNED: ['recipient_name', 'property_name', 'manager_name', 'work_order_number', 'work_title', 'work_details', 'work_room', 'work_priority', 'work_kind', 'work_due', 'requested_by'],
};

export const TITLES: Record<MessageEvent, string> = {
  RESERVATION_CONFIRMED: 'Reservation confirmed', CHECK_IN: 'Check-in completed', PAYMENT_RECEIVED: 'Payment received', SERVICE_ORDER: 'Additional service ordered',
  CHECK_OUT: 'Check-out completed', REFUND: 'Refund or adjustment', DOCUMENT: 'Any other document', MAINTENANCE_ASSIGNED: 'Job sent to a technician or contractor',
};

const SIGN = '\nWarm regards,\n{{manager_name}}\n{{property_name}}';
const WHATSAPP: Record<MessageEvent, string> = {
  MAINTENANCE_ASSIGNED: `Hello {{recipient_name}},

A {{work_priority}} {{work_kind}} job needs your attention at {{property_name}}.

Job: {{work_order_number}} — {{work_title}}
Where: {{work_room}}
Details: {{work_details}}
Please finish by: {{work_due}}
Asked by: {{requested_by}}

Please reply to confirm you have received this and tell us when you can attend.
${SIGN}`,
  RESERVATION_CONFIRMED: `Dear {{guest_name}},

Greetings from {{property_name}}.

We are pleased to confirm your reservation:

Booking reference: {{booking_reference}}
Check-in: {{check_in_date_time}}
Check-out: {{check_out_date_time}}
Location: {{maps_link}}

View your reservation, directions and terms, or ask us for a service: {{secure_link}}

We look forward to welcoming you. If you need any assistance before your arrival, please reply to this message.
${SIGN}`,
  CHECK_IN: `Dear {{guest_name}},

Welcome to {{property_name}}. Your check-in has been completed successfully.

Booking reference: {{booking_reference}}
Check-out: {{check_out_date_time}}

View your stay details: {{secure_link}}

Please reply to this message if you need any assistance.
${SIGN}`,
  PAYMENT_RECEIVED: `Dear {{guest_name}},

Thank you. We confirm receipt of your payment for your reservation at {{property_name}}.

Booking reference: {{booking_reference}}
Amount received: {{currency}} {{amount}}
Payment date: {{payment_date}}
Payment method: {{payment_method}}
Receipt number: {{receipt_number}}
Remaining balance: {{currency}} {{balance}}

Your payment receipt is available here: {{secure_link}}
${SIGN}`,
  SERVICE_ORDER: `Dear {{guest_name}},

Your order for {{service_name}} has been recorded.

Order number: {{order_number}}
Details: {{service_details}}
Amount: {{currency}} {{amount}}
Expected delivery/time: {{service_time}}

View your order: {{secure_link}}

Thank you for choosing {{property_name}}.`,
  CHECK_OUT: `Dear {{guest_name}},

Thank you for staying with us. Your check-out from {{property_name}} has been completed.

Booking reference: {{booking_reference}}
Final balance: {{currency}} {{balance}}

View your final statement: {{secure_link}}

We hope you had a pleasant stay and look forward to welcoming you again.
${SIGN}`,
  REFUND: `Dear {{guest_name}},

We confirm your refund / adjustment for booking {{booking_reference}} at {{property_name}}.

Amount: {{currency}} {{amount}}
Date: {{payment_date}}
Method: {{payment_method}}
Reference: {{receipt_number}}
Remaining balance: {{currency}} {{balance}}

View your document: {{secure_link}}
${SIGN}`,
  DOCUMENT: `Dear {{guest_name}},

Thank you for choosing {{property_name}}.

Your {{document_title}} has been generated successfully.

Reference: {{reference_number}}
Booking reference: {{booking_reference}}
Date: {{transaction_date}}
Description: {{description}}
Amount: {{currency}} {{amount}}
Remaining balance: {{currency}} {{balance}}

View or download your digital document: {{secure_link}}

If you have any questions, please reply to this message or contact us at {{property_contact}}.
${SIGN}
{{property_address}}`,
};

/** Email uses the same wording, with a subject. */
const SUBJECTS: Record<MessageEvent, string> = {
  RESERVATION_CONFIRMED: 'Your reservation at {{property_name}} is confirmed ({{booking_reference}})', CHECK_IN: 'Welcome to {{property_name}}', PAYMENT_RECEIVED: 'Payment receipt {{receipt_number}} — {{property_name}}',
  SERVICE_ORDER: 'Your order {{order_number}} — {{property_name}}', CHECK_OUT: 'Thank you for staying at {{property_name}}', REFUND: 'Your refund {{receipt_number}} — {{property_name}}', DOCUMENT: '{{document_title}} {{reference_number}} — {{property_name}}', MAINTENANCE_ASSIGNED: '{{work_priority}} job {{work_order_number}} — {{property_name}}',
};

export function defaultTemplate(event: MessageEvent, channel: Channel): { subject: string | null; body: string } {
  return { subject: channel === 'EMAIL' ? SUBJECTS[event] : null, body: WHATSAPP[event] };
}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** The placeholders a text uses that this kind of message does not offer. */
export function unknownVariables(event: MessageEvent, text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((v) => !VARIABLES[event].includes(v)))];
}

/**
 * Fills a template in. A line with any empty placeholder is left out whole (no "Location:" with nothing after it, no "Remaining balance: PKR" when nothing is owed).
 * Runs of blank lines are squeezed to one.
 */
export function render(template: string, vars: Record<string, string | null | undefined>): string {
  const out: string[] = [];
  for (const line of template.split('\n')) {
    const names = [...line.matchAll(PLACEHOLDER)].map((m) => m[1]!);
    if (names.some((n) => !vars[n])) continue;
    out.push(line.replace(PLACEHOLDER, (_m, n: string) => vars[n] ?? ''));
  }
  return out.join('\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
