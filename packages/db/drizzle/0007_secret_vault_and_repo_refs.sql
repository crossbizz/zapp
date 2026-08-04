-- The secrets vault, and two repository invariants CP-6's review found missing
-- (plan 02 CP-7; PRD §18.12, §23.2, §23.6).
--
-- Four things, all additive:
--
--   1. `secret_ciphertexts` — where an encrypted secret value actually lives.
--      PRD §23.6 gives `secret_metadata.encrypted_value_ref` and says the
--      ciphertext is held elsewhere; this is elsewhere. Splitting it out is not
--      tidiness: it is what makes the metadata read structurally incapable of
--      returning a value, because the table it selects from has no column that
--      holds one.
--   2. `secret_metadata.key_version` and `.created_at` — which master key
--      wrapped this secret's data key, and when the secret was first set.
--      Neither is a §23.6 column; both are declared with their reason in
--      packages/db/test/prd-schema-conformance.test.ts.
--   3. `repositories.provisioned_at` — null while only the record exists, set
--      when the internal Git instance confirms (plan 06 GIT-2).
--   4. `unique (organization_id, internal_repo_ref)` — one repository per ref
--      per tenant. See the schema comment: while the ref derived from the
--      mutable slug, rename-then-reuse minted a second row pointing at the same
--      Git repository, and nothing refused it.
--
-- Nothing here backfills or rewrites a row. The unique index is the one
-- statement that can fail on existing data, and it fails loudly rather than
-- silently dropping a duplicate — a database that already has two repositories
-- sharing a ref has a data problem to resolve by hand, not one a migration
-- should pick a winner for.

CREATE TABLE "secret_ciphertexts" (
	"secret_id" text PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"wrapped_dek" text NOT NULL
);
--> statement-breakpoint
-- ON DELETE CASCADE, deliberately: deleting a secret must not leave its
-- ciphertext behind. The vault row has no independent life — it is reachable
-- only through the metadata row, which is the row a tenant-scoped query returns.
ALTER TABLE "secret_ciphertexts" ADD CONSTRAINT "secret_ciphertexts_secret_id_secret_metadata_id_fk" FOREIGN KEY ("secret_id") REFERENCES "public"."secret_metadata"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Added with a default so the statement succeeds against existing rows, then
-- stripped of it so every future insert has to state which key it used. A
-- secret whose key version was filled in by a default is a secret nobody can
-- prove they can still decrypt.
ALTER TABLE "secret_metadata" ADD COLUMN "key_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "secret_metadata" ALTER COLUMN "key_version" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "secret_metadata" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

-- Two partial indexes rather than one four-column index, because Postgres
-- treats NULLs as distinct and a null `environment_id` means "every environment
-- of this project": under a single index two of those would both be allowed, and
-- a project would hold two secrets with one name that nothing could tell apart.
CREATE UNIQUE INDEX "secret_metadata_env_name_idx" ON "secret_metadata" USING btree ("organization_id","project_id","environment_id","name") WHERE environment_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "secret_metadata_project_name_idx" ON "secret_metadata" USING btree ("organization_id","project_id","name") WHERE environment_id is null;--> statement-breakpoint

ALTER TABLE "repositories" ADD COLUMN "provisioned_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_org_internal_ref_idx" ON "repositories" USING btree ("organization_id","internal_repo_ref");--> statement-breakpoint

-- The order the project list pages in: `where organization_id = $1
-- [and id < $cursor] order by id desc`. Without the descending `id` the planner
-- sorts a tenant's whole project table to return one page.
CREATE INDEX "projects_org_id_idx" ON "projects" USING btree ("organization_id","id" DESC NULLS FIRST);
