# GitHub Apps cannot be created through the GitHub Terraform provider. This
# checked manifest is the exact configuration applied through GitHub's App
# settings UI/API; keeping it as terraform_data makes drift visible in plans
# without placing the generated private key in Terraform state.
locals {
  github_app_manifest = {
    name = "zapp-build-${var.environment}"
    permissions = {
      contents      = "read"
      metadata      = "read"
      pull_requests = "read"
    }
    events                   = ["installation", "pull_request", "push"]
    request_oauth_on_install = true
  }
}

resource "terraform_data" "github_app" {
  input = local.github_app_manifest
}

output "github_app_manifest" {
  description = "Non-secret GitHub App permissions and subscribed events to apply."
  value       = terraform_data.github_app.output
}
