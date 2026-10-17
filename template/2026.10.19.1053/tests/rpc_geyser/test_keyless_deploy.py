"""Tests of the keyless deploy: no staked identity key is copied to a node.

slv v deploy starts a validator on its unstaked identity. The staked key stays on the controller
(~/.slv/keys/<identity>.json) and reaches the node on stdin during slv v set:identity and slv v switch, and a node
that restarts comes back on its unstaked identity. So:

  init      ansible/<network>-validator/init.yml imports no copy_keys.yml (the files are gone), and imports
            cmn/assert_unstaked_identity.yml right after cmn/setup_unstaked_identity.yml: the start script starts the
            node with --identity /home/solv/identity.json, and the deploy stops, before the node is started, when that
            path does not resolve to /home/solv/unstaked-identity.json.
  refusal   the retired playbooks (set_identity_to_active of both networks, switch_on_firedancer_identity and
            change_identity_and_restart of testnet) are one play with one task that fails with a message that starts with
            SLV_KEYLESS_REFUSED. Nothing else runs. set_identity_to_active set the identity without the checks that
            slv v set:identity makes first (on testnet, for a Firedancer host, from a key file on the node); the other two
            took the staked key from a file on the node, which deploy never copies there.
  signer    cmn/doublezero_deposit.yml and cmn/doublezero_withdraw.yml sign with a key file on the node: they look for it
            first and stop, without calling doublezero-solana, when it is not there.
  types     testnet-validator/init.yml sets up the solv unit, deploys the start script and starts the node for
            allnodes-jito as it does for agave and jito (mainnet-validator/init.yml does), and
            testnet-validator/update_startup_config.yml renders the start script of an allnodes-jito host.
  firedancer  a Firedancer host of testnet takes the staked key from a file on the node, so testnet-validator/
            nodowntime_migrate.yml refuses a Firedancer source or target before the source is demoted, and
            testnet-validator/set_identity_key.yml refuses a Firedancer host right after the check of the validator type:
            both with SLV_KEYLESS_REFUSED, and nothing is changed. The agave, jito and allnodes-jito hosts are not affected.

The tests run the real ansible-playbook on this machine over a local connection, without become, sudo, a network or a
host, with temporary directories for HOME and for the paths of the node (/home/solv and /mnt are moved into one, and a
playbook that still names a path of the real host is not run). The commands that a playbook could call are fakes that
write down what they were asked. Like test_init_geyser_plugin.py, whose helpers they take, they need PyYAML and
ansible-playbook (the one on PATH, or the one that ANSIBLE_PLAYBOOK names). Run from the repository root:

    python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_*.py' -v
"""

import functools
import grp
import os
import pwd
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_init_geyser_plugin import ANSIBLE_DIR, make_flow_copy, make_home, read_logs, run_ansible, write_inventory  # noqa: E402

VALIDATORS = ("mainnet-validator", "testnet-validator")
AGAVE_FAMILY = ("agave", "jito", "allnodes-jito")
FIREDANCER = ("firedancer-agave", "firedancer-jito")
COPY_KEYS_TASKS = ("Copy validator key file", "Look for the local key file", "Stop if key file not found")
FAKE_COMMANDS = ("sudo", "systemctl", "agave-validator", "fdctl", "doublezero-solana", "solana-keygen")


def task_names(listing):
    return [m.group(1) for m in re.finditer(r"^      (.*?)\tTAGS: \[.*\]$", listing, re.M)]


def play_names(listing):
    return [m.group(1) for m in re.finditer(r"^  play #\d+ \(.*?\): (.*?)\tTAGS: \[.*\]$", listing, re.M)]


def real_host_paths_left(text):
    return re.search(r"(^|[^A-Za-z0-9_])/(home/solv|mnt)([^A-Za-z0-9_]|$)", text) is not None


def move_to(text, root):
    """The playbook with the paths of the node moved into root, as the shell rigs move them."""
    return text.replace("/home/solv", "%s/solv" % root).replace("/mnt", "%s/mnt" % root)


def fake_bin(root, calls):
    """Fake commands that write down their arguments: a playbook that calls one gets nothing done."""
    directory = root / "bin"
    directory.mkdir()
    for name in FAKE_COMMANDS:
        path = directory / name
        path.write_text('#!/bin/bash\necho "%s $*" >>"%s"\nexit 0\n' % (name, calls))
        path.chmod(0o755)
    return directory


