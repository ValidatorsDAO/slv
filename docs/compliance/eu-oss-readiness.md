# SLV EU OSS readiness

Last verified: 2026-10-13

This is SLV's shared evidence and review procedure for Cyber Resilience Act
(CRA) readiness. It records preparation and open decisions; it is not a legal
classification, compliance certification, or CE declaration.

## Decisions requiring human confirmation

User-confirmed business facts (2026-10-13): the responsible legal entity for
SLV distribution and security is **ELSOUL LABO B.V.** All SLV code, binaries,
updates, and security fixes are free to obtain and use without Enterprise.
SLV Enterprise provides optional paid deployment and operations services around
the same public OSS; it does not provide Enterprise-only non-public software or
features. Enterprise fixes are intended to be prioritised before OSS fixes, but
this is not a fixed delay, support duration, or displacement of any applicable
mandatory law.

Security fixes are provided free through the latest public version. There is no
blanket promise to individually backport fixes to older versions; applicable
law and existing contracts remain preserved. A free latest-version upgrade must
not require extraordinary migration costs, such as new hardware or a fundamental
environment change; normal update, testing, and configuration effort is not
inherently extraordinary. Where that condition is not met, remediation must be
assessed case by case rather than denied under a blanket rule.

An internal accountable human and contact were designated by the user. Their
personal name and email are intentionally not published here. A deputy and a
functioning public security-reporting channel remain unconfirmed. Optional paid
ERPC service functionality in the same CLI leaves the monetisation and product
boundary assessment open. These facts do not determine the applicable statutory
role, CRA applicability, product classification, or support duration.

| Decision | Status | Evidence needed |
| --- | --- | --- |
| Product boundary and CRA applicability | UNDETERMINED | SLV distribution, intended use, EU availability, monetisation, including optional ERPC paid-service functionality in the same CLI |
| Responsible legal entity | CONFIRMED — ELSOUL LABO B.V. (2026-10-13) | Preserve the applicable product and distribution scope in the statutory analysis |
| Statutory role | UNDETERMINED | Assess whether and where ELSOUL LABO B.V. is a manufacturer, statutory OSS steward, or another role |
| Product classification | UNDETERMINED | In-scope functionality and applicable CRA category |
| Support commitments | PARTIALLY CONFIRMED | Security fixes are free through the latest public version; no blanket individual old-version backports; assess extraordinary-migration cases individually. Support duration, supported versions, and existing customer commitments remain UNDETERMINED; Enterprise-first then OSS fixes is intended prioritisation only |
| Security response owner and reporting channel | PARTIALLY CONFIRMED | Internal accountable human/contact designated 2026-10-13; [public SECURITY.md](../../SECURITY.md) links to the enabled GitHub private-reporting setting; human administrator recipient permission independently verified without publishing identity. Deputy, signed-in form flow, test-report delivery, notification routing, triage, escalation, and a functioning public channel remain unconfirmed |
| Release approval and evidence ownership | UNDETERMINED | Named humans, operational permissions, retention and recovery decisions |
| Overall compliance status | UNDETERMINED | Applicable requirements and reviewed evidence resolving the gaps below |

Only the missing assignments and due dates above require human assignment.
Technical hardening can proceed while these decisions are open; it does not
resolve them. Record confirmed answers with their date and responsible function
without publishing private personal or contact data.

## Legal sources and timing

