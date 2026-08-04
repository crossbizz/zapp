-- Links a `users` row to the identity provider's own record — a Stytch member
-- id (plan 02 CP-2/CP-3, ADR-0001).
--
-- Not a PRD §23.1 column: that section predates the identity-provider decision,
-- and the PRD is documentation of intent rather than a file to be edited into
-- agreement with the code. The deviation is declared instead, with its reason,
-- in packages/db/test/prd-schema-conformance.test.ts.
--
-- Nullable because a row can exist before it is linked (an invite, a fixture),
-- and unique only where it is set: two unlinked users are not duplicates. Until
-- this column exists to match on, CP-2 has to link identities by email address,
-- which breaks the moment someone changes theirs — and quietly hands the old
-- account to whoever registers the freed address next.
ALTER TABLE "users" ADD COLUMN "external_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_id_idx" ON "users" USING btree ("external_id") WHERE external_id is not null;