def run_with_fakes(args, root, home, bin_dir):
    # no gathering of facts: the setup module calls systemctl itself, and what the playbook calls is what is under test
    env = {"PATH": "%s:%s" % (bin_dir, os.environ.get("PATH", "")), "ANSIBLE_GATHERING": "explicit"}
    return run_ansible(args, root, home, extra_env=env)


# ---------------------------------------------------------------------------
# init: no key is copied, the unstaked identity is asserted
# ---------------------------------------------------------------------------


@functools.lru_cache(maxsize=None)
def list_init(network):
    with tempfile.TemporaryDirectory(prefix="slv-keyless-list-") as tmp:
        root = Path(tmp)
        home = root / "home"
        home.mkdir()
        write_inventory(root / "inventory.json", {"node": {"validator_type": "jito"}})
        process = run_ansible(["--list-tasks", "-i", "inventory.json", ANSIBLE_DIR / network / "init.yml"], root, home)
        return process.returncode, process.stdout


class InitCopiesNoStakedKey(unittest.TestCase):
    def test_k01_init_lists_no_copy_keys_task(self):
        for network in VALIDATORS:
            with self.subTest(network=network):
                returncode, listing = list_init(network)
                self.assertEqual(returncode, 0, listing[-2000:])
                names = task_names(listing)
                self.assertTrue(names, "no task listed:\n" + listing[-2000:])
                for forbidden in COPY_KEYS_TASKS:
                    self.assertNotIn(forbidden, names, "init.yml of %s still copies the staked key" % network)
                self.assertNotIn("Copy validator and vote key pairs", play_names(listing))
                self.assertFalse((ANSIBLE_DIR / network / "copy_keys.yml").exists(), "copy_keys.yml is gone")

    def test_k02_init_asserts_the_unstaked_identity_right_after_it_is_set_up(self):
        for network in VALIDATORS:
            with self.subTest(network=network):
                plays = play_names(list_init(network)[1])
                setup = plays.index("Create and link Solana identity files")
                self.assertEqual(plays[setup + 1], "Check that the node starts with its unstaked identity", plays)


# ---------------------------------------------------------------------------
# assert_unstaked_identity: what identity.json resolves to
# ---------------------------------------------------------------------------

ASSERT_PLAYBOOK = ANSIBLE_DIR / "cmn" / "assert_unstaked_identity.yml"
STAKED_KEY = "StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA"   # the identity_account of the hosts, and what a staked key file holds
SETUP_PLAYBOOK = ANSIBLE_DIR / "cmn" / "setup_unstaked_identity.yml"
LINK_TASK = "Ensure /home/solv/identity.json is a symlink to unstaked-identity.json"
STOP_TASK = "Stop when the node would start with another identity"

# host -> (how its /home/solv is made, whether the deploy may go on)
LAYOUTS = {
    "linked": True,         # identity.json -> /home/solv/unstaked-identity.json, as setup_unstaked_identity.yml makes it
    "relative": True,       # identity.json -> unstaked-identity.json
    "home-is-a-link": True,  # /home/solv itself is a link to the directory that holds the files
    "staked": False,        # identity.json -> a staked key file
    "regular-file": False,  # identity.json is a file of its own
    "missing": False,       # no identity.json
    "unstaked-is-a-link": False,  # unstaked-identity.json links to a staked key file, and identity.json to it
    "dangling": False,      # identity.json -> a file that is not there
    "no-home": False,       # /home/solv is not there, so identity.json cannot be resolved
    "unstaked-holds-staked": False,  # identity.json -> unstaked-identity.json, which holds the staked key
    "staked-by-key": False,  # identity.json -> a staked key file, whose public key is the identity_account of the host
}


