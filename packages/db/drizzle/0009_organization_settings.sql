-- Durable organization-owned settings (plan 02 CP-12, ADR-0004).
--
-- This is additive and requires no data rewrite: PostgreSQL supplies `{}` for
-- every existing and future row that omits the column. The control plane still
-- normalizes reads independently, so an existing row remains fail-closed even
-- before every replica has restarted onto the new API code.
ALTER TABLE "organizations" ADD COLUMN "settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL;
