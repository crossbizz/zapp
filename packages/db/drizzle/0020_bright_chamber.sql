CREATE INDEX "agent_events_org_project_occurred_at_idx" ON "agent_events" USING btree ("organization_id","project_id","occurred_at" DESC NULLS LAST);
