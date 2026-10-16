#!/usr/bin/env python3
"""Render tests for the Alpenglow changes in the validator start scripts and the
Firedancer configs. Nothing touches a host or the network.

    python3 -m unittest discover -s template/2026.6.6.2026/tests -p 'test_alpenglow_start_scripts.py' -v

Needs ansible-playbook on PATH. Every case is rendered once through Ansible's
template engine (lookup('template')), the way the playbooks render the scripts, and
the output is read back:

  - the known validators of the mainnet validator script and of both mainnet
    Firedancer configs are the four of Anza; the testnet validator scripts hold the
    five of testnet, and the generic one also pins the genesis hash and says
    --only-known-rpc like its siblings
  - votor_peer_overrides renders --votor-peer-overrides once per identity from
    agave 4.3.0, with the version the XDP flags use, and stops the render for the
    node's own identity_account and for anything that is not a base58 public key
  - nothing passes --tpu-connection-pool-size, which agave 4.3 removed
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.dirname(HERE)
JINJA = os.path.join(TEMPLATE, "jinja")

MAINNET_KNOWN = [
    "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2",
    "GdnSyH3YtwcxFvQrVVJMm1JhTS4QVX7MFsX56uJLUfiZ",
    "DE1bawNcRJB9rVm3buyMVfr8mBEoyyu73NBovf2oXJsJ",
    "CakcnaRDHka2gXyfbEd2d3xsvkJkqsLw2akB3zsN1D2S",
]
TESTNET_KNOWN = [
    "5D1fNXzvv5NjV1ysLjirC4WY92RNsVH18vjmcszZd8on",
    "dDzy5SR3AXdYWVqbDEkVFdvSPCtS9ihF5kJkHCtXoFs",
    "Ft5fbkqNa76vnsjYNwjDZUXoTWpP7VYm3mtsaQckQADN",
    "eoKpUABi59aT4rR9HGS3LcMecfut9x7zJyodWWP43YQ",
    "9QxCLckBiJc783jnMvXZubK4wH86Eqqvashtrwvcsgkv",
]
TESTNET_GENESIS = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"

OWN = "EjDwu2Czy8eWEYRuNwtjniYks47Du3KNJ6JY9rs3aFSV"
PEER_A = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2"
PEER_B = "GdnSyH3YtwcxFvQrVVJMm1JhTS4QVX7MFsX56uJLUfiZ"
PEERS = [PEER_A, PEER_B, PEER_A]  # a repeated identity is rendered once

# name -> (template, versions.yml section, clients)
VALIDATORS = {
    "mainnet": ("mainnet-validator/start-validator.sh.j2", "mainnet_validators", ["agave", "jito", "allnodes-jito"]),
    "testnet": ("testnet-validator/start-validator.sh.j2", "testnet_validators", ["agave", "jito", "allnodes-jito"]),
    "testnet-agave": ("testnet-validator/start-validator-agave.sh.j2", "testnet_validators", ["agave"]),
    "testnet-jito": ("testnet-validator/start-validator-jito.sh.j2", "testnet_validators", ["jito"]),
}
RPCS = {
    "mainnet-rpc": ("mainnet-rpc/start-validator.sh.j2", "mainnet_rpcs"),
    "testnet-rpc": ("testnet-rpc/start-validator.sh.j2", "testnet_rpcs"),
    "devnet-rpc": ("devnet-rpc/start-validator.sh.j2", "devnet_rpcs"),
}
SERIES = ["3.1.10", "4.2.2", "4.3.0", "4.3.2", "4.4.0-beta.1"]
VERSION_KEY = {"agave": "version_agave", "jito": "version_jito", "allnodes-jito": "version_allnodes_jito"}
SUFFIX = {"agave": "", "jito": "-jito", "allnodes-jito": "-allnodes"}

# votor_peer_overrides that must stop the render: id -> (list as JSON or None for absent, identity_account, message)
BAD_LISTS = {
    "own-first": ([OWN, PEER_A], OWN, "own identity_account"),
    "own-last": ([PEER_A, OWN], OWN, "own identity_account"),
    "word": (["not-a-key"], OWN, "not a base58 public key"),
    "base58-alphabet": (["0OIl" * 10], OWN, "not a base58 public key"),
    "too-short": ([PEER_A[:31]], OWN, "not a base58 public key"),
    "too-long": ([PEER_A + "x"], OWN, "not a base58 public key"),
    "empty-entry": ([PEER_A, ""], OWN, "not a base58 public key"),
    "number": ([42], OWN, "not a base58 public key"),
    "nested-list": ([[PEER_A]], OWN, "not a base58 public key"),
    "one-string": (PEER_A, OWN, "must be a list"),
    "mapping": ({"identity": PEER_A}, OWN, "must be a list"),
    "no-identity-account": ([PEER_A], None, "identity_account is not set"),
}

_outputs = {}
_errors = {}
_work = None


def numeric(version):
    major, minor, patch = (re.findall(r"[0-9]+", version.split("-")[0]) + ["0", "0"])[:3]
    return int(major) * 1000000 + int(minor) * 1000 + int(patch)


def case(case_id, template, variables):
    return {"id": case_id, "src": os.path.join(JINJA, template), "vars": variables}


def validator_vars(client, section, version, **extra):
    variables = {
        "vote_account": "VOTE",
        "validator_type": client,
        "identity_account": OWN,
        section: {VERSION_KEY[client]: version},
    }
    variables.update(extra)
    return variables


def versions_of(client):
    return [v + SUFFIX[client] for v in SERIES]


def build_cases():
    cases = []
    for name, (template, section, clients) in VALIDATORS.items():
        for client in clients:
            for version in versions_of(client):
                base = validator_vars(client, section, version)
                cases.append(case(f"base__{name}__{client}__{version}", template, base))
                cases.append(case(f"peers__{name}__{client}__{version}", template, dict(base, votor_peer_overrides=PEERS)))
        # an empty list in any spelling renders nothing
        client = clients[0]
        version = "4.3.2" + SUFFIX[client]
        for label, value in (("null", None), ("empty-list", []), ("empty-string", "")):
            cases.append(case(f"empty-{label}__{name}", template, validator_vars(client, section, version, votor_peer_overrides=value)))
        # invalid lists stop the render, whatever the version
        for bad_id, (value, identity, _) in BAD_LISTS.items():
            for version in ("4.3.2", "3.1.10"):
                variables = validator_vars(client, section, version + SUFFIX[client], votor_peer_overrides=value)
                if identity is None:
                    del variables["identity_account"]
                cases.append(case(f"bad__{name}__{bad_id}__{version}", template, variables))

    # the version the flag follows is the one the XDP flags follow
    template, section, _ = VALIDATORS["mainnet"]
    sources = {
        "installed-old-configured-new": validator_vars("agave", section, "4.3.2", votor_peer_overrides=PEERS, installed_agave_version="4.2.2"),
        "installed-new-configured-old": validator_vars("agave", section, "3.1.10", votor_peer_overrides=PEERS, installed_agave_version="4.3.2"),
        "installed-empty-configured-new": validator_vars("agave", section, "4.3.2", votor_peer_overrides=PEERS, installed_agave_version=""),
        "override-new": validator_vars("agave", section, "3.1.10", votor_peer_overrides=PEERS, agave_version="4.3.2"),
        "override-old": validator_vars("agave", section, "4.3.2", votor_peer_overrides=PEERS, agave_version="3.1.10"),
        "jito-override-new": validator_vars("jito", section, "3.1.10-jito", votor_peer_overrides=PEERS, jito_version="4.3.1-jito"),
        "allnodes-override-old": validator_vars("allnodes-jito", section, "4.3.2-allnodes", votor_peer_overrides=PEERS, allnodes_jito_version="4.2.2-allnodes"),
    }
    for label, variables in sources.items():
        cases.append(case(f"source__{label}", template, variables))

    # RPC scripts have no such flag
    for name, (template, section) in RPCS.items():
        variables = {
            "vote_account": "VOTE",
            "validator_type": "agave",
            "rpc_type": "Geyser gRPC",
            "identity_account": OWN,
            section: {"version_agave": "4.3.2"},
            "votor_peer_overrides": PEERS,
        }
        cases.append(case(f"rpc__{name}", template, variables))

    # the start scripts that no playbook renders
    for script in sorted(os.listdir(os.path.join(JINJA, "mainnet-rpc"))):
        if script.startswith("start-mainnet-rpc"):
            variables = {"port_rpc": 8899, "shredstream_address": "127.0.0.1:1002", "limit_ledger_size": 100000000}
            cases.append(case(f"rpc-script__{script}", f"mainnet-rpc/{script}", variables))
    return cases


def render(cases):
    """Render every case with ansible-playbook; fill _outputs and _errors.

    A case that is meant to stop the render is rendered in a play of its own, so the
    failure of one never ends the others (ansible-core 2.16 ends a whole loop when a
    lookup raises inside it).
    """
    global _work
    _work = tempfile.mkdtemp(prefix="slv-alpenglow-scripts.", dir="/tmp")
    out = os.path.join(_work, "out")
    os.makedirs(out)
    tmp = os.path.join(_work, "tmp")
    os.makedirs(tmp)
    with open(os.path.join(_work, "cases.json"), "w", encoding="utf-8") as handle:
        json.dump({"fast": [c for c in cases if not c["id"].startswith("bad__")], "slow": [c for c in cases if c["id"].startswith("bad__")]}, handle)
    with open(os.path.join(_work, "one.yml"), "w", encoding="utf-8") as handle:
        handle.write(
            f"""---