def build_layout(kind, root):
    """The files of a node of the given kind under root/<kind>; returns the directory that plays /home/solv."""
    if kind == "no-home":
        return root / kind / "missing-parent" / "solv"
    real = root / kind / "real-solv"
    real.mkdir(parents=True)
    home = real
    if kind == "home-is-a-link":
        home = root / kind / "solv"
        home.symlink_to(real)
    unstaked = real / "unstaked-identity.json"
    staked = real / "mainnet-validator-keypair.json"
    unstaked.write_text(STAKED_KEY if kind == "unstaked-holds-staked" else "[1]")
    staked.write_text(STAKED_KEY if kind == "staked-by-key" else "[2]")
    link = real / "identity.json"
    if kind in ("linked", "home-is-a-link"):
        link.symlink_to(unstaked)
    elif kind == "relative":
        link.symlink_to("unstaked-identity.json")
    elif kind in ("staked", "staked-by-key"):
        link.symlink_to(staked)
    elif kind == "unstaked-holds-staked":
        link.symlink_to(unstaked)
    elif kind == "regular-file":
        link.write_text("[3]")
    elif kind == "unstaked-is-a-link":
        unstaked.unlink()
        unstaked.symlink_to(staked)
        link.symlink_to(unstaked)
    elif kind == "dangling":
        link.symlink_to(real / "nothing")
    return home


class AssertUnstakedIdentityResolvesIdentityJson(unittest.TestCase):
    @classmethod
    @functools.lru_cache(maxsize=None)
    def run_layouts(cls):
        """The play of assert_unstaked_identity.yml, whole, on a node of every kind; /home/solv is a variable per host."""
        with tempfile.TemporaryDirectory(prefix="slv-keyless-assert-") as tmp:
            root = Path(tmp)
            home = root / "home"
            home.mkdir()
            homes = {kind: build_layout(kind, root) for kind in LAYOUTS}
            text = ASSERT_PLAYBOOK.read_text().replace("/home/solv", "{{ slv_home }}")
            playbook = root / "assert.yml"
            playbook.write_text(text)
            # solana-keygen pubkey <file> prints the first line of the file: a key file here holds its public key
            fakes = root / "fake-bin"
            fakes.mkdir()
            (fakes / "solana-keygen").write_text('#!/bin/bash\n[ "$1" = pubkey ] && head -n 1 "$2"\n')
            (fakes / "solana-keygen").chmod(0o755)
            write_inventory(root / "inventory.json", {kind: {"slv_home": str(path), "identity_account": STAKED_KEY}
                                                      for kind, path in homes.items()})
            process = run_ansible(["-i", "inventory.json", playbook, "-e", "ansible_become=false"], root, home,
                                  extra_env={"PATH": "%s:%s" % (fakes, os.environ.get("PATH", ""))})
            return process.stdout, homes

    def test_k03_the_layout_of_the_template_goes_on(self):
        """identity.json as setup_unstaked_identity.yml makes it: its own link task is run, then the assert."""
        with tempfile.TemporaryDirectory(prefix="slv-keyless-setup-") as tmp:
            root = Path(tmp)
            home = root / "home"
            home.mkdir()
            solv = root / "solv"
            solv.mkdir()
            (solv / "unstaked-identity.json").write_text("[1]")
            link_task = next(t for t in yaml.safe_load(SETUP_PLAYBOOK.read_text())[0]["tasks"] if t["name"] == LINK_TASK)
            asserts = yaml.safe_load(ASSERT_PLAYBOOK.read_text())[0]
            play = {"name": "setup and assert", "hosts": "all", "gather_facts": False, "vars": asserts["vars"],
                    "tasks": [link_task] + asserts["tasks"]}
            playbook = root / "setup-and-assert.yml"
            playbook.write_text(move_to(yaml.safe_dump([play], sort_keys=False), root))
            self.assertFalse(real_host_paths_left(playbook.read_text()))
            write_inventory(root / "inventory.json", {"node": {}})
            process = run_ansible(["-i", "inventory.json", playbook, "-e", "ansible_become=false"], root, home)
            self.assertEqual(process.returncode, 0, process.stdout[-3000:])
            self.assertEqual((solv / "identity.json").resolve(), (solv / "unstaked-identity.json").resolve())

    def test_k04_a_node_that_would_start_with_another_identity_stops_the_deploy(self):
        output, homes = self.run_layouts()
        for kind, may_go_on in LAYOUTS.items():
            with self.subTest(layout=kind):
                failed = re.search(r"^fatal: \[%s\]" % re.escape(kind), output, re.M) is not None
                self.assertEqual(failed, not may_go_on, "layout %s:\n%s" % (kind, output[-3000:]))
                if not may_go_on:
                    self.assertIn("would start with", output)
                    self.assertIn("Nothing was stopped or started", output)

    def test_k04a_an_identity_json_that_leads_to_the_staked_key_stops_the_deploy_whatever_the_path(self):
        """The public key of the file identity.json leads to (solana-keygen pubkey) must differ from the identity_account."""
        output, homes = self.run_layouts()
        for kind in ("unstaked-holds-staked", "staked-by-key"):
            with self.subTest(layout=kind):
                failed = re.search(r"^fatal: \[%s\]: FAILED! => (.*)$" % re.escape(kind), output, re.M)
                self.assertIsNotNone(failed, "layout %s:\n%s" % (kind, output[-3000:]))
                self.assertIn("leads to the key %s, which is the staked identity of the host (identity_account), so the node "
                              "would start with the staked identity" % STAKED_KEY, failed.group(1))
        # a file that is not the staked key keeps the message about the path, and the hosts of the template layout go on
        other = re.search(r"^fatal: \[staked\]: FAILED! => (.*)$", output, re.M)
        self.assertIn("so the node would start with another identity than its unstaked one", other.group(1))
        self.assertNotIn("leads to the key", other.group(1))

    def test_k05_the_stop_says_where_identity_json_leads(self):
        output, homes = self.run_layouts()
        staked = (homes["staked"] / "mainnet-validator-keypair.json").resolve()
        self.assertIn("identity.json on staked resolves to %s" % staked, output)
        self.assertIn("identity.json on no-home cannot be resolved", output)


