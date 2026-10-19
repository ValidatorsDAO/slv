"""Tests of the legacy init-*.yml, which are direct-run paths around the gates of init.yml.

init.yml of the validator and RPC networks stops, before it changes anything, a validator_type that it does not take and a
client that is older than the Alpenglow floor of its network (cmn/check_alpenglow_floor.yml). The older entry points
install one client each and begin without any of it:

  mainnet-validator/init-jito.yml, init-allnodes-jito.yml     the type gate of mainnet init.yml and the floor check
  testnet-validator/init-agave.yml, init-firedancer.yml        the type gate of testnet init.yml and the floor check
  mainnet-rpc/init-old.yml                                     the type gate of mainnet-rpc init.yml and the floor check
  mainnet-validator/init-firedancer.yml                        sets up Firedancer, which mainnet does not take: it refuses
  mainnet-validator/setup_firedancer.yml, update_firedancer.yml  the same refusal, for the playbooks that a CLI command runs on its own

The floor check reads the client that the flow installs (floor_client), not the one of validator_type, and the version that
the installer installs: install_jito.yml, install_agave.yml and install_allnodes_jito.yml of the validator networks set the
version as a play variable, so -e counts and the version of the host does not; install_jito.yml of mainnet-rpc reads the
host as well as -e.

Like test_alpenglow_floor.py, whose helpers they take, the tests run the real ansible-playbook on this machine over a local
connection, without become, sudo, a network or a host, on the first plays of each file and its import of the check (a
legacy flow imports playbooks that its directory does not hold, so it is cut after the check). Run from the repository root:

    python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_*.py' -v
"""

import functools
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_alpenglow_floor import (  # noqa: E402
    CHECK,
    CLIENTS,
    GOOD_GEYSER,
    LABEL,
    OLD_GEYSER,
    OWN_KEY,
    PIN_SETS,
    below,
    check_import_index,
    gate_hosts,
    make_floor_versions,
    network_of,
    pins_of_set,
    read,
    run_flow,
)
from test_init_geyser_plugin import (  # noqa: E402
    ANSIBLE_DIR,
    MISSING,
    REPOSITORY,
    make_home,
    module_of,
    prefetch,
    run_ansible,
    write_inventory,
)

# the legacy entry points that install a client: the section of versions.yml they read, the client they install, the
# init.yml whose gate they take, and the play variable that their installer sets ("host" when it reads the host as well)
LEGACY = {
    "mainnet-validator/init-jito.yml": {"section": "mainnet_validators", "client": "jito", "init": "mainnet-validator/init.yml", "installer": "-e"},
    "mainnet-validator/init-allnodes-jito.yml": {"section": "mainnet_validators", "client": "allnodes", "init": "mainnet-validator/init.yml", "installer": "-e"},
    "testnet-validator/init-agave.yml": {"section": "testnet_validators", "client": "agave", "init": "testnet-validator/init.yml", "installer": "-e"},
    "testnet-validator/init-firedancer.yml": {"section": "testnet_validators", "client": "jito", "init": "testnet-validator/init.yml", "installer": "-e"},
    "mainnet-rpc/init-old.yml": {"section": "mainnet_rpcs", "client": "jito", "init": "mainnet-rpc/init.yml", "installer": "host"},
}
# the playbooks of mainnet-validator that set up or update Firedancer, which mainnet does not take: each begins with the
# refusal, and says what it does (the word of its message)
MAINNET_FIREDANCER = {
    "mainnet-validator/init-firedancer.yml": "sets up",
    "mainnet-validator/setup_firedancer.yml": "sets up",
    "mainnet-validator/update_firedancer.yml": "updates",
}
# the validator_type of a host that the flow is meant for, and one of another family
NATURAL = {"jito": "jito", "allnodes": "allnodes-jito", "agave": "agave"}
OTHER = {"jito": "agave", "allnodes": "agave", "agave": "jito"}


