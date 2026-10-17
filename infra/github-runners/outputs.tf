output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "runner_zones" {
  value = sort(tolist(local.runner_zones))
}

output "runner_template" {
  description = "Exact immutable template self link for the hosted controller."
  value       = google_compute_instance_template.runner.self_link
}

output "runner_template_name" {
  value = google_compute_instance_template.runner.name
}

output "runner_service_account" {
  description = "Keyless provisioner identity, never the runner VM identity."
  value       = google_service_account.provisioner.email
}

output "workload_identity_provider" {
  value = google_iam_workload_identity_pool_provider.github.name
}

output "state_bucket" {
  value = google_storage_bucket.state.name
}

output "runner_ttl_seconds" {
  value = var.runner_ttl_seconds
}

output "budget_name" {
  value = google_billing_budget.runner.name
}

output "budget_stop_function" {
  value = google_cloudfunctions_function.budget_stop.name
}
