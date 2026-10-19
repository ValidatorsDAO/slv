"""Tests of the start and restart plays of the validators: a node that would come back on the staked identity is not touched.

Deploy puts the node on its unstaked identity (identity.json is a link to unstaked-identity.json) and the staked key
reaches it on stdin, during slv v set:identity and slv v switch. A node that a person laid out by hand can differ: its
identity.json, or the --identity of its start script (the identity_path of the Firedancer config), can lead to the staked
key. A start or a restart would then bring the node back on the staked identity, next to the host that now runs it.
cmn/assert_unstaked_identity.yml reads the three, by path and by public key (solana-keygen pubkey against the
identity_account of the host), and every play that starts or restarts a validator imports it before it stops or starts
anything. What it cannot tell stops the run as well: a start script or a Firedancer config that names no identity or more
than one, and a public key that solana-keygen does not print. These tests run those plays with ansible-playbook on this machine, over a local connection, with
temporary directories for HOME and for the paths of the node (/home/solv and /mnt are moved into one) and fake commands
that write down what they were asked. Like test_init_geyser_plugin.py, whose helpers they take, they need PyYAML and
ansible-playbook. Run from the repository root:

    python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_*.py' -v
"""

import concurrent.futures
import functools
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_init_geyser_plugin import ANSIBLE_DIR, run_ansible, write_inventory  # noqa: E402
from test_keyless_deploy import STAKED_KEY, move_to, real_host_paths_left  # noqa: E402

UNSTAKED_KEY = "UnstakedKeyOfTheNodeBBBBBBBBBBBBBBBBBBB"
OTHER_KEY = "AnotherUnstakedKeyCCCCCCCCCCCCCCCCCCCCCC"

# how a node is laid out: what identity.json links to, what the start script or the Firedancer config names (and in which
# of the forms agave and Firedancer read), what the unstaked-identity.json holds, and whether solana-keygen prints anything
LAYOUTS = {
    "standard": {},                                    # as deploy makes it
    "script-staked": {"script": "validator-keypair.json"},   # --identity names a file that holds the staked key
    "script-other": {"script": "other-unstaked.json"},       # --identity names a file that is not unstaked-identity.json
    "config-staked": {"config": "validator-keypair.json"},   # identity_path names a file that holds the staked key
    "identity-staked": {"link": "validator-keypair.json"},   # identity.json links to the staked key
    "unstaked-holds-staked": {"unstaked_key": STAKED_KEY},   # identity.json -> unstaked-identity.json, which holds the staked key
    # the forms of the start script and of the Firedancer config, each with the staked key and each with the unstaked identity
    "script-short-flag": {"script": "validator-keypair.json", "script_form": "short"},
    "script-short-flag-ok": {"script_form": "short"},
    "script-one-line": {"script": "validator-keypair.json", "script_form": "one-line"},
    "script-one-line-ok": {"script_form": "one-line"},
    "script-equals": {"script": "validator-keypair.json", "script_form": "equals"},
    "script-equals-ok": {"script_form": "equals"},
    "config-single-quoted": {"config": "validator-keypair.json", "config_form": "single"},
    "config-single-quoted-ok": {"config_form": "single"},
    "config-dotted": {"config": "validator-keypair.json", "config_form": "dotted"},
    "config-dotted-ok": {"config_form": "dotted"},
    # what cannot be told
    "silent-keygen": {"silent_keygen": True},                # solana-keygen prints nothing
    "script-no-identity": {"script_form": "none"},           # the start script names no identity
    "config-no-identity": {"config_form": "none"},           # the Firedancer config names no identity_path
    "script-two-identities": {"script": "validator-keypair.json", "script_form": "twice"},   # unstaked first, staked second
    "config-two-identities": {"config": "validator-keypair.json", "config_form": "twice"},
}
# the layouts a start or a restart goes on from
GOES_ON = tuple(kind for kind in LAYOUTS if kind == "standard" or kind.endswith("-ok"))

