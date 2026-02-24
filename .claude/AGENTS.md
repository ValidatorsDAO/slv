# AGENTS.md — SLV Repository (OSS)

## ⚠️ THIS IS AN OPEN-SOURCE REPOSITORY

**Every file, commit, PR, and comment is publicly visible.**
Treat every character you write as if it will be read by the entire world — because it will be.

## Security Rules (MANDATORY — NO EXCEPTIONS)

### 🚫 NEVER include in any file, commit message, PR, or comment:
- API keys, tokens, secrets, passwords, or credentials
- Internal or private API endpoints
- Internal hostnames, IPs of private infrastructure
- Authentication headers (e.g., `Authorization: Bearer ...`)
- Private environment variable values
- Internal database URLs or connection strings
- References to internal tools, dashboards, or monitoring systems
- Customer data, user IDs, or personally identifiable information

### ✅ Safe to include:
- Publicly documented API endpoints
- Public documentation URLs (erpc.global, docs, GitHub)
- Generic placeholder values (e.g., `YOUR_TOKEN_HERE`, `<server-ip>`)
- Ansible playbook usage with generic examples
- Architecture descriptions without internal implementation details

### External Communication & Token Handling
- **HTTP requests in code**: Any `fetch()`, `curl`, or HTTP call MUST use only public endpoints
- **Tokens in code**: Use placeholder constants, never real credentials
- **Environment variables**: Reference by name only (`$SOLANA_RPC_URL`), never embed actual values
- **Webhook URLs, callback URLs**: Never hardcode internal URLs
- **When adding new HTTP calls**: Verify the target is a public endpoint before committing

### Pre-Commit Security Checklist
1. `grep -r 'Bearer ' --include='*.ts' --include='*.yml'` — leaked tokens?
2. `grep -r 'erpc.global' --include='*.ts' --include='*.yml'` — verify only publicly documented endpoints
3. Review any new HTTP calls — ensure they target only public endpoints
4. If any check fails → **STOP. Remove the reference before committing.**

## Repository Structure

SLV is an open-source toolkit for Solana validator and RPC node deployment/management.

```
cli/                          — Deno CLI (`slv` command)
template/{version}/ansible/   — Ansible deployment playbooks
template/{version}/jinja/     — Jinja2 configuration templates
dist/oss-skills/              — AI agent skill packages
```

## Skill Packages (`dist/oss-skills/`)

Self-contained packages for AI agents:
- `SKILL.md` — Playbook knowledge + interactive deployment flow
- `AGENT.md` — Agent persona and behavior
- `ansible/` — Playbooks with resolved dependencies
- `jinja/` — Configuration templates
- `examples/` — Sample inventory files

Compatible with: OpenClaw, Codex, Claude Code, and other AI coding agents.
