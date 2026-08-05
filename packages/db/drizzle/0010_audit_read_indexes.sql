-- CP-12 reads one tenant's append-only trail newest-first, optionally narrowing
-- by actor, action or target. Keep the id last on filter indexes so the same
-- btree satisfies the keyset cursor after the equality predicates.
CREATE INDEX "audit_events_org_id_idx" ON "audit_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_org_actor_id_id_idx" ON "audit_events" USING btree ("organization_id","actor_id","id");--> statement-breakpoint
CREATE INDEX "audit_events_org_action_id_idx" ON "audit_events" USING btree ("organization_id","action","id");--> statement-breakpoint
CREATE INDEX "audit_events_org_target_id_idx" ON "audit_events" USING btree ("organization_id","target_type","target_id","id");
