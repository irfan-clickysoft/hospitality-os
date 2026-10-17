import type { ColumnType, Generated } from 'kysely';

type TsGen = ColumnType<Date, Date | string | undefined, Date | string>;           // NOT NULL DEFAULT now()
type Big = ColumnType<string, string | number | bigint, string | number | bigint>;                 // bigint minor units (pg returns int8 as string)
type BigNull = ColumnType<string | null, string | number | bigint | null | undefined, string | number | bigint | null>;
type TsNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type D = ColumnType<string, string, string>; // date as ISO string

export interface TenantTable { id: Generated<string>; name: string; slug: string; status: string; referred_by: string | null; created_at: TsGen }
export interface LegalEntityTable { tenant_id: string; id: Generated<string>; name: string; ntn: string | null; strn: string | null; address: string | null; created_at: TsGen }
export interface BrandTable { tenant_id: string; id: Generated<string>; name: string; created_at: TsGen }
export interface PropertyTable { tenant_id: string; id: Generated<string>; legal_entity_id: string; brand_id: string | null; code: string; name: string; timezone: Generated<string>; currency: Generated<string>; business_date: D; status: Generated<string>; weekend_days: Generated<number[]>; created_at: TsGen; version: Generated<number> }
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

export interface BuildingTable { tenant_id: string; id: Generated<string>; property_id: string; name: string }
export interface FloorTable { tenant_id: string; id: Generated<string>; property_id: string; building_id: string | null; name: string; sort_order: Generated<number> }
export interface RoomTypeTable { tenant_id: string; id: Generated<string>; property_id: string; code: string; name: string; description: string | null; max_adults: number; max_children: Generated<number>; max_occupancy: number; base_occupancy: Generated<number>; bed_config: string | null; size_sqm: string | null; default_overbook_limit: Generated<number>; status: Generated<'ACTIVE' | 'ARCHIVED'>; sort_order: Generated<number>; version: Generated<number>; created_at: TsGen }
export interface RoomTable { tenant_id: string; id: Generated<string>; property_id: string; room_type_id: string; floor_id: string | null; number: string; capacity_override: number | null; bed_config: string | null; smoking: Generated<boolean>; accessible: Generated<boolean>; connecting_room_id: string | null; status: Generated<'ACTIVE' | 'INACTIVE'>; notes: string | null; version: Generated<number>; created_at: TsGen }
export interface AmenityTable { tenant_id: string; id: Generated<string>; code: string; name_en: string; name_ur: string | null; category: Generated<string> }
export interface RoomTypeAmenityTable { tenant_id: string; room_type_id: string; amenity_id: string }
export interface RoomBlockTable { tenant_id: string; id: Generated<string>; property_id: string; room_id: string; block_type: 'OUT_OF_ORDER' | 'OUT_OF_SERVICE'; start_date: D; end_date: D; reason: string; ticket_ref: string | null; created_by: string | null; created_at: TsGen; cancelled_at: TsNull }
export interface InventoryDayTable { tenant_id: string; property_id: string; room_type_id: string; business_date: D; physical: number; out_of_order: Generated<number>; out_of_service: Generated<number>; blocked: Generated<number>; reserved: Generated<number>; held: Generated<number>; overbook_limit: Generated<number>; version: Generated<number> }
export interface RoomAssignmentTable { tenant_id: string; id: Generated<string>; property_id: string; room_id: string; assignment_ref: string; stay_range: string; status: 'ASSIGNED' | 'IN_HOUSE' | 'ENDED'; created_at: TsGen }

export interface RatePlanTable { tenant_id: string; id: Generated<string>; property_id: string; code: string; name: string; description: string | null; kind: Generated<'BASE' | 'DERIVED'>; parent_rate_plan_id: string | null; derive_type: 'PERCENT' | 'FIXED' | null; derive_value: BigNull; derive_round_minor: Generated<number>; meal_plan: Generated<string>; audience: Generated<'PUBLIC' | 'CORPORATE' | 'AGENT'>; residency: Generated<'ANY' | 'RESIDENT' | 'NON_RESIDENT'>; channels: Generated<string[]>; company_ids: Generated<string[]>; min_los: Generated<number>; max_los: number | null; min_advance_days: Generated<number>; max_advance_days: number | null; extra_bed_minor: ColumnType<string, string | number | bigint | undefined, string | number | bigint>; extra_adult_meal_minor: ColumnType<string, string | number | bigint | undefined, string | number | bigint>; extra_child_meal_minor: ColumnType<string, string | number | bigint | undefined, string | number | bigint>; cancellation_rule: unknown | null; no_show_rule: unknown | null; deposit_rule: unknown | null; valid_from: D | null; valid_to: D | null; status: Generated<'ACTIVE' | 'INACTIVE'>; sort_order: Generated<number>; version: Generated<number>; created_at: TsGen }
export interface RateBaseTable { tenant_id: string; property_id: string; rate_plan_id: string; room_type_id: string; amount_minor: Big; weekend_amount_minor: BigNull; extra_adult_minor: ColumnType<string, string | number | bigint | undefined, string | number | bigint>; extra_child_minor: ColumnType<string, string | number | bigint | undefined, string | number | bigint> }
export interface RateSeasonTable { tenant_id: string; id: Generated<string>; property_id: string; rate_plan_id: string; name: string; start_date: D; end_date: D; priority: Generated<number>; created_at: TsGen }
export interface RateSeasonValueTable { tenant_id: string; property_id: string; rate_plan_id: string; season_id: string; room_type_id: string; amount_minor: Big; weekend_amount_minor: BigNull }
export interface RateOverrideTable { tenant_id: string; property_id: string; rate_plan_id: string; room_type_id: string; business_date: D; amount_minor: Big }
export interface RateRestrictionTable { tenant_id: string; id: Generated<string>; property_id: string; rate_plan_id: string; room_type_id: string | null; start_date: D; end_date: D; min_los: number | null; max_los: number | null; closed_to_arrival: Generated<boolean>; closed_to_departure: Generated<boolean>; stop_sell: Generated<boolean>; min_advance_days: number | null; max_advance_days: number | null; note: string | null; created_at: TsGen }

export interface DB {
  rate_plan: RatePlanTable; rate_base: RateBaseTable; rate_season: RateSeasonTable; rate_season_value: RateSeasonValueTable; rate_override: RateOverrideTable; rate_restriction: RateRestrictionTable;
  building: BuildingTable; floor: FloorTable; room_type: RoomTypeTable; room: RoomTable; amenity: AmenityTable; room_type_amenity: RoomTypeAmenityTable;
  room_block: RoomBlockTable; inventory_day: InventoryDayTable; room_assignment: RoomAssignmentTable;
  user_session: UserSessionTable; user_mfa_totp: UserMfaTotpTable; user_recovery_code: UserRecoveryCodeTable; user_token: UserTokenTable;
  tenant: TenantTable; legal_entity: LegalEntityTable; brand: BrandTable; property: PropertyTable; staff_user: StaffUserTable;
  permission: PermissionTable; role: RoleTable; role_permission: RolePermissionTable; role_assignment: RoleAssignmentTable;
  audit_log: AuditLogTable; outbox_event: OutboxEventTable; inbox_receipt: InboxReceiptTable; idempotency_key: IdempotencyKeyTable;
}
