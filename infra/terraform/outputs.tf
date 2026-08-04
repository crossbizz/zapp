# zapp.build — what the rest of the deployment needs from this state (GIT-1).
#
# Values only, never credentials. The Forgejo admin token is minted by
# services/git-service/scripts/bootstrap.ts and set as a Fly secret on the
# services that use it; it never passes through terraform, because a secret in
# an output is a secret in state and in every backup of state.

output "forgejo_app_name" {
  description = "The Fly app. `fly deploy --app <this>`; also the private hostname's prefix."
  value       = fly_app.forgejo.name
}

output "forgejo_url" {
  description = "FORGEJO_URL for services/git-service. The public host, over TLS."
  value       = "https://${var.git_domain}"
}

output "forgejo_internal_url" {
  description = "The same instance over Fly's private network, for services in the same organization. No TLS and no edge: it never leaves the WireGuard mesh."
  value       = "http://${fly_app.forgejo.name}.internal:3000"
}

output "forgejo_volume_id" {
  description = "The volume every repository lives on. Quote this when asking Fly support to restore a snapshot."
  value       = fly_volume.forgejo_data.id
}
