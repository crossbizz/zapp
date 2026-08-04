# zapp.build — provider and version pins (GIT-1).
#
# Pinned with `~>` rather than left open: infrastructure state is the one place
# where "the provider changed under us" means a plan that proposes to destroy a
# volume. Upgrades are a reviewed edit here, followed by `terraform init
# -upgrade` and a plan that had better be empty.

terraform {
  required_version = "~> 1.9"

  required_providers {
    fly = {
      # The community Fly.io provider. Fly publishes no official one, which is
      # why this configuration deliberately manages only the *durable* objects
      # (app, volume, addresses, certificate) and leaves machine lifecycle to
      # `fly deploy` and infra/fly/forgejo/fly.toml: a provider that lags the
      # platform is survivable for four resource types and is not survivable for
      # the resource that carries the release.
      source  = "fly-apps/fly"
      version = "~> 0.0.23"
    }
  }

  # State lives in Terraform Cloud / an S3-compatible backend per environment.
  # Deliberately not configured here: a committed backend block is how a staging
  # apply writes production state. Pass it at init time:
  #
  #   terraform init -backend-config=env/staging.backend.hcl
  backend "local" {}
}

provider "fly" {
  # FLY_API_TOKEN from the environment. Never a variable, never a tfvars file —
  # a token in state is a token in every backup of that state.
  useinternaltunnel = false
}