def natural_type(path):
    if path == "testnet-validator/init-firedancer.yml":
        return "firedancer-jito"
    return NATURAL[LEGACY[path]["client"]]


def other_type(path):
    if path == "testnet-validator/init-firedancer.yml":
        return "firedancer-agave"
    return OTHER[LEGACY[path]["client"]]


def entries_of(path):
    return yaml.safe_load((ANSIBLE_DIR / path).read_text())


def gate_play(entries):
    (play,) = [entry for entry in entries if any(
        module_of(task)[0] == "assert" and "supported type" in task.get("name", "")
        for task in entry.get("tasks", []))]
    return play


def gate_task(entries):
    (task,) = [task for task in gate_play(entries)["tasks"] if module_of(task)[0] == "assert" and "supported type" in task.get("name", "")]
    return task


# ---------------------------------------------------------------------------
# the legacy flow cut after its check
# ---------------------------------------------------------------------------


def make_legacy_flow(path, root):
    """The legacy file cut after its import of the check, and the check next to it."""
    entries = entries_of(path)
    index = check_import_index(entries)
    directory = root / path.split("/")[0]
    directory.mkdir()
    (root / "cmn").mkdir(exist_ok=True)
    shutil.copy(CHECK, root / "cmn" / CHECK.name)
    playbook = directory / "legacy.yml"
    playbook.write_text(yaml.safe_dump(entries[: index + 1], sort_keys=False))
    return playbook


def fatal_messages(output):
    """host -> the msg of its fatal line."""
    messages = {}
    for host, body in re.findall(r"^fatal: \[([^\]]+)\]: FAILED! => (\{.*\})$", output, re.M):
        messages[host] = json.loads(body).get("msg")
    return messages


def warned_hosts(output):
    return set(re.findall(r"WARNING (\S+):", output))


class LegacyResult:
    def __init__(self, process, hosts):
        self.output = process.stdout
        self.returncode = process.returncode
        self.messages = fatal_messages(process.stdout)
        self.warned = warned_hosts(process.stdout)
        self.hosts = hosts

    def stopped(self, name):
        return name in self.messages

    def passed(self, name):
        """The host got through the stop task of the check: its last task is skipped for it."""
        block = next((part for part in re.split(r"\n(?=TASK \[|PLAY RECAP|PLAY \[)", self.output)
                      if part.startswith("TASK [Stop on a version that Alpenglow does not run on]")), "")
        return re.search(r"^skipping: \[%s\]" % re.escape(name), block, re.M) is not None


def client_hosts(path):
    """Hosts of the natural type of the flow and of another family, with the version of the host for the client of the flow
    (none, at the floor, below it, empty), and the version of another client."""
    flow = LEGACY[path]
    network = network_of(flow["section"])
    client = flow["client"]
    var = OWN_KEY[client]
    good = {"agave": "5.0.0", "jito": "5.0.0-jito", "allnodes": "5.0.0-allnodes"}[client]
    old = {"agave": "3.1.10", "jito": "3.1.10-jito", "allnodes": "3.1.10-allnodes"}[client]
    other = OWN_KEY["agave" if client != "agave" else "jito"]
    hosts = {}
    for label, validator_type in (("natural", natural_type(path)), ("other", other_type(path))):
        base = {"validator_type": validator_type}
        if path.startswith("mainnet-rpc/"):
            base["rpc_type"] = "Index RPC"  # no plugin: the plugin has a scenario of its own
        hosts["%s-plain" % label] = dict(base)
        hosts["%s-host-good" % label] = dict(base, **{var: good})
        hosts["%s-host-old" % label] = dict(base, **{var: old})
        hosts["%s-host-empty" % label] = dict(base, **{var: ""})
        hosts["%s-other-client-old" % label] = dict(base, **{other: "3.1.10"})
    return hosts


