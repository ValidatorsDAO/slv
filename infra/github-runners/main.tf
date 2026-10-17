locals {
  repository_id       = "894848970"
  repository_owner_id = "181146216"
  runner_name_prefix  = "slv-gha-"
  runner_zones        = length(var.runner_zones) == 0 ? toset(["${var.region}-a"]) : var.runner_zones
  labels = {
    managed-by = "slv-gce-runner"
  }
  instance_condition = join(" || ", [
    for zone in sort(tolist(local.runner_zones)) :
    "resource.name.startsWith('projects/${var.project_id}/zones/${zone}/instances/${local.runner_name_prefix}')"
  ])
  disk_condition = join(" || ", [
    for zone in sort(tolist(local.runner_zones)) :
    "resource.name.startsWith('projects/${var.project_id}/zones/${zone}/disks/${local.runner_name_prefix}')"
  ])
}

resource "google_project_service" "required" {
  for_each = toset([
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "storage.googleapis.com",
    "billingbudgets.googleapis.com",
    "cloudbilling.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "pubsub.googleapis.com",
    "logging.googleapis.com",
  ])
  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

resource "google_storage_bucket" "state" {
  name                        = var.state_bucket_name
  project                     = var.project_id
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  labels                      = local.labels

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
      num_newer_versions         = 10
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.required]
}

resource "google_compute_network" "runner" {
  name                    = "slv-github-runners"
  project                 = var.project_id
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  depends_on              = [google_project_service.required]
}

resource "google_compute_subnetwork" "runner" {
  name                     = "slv-github-runners"
  project                  = var.project_id
  region                   = var.region
  ip_cidr_range            = var.runner_subnet_cidr
  network                  = google_compute_network.runner.id
  private_ip_google_access = false
  stack_type               = "IPV4_ONLY"

  lifecycle {
    precondition {
      condition     = alltrue([for zone in local.runner_zones : startswith(zone, "${var.region}-")])
      error_message = "All runner zones must belong to the subnet region."
    }
  }
}

# Runners connect out to GitHub. No SSH listener, peer, VPN or ingress rule is
# needed. An explicit deny also covers traffic between runners on this subnet.
resource "google_compute_firewall" "deny_ingress" {
  name          = "slv-github-runners-deny-ingress"
  project       = var.project_id
  network       = google_compute_network.runner.id
  direction     = "INGRESS"
  priority      = 1000
  source_ranges = ["0.0.0.0/0"]
  deny {
    protocol = "all"
  }
}

resource "google_compute_instance_template" "runner" {
  name_prefix          = "slv-gha-c4-"
  project              = var.project_id
  region               = var.region
  description          = "Disposable x64 GitHub runner; controller supplies a single-use JIT configuration."
  instance_description = "Disposable SLV build runner; no attached service account."
  machine_type         = "c4-standard-16"
  can_ip_forward       = false
  labels               = local.labels

  disk {
    source_image = var.runner_image
    boot         = true
    auto_delete  = true
    disk_type    = "hyperdisk-balanced"
    disk_size_gb = 200
  }

  network_interface {
    subnetwork = google_compute_subnetwork.runner.id
    nic_type   = "GVNIC"
    stack_type = "IPV4_ONLY"
    access_config {
      # An ephemeral outbound address; ingress remains denied.
      network_tier = "PREMIUM"
    }
  }

  # Omit service_account entirely. Runtime must also pass --no-service-account
  # and verify serviceAccounts is empty before handing over the JIT credential.
  metadata = {
    block-project-ssh-keys   = "true"
    enable-oslogin           = "false"
    serial-port-enable       = "false"
    disable-legacy-endpoints = "true"
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  scheduling {
    provisioning_model  = "STANDARD"
    automatic_restart   = false
    on_host_maintenance = "TERMINATE"
    # The controller must supply both absolute termination_time and DELETE
    # together at creation. STANDARD templates reject DELETE without a limit,
    # and a template max_run_duration would conflict with the absolute limit.
  }

  lifecycle {
    create_before_destroy = true
  }
}
