variable "environment" {
  description = "Deployment environment and isolated Grafana stack name."
  type        = string

  validation {
    condition     = contains(["zapp-dev", "zapp-staging", "zapp-prod"], var.environment)
    error_message = "environment must be zapp-dev, zapp-staging, or zapp-prod"
  }
}

variable "grafana_url" {
  description = "Grafana stack URL, supplied outside source control."
  type        = string
}

variable "grafana_auth" {
  description = "Grafana service-account token, supplied outside source control."
  type        = string
  sensitive   = true
}

variable "mimir_datasource_uid" {
  description = "Grafana-managed Prometheus/Mimir data source UID for this stack."
  type        = string
}

variable "loki_datasource_uid" {
  description = "Grafana-managed Loki data source UID for this stack."
  type        = string
}