# ---------------------------------------------------------------------------
# refusal: the retired playbooks
# ---------------------------------------------------------------------------

REFUSALS = (
    ("mainnet-validator", "set_identity_to_active"),
    ("testnet-validator", "set_identity_to_active"),
    ("testnet-validator", "switch_on_firedancer_identity"),
    ("testnet-validator", "change_identity_and_restart"),
)


def node_files(root):
    """What is on the node: the files under the directories that play /home/solv and /mnt."""
    return sorted(str(p.relative_to(root)) for top in ("solv", "mnt") for p in (root / top).rglob("*"))


@functools.lru_cache(maxsize=None)
def run_refusal(directory, name):
    with tempfile.TemporaryDirectory(prefix="slv-keyless-refusal-") as tmp:
        root = Path(tmp)
        home = root / "home"
        home.mkdir()
        (root / "solv").mkdir()
        (root / "mnt" / "ledger").mkdir(parents=True)
        calls = root / "calls.log"
        calls.write_text("")
        bin_dir = fake_bin(root, calls)
        target = root / "ansible" / directory
        target.mkdir(parents=True)
        shutil.copytree(ANSIBLE_DIR / "cmn" / "tasks", root / "ansible" / "cmn" / "tasks")
        text = move_to((ANSIBLE_DIR / directory / ("%s.yml" % name)).read_text(), root)
        if real_host_paths_left(text):
            raise AssertionError("a path of the real host is left in %s/%s.yml" % (directory, name))
        playbook = target / ("%s.yml" % name)
        playbook.write_text(text)
        write_inventory(root / "inventory.json", {"node": {
            "identity_account": "StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA", "vote_account": "VOTE", "validator_type": "firedancer-jito"}})
        before = node_files(root)
        listing = run_with_fakes(["--list-tasks", "-i", "inventory.json", playbook, "-e", "on_host=node"], root, home, bin_dir)
        process = run_with_fakes(["-i", "inventory.json", playbook, "-e", "on_host=node", "-e", "ansible_become=false",
                                  "-e", "slv_alpenglow_rpc_url=http://127.0.0.1:9", "-e", "slv_alpenglow_rpc_delay=0"],
                                 root, home, bin_dir)
        return {"listing": listing.stdout, "run": process.stdout, "rc": process.returncode,
                "calls": calls.read_text(), "created": sorted(set(node_files(root)) - set(before))}


