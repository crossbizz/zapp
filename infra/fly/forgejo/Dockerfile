# zapp.build — the deployed Forgejo image (GIT-1).
#
# A thin layer over the upstream image whose whole job is the seeding contract
# the dev stack expresses in compose (infra/docker/docker-compose.dev.yml): the
# committed app.ini is a *seed* copied into the data volume on first boot only,
# because Forgejo writes its generated SECRET_KEY and INTERNAL_TOKEN into its own
# copy and those must never be in the repository.
#
# Build context is the repository root, so that one file can be shared with the
# dev stack rather than duplicated:
#
#   fly deploy --config infra/fly/forgejo/fly.toml --dockerfile infra/fly/forgejo/Dockerfile .
#
# Pinned to a digest-less major on purpose: Forgejo publishes patch releases into
# the `9` tag, and a Git host is the one component where an unpatched CVE is
# worse than an unreviewed patch. The version that is actually running is in the
# instance's own /api/v1/version, and scripts/bootstrap.ts prints it.
FROM codeberg.org/forgejo/forgejo:9

# Read-only seed. The entrypoint copies it; nothing ever writes back to it.
COPY infra/docker/forgejo/app.ini.prod /etc/forgejo/app.ini.seed
COPY infra/fly/forgejo/entrypoint.sh /usr/local/bin/zapp-entrypoint

RUN chmod 0444 /etc/forgejo/app.ini.seed && chmod 0555 /usr/local/bin/zapp-entrypoint

ENTRYPOINT ["/usr/local/bin/zapp-entrypoint"]
CMD ["/bin/s6-svscan", "/etc/s6"]
