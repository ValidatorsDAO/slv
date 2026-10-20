# 1Password and SLV credentials

SLV reads a validator identity key from 1Password by reference in `slv v keys:check`
and `slv v keys:try`, and puts one there with `slv v keys:gen` and `slv v keys:import`.
The legacy identity activation and migration commands and BLS registration refuse
bootstrap or 1Password-backed entries; deployment does not
read a reference. This guide describes those commands, external 1Password tooling and
the credential paths the current SLV implementation actually uses. It does not make SLV
fully diskless.

## Validator init: verified vault storage and sync-only startup

Run `slv v init` in your own local terminal. Standard setup asks for the network
and server, detects an existing SSH public-key selector, and uses Agave on
testnet or Jito on mainnet. It checks inventory integrity and 1Password access
before contacting the server. If no account is available, enable the desktop
app's CLI integration and retry; SLV does not start manual account registration.
On macOS 27, the terminal may also need permission to access data shared by
1Password in System Settings > Privacy & Security > Files & Folders.

SLV inspects the outbound interface, driver, kernel and physical CPU topology
without changing the server. Standard setup recommends XDP copy mode for a
supported physical interface and keeps PoH on a separate physical core. Unknown,
virtual, bonded or bridged paths use standard networking. This is a conservative
configuration recommendation, not a live XDP compatibility/performance test.
Zero-copy and kernel/reboot tuning require `--advanced`. Review the setup summary
before the identity and server user are created. Choose a vault by its displayed
number; the configured network vault is reused on later runs.

Use `--advanced` to choose another client/name, reuse an existing 1Password item,
or customize XDP and optional tuning. Connection flags can avoid repeated input:

```sh
slv v init -n testnet --host 192.0.2.10 --user ubuntu \
  --identity-file /absolute/path/to/example-node.pub --name testnet-validator
```

Init creates the identity in
memory, saves it to the network's 1Password vault, reads it back and verifies both
the key bytes and public-key field before saving the inventory. It can instead
use an existing item in that configured vault. New mainnet identities require a
human context with no configured/environment service-account tokens and explicit
vault-name confirmation; the standalone `keys:gen` command remains testnet/devnet
only. All `op` calls keep caching disabled. AI sessions, node hosts and headless
sessions cannot run secret setup.

The inventory contains public keys, the verified `identity_ref`, and
`no_voting: true`. Vote-account metadata is optional; an existing account must
match the identity on the selected network. No new vote key, vote account,
airdrop, transfer or signing transaction is created. No withdrawal authority is
invented. Duplicate inventory names are refused instead of replacing identities.
If inventory setup fails after vault verification, reuse the printed reference;
do not create another identity just to retry server setup.

Deploy starts the node's own unstaked identity with `--no-voting`. It does not
activate the identity saved in 1Password. Bootstrap startup uses the Jinja
shipped with the selected runtime templates, preserving older custom scripts.
Missing packaged templates stop setup before node changes. The default bootstrap
has no fixed shred-version pin and uses entrypoint discovery; explicit valid pins
are retained, and expected-genesis validation remains enabled.

`slv v restart -n testnet -p <host>` keeps the unstaked-startup guard. It prints
the restart policy and polls the exit request instead of waiting silently.
Only an explicitly non-voting testnet validator whose live process, startup
script and public identity match the unstaked key, with no vote accounts,
active stake or leader slots, can use the sync-only cluster-stake threshold.
Unknown facts and all other networks retain the normal threshold. The
installed client's health, snapshot and leader-window checks are unchanged.

The exit controller has a 600-second limit and cleans up its own child on
timeout. A lock and fresh process checks reject overlapping or stale requests.
A timeout or interruption can occur after an exit request was sent: inspect the
service and any remaining exit controller before retrying. Successful command
completion still needs confirmation of the running client and synchronization.

This completes storage and synchronization setup, not production voting. Legacy
`set:identity`, `switch` (before source demotion) and BLS signing refuse bootstrap
or 1Password-backed entries. Do not clear `no_voting` or export a key to bypass
that boundary. RPC init and legacy inventories without these fields retain their
existing workflows. Existing plaintext keys are not deleted automatically.

## What works today

