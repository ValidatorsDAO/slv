# slv-backup skill

Non-interactive command patterns for `slv backup` and `slv storage`.

Unlike other skills in this repo, `slv-backup` is **not** bound to a
sub-agent (Cecil, Tina, Setzer, etc.). It is loaded directly into the
main SLV assistant's system prompt so that any agent delegating a
backup or storage task — and the main agent itself — always knows
which flags must be passed to avoid TTY prompts.

The AI console is non-interactive: any command that falls back to
`Input` / `Select` / `Confirm` will hang indefinitely from the agent's
point of view. Every command listed in `SKILL.md` has been verified to
run end-to-end without prompts when the documented flags are passed.

See `SKILL.md` for the full reference.
