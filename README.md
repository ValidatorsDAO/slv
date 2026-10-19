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
  <a href="#credentials-and-control">1Password &amp; credentials</a> ·
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
validators. Testnet Firedancer variants can be deployed with an unstaked identity,
but SLV's staked-identity activation and migration commands refuse them.
Review the selected client, network, version pins, and server
requirements before deployment. See the [validator](dist/oss-skills/slv-validator/)
and [RPC](dist/oss-skills/slv-rpc/) packages for the available playbooks.

## Quick start

### 1. Prepare your management machine

The SLV release installer targets **Linux and macOS, on x64 and ARM64**. These are
CLI platforms; node hardware and operating-system requirements depend on the
selected deployment playbook.

| For | You need |
| --- | --- |
| **Installing SLV** | Python 3.9 or later, Git, and curl for the bootstrap download |
| **Deploying nodes** | ansible-core 2.15 or later, SSH access to the target, and the privileges required by the selected playbook |
| **Key, vote-account, and BLS operations** | Solana CLI where the selected workflow requires it |

The verified installer does not install system dependencies. Existing SLV users
should read [updating an older or locally built SLV](#updating-an-older-or-locally-built-slv)
before replacing an installation.

### 2. Install from a reviewed bootstrap

This bootstrap comes from the reviewed source of
[v2026.10.19.0750](https://github.com/ValidatorsDAO/slv/releases/tag/v2026.10.19.0750).
It discovers the **latest eligible immutable release** when run; it does not pin
your installed CLI to that bootstrap version. The block saves the script in a
private temporary directory and checks its fixed SHA-256 before execution.
See [secure delivery](docs/secure-delivery.md) for the verification model.

```sh
(
  set -eu
  umask 077
  slv_bootstrap_dir="$(mktemp -d)"
  cd "$slv_bootstrap_dir"
  curl --fail --location --output install \
    https://raw.githubusercontent.com/ValidatorsDAO/slv/c351b90306ec6e0cce01aa04725f7eaf5374f65b/sh/install
  python3 - <<'PY'
import hashlib
from pathlib import Path
expected = 'acc17d48c986a7dfcdc0afa2603da139da9e30d1af1766fd279d53152cf55282'
if hashlib.sha256(Path('install').read_bytes()).hexdigest() != expected:
    raise SystemExit('Installer checksum mismatch; stopping.')
PY
  sh ./install
)
```

After installation, follow the printed PATH instructions and check the CLI:

```sh
slv --version
slv --help
```

### Updating an older or locally built SLV

Older or custom builds may fail in `slv upgrade` with a missing `engine.py`, an
unsupported local version label, or a legacy-bootstrap migration message. Use
the [one-time recovery installer](docs/secure-delivery.md#recover-an-older-or-local-installation)
to replace the existing executable explicitly. Start by checking its location:

```sh
command -v slv
slv --version
```

The recovery guide includes a complete, checksum-checked command for
`/usr/local/bin/slv` and explains how to select another target. Run it as your
normal user; a protected binary location requires administrator authentication
only for the final replacement. Afterwards, use `slv upgrade` for normal updates.

### 3. Choose your workflow

**Direct CLI** — start an interactive validator setup:

```sh
slv validator init
```

Validator init now saves a generated identity directly to 1Password and verifies
it by reading it back. Run it in your own terminal with the 1Password app/CLI
available. It stores only public metadata and an `op://` reference in inventory;
it creates no normal plaintext identity or vote-key file. New configurations use
`no_voting: true`: deploy starts the server's unstaked identity for synchronization,
not the identity stored in the vault. It creates no vote account, requests no
airdrop and sends no transaction. Existing vote-account metadata is optional.

Sync-only startup uses the matching packaged templates without overwriting
custom templates used by older hosts. An unspecified shred-version pin is omitted
for entrypoint discovery; the network's expected genesis hash is still checked.
Normal promotion, switching and BLS signing refuse these bootstrap/1Password
entries until a separate supported activation workflow is available. Do not
remove the flag or export a private key as a workaround.

For RPC setup, use `slv rpc init` instead; its key workflow is unchanged.

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
slv onboard --no-start
slv c
```

By default, onboarding enables all five specialist agents and checks your AI balance before
opening chat. It preserves existing profiles and memory. Use
`slv onboard --no-start` to save settings without opening chat, or
`slv onboard --advanced` for names, deployment mode, notifications and browser
access.

SLV AI requires ERPC browser OAuth. Run `slv login`, then `slv ai`.
`slv auth` is also an ERPC login entry point. RPC API keys do not authenticate
account or AI requests; personal Claude/OpenAI keys and the old `--anthropic` /
`--openai` flags are no longer supported. Legacy AI settings migrate without
sending those keys to any service. ERPC login and unrelated settings are preserved.
Service usage is separate from installing the open-source CLI.

The console follows your current request, including on existing installations.
Greetings use a short reply without project scans or tool calls; closing chat
does not start another AI request to decide whether to save memory. Notable
outcomes can be recorded during the relevant task. Use `/focus` only when you
want to set an explicit working preference.

Operational guidance checks the installed command help when syntax is uncertain.
Validator "keyless" startup means initial synchronization with an unstaked
identity; production voting still needs the operator's keys and identity checks.
Key handling and interactive deployment steps stay in the operator's terminal.
`slv install firewall` changes the machine running SLV and replaces its ruleset;
the generic management-host rules must not be applied blindly to a live node.

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
| Check mainnet Alpenglow readiness | `slv validator check:alpenglow --network mainnet` |
| Explore validator operations | `slv validator --help` |
| Explore RPC operations | `slv rpc --help` |
| Build a validator client from source | `slv validator build:solana --network mainnet --pubkey "<inventory-host>"` |
| Check a public RPC endpoint | `slv check rpc --url https://api.mainnet-beta.solana.com` |
| Upgrade SLV, templates, and skills | `slv upgrade` |
| Restore skills for the installed CLI release | `slv skills sync` |
| Read embedded third-party notices | `slv licenses` |

`check:alpenglow` reads inventory, version pins, and public RPC data and reports
OK, WARN, or FAIL without SSH or transactions. It exits with status 1 when a
check fails or cannot run.

**SLV updates and node-client updates are separate operations.** `slv upgrade`
updates the management tool, its versioned templates, and its skills. Validator
and RPC client software is managed through the node commands.

For an older build whose updater cannot start, follow the
[one-time recovery procedure](docs/secure-delivery.md#recover-an-older-or-local-installation).

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
and refresh tokens to `~/.slv/api.yml` with mode `0600`; configured RPC API keys can
also be stored there.

Validator deployment starts nodes with an unstaked identity and does not copy
the staked identity key to them. Supported Agave-family identity activation and
migration commands read `~/.slv/keys/<identity_account>.json` on the management
machine and pass it through stdin. Older node-side copies are not automatically
removed. RPC deployment still uses a copied identity keypair file.

`slv v keys:gen`, `keys:import`, `keys:check` and `keys:try` keep a validator
identity key in 1Password and read it by reference,
`op://<vault id>/<item id>/keypair`, through the 1Password CLI (`op`), signed in
with the 1Password app or, for testnet and devnet, with a service account token
file named in `~/.slv/keyless.yml`, which also names the vault of each network.
`keys:import` writes the reference to the `identity_ref` field of the inventory
entry. Validator init also writes a verified reference. The legacy identity
activation, migration and BLS-signing paths refuse `no_voting` or 1Password-backed
entries; they do not resolve the reference. Deployment does not read the vault
key and starts the server with its own unstaked identity. `slv v hosts:pin` pins the SSH host key
of a node in `~/.slv/known_hosts`.
Using 1Password or an SSH agent does not eliminate SLV's other on-disk credentials.
Keep secret values out of AI conversations, source control, and command examples.

The [1Password and credential guide](docs/credentials-and-1password.md) covers
the `keys:` and `hosts:pin` commands, human-account CLI authentication, an
external SSH-agent setup, the credentials SLV still stores locally, and the
limits of `identity_ref` and `op run`.

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

- **Learn:** [SLV documentation](https://slv.dev/) · [Secure installation and upgrades](docs/secure-delivery.md) · [1Password and credentials](docs/credentials-and-1password.md) · [Source rebuilds](docs/rebuilding-releases.md)
- **Discuss:** [Validators DAO Discord](https://discord.gg/C7ZQSrCkYR) · [SLV on X](https://twitter.com/slvSOLANA)
- **Contribute:** [Issues](https://github.com/ValidatorsDAO/slv/issues) and pull requests are welcome. Follow the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Report a vulnerability:** Use the private reporting path in [SECURITY.md](SECURITY.md).

## License

SLV is available under the [Apache License 2.0](LICENSE.txt). Public SLV code,
binaries, updates, and security fixes are available without Enterprise.
Optional Enterprise services operate around the same public open-source software.
