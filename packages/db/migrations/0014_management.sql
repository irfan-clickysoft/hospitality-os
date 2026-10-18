-- 0014 Management KPIs: read-only views over the immutable daily snapshots and the live ledger. One new permission.
INSERT INTO permission (key, description) VALUES
 ('management.view', 'See the management dashboard: occupancy, revenue, receivables, approvals and revenue protection')
ON CONFLICT (key) DO NOTHING;
