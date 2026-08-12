# Grafana Cloud observability

This Terraform root provisions the two launch-critical alert rules in each
isolated Grafana Cloud stack: API 5xx responses from Mimir and unhandled service
exceptions from Loki.

Apply it once for each of `zapp-dev`, `zapp-staging`, and `zapp-prod`. Supply the
stack URL, service-account token, and Grafana-managed Mimir/Loki data-source UIDs
through untracked variable files or `TF_VAR_*` environment variables. Never put
those values in source control.

```sh
terraform init
terraform plan -var environment=zapp-staging
terraform apply -var environment=zapp-staging
```
