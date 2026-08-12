# R2 lifecycle can match only a key prefix. Artifact deletion by retention class
# is therefore enforced by CP-17 against structurally classified database rows;
# see ADR-0031. This resource intentionally has no delete_objects_transition:
# `org/` also contains release evidence, which must be retained with its release.
resource "cloudflare_r2_bucket_lifecycle" "artifacts" {
  account_id  = var.cloudflare_account_id
  bucket_name = var.artifact_bucket_name

  rules = [
    {
      id      = "abort-incomplete-multipart-uploads"
      enabled = true
      conditions = {
        prefix = ""
      }
      abort_multipart_uploads_transition = {
        condition = {
          max_age = 604800
          type    = "Age"
        }
      }
    }
  ]
}
