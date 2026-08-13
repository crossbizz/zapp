resource "grafana_folder" "platform_alerts" {
  title = "zapp.build ${var.environment} platform alerts"
}

resource "grafana_rule_group" "platform" {
  name             = "zapp.build ${var.environment} platform"
  folder_uid       = grafana_folder.platform_alerts.uid
  interval_seconds = 60

  rule {
    name           = "API 5xx responses"
    condition      = "C"
    for            = "5m"
    no_data_state  = "OK"
    exec_err_state = "Error"

    annotations = {
      summary = "The zapp.build API is returning server errors."
    }
    labels = {
      environment = var.environment
      severity    = "critical"
    }

    data {
      ref_id = "A"
      relative_time_range {
        from = 300
        to   = 0
      }
      datasource_uid = var.mimir_datasource_uid
      model = jsonencode({
        datasource = { type = "prometheus", uid = var.mimir_datasource_uid }
        editorMode = "code"
        expr       = "sum(increase(zapp_api_server_errors_total[5m]))"
        instant    = true
        refId      = "A"
      })
    }

    data {
      ref_id = "B"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        reducer    = "last"
        refId      = "B"
        type       = "reduce"
      })
    }

    data {
      ref_id = "C"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "B"
        refId      = "C"
        type       = "threshold"
        conditions = [{
          evaluator = { params = [0], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
      })
    }
  }

  rule {
    name           = "Unhandled service exceptions"
    condition      = "C"
    for            = "1m"
    no_data_state  = "OK"
    exec_err_state = "Error"

    annotations = {
      summary = "A zapp.build service emitted an uncaught exception or rejection."
    }
    labels = {
      environment = var.environment
      severity    = "critical"
    }

    data {
      ref_id = "A"
      relative_time_range {
        from = 300
        to   = 0
      }
      datasource_uid = var.loki_datasource_uid
      model = jsonencode({
        datasource = { type = "loki", uid = var.loki_datasource_uid }
        editorMode = "code"
        expr       = "sum(count_over_time({service_name=~\".+\"} |~ \"(?i)(uncaughtException|unhandledRejection|unhandled exception)\" [5m]))"
        queryType  = "instant"
        refId      = "A"
      })
    }

    data {
      ref_id = "B"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "A"
        reducer    = "last"
        refId      = "B"
        type       = "reduce"
      })
    }

    data {
      ref_id = "C"
      relative_time_range {
        from = 0
        to   = 0
      }
      datasource_uid = "__expr__"
      model = jsonencode({
        datasource = { type = "__expr__", uid = "__expr__" }
        expression = "B"
        refId      = "C"
        type       = "threshold"
        conditions = [{
          evaluator = { params = [0], type = "gt" }
          operator  = { type = "and" }
          query     = { params = ["C"] }
          reducer   = { params = [], type = "last" }
          type      = "query"
        }]
      })
    }
  }
}