@functools.lru_cache(maxsize=None)
def run_legacy(path, pin_set, extra=()):
    """The legacy file cut after the check, for the hosts of client_hosts, with the pins of a pin set; extra is a tuple of
    (variable, value) passed with -e."""
    with tempfile.TemporaryDirectory(prefix="slv-legacy-") as tmp:
        root = Path(tmp)
        home = make_home(root, make_floor_versions(LEGACY[path]["section"], pins_of_set(LEGACY[path]["section"], pin_set)))
        playbook = make_legacy_flow(path, root)
        hosts = client_hosts(path)
        write_inventory(root / "inventory.json", hosts)
        args = ["-i", "inventory.json", playbook]
        for key, value in extra:
            args += ["-e", "%s=%s" % (key, value)]
        return LegacyResult(run_ansible(args, root, home), hosts)


def expected(path, pin_set, variables, name, extra=()):
    """What the check has to do for a host: ("pass",), ("warn",) or ("stop", words of the message)."""
    flow = LEGACY[path]
    client = flow["client"]
    network = network_of(flow["section"])
    var = OWN_KEY[client]
    pin = pins_of_set(flow["section"], pin_set)[CLIENTS.index(client)]
    from_e = dict(extra).get(var)
    from_host = variables.get(var)
    # install_*.yml of the validator networks set the version as a play variable: -e beats it, the host is shadowed;
    # install_jito.yml of mainnet-rpc reads -e, then the host, then the pin
    override = from_e if from_e not in (None, "") else (from_host if flow["installer"] == "host" else None)
    text = str(override) if override not in (None, "") else (pin or "")
    if text == "":
        return ("stop", "No %s version for %s" % (LABEL[client], name))
    if read(text) is None:
        return ("stop", "is not a version") if network == "mainnet" else ("warn",)
    return ("stop", "is older than Alpenglow runs on") if below(text, network) else ("pass",)


# ---------------------------------------------------------------------------
# the tests
# ---------------------------------------------------------------------------


class LegacyEntriesBeginAsInitDoes(unittest.TestCase):
    def test_l01_each_legacy_entry_begins_with_the_type_gate_of_init_and_imports_the_check_before_it_changes_anything(self):
        read_only = {"assert", "fail", "set_fact", "debug"}
        for path, flow in LEGACY.items():
            entries = entries_of(path)
            init = entries_of(flow["init"])
            index = check_import_index(entries)
            with self.subTest(path):
                # the gate is the one of init.yml: the same play settings and the same assert
                for key in ("name", "hosts", "gather_facts", "any_errors_fatal"):
                    self.assertEqual(gate_play(entries)[key], gate_play(init)[key], key)
                self.assertEqual(gate_task(entries), gate_task(init))
                # then the check, with the section of the flow and the client the flow installs
                self.assertEqual(entries[index]["vars"]["versions_section"], flow["section"])
                self.assertEqual(entries[index]["vars"]["floor_client"], flow["client"])
                self.assertNotIn("when", entries[index], "every host is checked")
                # nothing that changes a host comes before it
                for earlier in entries[:index]:
                    self.assertNotIn("import_playbook", earlier)
                    for task in earlier["tasks"]:
                        self.assertIn(module_of(task)[0], read_only, "%s changes the host before the check" % task.get("name"))
                # the variable that the installer sets as a play variable is passed as the pin of the section, so that the
                # version of the host, which the installer does not read, does not count and -e, which it reads, does
                if flow["installer"] == "-e":
                    self.assertEqual(
                        entries[index]["vars"][OWN_KEY[flow["client"]]],
                        "{{ (%s | default({})).get('version_%s', '') }}" % (flow["section"], {"agave": "agave", "jito": "jito", "allnodes": "allnodes_jito"}[flow["client"]]),
                    )
                else:
                    self.assertNotIn(OWN_KEY[flow["client"]], entries[index]["vars"])

    def test_l02_the_installers_set_the_version_the_way_the_flows_say(self):
        # install_*.yml of the validator networks put the version in a play variable (the host is shadowed, -e wins);
        # install_jito.yml of mainnet-rpc resolves the host, then the pin, in a task
        for installer, variable in (("mainnet-validator/install_jito.yml", "jito_version"), ("testnet-validator/install_jito.yml", "jito_version"),
                                    ("testnet-validator/install_agave.yml", "agave_version"), ("mainnet-validator/install_allnodes_jito.yml", "allnodes_jito_version")):
            play = entries_of(installer)[-1]  # the installer follows the import of the check, when it has one
            with self.subTest(installer):
                self.assertIn(variable, play["vars"])
        play = entries_of("mainnet-rpc/install_jito.yml")[-1]
        self.assertNotIn("jito_version", play["vars"])
        self.assertIn("jito_version | default(", yaml.safe_dump(play["tasks"][0]))


