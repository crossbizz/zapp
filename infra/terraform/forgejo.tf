# zapp.build — the internal Git service, as infrastructure (GIT-1).
#
# PRD §19.1: one repository per project, branches, commits, tags, protected
# release branches, repository-scoped tokens, audit logs, and backup and restore.
# The last one is the reason this file exists at all — everything else is the git
# service's (GIT-2, GIT-3), but a volume and its snapshot policy are not
# something an application can create for itself.
#
# **What this file manages, and why it stops where it does.** The app, the
# volume, the two addresses and the certificate: the objects that outlive every
# release and whose accidental replacement is unrecoverable. The *machine* is
# deliberately not here — `fly deploy` and infra/fly/forgejo/fly.toml own it. A
# machine in terraform state means every image change is a state change, and a
# provider that lags the platform then proposes to recreate the machine, which
# for a single-volume app is a detached volume and a Git host that is down until
# somebody notices.
#
# Order of operations for a new environment:
#
#   1. terraform apply -var environment=staging -var fly_org=… -var git_domain=…
#   2. fly secrets set --app zapp-forgejo-staging FORGEJO__database__PASSWD=… …
#   3. fly deploy --config infra/fly/forgejo/fly.toml \
#                 --dockerfile infra/fly/forgejo/Dockerfile --app zapp-forgejo-staging .
#   4. pnpm --filter @zapp/git-service bootstrap   (idempotent; see that script)

locals {
  # `zapp-forgejo-{env}`, from plan 06 GIT-1. Derived rather than a variable, so
  # the app name and the environment cannot disagree.
  app_name = "zapp-forgejo-${var.environment}"

  # Volume names are Fly identifiers: letters, digits and underscores only. Kept
  # in sync with `source` in infra/fly/forgejo/fly.toml, which is the one place
  # this name is repeated — a mismatch there is a machine that boots with an
  # empty /data and an instance that looks freshly installed.
  volume_name = "forgejo_data"
}

resource "fly_app" "forgejo" {
  name = local.app_name
  org  = var.fly_org
}

# Every repository, every LFS object, and Forgejo's own generated SECRET_KEY and
# INTERNAL_TOKEN. The machine is disposable; this is the instance.
resource "fly_volume" "forgejo_data" {
  app    = fly_app.forgejo.name
  name   = local.volume_name
  region = var.primary_region
  size   = var.volume_size_gb

  lifecycle {
    # The one guard that matters in this file. Several attributes of a Fly volume
    # force replacement when they change — including `size`, which the provider
    # cannot extend in place — and a replaced volume is an empty volume. Every
    # repository, gone, from a plan that read like a resize.
    #
    # Removing this line is a deliberate act, and it should be accompanied by a
    # restore plan rather than by a hurry.
    prevent_destroy = true

    # `size` is managed out of band by `fly volumes extend`, which grows the
    # filesystem without replacing anything. Terraform therefore records the
    # size it created and stops having an opinion about it.
    ignore_changes = [size]
  }
}

# Shared v4 + dedicated v6 for HTTPS. Shared is enough for 80/443, and a
# dedicated v4 costs money that only port 22 justifies — see below.
resource "fly_ip" "v6" {
  app  = fly_app.forgejo.name
  type = "v6"
}

# Git over SSH needs port 22, and Fly's *shared* v4 forwards only 80 and 443.
# This address is what makes `git@git.zapp.build:org_…/proj_….git` resolvable at
# all; without it the only transport is HTTPS.
resource "fly_ip" "v4" {
  app  = fly_app.forgejo.name
  type = "v4"
}

resource "fly_cert" "git" {
  app      = fly_app.forgejo.name
  hostname = var.git_domain

  # The certificate cannot be issued until the hostname resolves to the addresses
  # above, so the dependency is stated rather than left to apply ordering.
  depends_on = [fly_ip.v4, fly_ip.v6]
}
