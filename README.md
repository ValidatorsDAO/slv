<p align="center">
  <a href="https://slv.dev/" target="_blank">
    <img src="https://storage.slv.dev/SLVogp.jpg" alt="SLV" />
  </a>

<a href="https://twitter.com/intent/follow?screen_name=slvSOLANA" target="_blank">
    <img src="https://img.shields.io/twitter/follow/slvSOLANA.svg?label=Follow%20@slvSOLANA" alt="Follow @slvSOLANA" />
  </a>
<a aria-label="License" href="https://github.com/ValidatorsDAO/slv/blob/main/LICENSE.txt">
    <img alt="" src="https://badgen.net/badge/license/Apache/blue">
  </a>
    <a aria-label="Code of Conduct" href="https://github.com/ValidatorsDAO/slv/blob/main/CODE_OF_CONDUCT.md">
    <img alt="" src="https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg">
  </a>
</p>

# SLV — Solana Node Manager with AI Console

**Deploy and manage Solana validators, RPC nodes, and gRPC streaming with an AI Console and Ansible.**

SLV is a CLI tool that handles the full lifecycle of Solana infrastructure — from bare metal to running node. The built-in AI Console lets you deploy and operate nodes through natural conversation.

<a href="https://solana.com/">
  <img src="https://storage.slv.dev/PoweredBySolana.svg" alt="Powered By Solana" width="200px" height="95px">
</a>

## 🆕 What's New

- **Verified release delivery** — Installation and upgrades verify immutable GitHub Releases, provenance, and payload hashes before replacement; see [secure delivery](docs/secure-delivery.md) for the bootstrap and release acceptance requirements
- **AI Console** — Deploy nodes through conversation with specialist AI agents
- **Alpenglow readiness** — Client version checks, guarded identity changes, and Yellowstone for Geyser RPC
- **Performance tuning** — Automated CPU governor, IRQ pinning, and kernel optimization
- **Multi-region snapshots** — 7 global snapshot endpoints for fast node bootstrapping

## Quick Start

Install Python 3.9 or later and Git first. Replace `<reviewed-commit>` with an exact reviewed commit and inspect the downloaded installer before running it. See [secure delivery](docs/secure-delivery.md) for prerequisites and migration from an existing installation.

```bash
# 1. Install SLV from a reviewed, commit-pinned bootstrap.
# See docs/secure-delivery.md; do not pipe a floating URL to a shell.
curl --fail --location --remote-name \
  https://raw.githubusercontent.com/ValidatorsDAO/slv/<reviewed-commit>/sh/install
sh ./install

# 2. Choose your language, configure your agent, and sign in when needed
slv onboard

# 3. Launch the AI Console
slv c
```

The AI Console guides you through deployment and asks for terminal confirmation before AI-requested tool commands that manage nodes or credentials:

```
You: Deploy a mainnet Jito validator on 203.0.113.10

Agent: I'll set up a mainnet Jito validator. Let me walk you through:
       - Checking SSH connectivity...
       - Generating validator identity and vote keys...
       - Building Solana from source...
       - Downloading snapshot from nearest region...
       - Starting validator and monitoring slot sync...
```

## What Can SLV Do?

| Task | Command |
|---|---|
| **Install SLV** | Follow [secure delivery instructions](docs/secure-delivery.md) |
| **Initial setup** | `slv onboard` |
| **AI Console** (interactive) | `slv c` |
| **Upgrade SLV** | `slv upgrade` |
| **Restore skills for the installed CLI release** | `slv skills sync` |
| **View bundled third-party notices** | `slv licenses` |
| **List mainnet validators** | `slv validator list --network mainnet` |
| **Build Solana from source on a validator** | `slv validator build:solana --network mainnet --pubkey <validator-name>` |
| **Check endpoints** | `slv check rpc` / `slv check grpc` / `slv check shreds` |

`slv upgrade` updates SLV, its versioned templates, and its skills. Solana node software is managed separately through the validator or RPC commands. The release consumer preserves existing keys, configuration, inventories, and backups; review the [migration and recovery instructions](docs/secure-delivery.md) before upgrading an older installation.

### Supported Node Types

- **Validators** — Jito, Agave and Allnodes-Jito (mainnet & testnet); Firedancer on testnet only, because a mainnet voting validator cannot be Firedancer or Frankendancer during the Alpenglow migration
- **RPC Nodes** — Standard, Index, Geyser gRPC, Index+gRPC
- **gRPC Geyser Streaming** — Yellowstone (richat once a release supports agave 4.3 or later)

## AI Console Agents

The AI Console (`slv c`) includes specialist agents for different tasks:

| Agent | Role |
|---|---|
| **Cecil** | Validator deployments (Jito, Agave, Allnodes-Jito; Firedancer on testnet) |
| **Tina** | RPC & gRPC Geyser deployments |
| **Figaro** | Server procurement and pricing |
| **Setzer** | Solana app development |

