<p align="center">
  <a href="https://slv.dev/">
    <img src="https://storage.slv.dev/SLVogp.jpg" alt="SLV — Solana node operations" width="900" />
  </a>
</p>

<h1 align="center">SLV</h1>

<p align="center">
  <strong>Solana infrastructure, from setup to operations.</strong><br />
  Validators, RPC nodes, and Yellowstone gRPC — through a CLI, AI Console, or Ansible.
</p>

<p align="center">
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="Apache 2.0 license" /></a>
  <a href="https://slv.dev/"><img src="https://img.shields.io/badge/docs-slv.dev-14F195" alt="SLV documentation" /></a>
  <a href="https://discord.gg/C7ZQSrCkYR"><img src="https://img.shields.io/badge/community-Discord-5865F2" alt="Validators DAO Discord" /></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-you-can-run">Node types</a> ·
  <a href="#everyday-operations">Commands</a> ·
  <a href="#verified-releases">Release verification</a> ·
  <a href="#documentation-and-community">Documentation</a>
</p>

SLV brings node configuration, source builds, snapshots, service management, and
endpoint checks into one open-source toolkit. Use the CLI directly, add the AI
Console for guided operations, or work with the underlying Ansible playbooks and
Jinja templates. AI is optional.

## Built for node operators

| Your workflow | How SLV helps |
| --- | --- |
| **Bring a node online** | Interactive setup, inventories, client selection, and deployment playbooks for validators and RPC nodes. |
| **Keep it running** | Build client software, manage services, fetch snapshots, and update startup settings through explicit commands. |
| **Prepare for protocol changes** | Client version checks and identity-change guards for Alpenglow, with network-specific restrictions. |
| **Ask for operational help** | Specialist AI agents prepare commands and explain workflows; sensitive AI tool commands require your terminal confirmation. |
| **Inspect the automation** | Readable playbooks, templates, and reusable agent skills let you review and adapt each operation. |
| **Verify an SLV update** | The release consumer checks immutable release identity, provenance, and payload hashes before replacement. |

## What you can run

| Workload | Current choices |
| --- | --- |
| **Mainnet validators** | Agave, Jito, Allnodes-Jito |
| **Testnet validators** | Agave, Jito, Firedancer-Agave, Firedancer-Jito |
| **RPC nodes** | SendTx RPC, Index RPC, Geyser gRPC, Index RPC + gRPC |
| **Geyser streaming** | Yellowstone gRPC |

The current mainnet deployment guards refuse Firedancer and Frankendancer voting
validators. Review the selected client, network, version pins, and server
requirements before deployment. See the [validator](dist/oss-skills/slv-validator/)
and [RPC](dist/oss-skills/slv-rpc/) packages for the available playbooks.

## Quick start

### 1. Prepare your management machine

The SLV release installer targets **Linux and macOS, on x64 and ARM64**. These are
CLI platforms; node hardware and operating-system requirements depend on the
selected deployment playbook.

| For | You need |
| --- | --- |
| **Installing SLV** | Python 3.9 or later and Git |
| **Deploying nodes** | ansible-core 2.15 or later, SSH access to the target, and the privileges required by the selected playbook |
| **Key, vote-account, and BLS operations** | Solana CLI where the selected workflow requires it |