class LegacyGatesAreTheGatesOfInit(unittest.TestCase):
    def test_l03_a_validator_type_is_stopped_by_a_legacy_entry_with_the_words_of_init_and_let_through_when_init_lets_it_through(self):
        for path, flow in LEGACY.items():
            hosts = gate_hosts(flow["init"])
            init_result = run_flow(flow["init"], "gate", "good")
            with tempfile.TemporaryDirectory(prefix="slv-legacy-gate-") as tmp:
                root = Path(tmp)
                home = make_home(root, make_floor_versions(flow["section"], pins_of_set(flow["section"], "good")))
                playbook = make_legacy_flow(path, root)
                write_inventory(root / "inventory.json", hosts)
                result = LegacyResult(run_ansible(["-i", "inventory.json", playbook], root, home), hosts)
            init_messages = fatal_messages(next(iter(init_result.values())).output)
            for name, variables in hosts.items():
                value = variables.get("validator_type", MISSING)
                with self.subTest("%s %r" % (path, value if value is not MISSING else "<missing>")):
                    self.assertEqual(result.messages.get(name), init_messages.get(name))


class LegacyEntriesCheckTheFloor(unittest.TestCase):
    def test_l04_the_client_the_flow_installs_is_checked_whatever_validator_type_says(self):
        prefetch(run_legacy, [(path, pin_set) for path in LEGACY for pin_set in PIN_SETS])
        for path in LEGACY:
            for pin_set in PIN_SETS:
                result = run_legacy(path, pin_set)
                for name, variables in client_hosts(path).items():
                    want = expected(path, pin_set, variables, name)
                    with self.subTest("%s %s %s" % (path, pin_set, name)):
                        if want[0] == "stop":
                            self.assertTrue(result.stopped(name), result.output[-1500:])
                            self.assertIn(want[1], result.messages[name])
                        else:
                            self.assertFalse(result.stopped(name), result.messages.get(name))
                            self.assertTrue(result.passed(name), result.output[-1500:])
                            self.assertEqual(name in result.warned, want[0] == "warn")

    def test_l05_a_version_given_with_e_counts_and_the_version_of_the_host_counts_only_where_the_installer_reads_it(self):
        cases = []
        for path, flow in LEGACY.items():
            var = OWN_KEY[flow["client"]]
            old = {"agave": "3.1.10", "jito": "3.1.10-jito", "allnodes": "3.1.10-allnodes"}[flow["client"]]
            good = {"agave": "5.0.0", "jito": "5.0.0-jito", "allnodes": "5.0.0-allnodes"}[flow["client"]]
            cases += [(path, "good", ((var, old),)), (path, "old", ((var, good),))]
        prefetch(run_legacy, cases)
        for path, pin_set, extra in cases:
            result = run_legacy(path, pin_set, extra)
            for name, variables in client_hosts(path).items():
                want = expected(path, pin_set, variables, name, extra)
                with self.subTest("%s %s -e %s %s" % (path, pin_set, dict(extra), name)):
                    self.assertEqual(result.stopped(name), want[0] == "stop", result.output[-1500:])
                    if want[0] == "stop":
                        self.assertIn(want[1], result.messages[name])

    def test_l06_init_old_checks_the_yellowstone_plugin_it_builds(self):
        path = "mainnet-rpc/init-old.yml"
        for geyser, label in ((GOOD_GEYSER["mainnet"], "good"), (OLD_GEYSER["mainnet"], "old")):
            hosts = {}
            for validator_type in ("jito", "agave", "firedancer-jito"):
                for rpc_type in ("Geyser gRPC", "Index RPC"):
                    for plugin in (None, "richat"):
                        variables = {"validator_type": validator_type, "rpc_type": rpc_type}
                        if plugin:
                            variables["geyser_plugin"] = plugin
                        hosts["%s-%s-%s" % (validator_type, rpc_type.split()[0].lower(), plugin or "unset")] = variables
            with tempfile.TemporaryDirectory(prefix="slv-legacy-geyser-") as tmp:
                root = Path(tmp)
                home = make_home(root, make_floor_versions("mainnet_rpcs", pins_of_set("mainnet_rpcs", "good"), geyser))
                playbook = make_legacy_flow(path, root)
                write_inventory(root / "inventory.json", hosts)
                result = LegacyResult(run_ansible(["-i", "inventory.json", playbook], root, home), hosts)
            for name, variables in hosts.items():
                # geyser_build.yml of init-old.yml builds the plugin for a Geyser gRPC node whatever its type and plugin say
                stops = label == "old" and variables["rpc_type"] == "Geyser gRPC"
                with self.subTest("%s %s" % (label, name)):
                    self.assertEqual(result.stopped(name), stops, result.output[-1500:])
                    if stops:
                        self.assertIn("Yellowstone geyser_version %s" % OLD_GEYSER["mainnet"], result.messages[name])


