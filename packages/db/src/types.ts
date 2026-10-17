import type { ColumnType, Generated } from 'kysely';

type TsGen = ColumnType<Date, Date | string | undefined, Date | string>;           // NOT NULL DEFAULT now()
type TsNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type D = ColumnType<string, string, string>; // date as ISO string

export interface TenantTable { id: Generated<string>; name: string; slug: string; status: string; referred_by: string | null; created_at: TsGen }
export interface LegalEntityTable { tenant_id: string; id: Generated<string>; name: string; ntn: string | null; strn: string | null; address: string | null; created_at: TsGen }
export interface BrandTable { tenant_id: string; id: Generated<string>; name: string; created_at: TsGen }
export interface PropertyTable { tenant_id: string; id: Generated<string>; legal_entity_id: string; brand_id: string | null; code: string; name: string; timezone: Generated<string>; currency: Generated<string>; business_date: D; status: Generated<string>; created_at: TsGen; version: Generated<number> }
export interface StaffUserTable { tenant_id: string; id: Generated<string>; email: string; full_name: string; preferred_locale: Generated<'en' | 'ur'>; status: Generated<string>; password_hash: string | null; mfa_enabled: Generated<boolean>; created_at: TsGen; failed_login_count: Generated<number>; locked_until: TsNull; last_login_at: TsNull; password_changed_at: TsNull }
export interface PermissionTable { key: string; description: string }
export interface RoleTable { tenant_id: string; id: Generated<string>; key: string; name: string; is_system: Generated<boolean> }
export interface RolePermissionTable { tenant_id: string; role_id: string; permission_key: string }
export interface RoleAssignmentTable { tenant_id: string; id: Generated<string>; user_id: string; role_id: string; scope_type: 'TENANT' | 'LEGAL_ENTITY' | 'PROPERTY' | 'DEPARTMENT'; scope_id: string | null; limits: Generated<unknown>; valid_from: TsGen; valid_to: TsNull }
export interface AuditLogTable { tenant_id: string; id: Generated<string>; occurred_at: TsGen; actor_type: string; actor_id: string | null; on_behalf_of: string | null; action: string; resource_type: string; resource_id: string | null; property_id: string | null; before: unknown | null; after: unknown | null; reason_code: string | null; note: string | null; request_id: string | null; ip: string | null; user_agent: string | null }
export interface OutboxEventTable { tenant_id: string; id: Generated<string>; aggregate_type: string; aggregate_id: string; event_type: string; event_version: Generated<number>; property_id: string | null; business_date: D | null; payload: unknown; created_at: TsGen; published_at: TsNull; seq: ColumnType<string, never, never>; attempts: Generated<number>; last_error: string | null; dead_lettered_at: TsNull }
export interface InboxReceiptTable { tenant_id: string; consumer: string; event_id: string; received_at: TsGen }
export interface IdempotencyKeyTable { tenant_id: string; key: string; request_hash: string; status_code: number | null; response: unknown | null; created_at: TsGen; expires_at: TsGen }

export interface UserSessionTable { tenant_id: string; id: Generated<string>; user_id: string; token_hash: Buffer; csrf_token: string; state: 'PENDING_MFA' | 'ACTIVE'; created_at: TsGen; last_seen_at: TsGen; idle_expires_at: Date | string; absolute_expires_at: Date | string; mfa_verified_at: TsNull; revoked_at: TsNull; mfa_failed_count: Generated<number>; ip: string | null; user_agent: string | null }
export interface UserMfaTotpTable { tenant_id: string; user_id: string; secret_enc: string; confirmed_at: TsNull; last_used_step: ColumnType<string | null, string | number | null | undefined, string | number | null>; created_at: TsGen }
export interface UserRecoveryCodeTable { tenant_id: string; id: Generated<string>; user_id: string; code_hash: Buffer; used_at: TsNull }
export interface UserTokenTable { tenant_id: string; id: Generated<string>; user_id: string; purpose: 'INVITE' | 'PASSWORD_RESET'; token_hash: Buffer; expires_at: Date | string; used_at: TsNull; created_at: TsGen }

export interface DB {
  user_session: UserSessionTable; user_mfa_totp: UserMfaTotpTable; user_recovery_code: UserRecoveryCodeTable; user_token: UserTokenTable;
  tenant: TenantTable; legal_entity: LegalEntityTable; brand: BrandTable; property: PropertyTable; staff_user: StaffUserTable;
  permission: PermissionTable; role: RoleTable; role_permission: RolePermissionTable; role_assignment: RoleAssignmentTable;
  audit_log: AuditLogTable; outbox_event: OutboxEventTable; inbox_receipt: InboxReceiptTable; idempotency_key: IdempotencyKeyTable;
}
