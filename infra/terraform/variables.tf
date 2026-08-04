# zapp.build — inputs for every environment (GIT-1).
#
# No defaults for anything whose wrong value is a production incident: the
# environment name and the organization are named explicitly at apply time or the
# plan fails, because a default here is what makes `terraform apply` in the wrong
# directory a survivable-looking mistake.

variable "environment" {
  description = "Which deployment this is. Part of every resource name, so a plan naming the wrong one is visibly wrong."
  type        = string

  validation {
    # A closed set rather than free text. `zapp-forgejo-stagging` would otherwise
    # be a brand new app with a brand new empty volume, and the first symptom
    # would be "all the repositories are gone".
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be one of: staging, production."
  }
}

variable "fly_org" {
  description = "The Fly.io organization slug that owns the app."
  type        = string
}

variable "primary_region" {
  description = "Where the volume and the machine live. One region: the volume cannot be in two."
  type        = string
  default     = "iad"
}

variable "git_domain" {
  description = "The hostname clone URLs are built from, e.g. git.zapp.build. Must match FORGEJO__server__DOMAIN on the app."
  type        = string
}

variable "volume_size_gb" {
  description = "Repository storage. Grows in place (`fly volumes extend`); it cannot shrink, so start smaller than you expect to need."
  type        = number
  default     = 40

  validation {
    condition     = var.volume_size_gb >= 10
    error_message = "volume_size_gb must be at least 10: Git objects plus LFS on a shared volume fill a smaller one before anyone notices."
  }
}

# Snapshot retention is deliberately *not* a variable. The provider's
# `fly_volume` has no attribute for it, and a variable that is declared, defaulted
# and then quietly unused is worse than an honest manual step: it reads like the
# backup policy is under version control when nothing is enforcing it. The
# retention is set with `fly volumes update --snapshot-retention` and asserted by
# the bootstrap checklist — see infra/terraform/README.md § Backups.