Describe what you need in plain language. The agent prepares SSH and Ansible operations for builds, snapshots, firewall configuration, and node management. AI-requested tool commands that manage nodes or credentials require a person to confirm them in a terminal; those commands are refused in sessions without a terminal.

## Credentials and Operator Approval

SLV currently uses local credential storage. `slv login` stores ERPC access and refresh tokens in `~/.slv/api.yml` with mode `0600`. Configured API keys can also be stored there. Validator and RPC deployment playbooks use keypair files on the management machine or target node, depending on the operation.

The AI Console's file tools restrict access to credential files. Its `run_command` tool requires terminal confirmation for SSH, Ansible, key-management commands, and the 1Password CLI (`op`). Commands launched through this tool receive a restricted environment: `OP_*` credentials are not forwarded, biometric unlock is disabled for those child commands, and `SSH_AUTH_SOCK` is forwarded only after a person confirms the command. Shell commands entered directly by the operator with the `/` prefix use the operator's environment and run outside these tool restrictions.

There is no built-in 1Password credential provider or `op://` reference resolution in SLV. An operator's use of 1Password or an SSH agent does not make SLV a system that stores no secrets on disk. Keep secret values out of AI conversations, source control, and command examples, and use the documented credential flow for each operation.

## How It Works

SLV uses **Ansible playbooks** and **Jinja2 templates** under the hood:

```
Your request → AI Agent → Ansible playbooks → Target server
```

**Design principles:**
- **Remote administration** — run Ansible over SSH from your management machine; local deployment is also available
- **Dummy key start** — validators start with unstaked identity, then hot-switch
- **Source builds** — Solana binaries built from GitHub source
- **Firewall-first** — SSH restrictions and nftables from day one

## Using AI Agent Skills (Advanced)

SLV also provides standalone AI agent skills that work with **any AI coding agent** — OpenClaw, Claude Code, Codex, Cursor, Windsurf, and more.

| Skill | What It Does |
|---|---|
| **[slv-validator](dist/oss-skills/slv-validator/)** | Deploy & manage validators |
| **[slv-rpc](dist/oss-skills/slv-rpc/)** | Deploy & manage RPC nodes |
| **[slv-grpc-geyser](dist/oss-skills/slv-grpc-geyser/)** | Deploy & manage gRPC Geyser streaming |

```bash
# OpenClaw (via ClawHub)
npx clawhub install slv-validator

# Claude Code — copy skill into your project
cp -r dist/oss-skills/slv-validator /your/project/.claude/skills/

# Any agent — add SKILL.md to your agent's context
cp dist/oss-skills/slv-validator/SKILL.md /your/project/AGENTS.md
```

Each skill includes SKILL.md (AI knowledge), Ansible playbooks, setup scripts, and example inventories. No lock-in — they're plain Markdown + Ansible.

## Using Without AI (Direct Ansible)

```bash
cd dist/oss-skills/slv-validator/ansible/

# Deploy a mainnet Jito validator
ansible-playbook -i inventory.yml mainnet-validator/init.yml \
  -e '{"validator_type":"jito","jito_version":"4.3.2-jito"}'

# Restart a validator
ansible-playbook -i inventory.yml mainnet-validator/restart_node.yml

# Build Solana from source (agave_version, jito_version or allnodes_jito_version, for the validator_type of the host)
ansible-playbook -i inventory.yml cmn/build_solana.yml \
  -e '{"agave_version":"4.3.2"}'
```

## ERPC Network Benefits

Servers from [erpc.global](https://erpc.global/en/) automatically get:
- **Dedicated snapshot endpoints** — 7 global regions
- **Internal routing** — lower bandwidth costs
- **Auto-detection** — SLV finds the nearest snapshot server via ping

## Prerequisites

- **Python** >= 3.9 and **Git** for the verified release installer
- **ansible-core** >= 2.15 (`pip install ansible-core`)
- **SSH access** to remote target servers (key-based authentication, including an operator-configured SSH agent)
- **solana-cli** (optional, for local key generation)

Install the prerequisites before deployment. `slv onboard` configures the agent and account features; the verified release installer does not install system dependencies.

## For Developers

```bash
git clone https://github.com/ValidatorsDAO/slv.git
cd slv
deno task dev --help
deno test -A
```

Release binaries require the source-build and notice inputs described in [rebuilding releases](docs/rebuilding-releases.md). Normal releases are published through the reviewed GitHub release workflow. Perform the one-time legacy bootstrap migration only after immutable publication and public installation verification, using its separate workflow operation.

## Community

- [Validators DAO Discord](https://discord.gg/C7ZQSrCkYR)
- [Documentation](https://slv.dev/)
- [Twitter @slvSOLANA](https://twitter.com/slvSOLANA)

## Contributing

Bug reports and pull requests are welcome. This project follows the [Contributor Covenant](http://contributor-covenant.org) code of conduct.

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