The verified installer does not install system dependencies. Existing SLV users
should read the [migration instructions](docs/secure-delivery.md#initial-installation)
before replacing an installation.

### 2. Install from a reviewed bootstrap

Follow the [secure delivery guide](docs/secure-delivery.md) to select a reviewed
bootstrap and an eligible immutable release. Replace `<reviewed-commit>` below
with the exact reviewed commit; the placeholder is deliberately not runnable.

```sh
# Download the bootstrap from that exact commit.
curl --fail --location --remote-name \
  https://raw.githubusercontent.com/ValidatorsDAO/slv/<reviewed-commit>/sh/install

# Inspect the downloaded script before running it.
less ./install
sh ./install
```

After installation, follow the printed PATH instructions and check the CLI:

```sh
slv --version
slv --help
```

### 3. Choose your workflow

**Direct CLI** — start an interactive validator setup:

```sh
slv validator init
```

For RPC setup, use `slv rpc init` instead.

Setup can change the target server: it may create a user and offer system tuning
or a reboot. Review each prompt, the chosen network, inventory, client version,
and key configuration before deploying.

For a configured mainnet validator, replace `<inventory-host>` with the exact
inventory entry you intend to deploy:

```sh
slv validator list --network mainnet
slv validator deploy --network mainnet --pubkey "<inventory-host>"
```

Use `slv rpc deploy --help` for the equivalent RPC workflow.

**AI Console** — run onboarding, then open the interactive console:

```sh
slv onboard
slv c
```

Onboarding defaults to SLV AI with ERPC sign-in. If sign-in was skipped, run
`slv login`. You can configure an alternative AI provider through `slv auth`.
Provider accounts and service usage are separate from installing the open-source
CLI.

Example requests:

- “Help me prepare a testnet validator deployment.”
- “Explain the steps to rebuild the client on this validator.”
- “Help me check this RPC endpoint.”

<details>
<summary><strong>Meet the specialist agents</strong></summary>

| Agent | Focus |
| --- | --- |
| **Cecil** | Validator deployment and operations |
| **Tina** | RPC nodes and Geyser gRPC |
| **Cid** | Benchmarks and connectivity checks |
| **Figaro** | Server procurement, pricing, and hardware selection |
| **Setzer** | Solana application development |

</details>

## Everyday operations

| Task | Command |
| --- | --- |
| List mainnet validators | `slv validator list --network mainnet` |
| List mainnet RPC nodes | `slv rpc list --network mainnet` |
| Explore validator operations | `slv validator --help` |
| Explore RPC operations | `slv rpc --help` |
| Build a validator client from source | `slv validator build:solana --network mainnet --pubkey "<inventory-host>"` |
| Check a public RPC endpoint | `slv check rpc --url https://api.mainnet-beta.solana.com` |
| Upgrade SLV, templates, and skills | `slv upgrade` |
| Restore skills for the installed CLI release | `slv skills sync` |
| Read embedded third-party notices | `slv licenses` |

**SLV updates and node-client updates are separate operations.** `slv upgrade`
updates the management tool, its versioned templates, and its skills. Validator
and RPC client software is managed through the node commands.

Streaming and benchmark commands such as `slv check grpc`, `slv check shreds`,
and `slv check geyserbench` need separate helper binaries. The verified SLV
installer does not install those optional tools.

## Verified releases

Before installing or replacing release files, the release installer,
`slv upgrade`, and `slv skills sync` use a common verification path:

1. Select the latest eligible immutable release for installation or upgrade,
   or the installed CLI's exact release for skill sync.
2. Verify the manifest's provenance and source identity, including the public
   release tag and pinned runtime qualification, before accepting payloads.
3. Check archive hashes and contents before replacing the selected files.
4. Journal core replacements so an interrupted transaction can be recovered.

The consumer preserves existing keys, configuration, inventories, and backups.
Review the [recovery and settings behavior](docs/secure-delivery.md#recovery-and-settings),
including the separate handling of a settings-migration failure.

The release pipeline pairs each fresh CLI build with a separately qualified,
source-built runtime. Linux builders produce all four target binaries; signed
receipts distinguish native Linux execution from static macOS checks and the
runtime's earlier native qualification. Corresponding source archives, an SPDX
SBOM, and third-party notices make the inputs available for inspection and
rebuilding. See [secure delivery](docs/secure-delivery.md) for the trust
and acceptance requirements, and [rebuilding releases](docs/rebuilding-releases.md)
to inspect the source materials and rebuild procedure. Implemented verification
controls do not by themselves establish that a release has passed live acceptance.

## Credentials and control

**SLV currently uses local credential storage.** `slv login` writes ERPC access
and refresh tokens to `~/.slv/api.yml` with mode `0600`; configured API keys can
also be stored there. Deployment workflows use keypair files on the management
machine or target node, depending on the operation.

SLV has no built-in 1Password credential provider or `op://` reference resolver.
Using 1Password or an SSH agent does not eliminate SLV's other on-disk credentials.
Keep secret values out of AI conversations, source control, and command examples.

<details>
<summary><strong>AI tool approvals and credential boundaries</strong></summary>

The AI Console's file tools restrict access to known credential locations.
Its `run_command` tool requires terminal confirmation for SSH, Ansible,
key-management commands, and the 1Password CLI (`op`). Those sensitive tool
commands are refused when no terminal is attached.

Commands launched through `run_command` receive a restricted environment:
`OP_*` credentials are not forwarded, biometric unlock is disabled for those
child commands, and `SSH_AUTH_SOCK` is forwarded only after a person confirms
the command.

Shell commands entered directly by the operator with the `/` prefix use the
operator's environment and run outside these tool restrictions. These controls
are not a machine-wide credential isolation boundary.

</details>

For vulnerability reporting and the security-update policy, see [SECURITY.md](SECURITY.md).

## Reuse the skills and playbooks

SLV includes reusable agent skills, including these node-operation packages:

| Package | Start here |
| --- | --- |
| Validator operations | [slv-validator](dist/oss-skills/slv-validator/) |
| RPC operations | [slv-rpc](dist/oss-skills/slv-rpc/) |
| Geyser gRPC streaming | [slv-grpc-geyser](dist/oss-skills/slv-grpc-geyser/) |

Browse [all skill packages](dist/oss-skills/), or list the available names with
`slv skills list`. Each node-operation package includes instructions, Ansible
playbooks, Jinja templates, and example inventories.

Use the full package with an AI coding agent that can read its instructions and
run the required tools. Direct Ansible use is also available to operators who
prepare the expected inventories, version configuration, key files, and template
paths. Inspect the package's playbooks and examples before running them.

## Development

With Deno installed:

```sh
git clone https://github.com/ValidatorsDAO/slv.git
cd slv
deno task dev --help
deno test --frozen -A
```

| Path | Contents |
| --- | --- |
| [`cli/`](cli/) | Deno CLI and AI Console |
| [`template/`](template/) | Versioned Ansible and Jinja sources |
| [`oss-skills/`](oss-skills/) | Agent skill sources |
| [`dist/oss-skills/`](dist/oss-skills/) | Packaged skills and supporting files |
| [`scripts/release/`](scripts/release/) | Release packaging and verification tools |

Release binaries require the source-build and notice inputs described in
[rebuilding releases](docs/rebuilding-releases.md).

## Documentation and community

- **Learn:** [SLV documentation](https://slv.dev/) · [Secure installation and upgrades](docs/secure-delivery.md) · [Source rebuilds](docs/rebuilding-releases.md)
- **Discuss:** [Validators DAO Discord](https://discord.gg/C7ZQSrCkYR) · [SLV on X](https://twitter.com/slvSOLANA)
- **Contribute:** [Issues](https://github.com/ValidatorsDAO/slv/issues) and pull requests are welcome. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Report a vulnerability:** Use the private reporting path in [SECURITY.md](SECURITY.md).

## License

SLV is available under the [Apache License 2.0](LICENSE.txt). Public SLV code,
binaries, updates, and security fixes are available without Enterprise.
Optional Enterprise services operate around the same public open-source software.