class KeylessRefusals(unittest.TestCase):
    def test_k06_each_playbook_is_one_task(self):
        for directory, name in REFUSALS:
            with self.subTest(playbook="%s/%s" % (directory, name)):
                result = run_refusal(directory, name)
                self.assertEqual(len(task_names(result["listing"])), 1, result["listing"])
                self.assertEqual(len(play_names(result["listing"])), 1, result["listing"])

    def test_k07_each_playbook_fails_in_its_first_task_and_runs_nothing_else(self):
        for directory, name in REFUSALS:
            with self.subTest(playbook="%s/%s" % (directory, name)):
                result = run_refusal(directory, name)
                output = result["run"]
                self.assertNotEqual(result["rc"], 0, output[-2000:])
                self.assertEqual(len(re.findall(r"^TASK \[", output, re.M)), 1, output[-2000:])
                self.assertRegex(output, r"node\s+: ok=0\s+changed=0\s+unreachable=0\s+failed=1")
                self.assertEqual(result["calls"], "", "a command of the node was called")
                self.assertEqual(result["created"], [], "the playbook created a file")

    def test_k08_the_message_starts_with_the_token_and_names_what_to_use_instead(self):
        for directory, name in REFUSALS:
            with self.subTest(playbook="%s/%s" % (directory, name)):
                output = run_refusal(directory, name)["run"]
                network = directory.replace("-validator", "")
                self.assertIn('"msg": "SLV_KEYLESS_REFUSED', output)
                self.assertIn("slv v set:identity -n %s -p %s" % (network, "node" if name == "set_identity_to_active" else "<host>"), output)
                self.assertIn("slv v switch -n %s" % network, output)
                self.assertIn("Nothing was changed on node", output)

    def test_k08a_the_message_gives_the_reason_that_holds_for_the_playbook(self):
        # set_identity_to_active passed the staked key of the controller on stdin for its agave and jito hosts: it is retired
        # because it set the identity without the checks that slv v set:identity makes, not because it read a key on the node
        # the caught-up check belongs to Alpenglow only (check 2 of vote_history_dead_primary.yml): the text says so
        checks = ("It set the identity without the checks that the set:identity command of slv makes first: that nothing votes "
                  "with the identity, where the identity is in gossip, and that the tower or vote history file of the identity "
                  "is there (on Alpenglow, also that the host has caught up)")
        reasons = {
            ("mainnet-validator", "set_identity_to_active"): [checks],
            ("testnet-validator", "set_identity_to_active"): [checks, "and on a Firedancer host it read the staked key from a file on the node"],
            ("testnet-validator", "switch_on_firedancer_identity"): ["It took the staked key from a file on the node",
                                                                     "deploy never copies the staked key to a node"],
            ("testnet-validator", "change_identity_and_restart"): ["It linked the identity of the node to a staked key on the node and restarted firedancer.service",
                                                                  "deploy never copies the staked key to a node"],
        }
        for directory, name in REFUSALS:
            with self.subTest(playbook="%s/%s" % (directory, name)):
                output = run_refusal(directory, name)["run"]
                self.assertIn("%s.yml is retired." % name, output)
                for fragment in reasons[(directory, name)]:
                    self.assertIn(fragment, output)
                self.assertNotIn("sets the identity from a staked key on the node", output)
                self.assertNotIn("the node has no staked key", output)


# ---------------------------------------------------------------------------
# signer: doublezero-solana is not called without the key file
# ---------------------------------------------------------------------------

DOUBLEZERO = ("doublezero_deposit", "doublezero_withdraw")


@functools.lru_cache(maxsize=None)
def run_doublezero(name, key_present):
    with tempfile.TemporaryDirectory(prefix="slv-keyless-dz-") as tmp:
        root = Path(tmp)
        home = root / "home"
        home.mkdir()
        calls = root / "calls.log"
        calls.write_text("")
        bin_dir = fake_bin(root, calls)
        key = root / "solv" / "mainnet-validator-keypair.json"
        key.parent.mkdir()
        if key_present:
            key.write_text("[1,2,3]")
        text = (ANSIBLE_DIR / "cmn" / ("%s.yml" % name)).read_text()
        playbook = root / ("%s.yml" % name)
        playbook.write_text(text)
        write_inventory(root / "inventory.json", {"node": {"identity_account": "StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA"}})
        process = run_with_fakes(["-i", "inventory.json", playbook, "-e", "ansible_become=false",
                                  "-e", "doublezero_keypair_path=%s" % key], root, home, bin_dir)
        return process.returncode, process.stdout, calls.read_text(), str(key)


