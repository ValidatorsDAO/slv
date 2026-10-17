mock_provider "google" {
  mock_data "google_project" {
    defaults = { number = "123456789012" }
  }
}
mock_provider "archive" {}

variables {
  project_id         = "runner-fixture"
  state_bucket_name  = "runner-fixture-state"
  billing_account_id = "000000-000000-000000"
  runner_image       = "https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20261001"
  approved_workflow_refs = [
    "ValidatorsDAO/slv/.github/workflows/gce-runner-smoke.yml@refs/heads/main",
  ]
}

run "isolated_disposable_runner" {
  command = plan

  assert {
    condition     = length(google_compute_instance_template.runner.service_account) == 0
    error_message = "Build VMs must not inherit a service account."
  }
  assert {
    condition     = alltrue([for disk in google_compute_instance_template.runner.disk : disk.auto_delete])
    error_message = "Every runner disk must be deleted with its VM."
  }
  assert {
    condition = (
      length(google_compute_instance_template.runner.disk) == 1 &&
      google_compute_instance_template.runner.disk[0].boot &&
      google_compute_instance_template.runner.disk[0].disk_type == "hyperdisk-balanced" &&
      google_compute_instance_template.runner.disk[0].disk_size_gb == 200
    )
    error_message = "The reviewed C4 runner uses one 200 GB Hyperdisk Balanced boot disk."
  }
  assert {
    condition = (
      google_compute_instance_template.runner.scheduling[0].automatic_restart == false &&
      length(google_compute_instance_template.runner.scheduling[0].max_run_duration) == 0
    )
    error_message = "Template must prohibit restarts and leave the absolute deadline and DELETE action to the controller."
  }
  assert {
    condition     = google_compute_firewall.deny_ingress.direction == "INGRESS" && one(google_compute_firewall.deny_ingress.deny).protocol == "all"
    error_message = "Runner ingress, including traffic between runners, must be denied."
  }
  assert {
    condition     = google_storage_bucket.state.uniform_bucket_level_access && google_storage_bucket.state.public_access_prevention == "enforced" && google_storage_bucket.state.versioning[0].enabled
    error_message = "State storage must be private, uniformly authorized and versioned."
  }
  assert {
    condition = alltrue([
      for permission in concat(
        tolist(google_project_iam_custom_role.instances.permissions),
        tolist(google_project_iam_custom_role.disks.permissions),
        tolist(google_project_iam_custom_role.observe.permissions),
        tolist(google_project_iam_custom_role.template.permissions),
        tolist(google_project_iam_custom_role.subnet.permissions),
      ) : !startswith(permission, "iam.") && !strcontains(permission, "setIamPolicy") && !contains(["compute.instances.setServiceAccount", "compute.instances.start", "compute.firewalls.create", "compute.networks.create"], permission)
    ])
    error_message = "Runtime identity must not acquire IAM, service-account attachment, restart or network administration permissions."
  }
  assert {
    condition = (
      google_billing_budget.runner.budget_filter[0].credit_types_treatment == "INCLUDE_ALL_CREDITS" &&
      google_billing_budget.runner.budget_filter[0].calendar_period == "MONTH" &&
      google_billing_budget.runner.amount[0].specified_amount[0].currency_code == "EUR" &&
      tonumber(google_billing_budget.runner.amount[0].specified_amount[0].units) == 50 &&
      google_billing_budget.runner.all_updates_rule[0].disable_default_iam_recipients == false
    )
    error_message = "Budget must use monthly net cost after all credits, EUR50 and default billing email recipients."
  }
  assert {
    condition = (
      toset(google_project_iam_custom_role.budget_disable.permissions) == toset(["iam.serviceAccounts.get", "iam.serviceAccounts.disable"]) &&
      !contains(google_project_iam_custom_role.budget_delete.permissions, "compute.instances.create") &&
      google_cloudfunctions_function.budget_stop.max_instances == 1 &&
      google_cloudfunctions_function.budget_stop.min_instances == 0
    )
    error_message = "The budget response must stop provisioning without creating VMs, re-enabling identities, or detaching project billing."
  }
}

run "reject_pull_request_controller" {
  command = plan
  variables {
    approved_workflow_refs = [
      "ValidatorsDAO/slv/.github/workflows/gce-runner-smoke.yml@refs/pull/1/merge",
    ]
  }
  expect_failures = [var.approved_workflow_refs]
}

run "reject_foreign_repository" {
  command = plan
  variables {
    approved_workflow_refs = [
      "other-owner/slv/.github/workflows/gce-runner-smoke.yml@refs/heads/main",
    ]
  }
  expect_failures = [var.approved_workflow_refs]
}

run "reject_mutable_image_family" {
  command = plan
  variables {
    runner_image = "https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64"
  }
  expect_failures = [var.runner_image]
}

run "reject_unbounded_lease" {
  command = plan
  variables {
    runner_ttl_seconds = 21601
  }
  expect_failures = [var.runner_ttl_seconds]
}

run "reject_cross_region_zone" {
  command = plan
  variables {
    runner_zones = ["us-central1-a"]
  }
  expect_failures = [google_compute_subnetwork.runner]
}
