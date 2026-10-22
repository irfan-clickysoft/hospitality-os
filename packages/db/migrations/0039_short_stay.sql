-- 0039 Short stays: a guest who checks in and leaves a few hours later is not charged a full night unless the property says so. The property's rule says how much of the night is charged
-- for each length of stay, e.g. {"tiers":[{"upToHours":3,"percent":30},{"upToHours":6,"percent":50},{"upToHours":12,"percent":75}]} (longer than the last tier is the full night). Null: no rule, the full night is charged.
ALTER TABLE property ADD COLUMN short_stay_rule jsonb;