class DoubleZeroSignsOnlyWithAKeyFileOnTheNode(unittest.TestCase):
    def test_k09_the_signer_is_not_called_when_the_key_file_is_absent(self):
        for name in DOUBLEZERO:
            with self.subTest(playbook=name):
                returncode, output, calls, key = run_doublezero(name, False)
                self.assertNotEqual(returncode, 0, output[-2000:])
                self.assertEqual(calls, "", "doublezero-solana was called without a key file")
                self.assertIn("%s does not exist on node" % key, output)
                self.assertIn("Nothing was changed on node", output)

    def test_k10_the_signer_is_called_with_the_key_file_when_it_is_there(self):
        for name in DOUBLEZERO:
            with self.subTest(playbook=name):
                returncode, output, calls, key = run_doublezero(name, True)
                self.assertEqual(returncode, 0, output[-2000:])
                self.assertEqual(len(calls.strip().splitlines()), 1, calls)
                self.assertIn("-k %s" % key, calls)


# ---------------------------------------------------------------------------
# types: the plays that init runs for each validator_type
# ---------------------------------------------------------------------------

SOLV_PLAYS = {
    "mainnet-validator": ("setup_solv_service.yml", "create-start-validator-sh.yml", "start_solv.yml"),
    "testnet-validator": ("setup_solv_service.yml", "deploy-start-validator-sh.yml", "start_solv.yml"),
}
FIREDANCER_PLAYS = {"mainnet-validator": (), "testnet-validator": ("setup_firedancer.yml", "start_firedancer.yml")}


@functools.lru_cache(maxsize=None)
def run_init_flow(network):
    """init.yml of the network with every playbook it imports replaced by a stub that writes its name down; the first play
    (the gate on validator_type) and the conditions of the imports are the real ones."""
    types = AGAVE_FAMILY if network == "mainnet-validator" else AGAVE_FAMILY + FIREDANCER
    with tempfile.TemporaryDirectory(prefix="slv-keyless-flow-") as tmp:
        root = Path(tmp)
        home = root / "home"
        home.mkdir()
        init = make_flow_copy(network, root)
        logs = root / "logs"
        logs.mkdir()
        hosts = {t: {"validator_type": t} for t in types}
        write_inventory(root / "inventory.json", hosts)
        process = run_ansible(["-i", "inventory.json", init, "-e", "slv_log_dir=%s" % logs], root, home)
        return read_logs(logs, hosts, process)


class InitRunsTheSolvPlaysForEveryAgaveType(unittest.TestCase):
    def test_k11_every_agave_type_gets_the_unit_the_start_script_and_the_start(self):
        for network in VALIDATORS:
            for validator_type in AGAVE_FAMILY:
                with self.subTest(network=network, validator_type=validator_type):
                    imports = [Path(play).name for play in run_init_flow(network)[validator_type].imports]
                    self.assertTrue(imports, "init.yml stopped:\n" + run_init_flow(network)[validator_type].output[-3000:])
                    for play in SOLV_PLAYS[network]:
                        self.assertIn(play, imports)
                    for play in FIREDANCER_PLAYS[network]:
                        self.assertNotIn(play, imports)

    def test_k12_a_firedancer_type_gets_firedancer_and_not_the_solv_plays(self):
        for validator_type in FIREDANCER:
            with self.subTest(validator_type=validator_type):
                imports = [Path(play).name for play in run_init_flow("testnet-validator")[validator_type].imports]
                self.assertTrue(imports)
                for play in FIREDANCER_PLAYS["testnet-validator"]:
                    self.assertIn(play, imports)
                for play in SOLV_PLAYS["testnet-validator"]:
                    self.assertNotIn(play, imports)

    def test_k13_the_unstaked_identity_is_asserted_right_after_it_is_set_up_and_no_key_is_copied(self):
        for network in VALIDATORS:
            for validator_type in AGAVE_FAMILY:
                with self.subTest(network=network, validator_type=validator_type):
                    imports = run_init_flow(network)[validator_type].imports
                    self.assertNotIn("copy_keys.yml", imports)
                    setup = imports.index("../cmn/setup_unstaked_identity.yml")
                    self.assertEqual(imports[setup + 1], "../cmn/assert_unstaked_identity.yml")



# ---------------------------------------------------------------------------
# firedancer: a Firedancer host of testnet is refused before anything is changed
# ---------------------------------------------------------------------------

TESTNET = ANSIBLE_DIR / "testnet-validator"
STAKED = "StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA"