- name: Render one case
  ansible.builtin.copy:
    dest: "{out}/{{{{ case.id }}}}.out"
    content: "{{{{ lookup('ansible.builtin.template', case.src, template_vars=case.vars) }}}}"
  register: attempt
  ignore_errors: true

- name: Keep why it did not render
  ansible.builtin.copy:
    dest: "{out}/{{{{ case.id }}}}.err"
    content: "{{{{ attempt.msg | default('failed') }}}}"
  when: attempt is failed
"""
        )
    with open(os.path.join(_work, "render.yml"), "w", encoding="utf-8") as handle:
        handle.write(
            f"""---
- hosts: localhost
  gather_facts: false
  connection: local
  vars:
    ansible_python_interpreter: auto_silent
    cases: "{{{{ lookup('ansible.builtin.file', '{_work}/cases.json') | from_json }}}}"
  tasks:
    - name: Render the cases that are meant to render
      ansible.builtin.copy:
        dest: "{out}/{{{{ item.id }}}}.out"
        content: "{{{{ lookup('ansible.builtin.template', item.src, template_vars=item.vars) }}}}"
      loop: "{{{{ cases.fast }}}}"
      loop_control:
        label: "{{{{ item.id }}}}"

    - name: Render the cases that are meant to stop
      ansible.builtin.include_tasks: one.yml
      loop: "{{{{ cases.slow }}}}"
      loop_control:
        loop_var: case
        label: "{{{{ case.id }}}}"