| Credential or operation | Current behavior |
| --- | --- |
| SSH access to management targets | OpenSSH can use the 1Password SSH agent. Configure and verify that client connection before using SLV/Ansible. |
| Human access through 1Password CLI | Authenticate `op` with the 1Password desktop app in your own terminal. The `keys:` commands run `op` themselves, as described [below](#keep-a-validator-key-in-1password). |
| Validator keys held in 1Password | `slv v keys:gen`, `keys:import`, `keys:check` and `keys:try`, by reference: `op://<vault id>/<item id>/keypair`. |
| Validator `identity_ref` | The reference to the key of a host: `op://<vault id>/<item id>/keypair` or `file://<absolute path>`. `keys:import` writes it, and `keys:check -p <host>` reads the key it names (a host without one is read from `~/.slv/keys/<identity_account>.json`). Legacy activation, switching and BLS registration refuse 1Password references; they do not resolve them. |
| SSH host keys | `slv v hosts:pin` pins the `ssh-ed25519` key of a node in `~/.slv/known_hosts` after you confirm its fingerprint. |
| Supported Agave-family validator activation and switching | Reads `~/.slv/keys/<identity_account>.json` on the management machine and sends key material through stdin. |
| New validator deployment | Starts with an unstaked identity without copying the staked key. Existing node-side copies are not removed. |
| RPC identity | Deployment still copies a keypair file to the node. |
| ERPC login | `slv login` stores access/refresh tokens in `~/.slv/api.yml` with mode `0600`; RPC API keys may also be stored there. |
| Environment injection with `op run` | Useful for a program that explicitly reads those variables. It does not resolve SLV's `identity_ref`, replace its key-file reads or reach the `op` that the `keys:` commands start, which gets an environment of its own. |

Validator startup without a staked key on the node is distinct from keeping all
credentials off the management machine. BLS registration and vote-account
operations also use local key files. See the [validator key documentation](../oss-skills/slv-validator/SKILL.md#keys)
for client-specific restrictions, including Firedancer activation refusals.

## Keep a validator key in 1Password

Four commands hold a validator identity key in 1Password and read it by reference. A
reference names a field of a 1Password item by the ids of the vault and of the item, never
by names: `op://<vault id>/<item id>/keypair`. An existing local key can instead use
`file://<absolute path>`. A name in place of an id, a section, a query,
a relative path and schemes other than `op://` and `file://` are refused. The commands read a
key as bytes, check that it is a whole keypair whose seed gives the public key stored in it,
wipe every buffer
that held it, and print public keys only.

`~/.slv/keyless.yml` on the management machine names the vault of each network and, for
testnet and devnet, an optional service account token file (an absolute path to a regular
file with mode `0600`, owned by the user who runs slv):

```yaml
networks:
  testnet:
    vault_id: <26 lower-case letters and digits>
    service_account_token_file: /absolute/path/of/a/file/with/mode/0600
  mainnet:
    vault_id: <the id of another vault>
ssh:
  identity_agent: /absolute/path/of/an/ssh/agent/socket   # optional
```

The vault of mainnet is a vault of its own. A reference in another vault than the one of the
network is refused before anything is asked.

| Command | What it does |
| --- | --- |
| `slv v keys:gen -n testnet --title <text>` | Makes a throwaway Ed25519 identity in memory, saves it as an item with `op item create`, reads it back through the same reader, compares the bytes, and prints its public key and reference. |
| `slv v keys:import -n <network> -p <host> [--file <key file>]` | Puts the key file of a validator (default `~/.slv/keys/<identity_account>.json`) into 1Password and sets `identity_ref` on every inventory entry with that `identity_account`. It checks the file against the entry, shows the vault by its name and id and asks for the name before it makes an item, reads the item back and compares the bytes. It does not overwrite an `identity_ref` and does not remove the key file. |
| `slv v keys:check -n <network> -p <host>`, or `--ref <ref> --pubkey <expected>` | Reads the key, shows that it is a whole keypair and prints its public key; it fails when the key is not the expected one. With `-p` it holds the key against the inventory entry and the vote account on chain, after the name of the host is typed. It touches no node. |
| `slv v keys:try -n testnet -p <host> --ref <ref>` | Checks that a testnet node runs its unstaked identity and that the public key is in no gossip table, vote account or inventory account. After the name of the host is typed it sends the key on standard input to `set-identity`, reads `contact-info`, and always sets the node back on its unstaked identity and reads it again. |

A key is read only by a person at a terminal, on a machine that is not a node. The commands
refuse when there is no terminal, when `SLV_EXECUTION_CONTEXT` is `ai-console`, when
`/etc/slv/no-op-resolution` exists, and on a machine that has `/home/solv/unstaked-identity.json`
or the unit file of `solv` or `firedancer`. Without a service account they also refuse in a
shell reached over SSH and when `OP_BIOMETRIC_UNLOCK_ENABLED` is `false`, because 1Password then
has to ask a person at the app. Mainnet is refused while a service account token is configured
in `keyless.yml` or present in the environment.

slv starts `op` from an absolute directory of `PATH`, without a shell and with no standard
input (`op item create` gets the item template on it). Its environment is `HOME`, `PATH`,
`USER`, `LANG`, `TMPDIR` and `OP_ACCOUNT` of the process, the service account token of
`keyless.yml` where there is one, and `OP_CACHE=false`, so that a key that was read is not left
in the cache of `op`. Human calls explicitly use desktop-app integration; other `OP_*` variables of the process are not passed on. What `op` writes to
standard error is cut to one line, without the token, control characters or anything that looks
like part of a key, and `op item create` runs with its output discarded.

`slv v hosts:pin -n <network> -p <host>` trusts the SSH key of a node: it shows the SHA256
fingerprint and, after you type `yes`, pins the `ssh-ed25519` key in `~/.slv/known_hosts` under
`[address]:port`. The key comes from your `~/.ssh/known_hosts` or from `ssh-keyscan`; a key that
`~/.ssh/known_hosts` revokes is not pinned, and a pin that is there is left as it is. `keys:try`
connects only to a node that is pinned, with strict host key checking.

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

At SLV's SSH identity file prompt, enter the absolute `.pub` selector path that
succeeded above. The public file must exist before initialization; no local SSH
private key is required for this agent flow. SLV passes the path to OpenSSH with
`-i` and retains the compatible inventory field `ansible_ssh_private_key_file`.
User setup authorizes that `.pub` file directly for `solv`; a private-key path
still uses its adjacent `.pub` file. SLV does not select a key from the agent for
you. Check existing inventory overrides and your Ansible SSH transport before
deployment.

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
operator's environment and bypass those tool restrictions. A command that `run_command` runs
carries `SLV_EXECUTION_CONTEXT=ai-console`, so the `keys:` commands refuse to run in it.
The console gate refuses SLV's `keys:` and `hosts:` commands outright, whoever confirms.
It also refuses a line that clears `SLV_EXECUTION_CONTEXT` or
`OP_BIOMETRIC_UNLOCK_ENABLED`, or runs `env` with an empty environment or `exec -c`.

Do not put secret values in shell arguments, print them with `op read` for an AI
to inspect, or paste them into inventories, logs, or public examples. SLV's
existing key and backup protections remain relevant when using 1Password.

## Implementation references

- [Validator inventory schema](../cmn/zod/config.ts): `identity_ref` accepts a string.
- [Reference parser](../cli/lib/secret/identityRef.ts), [key reader](../cli/lib/secret/resolveIdentity.ts) and [`op` launcher](../cli/lib/secret/opCli.ts): how a reference is read and how `op` is run.
- [`keys:` and `hosts:pin` commands](../cli/src/validator/keys/register.ts) and [`keyless.yml` policy](../cli/lib/secret/vaultPolicy.ts): what the commands do and where keys may be read.
- [SSH setup check](../cmn/prompt/checkSSHConnection.ts) and [Ansible launcher](../cli/lib/runAnsible.ts): external SSH client use.
- [Identity activation playbook](../template/latest/ansible/mainnet-validator/set_identity_key.yml): controller-file reads and stdin delivery.
- [BLS registration](../cli/src/validator/registerBlsPubkey.ts): local identity keypair path.
- [Credential locations](../cli/lib/keyLocations.ts) and [AI tool environment](../cli/src/ai/console/toolSafety.ts): current protection boundaries.