def copy_validator_plays(root, network_dir):
    """A copy of the playbooks of the directory and of cmn/tasks with the paths of the node moved into root."""
    target = root / "ansible" / network_dir
    target.mkdir(parents=True)
    shutil.copytree(ANSIBLE_DIR / "cmn" / "tasks", root / "ansible" / "cmn" / "tasks")
    for source in sorted((ANSIBLE_DIR / network_dir).glob("*.yml")):
        text = move_to(source.read_text(), root)
        if real_host_paths_left(text):
            raise AssertionError("a path of the real host is left in %s/%s" % (network_dir, source.name))
        (target / source.name).write_text(text)
    return target


def node_dirs(root):
    for name in ("solv", "mnt", "mnt/ledger"):
        (root / name).mkdir(exist_ok=True)


@functools.lru_cache(maxsize=None)
def run_migrate(source_type, target_type):
    with tempfile.TemporaryDirectory(prefix="slv-keyless-migrate-") as tmp:
        root = Path(tmp)
        home = root / "home"
        home.mkdir()
        node_dirs(root)
        calls = root / "calls.log"
        calls.write_text("")
        bin_dir = fake_bin(root, calls)
        target = copy_validator_plays(root, "testnet-validator")
        (root / "mnt" / "ledger" / ("tower-1_9-%s.bin" % STAKED)).write_text("ledger-tower")
        write_inventory(root / "inventory.json", {
            "src": {"identity_account": STAKED, "vote_account": "VOTE", "validator_type": source_type},
            "dst": {"identity_account": STAKED, "vote_account": "VOTE", "validator_type": target_type}})
        before = node_files(root)
        process = run_with_fakes(["-i", "inventory.json", target / "nodowntime_migrate.yml", "-e", "source_host=src",
                                  "-e", "target_host=dst", "-e", "ansible_become=false",
                                  "-e", "slv_alpenglow_rpc_url=http://127.0.0.1:9", "-e", "slv_alpenglow_rpc_delay=0"],
                                 root, home, bin_dir)
        return {"rc": process.returncode, "output": process.stdout, "calls": calls.read_text(),
                "created": sorted(set(node_files(root)) - set(before))}


@functools.lru_cache(maxsize=None)
def run_set_identity_key(validator_type):
    with tempfile.TemporaryDirectory(prefix="slv-keyless-setkey-") as tmp:
        root = Path(tmp)
        home = root / "home"
        home.mkdir()
        node_dirs(root)
        calls = root / "calls.log"
        calls.write_text("")
        bin_dir = fake_bin(root, calls)
        target = copy_validator_plays(root, "testnet-validator")
        # no identity_account: the first check of the agave family, the base58 one, stops it
        write_inventory(root / "inventory.json", {"node": {"validator_type": validator_type, "vote_account": "VOTE"}})
        before = node_files(root)
        process = run_with_fakes(["-i", "inventory.json", target / "set_identity_key.yml", "-e", "ansible_become=false",
                                  "-e", "slv_alpenglow_rpc_url=http://127.0.0.1:9", "-e", "slv_alpenglow_rpc_delay=0"],
                                 root, home, bin_dir)
        return {"rc": process.returncode, "output": process.stdout, "calls": calls.read_text(),
                "created": sorted(set(node_files(root)) - set(before))}


def tasks_run(output):
    """The names of the tasks that the run started, but for the gathering of facts."""
    return [name for name in re.findall(r"^TASK \[(.*?)\] \*", output, re.M) if name != "Gathering Facts"]


FIREDANCER_MOVES = (("firedancer-jito", "firedancer-jito"), ("agave", "firedancer-jito"), ("firedancer-agave", "agave"))


