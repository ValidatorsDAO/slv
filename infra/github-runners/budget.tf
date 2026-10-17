data "google_project" "runner" {
  project_id = var.project_id
}

locals {
  budget_display_name = "SLV runners monthly net cost"
}

resource "google_pubsub_topic" "budget" {
  project    = var.project_id
  name       = "slv-runner-budget-stop"
  labels     = local.labels
  depends_on = [google_project_service.required]
}

resource "google_pubsub_topic_iam_member" "billing_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.budget.name
  role    = "roles/pubsub.publisher"
  # Google Cloud Billing's documented system publisher (singular "alert").
  member = "serviceAccount:billing-budget-alert@system.gserviceaccount.com"
}

resource "google_billing_budget" "runner" {
  billing_account = var.billing_account_id
  display_name    = local.budget_display_name

  budget_filter {
    projects               = ["projects/${data.google_project.runner.number}"]
    calendar_period        = "MONTH"
    credit_types_treatment = "INCLUDE_ALL_CREDITS"
  }
  amount {
    specified_amount {
      currency_code = var.budget_currency
      units         = tostring(var.monthly_budget_amount)
    }
  }
  dynamic "threshold_rules" {
    for_each = [0.5, 0.8, 1.0]
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }
  all_updates_rule {
    pubsub_topic                   = google_pubsub_topic.budget.id
    schema_version                 = "1.0"
    disable_default_iam_recipients = false
  }

  depends_on = [
    google_pubsub_topic_iam_member.billing_publisher,
    google_cloudfunctions_function.budget_stop,
  ]
}

resource "google_service_account" "budget_stop" {
  project      = var.project_id
  account_id   = "slv-runner-budget-stop"
  display_name = "SLV runner budget stop"
  description  = "Disable only the runner provisioner and delete disposable runners on a net budget alert."
  depends_on   = [google_project_service.required]
}

resource "google_project_iam_custom_role" "budget_disable" {
  project     = var.project_id
  role_id     = "slvRunnerBudgetDisable"
  title       = "Disable SLV runner provisioning"
  permissions = ["iam.serviceAccounts.get", "iam.serviceAccounts.disable"]
}

resource "google_service_account_iam_member" "budget_disable" {
  service_account_id = google_service_account.provisioner.name
  role               = google_project_iam_custom_role.budget_disable.name
  member             = "serviceAccount:${google_service_account.budget_stop.email}"
}

resource "google_project_iam_custom_role" "budget_delete" {
  project     = var.project_id
  role_id     = "slvRunnerBudgetDelete"
  title       = "Delete SLV runners after budget stop"
  permissions = ["compute.instances.get", "compute.instances.delete"]
}

resource "google_project_iam_member" "budget_delete" {
  project = var.project_id
  role    = google_project_iam_custom_role.budget_delete.name
  member  = "serviceAccount:${google_service_account.budget_stop.email}"
  condition {
    title      = "disposable_runner_names_and_zones"
    expression = local.instance_condition
  }
}

resource "google_project_iam_custom_role" "budget_disks" {
  project     = var.project_id
  role_id     = "slvRunnerBudgetDisks"
  title       = "Delete disposable runner disks after budget stop"
  permissions = ["compute.disks.delete"]
}

resource "google_project_iam_member" "budget_disks" {
  project = var.project_id
  role    = google_project_iam_custom_role.budget_disks.name
  member  = "serviceAccount:${google_service_account.budget_stop.email}"
  condition {
    title      = "disposable_disk_names_and_zones"
    expression = local.disk_condition
  }
}

resource "google_project_iam_member" "budget_observe" {
  project = var.project_id
  role    = google_project_iam_custom_role.observe.name
  member  = "serviceAccount:${google_service_account.budget_stop.email}"
}

resource "google_service_account" "budget_build" {
  project      = var.project_id
  account_id   = "slv-runner-budget-build"
  display_name = "Build the SLV budget function"
  description  = "Build-only identity; no runner lifecycle or service-account administration."
  depends_on   = [google_project_service.required]
}