The Commission explains that commercial supply, monetisation, and responsibility
matter to CRA applicability. A public repository or OSS licence alone establishes
neither an exemption nor manufacturer obligations. A statutory OSS steward is a
legal person supporting relevant OSS development on a sustained basis and playing
a main role in its viability; this software review agent does not create that
status. [Commission OSS guidance](https://digital-strategy.ec.europa.eu/en/policies/cra-open-source)
(page updated 2026-07-31; checked 2026-10-12).

The main CRA obligations apply from **2027-12-11**.
[Commission CRA summary](https://digital-strategy.ec.europa.eu/en/policies/cra-summary)
(checked 2026-10-12).

Manufacturer reporting applies from **2026-09-11**; statutory OSS steward
reporting under Article 24(3) starts **2027-12-11**. For manufacturers, actively
exploited vulnerabilities or severe incidents affecting product security can
trigger a 24-hour early warning and 72-hour notification after awareness. Final
reports are due within 14 days after a corrective measure becomes available for
an exploited vulnerability, or within one month of the 72-hour notification for
a severe incident. These are event-specific duties, not a rule to report every
CVE. [Commission reporting guidance](https://digital-strategy.ec.europa.eu/en/policies/cra-reporting)
(page updated 2026-09-11; checked 2026-10-12).

On a potential reporting trigger, immediately flag the facts and awareness time
to the project lead and responsible human in the current task context. Track
applicable deadlines once reportability is confirmed; do not wait for the next
release review. Keep confidential details out of this public repository.

The governing text is [Regulation (EU) 2024/2847](https://eur-lex.europa.eu/eli/reg/2024/2847/oj),
particularly Articles 2, 3, 13, 14, 24, and 71 and Annex I. Commission summaries
support planning; verify current law for a legal determination. This bounded
review has not audited the full statutory text. SBOM and provenance work below
is an engineering readiness target, not a claim that every OSS project must
publish an SBOM, obtain certification, or promise a particular support period.
The Commission's support-period examples (sections 129–131, Examples 52–53)
provide planning context for the latest-version policy; they do not settle SLV's
applicable statutory role or duration. [Commission guidance C(2026) 5252
final](https://ec.europa.eu/newsroom/dae/redirection/document/131456) (checked
2026-10-13).

## Product-boundary evidence candidates (2026-10-13)

These candidates organise product-boundary evidence; they do not identify
separate legal products. CRA role, applicability, and classification remain
**UNDETERMINED**.

| Candidate | Evidence relevance | Next evidence |
| --- | --- | --- |
| Same public CLI with optional paid AI, storage, purchase, subscription, and credit functionality | The Commission's section 54 treats monetisation of other services as relevant; free or optional functionality alone does not establish an exemption | Supplier/entity, intended EU use, and remote-processing facts |
| Same-OSS Enterprise optional services | Sections 55–57 and Example 18 distinguish optional services around public OSS from software monetisation | Confirm actual terms and that no payment-dependent edition or maintenance exists |
| Rebuilt and redistributed Agave components | `docs/agave-build-playbook/README.md` documents `storage.slv.dev/agave/<version>` distribution | Upstream revision, modifications, notices, branding, supplier, integrity, and product-versus-component analysis |
| Legacy `grpc_test`, `geyserbench`, and `shreds_test` helpers outside the new verified flow | These helpers may have distinct delivery and integrity evidence | Identify active paths, suppliers, integrity controls, and disposition |

Statutory OSS steward status is not an elective label; sections 69–76 require
its own factual assessment. On 2026-10-13, [Regulation (EU)
2025/2392](https://eur-lex.europa.eu/legal-content/en/TXT/?uri=CELEX%3A32025R2392),
Annex I, Class I, point 6 was verified to cover network-operation and
configuration-monitoring functionality for connected servers and dedicated
configuration systems. SLV's advertised node-management, network-tuning, and
DoubleZero-status functionality is therefore a relevant candidate; recitals 4–5
require the assessment to use the product's core functionality. Final
classification, role, and applicability remain **UNDETERMINED**.

Article 32(5) permits Free and Open Source Software Class I or II manufacturers
to choose Article 32(1), including internal control, if the Article 31 technical
documentation is publicly available when the product is placed on the market.
That conditional route does not support a CE mark or compliance claim here. See
the Commission's [CRA summary, Chapter
III](https://digital-strategy.ec.europa.eu/en/policies/cra-summary).

Prior-session build, SBOM, provenance, and consumer tests are implementation
evidence only. They are not fresh all-native testing, live OIDC evidence, or an
immutable-release end-to-end verification.

## Repository baseline and outstanding evidence

This is a bounded historical baseline at commit
`08acbaf3cdaaae7c03b1ab0c57c4233a9d31d727`, inspected 2026-10-12. It is not a
complete product or infrastructure audit. Later implementation must be evidenced
separately; these findings do not describe a completed hardening effort.

| Area | Evidence at baseline | Gap / next evidence |
| --- | --- | --- |
| Product inventory | `cli/` Deno CLI; `template/` Ansible/Jinja templates; `dist/oss-skills/`; `sh/install` | Confirm product boundaries, bundled components, optional downloads, and distribution channels |
| Licence | `LICENSE.txt` is Apache License 2.0; `README.md` states Apache-2.0 | Existing copyright and licence conditions apply now independently of CRA 2027. `NOASSERTION` alone is not a violation; check actual distribution notices and third-party obligations. The erpc-sdk MIT baseline does not apply |
| Dependencies and SBOM | `deno.json`, `cli/deno.json`, `deno.lock`; release workflow installs additional build/publishing tools | No SBOM production evidence in inspected release workflow; inventory build/runtime/transitive dependencies and fetched external software, recording exclusions |
| Build and publication | `.github/workflows/slv-remote-build.yml` uses hosted macOS and self-hosted Linux release jobs; GitHub Releases and ClawHub publication; `deno.json` invokes R2 upload tasks | Verify source identity, runner isolation, least privilege, reproducible inputs, promotion controls, and per-channel publication evidence |
| Consumer verification | `sh/install` checks executable archive checksums, then fetches templates and ancillary tools; skills use the mutable `main` branch | Checksums fetched beside assets do not independently authenticate their origin; templates, tools, and skills need an explicit verified-delivery boundary |
| Vulnerability intake | Root `SECURITY.md` absent at baseline; GitHub private vulnerability reporting returned `enabled: false` on 2026-10-12 via read-only repository API inspection | Assign a human and verify a private channel before documenting it as operational; no channel settings were changed by this review |
| Support and recovery | No support-period decision established by the inspected release paths | Confirm maintained versions, patch delivery, evidence retention, rollback and compromised-release response |

Reproduce the static baseline with `git show <baseline>:<path>` for the paths
above. The separate live-setting observation used
`gh api repos/ValidatorsDAO/slv/private-vulnerability-reporting`; it must be
rechecked before claiming that reporting is enabled. Published artifacts,
repository protections, R2 access controls, and live attestations are not proven
by workflow source alone.

### GitHub settings observations

The earlier 2026-10-13 observation that private vulnerability reporting was
`false` is superseded for that setting. After explicit user approval, an
authorised operator enabled GitHub private vulnerability reporting on
2026-10-13; a read-only follow-up API check returned `enabled: true`. The public
[security advisories page](https://github.com/ValidatorsDAO/slv/security/advisories)
returned `200` and included a Report a vulnerability entry pointing to
`/ValidatorsDAO/slv/security/advisories/new`. An unauthenticated request to that
entry redirects to GitHub sign-in with the same return target.

This confirms setting activation and a public entry point, not a functioning
reporting or notification channel. A human administrator's recipient permission
was independently verified without recording their identity; this supersedes
only the earlier recipient-access gap. The notification API check lacked the
needed scope and the user deferred that check. Authenticated submission access,
signed-in form inspection, test-report delivery, and notification routing remain
unverified. The public [SECURITY.md](../../SECURITY.md) now directs reporters to
the enabled GitHub channel. Immutable releases remain
`false` and `enforced_by_owner` remains `false`; rulesets remain `[]`; and the
only environment remains `copilot`, with no protection rules. Recheck current
settings and actual report-routing and release-approval behaviour before
treating any channel or control as operational.

## Delivery readiness evidence to collect

For the chosen release design, attach evidence for:

- Exact source revision, version and locked build inputs; a recorded build
  environment and an inventory covering shipped archives, installers, templates,
  skills and explicitly included or excluded external tools.
- Separation of untrusted PR execution from release credentials; narrowly scoped
  publication permissions and approved source selection.
- Machine-readable component inventory/SBOM, licence notices, vulnerability
  findings and triage decisions tied to the released version. A lockfile alone
  does not inventory every downloaded tool or native runtime component.
- Artifact digests and verifiable build provenance; consumer rejection of a
  wrong source, altered content, incomplete release or unverified executable.
  Document the initial installer trust path as well as subsequent downloads.
- Promotion of the same verified artifacts to every supported channel, surfaced
  publication failures, and recovery without silently replacing an existing
  version. Record what was actually published and how a consumer verifies it.

These are review targets. Mark each as implemented, tested, live-verified, or
open with supporting evidence; do not convert this list into a completion claim.

## Reviewer role and procedure

`eu-oss-compliance` is the project's read-only evidence reviewer. Invoke it for
licensing, dependency/SBOM, vulnerability handling, release delivery, or support
changes, and when new business facts may change applicability. It reports to the
project lead; the lead assigns implementation to the relevant contributor.
Codex loads the role from
[the agent definition](../../.codex/agents/eu-oss-compliance.toml); other runtimes
use this same procedure.

The reviewer checks the changed paths, affected artifacts, current primary
sources, and prior open decisions. It identifies missing evidence without
inventing owners, dates, a statutory role, or support commitments. It cannot
certify conformity, approve/publish releases, change live settings, file with a
regulator, send external messages, or disclose vulnerabilities. Human decisions
and external actions remain with the responsible humans and authorized project
workflow. This role designation creates no scheduled automation.

Return a concise record to the lead:

```text
Change / release / incident and source revision:
Applicability / legal role / classification status:
Support commitments and responsible human:
Primary sources and dates checked:
Evidence (configured / tested / live-verified):
Gaps and impact on this change:
Potential reporting trigger and awareness time, if relevant:
Required human decision:
Implementation owner and due date (or TBD — human assignment required):
Next review event or assigned date:
```

Use `UNDETERMINED` for unresolved decisions and `CONFIRMED` only with attributed
evidence. Review again on the next relevant change or security event, or an
explicitly assigned date. Keep current decisions here and release-specific test
and publication receipts with their release record. The earlier
[erpc-sdk runbook](https://github.com/elsoul/erpc-sdk/blob/fdc3ea3/.codex/docs/eu-oss-compliance.md)
informed this procedure; its product facts and internal role names are not SLV
evidence.

## Disposable runner review (2026-10-17)

The source-build integration was reviewed against `44cf822b4c8815833417a72c601358389f0d5678`
with a separate infrastructure change. Applicability, statutory role,
classification, support commitments, and existing human assignments remain
unchanged or **UNDETERMINED**. This is implementation evidence, not release
approval or compliance certification.

Configured controls include main-only hosted management jobs, restricted OIDC
federation, a repository-scoped GitHub App, dedicated read-only secret access,
service-account-free build VMs, one-job runners, owned-resource cleanup, and an
absolute cloud deletion deadline. Linux split builds accept 2, 4, 8, or 16 jobs
and retain matching producer/combined receipt checks. macOS, native ARM runtime
execution, signing, and publication retain their existing runners.

Local evidence: 27 workflow regression tests and eight targeted source tests
passed in Linux; 21 controller tests, five budget tests, and six Terraform mock
tests passed. The live bootstrap check found an explicit gcloud boot-disk flag
replacing the inherited image. The correction removes the override and checks
the actual image, disk size/type, machine type, and deadline before handoff.

The corrected live infrastructure smoke reached runner-online with the pinned
Ubuntu image, 16-vCPU machine, no attached cloud identity, and JIT metadata
removed. A synthetic monthly-budget notification disabled provisioning, denied
the disabled identity's API access, and deleted that VM and its boot disk. The
function completed successfully; subsequent cleanup removed the runner
registration. The administrator restored the identity after this synthetic test
and removed the temporary test impersonation grant. No GCP private key was
created. Account-specific identifiers and logs are retained outside this public
repository.

The monthly budget uses net cost after credits, US Pacific calendar months, and
a latched stop requiring explicit recovery. Billing notifications are delayed;
this is not an invoice cap, and persistent storage can continue to incur costs.
Random runner labels are routing identifiers, not authorization credentials.
After a budget stop, GitHub registration cleanup can require later recovery,
while cloud deletion remains independently protected.

Outstanding activation evidence: the hosted OIDC/secret-loading path, actual
single-job completion, per-job cleanup, cancellation/orphan recovery, and a
source-build performance comparison. Release opt-in remains disabled pending
that evidence. The bounded reviewer participated in implementation; normal PR
review remains required. No potentially reportable incident was established by
this review. The next review is the final PR revision and first hosted smoke / GCE
source-build evidence. Implementation lead owns that follow-up; human ownership
and due dates otherwise remain as recorded above.
