# Cloud Run v2 job with Direct VPC egress; declared for plan only.
resource "google_cloud_run_v2_job" "this" {
  project  = var.project_id
  name     = var.name
  location = var.region

  template {
    template {
      service_account = var.service_account_email
      max_retries     = var.max_retries

      vpc_access {
        network_interfaces {
          network    = var.network
          subnetwork = var.subnetwork
        }
        egress = "ALL_TRAFFIC"
      }

      containers {
        image   = var.image
        command = var.command
        args    = var.args

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
    }
  }
}
