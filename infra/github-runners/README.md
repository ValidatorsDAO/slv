# Disposable GitHub runner foundation

This module manages the persistent resources in an existing, billing-enabled
project dedicated to SLV runners. GitHub-hosted control jobs create individual
VMs from the immutable template and delete them after one job. Per-job VMs and
JIT credentials never enter this Terraform state.

The template uses `c4-standard-16`, a 200 GB Hyperdisk Balanced boot disk, a
version-pinned Ubuntu 24.04 amd64 image, and a fresh ephemeral external IP. It
has no service account and no startup script. The controller supplies a reviewed
startup script and a single-use GitHub JIT configuration at runtime, verifies
the VM has no service account, and removes the JIT metadata after registration.
The controller sets cloud-enforced deletion at an absolute deadline of at most
six hours. The controller supplies the DELETE action together with that deadline.
The template omits both because STANDARD templates reject a DELETE action without
a limit, and a relative limit would conflict with the absolute deadline. No ingress, VPC
peering, VPN, or permanent runner is created.

## Identities and trust

Run foundation Terraform with a separate infrastructure administrator identity.
Runner provisioning uses the keyless `slv-runner-provisioner` service
account. It cannot administer IAM, attach a service account to a VM, modify the
network, restart a VM, or access the state bucket. Do not grant it Owner, Editor,
Compute Admin, Service Account User, or Service Account Token Creator.

The budget function has a separate identity that can disable the provisioner
and delete runner VMs; it cannot create VMs, enable an identity, or detach billing.
The function build identity can read only its source buckets, write its dedicated
Artifact Registry repository, and write logs. Neither identity can read tfstate.

The dedicated WIF pool accepts the numeric IDs of `ValidatorsDAO/slv` and its
owner, the exact main-branch workflow paths supplied in
`approved_workflow_refs`, the `slv-gce-runners` environment, GitHub-hosted runners,
and push, dispatch or schedule events. PR workflows are deliberately not trusted
to create cloud credentials. Configure the GitHub environment to allow only
`main`, protect that branch, and keep all untrusted build code out of the hosted
control jobs. Add the janitor's exact workflow ref when enabling scheduled
cleanup. No service-account key is generated.

Instance and disk mutation permissions are restricted by runner name prefix
`slv-gha-` and the configured zones. Template and subnet access are limited to
this module's resources. Instance listing and operation polling are project
wide so a janitor can recover orphaned leases; use a dedicated project. These
permissions do not impose a machine-type or concurrent-instance limit: the
reviewed controller must enforce its template and lease policy, and project
quotas provide a separate resource bound. Test the conditional IAM grants in
the first smoke run; local Terraform checks do not contact the IAM API.

## Bootstrap and state

Terraform cannot establish its own initial identity. Authenticate the initial
administrator using user ADC or an existing infrastructure WIF identity. Supply
values in an untracked `foundation.tfvars`; never commit project identifiers,
credentials, state, or plan files. The image must be an exact dated public image
self link, for example the value returned by an explicitly reviewed image's
`gcloud compute images describe --format='value(selfLink)'` command. Confirm C4
quota and availability in the selected zones before applying.

```hcl
project_id        = "YOUR_PROJECT_ID"
state_bucket_name = "YOUR_GLOBALLY_UNIQUE_STATE_BUCKET"
billing_account_id = "YOUR_BILLING_ACCOUNT_ID"
runner_image      = "https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-vYYYYMMDD"
region            = "europe-west4"
runner_zones      = ["europe-west4-a"]
approved_workflow_refs = [
  "ValidatorsDAO/slv/.github/workflows/gce-runner-smoke.yml@refs/heads/main",
]
```

From this directory, bootstrap using the default local backend:

```sh
terraform init
terraform plan -var-file=foundation.tfvars -out=foundation.plan
terraform apply foundation.plan
```

The module creates a private state bucket with uniform bucket-level access,
public access prevention, versioning and deletion protection. Then create an
untracked `backend.local.tf`:

```hcl
terraform {
  backend "gcs" {}
}
```

Migrate the local state using the actual bucket name from `terraform output
-raw state_bucket`:

```sh
terraform init -migrate-state \
  -backend-config="bucket=YOUR_GLOBALLY_UNIQUE_STATE_BUCKET" \
  -backend-config="prefix=foundation/github-runners"
```

Keep local state backups secure until the remote state is verified. Subsequent
infrastructure Actions jobs generate the same backend declaration and initialize
the same bucket/prefix. Grant their separate infrastructure identity access to
that bucket. Never pass the GitHub App private key, JIT config, 1Password token,
or a service-account key to Terraform variables or metadata. `sensitive = true`
would hide terminal output but would not remove values from state.

## Controller outputs

`terraform output -json` exposes these non-secret configuration values:

| Output | Purpose |
| --- | --- |
| `project_id` | Existing dedicated project |
| `region`, `runner_zones` | Subnet region and permitted runner zones |
| `runner_template`, `runner_template_name` | Exact template self link and name |
| `runner_service_account` | Provisioner SA email for WIF, never attached to VMs |
| `workload_identity_provider` | Provider resource name for the auth action |
| `runner_ttl_seconds` | Maximum permitted lease runtime |
| `state_bucket` | Foundation backend bucket |

The controller must use the exact template, `--no-service-account`,
`--no-scopes`, and a unique `slv-gha-` name for every job and attempt. It must
check ownership labels before cleanup. Use a GitHub App scoped to this repository
to generate JIT config in the hosted control job; only that one-use config reaches
the VM. Keep the App private key in the dedicated 1Password integration and never
include it in a runner image, artifact, Terraform input, or startup log.

## Local verification

Configure the GitHub environment `slv-gce-runners` with a custom branch policy
allowing only `main`. Store the dedicated, read-only 1Password service-account
token as its `OP_SERVICE_ACCOUNT_TOKEN` secret. Keep the token's recovery record
in an administrator-only vault, outside the vault the token itself can read.
Record its expiration and rotate it before that date; an expired token stops
new provisioning. The GitHub App installation must include only this repository
with Administration write and Metadata read. No organization runner permission
or personal access token is needed.

Set these environment variables from the Terraform outputs and the 1Password
item reference (not from the private key contents):

| GitHub environment variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | `project_id` output |
| `GCP_RUNNER_ZONE` | One entry from `runner_zones` |
| `GCP_RUNNER_TEMPLATE` | `runner_template` output |
| `GCP_RUNNER_SERVICE_ACCOUNT` | `runner_service_account` output |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `workload_identity_provider` output |
| `SLV_RUNNER_APP_ID` | Dedicated GitHub App ID |
| `SLV_RUNNER_APP_KEY_REF` | `op://VAULT_ID/ITEM_ID/private_key` |

After the reviewed smoke workflow is on `main`, dispatch `gce-runner-smoke.yml`
and verify the guest checks and subsequent deletion. The release workflow stays
on GitHub-hosted runners until repository variable `SLV_GCE_RUNNERS_ENABLED`
is explicitly set to `true`. Even when enabled, PRs and tags use the existing
hosted path. Only trusted main push/dispatch source builds use the GCE path.
Each of the four Linux variants gets its own VM and immediate cleanup job.
The largest release run can use four 16-vCPU VMs; verify the regional quota and
available credits before activation. macOS and native ARM execution stay hosted.

The random runner label avoids accidental or predictable dispatch collisions;
it is not an authorization credential. GitHub may expose job runner labels.
Untrusted builds must never receive controller credentials, regardless of labels.
The host has no GCP identity, no inbound connectivity, and is discarded after
each job. Runner process logs stay on the disposable disk; build diagnostics
must be uploaded by the job before cleanup. Review an organization's restricted
runner groups separately if workflow-level runner assignment is required.

The required budget covers all services in this project, with all credits
subtracted, over each billing calendar month in the US Pacific time zone. Its default and maximum amount is
EUR 50, with email alerts at 50%, 80% and 100% sent to the default billing IAM
recipients. EUR must match the existing billing account currency. The initial
administrator also needs budget-administration permissions on that account and
`serviceusage.services.use` on the project for user ADC quota attribution.

Cloud Billing updates a dedicated Pub/Sub topic. At the limit, the Python 3.12
function disables the provisioner identity and deletes only managed ephemeral
VMs. The state bucket and billing connection remain available. Billing data and
notifications are delayed: this is a cost-control response, not a guarantee that
the invoice cannot exceed EUR 50. Persistent storage and the budget function can
still incur small costs after runners stop.

The first-generation budget function and its artifact repository default to
`europe-west1`, independently of the GCE runner region. First-generation Cloud
Functions is not available in every GCE or Cloud Run region.

Disabling the provisioner is latched: normal Terraform applies ignore changes
to its `disabled` state, and the handler cannot enable it. After reviewing the
new month's available budget and any delayed billing messages, an administrator
can explicitly re-enable that identity. Do not automate a monthly reset without
checking the spending state.

After the budget stop disables the provisioner, ordinary controller cleanup
cannot authenticate to GCP. The budget handler and GCE deadline still delete
VMs independently. An unused GitHub runner registration may need cleanup after
the administrator restores the provisioner; it cannot restart the deleted VM.

These checks use a mock provider for tests and do not provision cloud resources:

```sh
terraform fmt -check -recursive
terraform init -backend=false -input=false
terraform validate
terraform test
```

Review the first real smoke run for image boot compatibility, C4 quota,
conditional IAM permissions, startup logs, one-job deregistration and deletion
of both VM and disk before enabling release build jobs. Runtime expiry and the
scheduled janitor cover cancellation paths that a normal cleanup job cannot.

References: [Google WIF trust conditions](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines),
[VM runtime limits](https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime),
[Terraform GCS backend](https://developer.hashicorp.com/terraform/language/backend/gcs),
[Terraform sensitive values](https://developer.hashicorp.com/terraform/language/manage-sensitive-data).
