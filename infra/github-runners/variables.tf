variable "project_id" {
  description = "Existing, billing-enabled project dedicated to disposable runners."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "Provide an existing Google Cloud project ID."
  }
}

variable "state_bucket_name" {
  description = "Globally unique bucket name for this foundation's state; no runner access is granted."
  type        = string
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "Use a 3-63 character lowercase bucket name without dots."
  }
}

variable "billing_account_id" {
  description = "Existing billing account ID for the monthly project budget. The bootstrap identity needs budget administration on this account."
  type        = string
  validation {
    condition     = can(regex("^[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}$", var.billing_account_id))
    error_message = "Use the existing billing account ID, without the billingAccounts/ prefix."
  }
}

variable "monthly_budget_amount" {
  description = "Monthly net cost limit after all credits. Billing updates are delayed, so this is not an instantaneous hard cap."
  type        = number
  default     = 50
  validation {
    condition     = var.monthly_budget_amount > 0 && var.monthly_budget_amount <= 50 && floor(var.monthly_budget_amount) == var.monthly_budget_amount
    error_message = "The authorized monthly budget is at most 50 whole currency units."
  }
}

variable "budget_currency" {
  description = "Currency of the existing billing account; this deployment is authorized for EUR only."
  type        = string
  default     = "EUR"
  validation {
    condition     = var.budget_currency == "EUR"
    error_message = "The authorized budget is EUR. Confirm billing currency before applying; do not silently convert currencies."
  }
}

variable "region" {
  description = "Region for the isolated subnet and state bucket."
  type        = string
  default     = "europe-west4"
  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "Use a Google Cloud region name."
  }
}

variable "budget_function_region" {
  description = "Supported first-generation Cloud Functions region, independent of the GCE region."
  type        = string
  default     = "europe-west1"
  validation {
    condition     = contains(["europe-west1", "europe-west2", "europe-west3", "europe-west6"], var.budget_function_region)
    error_message = "Choose a supported European first-generation Cloud Functions region."
  }
}

variable "runner_zones" {
  description = "Allowed runner zones in region. Empty selects region-a; check C4 quota and availability before applying."
  type        = set(string)
  default     = []
  validation {
    condition     = alltrue([for zone in var.runner_zones : can(regex("^[a-z]+-[a-z]+[0-9]+-[a-z]$", zone))])
    error_message = "Use fully qualified zone names."
  }
}

variable "runner_subnet_cidr" {
  description = "Private CIDR for the dedicated, unpeered runner subnet."
  type        = string
  default     = "10.244.0.0/24"
  validation {
    condition     = can(cidrnetmask(var.runner_subnet_cidr))
    error_message = "Use an IPv4 CIDR."
  }
}

variable "runner_image" {
  description = "Exact official Ubuntu 24.04 amd64 image self link, including its dated version; never an image family."
  type        = string
  validation {
    condition     = can(regex("^https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v[0-9]{8}$", var.runner_image))
    error_message = "Pin an exact dated ubuntu-os-cloud Ubuntu 24.04 amd64 image self link."
  }
}

variable "runner_ttl_seconds" {
  description = "Cloud-enforced maximum runtime in seconds. The controller also sets an absolute deletion deadline."
  type        = number
  default     = 21600
  validation {
    condition     = var.runner_ttl_seconds >= 600 && var.runner_ttl_seconds <= 21600 && floor(var.runner_ttl_seconds) == var.runner_ttl_seconds
    error_message = "Runner TTL must be an integer between 600 and 21600 seconds."
  }
}

variable "approved_workflow_refs" {
  description = "Exact main-branch controller workflow refs allowed to impersonate the provisioner; no PR workflow refs."
  type        = set(string)
  validation {
    condition = length(var.approved_workflow_refs) > 0 && alltrue([
      for ref in var.approved_workflow_refs : can(regex("^ValidatorsDAO/slv/\\.github/workflows/[A-Za-z0-9_-]+\\.ya?ml@refs/heads/main$", ref))
    ])
    error_message = "Allow only exact ValidatorsDAO/slv workflow paths at refs/heads/main."
  }
}