class MainnetFiredancerPlaybooksRefuse(unittest.TestCase):
    def test_l07_each_playbook_that_sets_up_or_updates_firedancer_on_mainnet_stops_every_host_before_anything_is_changed_with_the_words_of_the_cli(self):
        guard = (REPOSITORY / "cli" / "lib" / "fdctlMainnetGuard.ts").read_text()
        note = re.search(r"const ALPENGLOW_NOTE =\s*'([^']+)'", guard).group(1)
        way_out = re.search(r"const WAY_OUT =\s*'([^']+)'", guard).group(1)
        hosts = {}
        for number, value in enumerate(["firedancer-agave", "firedancer-jito", "frankendancer", "firedancer", "agave", "jito", "allnodes-jito", "bogus", "", None, MISSING]):
            variables = {} if value is MISSING else {"validator_type": value}
            hosts["f%02d" % number] = variables
        for path, verb in MAINNET_FIREDANCER.items():
            entries = entries_of(path)
            with self.subTest(path):
                self.assertEqual(entries[0]["name"], "Refuse Firedancer on mainnet")
                self.assertTrue(entries[0]["any_errors_fatal"])
                with tempfile.TemporaryDirectory(prefix="slv-legacy-firedancer-") as tmp:
                    root = Path(tmp)
                    home = make_home(root, make_floor_versions("mainnet_validators", pins_of_set("mainnet_validators", "good")))
                    directory = root / "mainnet-validator"
                    directory.mkdir()
                    playbook = directory / "legacy.yml"
                    # only the first play: the rest of the file imports playbooks that its directory does not hold
                    playbook.write_text(yaml.safe_dump(entries[:1], sort_keys=False))
                    write_inventory(root / "inventory.json", hosts)
                    result = LegacyResult(run_ansible(["-i", "inventory.json", playbook], root, home), hosts)
                self.assertNotEqual(result.returncode, 0)
                for name in hosts:
                    with self.subTest("%s %s" % (path, name)):
                        self.assertEqual(
                            result.messages[name],
                            "A mainnet voting validator cannot be Firedancer or Frankendancer, and this playbook %s Firedancer. %s %s Nothing was changed on %s." % (verb, note, way_out, name),
                        )


if __name__ == "__main__":
    unittest.main()
