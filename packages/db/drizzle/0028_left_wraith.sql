ALTER TABLE "usage_ledger" DROP CONSTRAINT "usage_ledger_category_check";--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_category_check" CHECK (category in ('model_input_tokens', 'model_output_tokens', 'model_cached_tokens', 'sandbox_cpu_seconds', 'sandbox_mem_gib_seconds', 'storage_gib_hours', 'deploy_provider', 'artifact_storage', 'credit_grant'));