SCRIPT_FORMS = {
    "lines": "#!/bin/bash\nexec agave-validator \\\n--identity %(file)s \\\n--vote-account VOTE \\\n--ledger %(ledger)s\n",
    "short": "#!/bin/bash\nexec agave-validator \\\n-i %(file)s \\\n--vote-account VOTE \\\n--ledger %(ledger)s\n",
    "one-line": "#!/bin/bash\nexec agave-validator --identity %(file)s --vote-account VOTE --ledger %(ledger)s\n",
    "equals": "#!/bin/bash\nexec agave-validator \\\n--identity=%(file)s \\\n--vote-account VOTE \\\n--ledger %(ledger)s\n",
    "twice": "#!/bin/bash\nexec agave-validator \\\n--identity %(identity)s \\\n--vote-account VOTE \\\n--identity %(file)s \\\n--ledger %(ledger)s\n",
    "none": "#!/bin/bash\nexec agave-validator \\\n--vote-account VOTE \\\n--ledger %(ledger)s\n",
}
CONFIG_FORMS = {
    "double": '[consensus]\n    identity_path = "%(file)s"\n',
    "single": "[consensus]\n    identity_path = '%(file)s'\n",
    "dotted": 'consensus.identity_path = "%(file)s"\n',
    "twice": '[consensus]\n    identity_path = "%(identity)s"\n\n[layout]\n    identity_path = "%(file)s"\n',
    "none": "[consensus]\n    expected_shred_version = 1\n",
}

FAKE_SYSTEMCTL = """#!/bin/bash
echo "systemctl $*" >>"%(calls)s"
if [ "$1" = show ]; then
  printf 'LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nUnitFileState=enabled\\n'
fi
exit 0
"""


def fake_commands(root, calls, silent_keygen=False):
    directory = root / "bin"
    directory.mkdir()
    scripts = {
        "sudo": '#!/bin/bash\necho "sudo $*" >>"%s"\nexit 0\n' % calls,
        "agave-validator": '#!/bin/bash\necho "agave-validator $*" >>"%s"\nexit 0\n' % calls,
        "fdctl": '#!/bin/bash\necho "fdctl $*" >>"%s"\nexit 0\n' % calls,
        "systemctl": FAKE_SYSTEMCTL % {"calls": calls},
        # solana-keygen pubkey <file> prints the first line of the file: a key file here holds its public key
        "solana-keygen": '#!/bin/bash\nexit 0\n' if silent_keygen else '#!/bin/bash\n[ "$1" = pubkey ] && head -n 1 "$2"\n',
    }
    for name, text in scripts.items():
        (directory / name).write_text(text)
        (directory / name).chmod(0o755)
    return directory


def lay_out(root, kind):
    """The files of the node under root/solv: the key files, identity.json, the start script and the Firedancer config."""
    spec = LAYOUTS[kind]
    solv = root / "solv"
    solv.mkdir(exist_ok=True)
    (solv / "unstaked-identity.json").write_text(spec.get("unstaked_key", UNSTAKED_KEY) + "\n")
    (solv / "validator-keypair.json").write_text(STAKED_KEY + "\n")
    (solv / "other-unstaked.json").write_text(OTHER_KEY + "\n")
    (solv / "identity.json").symlink_to(solv / spec.get("link", "unstaked-identity.json"))
    named = lambda key: str(solv / spec.get(key, "identity.json"))  # noqa: E731
    fields = {"identity": str(solv / "identity.json"), "ledger": "%s/mnt/ledger" % root}
    (solv / "start-validator.sh").write_text(
        SCRIPT_FORMS[spec.get("script_form", "lines")] % dict(fields, file=named("script")))
    (solv / "firedancer-config.toml").write_text(
        CONFIG_FORMS[spec.get("config_form", "double")] % dict(fields, file=named("config")))
    (root / "mnt" / "ledger").mkdir(parents=True, exist_ok=True)
    (root / "mnt" / "ledger" / "ledger-marker").write_text("ledger\n")


def copy_flow(root, directory, cmn_names):
    """The playbooks of the validator directory and the named ones of cmn, with the paths of the node moved into root."""
    for source_dir, names in ((directory, None), ("cmn", cmn_names)):
        target = root / "ansible" / source_dir
        target.mkdir(parents=True, exist_ok=True)
        sources = sorted((ANSIBLE_DIR / source_dir).glob("*.yml")) if names is None else [ANSIBLE_DIR / "cmn" / n for n in names]
        for source in sources:
            text = move_to(source.read_text(), root)
            if real_host_paths_left(text):
                raise AssertionError("a path of the real host is left in %s/%s" % (source_dir, source.name))
            (target / source.name).write_text(text)
    shutil.copytree(ANSIBLE_DIR / "cmn" / "tasks", root / "ansible" / "cmn" / "tasks")


