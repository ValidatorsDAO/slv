# 1Password and SLV credentials

SLV currently has no native 1Password credential provider or `op://` resolver.
This guide describes external 1Password tooling and the credential paths the
current SLV implementation actually uses. It does not make SLV fully diskless.

## What works today

| Credential or operation | Current behavior |
| --- | --- |
| SSH access to management targets | OpenSSH can use the 1Password SSH agent. Configure and verify that client connection before using SLV/Ansible. |
| Human access through 1Password CLI | Authenticate `op` with the 1Password desktop app in your own terminal. This does not add a provider to SLV. |
| Validator `identity_ref` | Optional reference metadata only. SLV does not fetch the referenced value. |
| Supported Agave-family validator activation and switching | Reads `~/.slv/keys/<identity_account>.json` on the management machine and sends key material through stdin. |
| New validator deployment | Starts with an unstaked identity without copying the staked key. Existing node-side copies are not removed. |
| RPC identity | Deployment still copies a keypair file to the node. |
| ERPC login | `slv login` stores access/refresh tokens in `~/.slv/api.yml` with mode `0600`; RPC API keys may also be stored there. |
| Environment injection with `op run` | Useful for a program that explicitly reads those variables. It does not resolve SLV's `identity_ref` or replace its key-file reads. |

Validator startup without a staked key on the node is distinct from keeping all
credentials off the management machine. BLS registration and vote-account
operations also use local key files. See the [validator key documentation](../oss-skills/slv-validator/SKILL.md#keys)
for client-specific restrictions, including Firedancer activation refusals.

## Set up human-account CLI access

Use your human account in the 1Password desktop app on the management machine.
Follow the official [CLI installation guide](https://www.1password.dev/cli/get-started)
and [desktop-app integration guide](https://www.1password.dev/cli/app-integration).
Enable the CLI integration in the app's developer settings, then authenticate
when the app requests it. This interactive setup does not require deploying
Connect or provisioning a service account.

These checks do not print secret fields; the second also suppresses vault names
and identifiers:

```sh
op --version
op vault list >/dev/null
```

For multiple accounts, select the intended account using the official app
integration instructions. Keep account identifiers and secret references out of
public issues and examples. Run authentication in your own terminal; never send
an account password, session token, or secret value to an AI conversation.

## Use the SSH agent without exporting an SSH private key

Enable the [1Password SSH agent](https://www.1password.dev/ssh/get-started)
and allow the SSH key you intend to use. Save only that key's **public** part as a
`.pub` selector on the management machine. 1Password documents
[public-key export](https://www.1password.dev/ssh/manage-keys#share-a-public-key)
and [OpenSSH agent configuration](https://www.1password.dev/ssh/agent/compatibility).
Ensure the matching public key is authorized for the selected remote user
before testing the connection.

Configure the host entry in `~/.ssh/config`. Replace the documentation address
and both placeholder paths with your own values; obtain the agent socket path
from 1Password's instructions for your operating system:

```sshconfig
Host 192.0.2.10
  User ubuntu
  IdentityAgent "/absolute/path/to/1password-agent.sock"
  IdentityFile /absolute/path/to/example-node.pub
  IdentitiesOnly yes
  ForwardAgent no
```

Match `Host` to the actual hostname or IP used in the SLV inventory. An SSH alias
that does not match that destination will not select this configuration. Verify
the connection in your terminal, approving the key use in 1Password:

```sh
ssh -i /absolute/path/to/example-node.pub ubuntu@192.0.2.10 true
```

SLV's setup prompt currently calls the input an RSA key path. Its OpenSSH check
passes that path with `-i`, and generated inventories store it as
`ansible_ssh_private_key_file`. For this externally configured agent flow, use the
absolute public-key selector path that succeeded above. Check existing inventory
overrides and your Ansible SSH transport before deployment. This is a configuration
route based on OpenSSH support, not a native SLV provider or a claim of tested
1Password authentication against every target.

The agent handles SSH authentication only. It does not supply Solana validator
identity keys, remove ERPC token files, or remove older private-key copies. The
public selector and SSH configuration still exist on disk.

## Understand `op run` and the AI Console boundary

1Password's [`op run` documentation](https://www.1password.dev/cli/secrets-environment-variables)
explains how secret references become environment values for a child process.
That avoids putting resolved values in an environment file, but the receiving
program must support those variables and can still persist or disclose them.
Processes running as the same user may also be able to inspect the environment.
Wrapping `slv` in `op run` does not change SLV's current local storage model.

The AI Console's `run_command` tool requires terminal confirmation for `op`, SSH,
Ansible, and key-management commands. Its child environment removes `OP_*` and
credential variables, sets `OP_BIOMETRIC_UNLOCK_ENABLED=false`, and passes
`SSH_AUTH_SOCK` only after a human confirms the command. Biometric CLI sign-in
therefore belongs in the operator's terminal. SSH can also discover an agent
through `IdentityAgent` in SSH configuration; removing an environment variable
is not machine-wide isolation. Direct `/` shell commands in the console use the
operator's environment and bypass those tool restrictions.

Do not put secret values in shell arguments, print them with `op read` for an AI
to inspect, or paste them into inventories, logs, or public examples. SLV's
existing key and backup protections remain relevant when using 1Password.

## Implementation references

- [Validator inventory schema](../cmn/zod/config.ts): `identity_ref` accepts a string but has no resolver.
- [SSH setup check](../cmn/prompt/checkSSHConnection.ts) and [Ansible launcher](../cli/lib/runAnsible.ts): external SSH client use.
- [Identity activation playbook](../template/latest/ansible/mainnet-validator/set_identity_key.yml): controller-file reads and stdin delivery.
- [BLS registration](../cli/src/validator/registerBlsPubkey.ts): local identity keypair path.
- [Credential locations](../cli/lib/keyLocations.ts) and [AI tool environment](../cli/src/ai/console/toolSafety.ts): current protection boundaries.