resource "google_storage_bucket" "function_source" {
  project                     = var.project_id
  name                        = "${var.project_id}-slv-budget-function"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels
  depends_on                  = [google_project_service.required]
}

data "archive_file" "budget_handler" {
  type        = "zip"
  output_path = "${path.module}/.terraform/budget-handler.zip"
  source {
    filename = "main.py"
    content  = file("${path.module}/budget-handler/main.py")
  }
  source {
    filename = "requirements.txt"
    content  = file("${path.module}/budget-handler/requirements.txt")
  }
}

resource "google_storage_bucket_object" "function_source" {
  name   = "budget-handler-${data.archive_file.budget_handler.output_sha256}.zip"
  bucket = google_storage_bucket.function_source.name
  source = data.archive_file.budget_handler.output_path
}

resource "google_storage_bucket_iam_member" "build_source" {
  bucket = google_storage_bucket.function_source.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.budget_build.email}"
}

# Gen1 copies source into these Google-managed buckets before the build. Scope
# read access to this project's region-specific staging buckets, not tfstate.
resource "google_project_iam_member" "build_staging" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.budget_build.email}"
  condition {
    title = "function_source_staging_only"
    expression = join(" || ", [
      "resource.name.startsWith('projects/_/buckets/gcf-sources-${data.google_project.runner.number}-${var.budget_function_region}/objects/')",
      "resource.name.startsWith('projects/_/buckets/gcf-uploads-${data.google_project.runner.number}-${var.budget_function_region}.cloudfunctions.appspot.com/objects/')",
    ])
  }
}

resource "google_project_iam_member" "build_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.budget_build.email}"
}

resource "google_artifact_registry_repository" "budget" {
  project       = var.project_id
  location      = var.budget_function_region
  repository_id = "slv-runner-budget-function"
  format        = "DOCKER"
  labels        = local.labels
  depends_on    = [google_project_service.required]
}

resource "google_artifact_registry_repository_iam_member" "budget_build" {
  project    = var.project_id
  location   = var.budget_function_region
  repository = google_artifact_registry_repository.budget.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.budget_build.email}"
}

resource "google_cloudfunctions_function" "budget_stop" {
  project               = var.project_id
  region                = var.budget_function_region
  name                  = "slv-runner-budget-stop"
  description           = "Stop new runner provisioning and delete managed runners after the monthly net budget is reached."
  runtime               = "python312"
  entry_point           = "stop_runner_spend"
  service_account_email = google_service_account.budget_stop.email
  build_service_account = google_service_account.budget_build.name
  available_memory_mb   = 256
  timeout               = 120
  max_instances         = 1
  min_instances         = 0
  ingress_settings      = "ALLOW_INTERNAL_ONLY"
  labels                = local.labels

  source_archive_bucket = google_storage_bucket.function_source.name
  source_archive_object = google_storage_bucket_object.function_source.name
  docker_registry       = "ARTIFACT_REGISTRY"
  docker_repository     = google_artifact_registry_repository.budget.id

  environment_variables = {
    TARGET_PROJECT_ID           = var.project_id
    PROVISIONER_SERVICE_ACCOUNT = google_service_account.provisioner.email
    BUDGET_DISPLAY_NAME         = local.budget_display_name
    BUDGET_CURRENCY             = var.budget_currency
    BUDGET_AMOUNT               = tostring(var.monthly_budget_amount)
  }

  event_trigger {
    event_type = "google.pubsub.topic.publish"
    resource   = google_pubsub_topic.budget.id
    failure_policy {
      retry = true
    }
  }

  depends_on = [
    google_storage_bucket_iam_member.build_source,
    google_project_iam_member.build_staging,
    google_project_iam_member.build_logs,
    google_artifact_registry_repository_iam_member.budget_build,
    google_service_account_iam_member.budget_disable,
    google_project_iam_member.budget_delete,
    google_project_iam_member.budget_disks,
    google_project_iam_member.budget_observe,
  ]
}