def run_scenario(directory, playbook, validator_type, kind):
    with tempfile.TemporaryDirectory(prefix="slv-unstaked-start-") as tmp:
        root = Path(tmp)
        home = root / "home"
        home.mkdir()
        (home / ".profile").write_text("")   # the plays source ~/.profile
        calls = root / "calls.log"
        calls.write_text("")
        bin_dir = fake_commands(root, calls, LAYOUTS[kind].get("silent_keygen", False))
        (root / "mnt").mkdir()
        lay_out(root, kind)
        copy_flow(root, directory, ("assert_unstaked_identity.yml", "restart_solv.yml"))
        write_inventory(root / "inventory.json", {"node": {
            "identity_account": STAKED_KEY, "vote_account": "VOTE", "validator_type": validator_type}})
        env = {"PATH": "%s:%s" % (bin_dir, os.environ.get("PATH", "")), "ANSIBLE_GATHERING": "explicit"}
        process = run_ansible(["-i", "inventory.json", root / "ansible" / directory / playbook, "-e", "ansible_become=false"],
                              root, home, extra_env=env)
        return {"rc": process.returncode, "output": process.stdout,
                "calls": [line for line in calls.read_text().splitlines() if line],
                "ledger": (root / "mnt" / "ledger" / "ledger-marker").exists()}


# (directory, playbook, validator_type) -> the layouts to run it on; "standard" is the one that goes on
TWO = ("standard", "script-staked")
# the layouts of an agave family node (the start script is read) and of a Firedancer node (the Firedancer config is read)
SCRIPT_FORMS_RUN = ("script-short-flag", "script-short-flag-ok", "script-one-line", "script-one-line-ok", "script-equals",
                    "script-equals-ok", "script-no-identity", "script-two-identities", "silent-keygen")
CONFIG_FORMS_RUN = ("config-single-quoted", "config-single-quoted-ok", "config-dotted", "config-dotted-ok",
                    "config-no-identity", "config-two-identities", "silent-keygen")
SCENARIOS = {}
for _network in ("mainnet", "testnet"):
    _dir = "%s-validator" % _network
    SCENARIOS[(_dir, "start_solv.yml", "jito")] = (
        ("standard", "script-staked", "script-other", "identity-staked", "unstaked-holds-staked") + SCRIPT_FORMS_RUN)
    SCENARIOS[(_dir, "restart_node.yml", "jito")] = ("standard", "script-staked", "identity-staked") + SCRIPT_FORMS_RUN
    SCENARIOS[(_dir, "restart_node.yml", "firedancer-jito")] = ("standard", "config-staked", "identity-staked") + CONFIG_FORMS_RUN
    SCENARIOS[(_dir, "start_firedancer.yml", "firedancer-jito")] = ("standard", "config-staked") + CONFIG_FORMS_RUN
    SCENARIOS[(_dir, "start_node.yml", "jito")] = TWO + ("script-no-identity", "script-two-identities", "silent-keygen")
    SCENARIOS[(_dir, "start_node.yml", "firedancer-jito")] = ("standard", "config-staked", "config-no-identity", "silent-keygen")
SCENARIOS[("mainnet-validator", "start-solv-service.yml", "jito")] = TWO + ("script-no-identity", "silent-keygen")
SCENARIOS[("testnet-validator", "restart_solv.yml", "jito")] = TWO + ("script-no-identity", "silent-keygen")
SCENARIOS[("testnet-validator", "restart_firedancer.yml", "firedancer-jito")] = ("standard", "config-staked", "config-no-identity", "silent-keygen")
SCENARIOS[("testnet-validator", "restart_agave_with_rm_ledger.yml", "jito")] = ("script-staked", "script-no-identity", "silent-keygen")
SCENARIOS[("testnet-validator", "restart_firedancer_with_rm_ledger.yml", "firedancer-jito")] = ("config-staked", "config-no-identity", "silent-keygen")

# what a run that goes on does first
FIRST_CALL = {
    "start_solv.yml": "sudo systemctl start solv",
    "start-solv-service.yml": "systemctl start solv.service",
    "start_firedancer.yml": "systemctl start firedancer",
    "restart_solv.yml": "agave-validator -l",
}


@functools.lru_cache(maxsize=None)
def run_all():
    keys = [(d, p, t, kind) for (d, p, t), kinds in SCENARIOS.items() for kind in kinds]
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda key: run_scenario(*key), keys))
    return dict(zip(keys, results))