class FiredancerHostsAreRefusedOnTestnet(unittest.TestCase):
    def test_k14_a_migrate_with_a_firedancer_source_or_target_is_refused_before_the_source_is_demoted(self):
        for source_type, target_type in FIREDANCER_MOVES:
            with self.subTest(source=source_type, target=target_type):
                result = run_migrate(source_type, target_type)
                output = result["output"]
                self.assertNotEqual(result["rc"], 0, output[-2000:])
                self.assertIn("SLV_KEYLESS_REFUSED", output)
                self.assertIn("Nothing was changed", output)
                self.assertEqual(result["calls"], "", "a command of the node was called: the source was demoted")
                self.assertEqual(result["created"], [], "the run created a file")
                # the type gate, which asserts and changes nothing, and then the refusal: nothing else started
                names = tasks_run(output)
                self.assertEqual(len(names), 2, output[-2000:])
                self.assertTrue(names[1].startswith("Refuse a Firedancer"), names)

    def test_k15_set_identity_key_refuses_a_firedancer_host_before_any_check_but_the_type_gate(self):
        for validator_type in ("firedancer-agave", "firedancer-jito"):
            with self.subTest(validator_type=validator_type):
                result = run_set_identity_key(validator_type)
                output = result["output"]
                self.assertNotEqual(result["rc"], 0, output[-2000:])
                self.assertIn('"msg": "SLV_KEYLESS_REFUSED', output)
                self.assertIn("Nothing was changed on node", output)
                names = tasks_run(output)
                self.assertEqual(len(names), 2, "the refusal comes right after the type gate:\n" + output[-2000:])
                self.assertEqual(names[1], "Refuse a Firedancer host, which takes the staked key from a file on the node")
                self.assertEqual(result["calls"], "", "a command of the node was called")
                self.assertEqual(result["created"], [], "the play created a file")

    def test_k16_an_agave_family_host_goes_through_its_own_checks_as_before(self):
        for validator_type in AGAVE_FAMILY:
            with self.subTest(validator_type=validator_type):
                output = run_set_identity_key(validator_type)["output"]
                self.assertNotIn("SLV_KEYLESS_REFUSED", output)
                self.assertIn("is not a base58 public key", output)
                self.assertGreaterEqual(len(tasks_run(output)), 2, output[-2000:])


# ---------------------------------------------------------------------------
# update_startup_config.yml of testnet: the start script of every agave type
# ---------------------------------------------------------------------------

UPDATE_TYPES = AGAVE_FAMILY


@functools.lru_cache(maxsize=None)
def run_update_script(validator_type):
    with tempfile.TemporaryDirectory(prefix="slv-keyless-update-") as tmp:
        root = Path(tmp)
        home = make_home(root)
        node_dirs(root)
        # the agave-validator that the solv unit would find: it reports a version the way the real one does
        agave_dir = root / "solv" / ".local" / "share" / "solana" / "install" / "active_release" / "bin"
        agave_dir.mkdir(parents=True)
        agave = agave_dir / "agave-validator"
        agave.write_text("#!/bin/bash\necho 'agave-validator 4.4.0-beta.0 (src:00000000; feat:1, client:Agave)'\n")
        agave.chmod(0o755)
        calls = root / "calls.log"
        calls.write_text("")
        fakes = fake_bin(root, calls)
        user, group = pwd.getpwuid(os.getuid()).pw_name, grp.getgrgid(os.getgid()).gr_name
        text = move_to((TESTNET / "update_startup_config.yml").read_text(), root)
        text = text.replace("owner: solv", "owner: %s" % user).replace("group: solv", "group: %s" % group)
        if real_host_paths_left(text):
            raise AssertionError("a path of the real host is left in update_startup_config.yml")
        playbook = root / "update.yml"
        playbook.write_text(text)
        write_inventory(root / "inventory.json", {"node": {
            "validator_type": validator_type, "vote_account": "VOTE", "commission_bps": 0,
            "block_engine_url": "http://localhost"}})
        process = run_with_fakes(["-i", "inventory.json", playbook, "-e", "ansible_become=false"], root, home, fakes)
        script = root / "solv" / "start-validator.sh"
        return process.returncode, process.stdout, script.read_text() if script.exists() else None


class UpdateStartupConfigRendersEveryAgaveType(unittest.TestCase):
    def test_k17_the_start_script_of_an_allnodes_jito_host_is_rendered_as_init_renders_it(self):
        returncode, output, script = run_update_script("allnodes-jito")
        self.assertEqual(returncode, 0, output[-3000:])
        self.assertIsNotNone(script, "update_startup_config.yml wrote no start script for allnodes-jito")
        self.assertIn("--vote-account VOTE", script)
        self.assertIn("--identity /home/solv/identity.json", script)
        self.assertIn("--block-engine-url", script, "the Jito flags of the generic template")

    def test_k18_agave_and_jito_keep_the_scripts_of_their_own_templates(self):
        for validator_type in ("agave", "jito"):
            with self.subTest(validator_type=validator_type):
                returncode, output, script = run_update_script(validator_type)
                self.assertEqual(returncode, 0, output[-3000:])
                self.assertIsNotNone(script)
                self.assertIn("--vote-account VOTE", script)
                self.assertEqual("--block-engine-url" in script, validator_type == "jito")


if __name__ == "__main__":
    unittest.main()
