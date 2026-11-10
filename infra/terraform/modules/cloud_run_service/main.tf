# Cloud Run v2 service with an OpenTelemetry Collector sidecar and Direct VPC egress.
resource "google_cloud_run_v2_service" "this" {
  project  = var.project_id
  name     = var.name
  location = var.region
  ingress  = var.ingress

  template {
    service_account = var.service_account_email

    scaling {
      min_instance_count = var.min_instance_count
    }

    vpc_access {
      network_interfaces {
        network    = var.network
        subnetwork = var.subnetwork
      }
      egress = "ALL_TRAFFIC"
    }

    # Application container; Cloud Run injects PORT itself.
    containers {
      name       = "app"
      image      = var.image
      depends_on = ["otel-collector"]

      ports {
        container_port = 8080
      }

      resources {
        cpu_idle = var.cpu_idle
      }

      dynamic "env" {
        for_each = var.env
        content {
          name  = env.key
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
    }

    # Collector sidecar exporting OTLP traces to Google Cloud.
    containers {
      name  = "otel-collector"
      image = var.otel_image
      args  = ["--config=/etc/otelcol-google/config.yaml"]

      env {
        name  = "GOOGLE_CLOUD_PROJECT"
        value = var.project_id
      }

      startup_probe {
        http_get {
          path = "/"
          port = 13133
        }
      }

      volume_mounts {
        name       = "otel-collector-config"
        mount_path = "/etc/otelcol-google/"
      }
    }

    volumes {
      name = "otel-collector-config"
      secret {
        secret = var.otel_config_secret_id
        items {
          path    = "config.yaml"
          version = "latest"
        }
      }
    }
  }
}

# Grants roles/run.invoker on the service to each listed member.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = toset(var.invoker_members)

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.this.name
  role     = "roles/run.invoker"
  member   = each.value
}