"""
        )
    env = dict(
        os.environ,
        ANSIBLE_HOME=os.path.join(_work, "home"),
        TMPDIR=tmp,
        ANSIBLE_NOCOLOR="1",
        ANSIBLE_LOCALHOST_WARNING="False",
        ANSIBLE_INVENTORY_UNPARSED_WARNING="False",
    )
    run = subprocess.run(
        ["ansible-playbook", "-i", "localhost,", os.path.join(_work, "render.yml")],
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        check=False,
    )
    if run.returncode != 0:
        raise RuntimeError("ansible-playbook failed:\n" + run.stdout[-3000:] + run.stderr[-3000:])
    for name in os.listdir(out):
        with open(os.path.join(out, name), encoding="utf-8") as handle:
            if name.endswith(".out"):
                _outputs[name[: -len(".out")]] = handle.read()
            else:
                _errors[name[: -len(".err")]] = handle.read()


def setUpModule():
    if shutil.which("ansible-playbook") is None:
        raise RuntimeError("ansible-playbook is required on PATH")
    try:
        render(build_cases())
    except BaseException:
        tearDownModule()  # unittest does not call it when setUpModule fails
        raise


def tearDownModule():
    if _work:
        shutil.rmtree(_work, ignore_errors=True)


def continuation_problems(text):
    """Every line but the last of the command ends in a backslash, so it stays one command."""
    lines = [line for line in text.splitlines() if line.strip() and not line.startswith("#!")]
    return ["%d: %s" % (i, line) for i, line in enumerate(lines[:-1]) if not line.endswith("\\")]


def bash_syntax(text):
    run = subprocess.run(["bash", "-n"], input=text, capture_output=True, text=True, check=False)
    return run.stderr


def flags(text, flag):
    return re.findall(r"^%s (\S+) \\$" % re.escape(flag), text, re.M)


def toml_known_validators(path):
    with open(path, encoding="utf-8") as handle:
        match = re.search(r"known_validators = \[\n(.*?)\n\s*\]", handle.read(), re.S)
    assert match, path + " has no known_validators"
    return re.findall(r'"([^"]+)"', match.group(1))


class KnownValidators(unittest.TestCase):
    def test_mainnet_validator_script_names_the_four_validators_of_anza(self):
        for client in VALIDATORS["mainnet"][2]:
            version = "4.3.2" + SUFFIX[client]
            text = _outputs[f"base__mainnet__{client}__{version}"]
            with self.subTest(client=client):
                self.assertEqual(flags(text, "--known-validator"), MAINNET_KNOWN)
                self.assertNotIn("Certusm1sa411sMpV9FPqU5dXAYhmmhygvxJ23S6hJ24", text)

    def test_mainnet_firedancer_configs_name_the_four_validators_of_anza(self):
        for path in ("mainnet-validator/firedancer-config.toml.j2", "mainnet-rpc/firedancer-config.toml.j2"):
            with self.subTest(path=path):
                self.assertEqual(toml_known_validators(os.path.join(JINJA, path)), MAINNET_KNOWN)

    def test_testnet_validator_scripts_name_the_five_validators_of_testnet(self):
        for name in ("testnet", "testnet-agave", "testnet-jito"):
            client = VALIDATORS[name][2][0]
            text = _outputs[f"base__{name}__{client}__4.3.2{SUFFIX[client]}"]
            with self.subTest(script=name):
                self.assertEqual(flags(text, "--known-validator"), TESTNET_KNOWN)

    def test_every_testnet_validator_script_pins_the_genesis_hash_and_the_known_rpc(self):
        for name in ("testnet", "testnet-agave", "testnet-jito"):
            for client in VALIDATORS[name][2]:
                text = _outputs[f"base__{name}__{client}__4.4.0-beta.1{SUFFIX[client]}"]
                with self.subTest(script=name, client=client):
                    self.assertEqual(flags(text, "--expected-genesis-hash"), [TESTNET_GENESIS])
                    self.assertEqual(len(re.findall(r"^--only-known-rpc \\$", text, re.M)), 1)


class VotorPeerOverrides(unittest.TestCase):
    def test_nothing_is_rendered_without_a_list(self):
        for name, (_, _, clients) in VALIDATORS.items():
            for client in clients:
                for version in versions_of(client):
                    text = _outputs[f"base__{name}__{client}__{version}"]
                    with self.subTest(script=name, client=client, version=version):
                        self.assertNotIn("votor", text)

    def test_an_empty_list_renders_nothing_in_every_spelling(self):
        for name in VALIDATORS:
            client = VALIDATORS[name][2][0]
            base = _outputs[f"base__{name}__{client}__4.3.2{SUFFIX[client]}"]
            for label in ("null", "empty-list", "empty-string"):
                with self.subTest(script=name, empty=label):
                    self.assertEqual(_outputs[f"empty-{label}__{name}"], base)

    def test_one_flag_per_identity_from_agave_4_3_0(self):
        for name, (_, _, clients) in VALIDATORS.items():
            for client in clients:
                for version in versions_of(client):
                    text = _outputs[f"peers__{name}__{client}__{version}"]
                    expected = [PEER_A, PEER_B] if numeric(version) >= 4003000 else []
                    with self.subTest(script=name, client=client, version=version):
                        self.assertEqual(flags(text, "--votor-peer-overrides"), expected)
                        self.assertEqual(text.count("votor-peer-overrides"), len(expected))

    def test_the_flag_changes_nothing_else_and_leaves_a_script_bash_accepts(self):
        for name, (_, _, clients) in VALIDATORS.items():
            for client in clients:
                for version in versions_of(client):
                    base = _outputs[f"base__{name}__{client}__{version}"]
                    text = _outputs[f"peers__{name}__{client}__{version}"]
                    rest = "".join(l + "\n" for l in text.splitlines() if not l.startswith("--votor-peer-overrides "))
                    with self.subTest(script=name, client=client, version=version):
                        self.assertEqual(rest.rstrip("\n"), base.rstrip("\n"))
                        self.assertEqual(continuation_problems(text), [])
                        self.assertEqual(bash_syntax(text), "")

    def test_the_version_is_the_one_the_xdp_flags_follow(self):
        expected = {
            "installed-old-configured-new": False,
            "installed-new-configured-old": True,
            "installed-empty-configured-new": True,
            "override-new": True,
            "override-old": False,
            "jito-override-new": True,
            "allnodes-override-old": False,
        }
        for label, flag in expected.items():
            with self.subTest(source=label):
                self.assertEqual(flags(_outputs[f"source__{label}"], "--votor-peer-overrides"), [PEER_A, PEER_B] if flag else [])

    def test_an_invalid_list_stops_the_render(self):
        for name in VALIDATORS:
            for bad_id, (_, _, message) in BAD_LISTS.items():
                for version in ("4.3.2", "3.1.10"):
                    key = f"bad__{name}__{bad_id}__{version}"
                    with self.subTest(script=name, case=bad_id, version=version):
                        self.assertNotIn(key, _outputs, "a script was rendered from an invalid list")
                        self.assertIn(message, _errors.get(key, ""))

    def test_rpc_scripts_do_not_take_the_flag(self):
        for name in RPCS:
            with self.subTest(script=name):
                self.assertIn(f"rpc__{name}", _outputs)
                self.assertNotIn("votor", _outputs[f"rpc__{name}"])


class RemovedFlag(unittest.TestCase):
    def test_no_template_passes_tpu_connection_pool_size(self):
        found = []
        for sub in ("jinja", "ansible"):
            for directory, _, names in os.walk(os.path.join(TEMPLATE, sub)):
                for name in names:
                    path = os.path.join(directory, name)
                    with open(path, encoding="utf-8", errors="replace") as handle:
                        if "tpu-connection-pool-size" in handle.read():
                            found.append(os.path.relpath(path, TEMPLATE))
        self.assertEqual(found, [])

    def test_the_start_scripts_no_playbook_renders_are_still_one_command(self):
        scripts = [k for k in _outputs if k.startswith("rpc-script__")]
        self.assertGreaterEqual(len(scripts), 4)
        for key in scripts:
            with self.subTest(script=key):
                self.assertEqual(continuation_problems(_outputs[key]), [])
                self.assertEqual(bash_syntax(_outputs[key]), "")


if __name__ == "__main__":
    unittest.main()