# what the stop says about the file or the key, by layout
SAID = {
    "script-staked": ("The start script", "validator-keypair.json", "the staked identity"),
    "script-short-flag": ("The start script", "validator-keypair.json", "the staked identity"),
    "script-one-line": ("The start script", "validator-keypair.json", "the staked identity"),
    "script-equals": ("The start script", "validator-keypair.json", "the staked identity"),
    "script-other": ("The start script", "other-unstaked.json", "another identity than its unstaked one"),
    "config-staked": ("The Firedancer config", "validator-keypair.json", "the staked identity"),
    "config-single-quoted": ("The Firedancer config", "validator-keypair.json", "the staked identity"),
    "config-dotted": ("The Firedancer config", "validator-keypair.json", "the staked identity"),
    "identity-staked": ("/identity.json on node leads to the key %s" % STAKED_KEY, "", "the staked identity"),
    "unstaked-holds-staked": ("/identity.json on node leads to the key %s" % STAKED_KEY, "", "the staked identity"),
    "script-no-identity": ("The start script", "names no identity that can be read", "Nothing was stopped or started"),
    "config-no-identity": ("The Firedancer config", "names no identity that can be read", "Nothing was stopped or started"),
    "script-two-identities": ("The start script", "names 2 identities", "which one the node would start with"),
    "config-two-identities": ("The Firedancer config", "names 2 identities", "which one the node would start with"),
    "silent-keygen": ("The public key of", "could not be read (solana-keygen printed nothing", "whether the node would start with the staked identity"),
}


class AStartOrRestartStopsWhereTheNodeWouldComeBackStaked(unittest.TestCase):
    def test_u01_a_node_laid_out_as_deploy_makes_it_goes_on(self):
        results = run_all()
        for (directory, playbook, validator_type, kind), result in results.items():
            if kind not in GOES_ON:
                continue
            with self.subTest(playbook="%s/%s" % (directory, playbook), validator_type=validator_type, layout=kind):
                self.assertNotIn("Nothing was stopped or started", result["output"], result["output"][-2000:])
                self.assertNotRegex(result["output"], r"fatal: \[node\]", result["output"][-2000:])
                self.assertTrue(result["calls"], "nothing was run:\n" + result["output"][-2000:])
                if playbook in FIRST_CALL:
                    self.assertTrue(any(call.startswith(FIRST_CALL[playbook]) for call in result["calls"]), result["calls"])

    def test_u02_a_node_that_would_come_back_on_the_staked_identity_is_not_touched(self):
        results = run_all()
        for (directory, playbook, validator_type, kind), result in results.items():
            if kind in GOES_ON:
                continue
            with self.subTest(playbook="%s/%s" % (directory, playbook), validator_type=validator_type, layout=kind):
                self.assertNotEqual(result["rc"], 0, result["output"][-2000:])
                self.assertRegex(result["output"], r"fatal: \[node\]: FAILED! => .*would start with")
                self.assertIn("Nothing was stopped or started", result["output"])
                self.assertEqual(result["calls"], [], "a command of the node was called before the check stopped the run")
                self.assertTrue(result["ledger"], "the ledger was touched")

    def test_u03_the_stop_names_the_file_that_leads_to_the_staked_key_and_how_to_move_the_node(self):
        results = run_all()
        for (directory, playbook, validator_type, kind), result in results.items():
            if kind in GOES_ON:
                continue
            network = directory.replace("-validator", "")
            with self.subTest(playbook="%s/%s" % (directory, playbook), layout=kind):
                output = result["output"]
                for fragment in SAID[kind]:
                    self.assertIn(fragment, output)
                if validator_type.startswith("firedancer"):
                    # a Firedancer host cannot be given the staked identity back by slv: the remedy sends it elsewhere
                    self.assertIn("slv cannot put the staked identity on a Firedancer host of %s" % network, output)
                    self.assertIn("agave, jito or allnodes-jito host", output)
                    self.assertIn("slv v set:identity -n %s -p <host>" % network, output)
                    self.assertIn("change the validator_type of node", output)
                    self.assertNotIn("update:script", output)
                    self.assertNotIn("once it is up", output)
                else:
                    self.assertIn("run slv v update:script -n %s -p node" % network, output)
                    self.assertIn("run slv v set:identity -n %s -p node once it is up" % network, output)
                    self.assertNotIn("Firedancer host", output)

    def test_u04_the_remedy_for_a_firedancer_host_says_what_is_true_of_its_network(self):
        results = run_all()
        reasons = {
            "testnet": "slv v set:identity and slv v switch refuse it, because a Firedancer host takes the staked key from a file on the node.",
            "mainnet": "slv v set:identity and slv v switch refuse it, because the Alpenglow migration does not support Firedancer or Frankendancer.",
        }
        seen = set()
        for (directory, playbook, validator_type, kind), result in results.items():
            if kind in GOES_ON or not validator_type.startswith("firedancer"):
                continue
            network = directory.replace("-validator", "")
            seen.add(network)
            other = "mainnet" if network == "testnet" else "testnet"
            with self.subTest(playbook="%s/%s" % (directory, playbook), layout=kind):
                self.assertIn(reasons[network], result["output"])
                self.assertNotIn(reasons[other].split(", because ")[1], result["output"])
        self.assertEqual(seen, {"mainnet", "testnet"})


if __name__ == "__main__":
    unittest.main()
