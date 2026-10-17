resource "google_service_account" "provisioner" {
  project      = var.project_id
  account_id   = "slv-runner-provisioner"
  display_name = "SLV disposable runner lifecycle"
  description  = "Keyless GitHub-hosted control-plane identity. Never attached to a runner VM."
  depends_on   = [google_project_service.required]

  lifecycle {
    # The budget handler latches this off. Normal infrastructure applies must
    # not silently re-enable provisioning after a budget stop.
    ignore_changes = [disabled]
  }
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "slv-runner-control"
  display_name              = "SLV runner control"
  depends_on                = [google_project_service.required]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "Approved hosted SLV workflows"
  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.ref"                 = "assertion.ref"
    "attribute.workflow_ref"        = "assertion.workflow_ref"
    "attribute.environment"         = "assertion.environment"
    "attribute.runner_environment"  = "assertion.runner_environment"
    "attribute.event_name"          = "assertion.event_name"
  }
  attribute_condition = join(" && ", [
    "assertion.repository_id == '${local.repository_id}'",
    "assertion.repository_owner_id == '${local.repository_owner_id}'",
    "assertion.ref == 'refs/heads/main'",
    "assertion.workflow_ref in ${jsonencode(sort(tolist(var.approved_workflow_refs)))}",
    "assertion.environment == 'slv-gce-runners'",
    "assertion.runner_environment == 'github-hosted'",
    "assertion.event_name in ['workflow_dispatch', 'push', 'schedule']",
  ])
  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
    # The provider's full resource name is the default audience. Do not accept
    # generic audiences that could be replayed from an unrelated integration.
  }
}

resource "google_service_account_iam_member" "github" {
  service_account_id = google_service_account.provisioner.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${local.repository_id}"
}

resource "google_project_iam_custom_role" "instances" {
  project     = var.project_id
  role_id     = "slvRunnerInstances"
  title       = "SLV runner instances"
  description = "Create, inspect and delete disposable runner instances; no IAM, network, service-account attachment or start permissions."
  permissions = [
    "compute.instances.create",
    "compute.instances.delete",
    "compute.instances.get",
    "compute.instances.getSerialPortOutput",
    "compute.instances.setLabels",
    "compute.instances.setMetadata",
  ]
}

resource "google_project_iam_member" "instances" {
  project = var.project_id
  role    = google_project_iam_custom_role.instances.name
  member  = "serviceAccount:${google_service_account.provisioner.email}"
  condition {
    title       = "disposable_runner_names_and_zones"
    description = "Only slv-gha- instances in configured runner zones."
    expression  = local.instance_condition
  }
}

resource "google_project_iam_custom_role" "disks" {
  project     = var.project_id
  role_id     = "slvRunnerDisks"
  title       = "SLV runner disks"
  description = "Manage only disposable boot disks named after their runner."
  permissions = [
    "compute.disks.create",
    "compute.disks.delete",
    "compute.disks.get",
    "compute.disks.setLabels",
  ]
}

resource "google_project_iam_member" "disks" {
  project = var.project_id
  role    = google_project_iam_custom_role.disks.name
  member  = "serviceAccount:${google_service_account.provisioner.email}"
  condition {
    title      = "disposable_disk_names_and_zones"
    expression = local.disk_condition
  }
}

resource "google_project_iam_custom_role" "observe" {
  project     = var.project_id
  role_id     = "slvRunnerObserve"
  title       = "SLV runner lifecycle observations"
  description = "List instances for orphan cleanup and wait for zonal operations."
  permissions = [
    "compute.instances.list",
    "compute.zoneOperations.get",
  ]
}

resource "google_project_iam_member" "observe" {
  project = var.project_id
  role    = google_project_iam_custom_role.observe.name
  member  = "serviceAccount:${google_service_account.provisioner.email}"
}

resource "google_project_iam_custom_role" "template" {
  project     = var.project_id
  role_id     = "slvRunnerTemplate"
  title       = "SLV runner template use"
  permissions = ["compute.instanceTemplates.get", "compute.instanceTemplates.useReadOnly"]
}

resource "google_project_iam_member" "template" {
  project = var.project_id
  role    = google_project_iam_custom_role.template.name
  member  = "serviceAccount:${google_service_account.provisioner.email}"
  condition {
    title      = "approved_runner_template"
    expression = "resource.name == 'projects/${var.project_id}/global/instanceTemplates/${google_compute_instance_template.runner.name}'"
  }
}

resource "google_project_iam_custom_role" "subnet" {
  project     = var.project_id
  role_id     = "slvRunnerSubnet"
  title       = "SLV runner subnet use"
  permissions = ["compute.subnetworks.get", "compute.subnetworks.use", "compute.subnetworks.useExternalIp"]
}

resource "google_compute_subnetwork_iam_member" "provisioner" {
  project    = var.project_id
  region     = var.region
  subnetwork = google_compute_subnetwork.runner.name
  role       = google_project_iam_custom_role.subnet.name
  member     = "serviceAccount:${google_service_account.provisioner.email}"
}
