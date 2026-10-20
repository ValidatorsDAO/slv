"""Tests of the install playbooks that a CLI command runs on their own, which hold the version they install to the floor.

init.yml of the validator and RPC networks stops, before it changes anything, a client older than the Alpenglow floor of its
network (cmn/check_alpenglow_floor.yml). `slv v build:solana` and `slv r build:solana` run install_solana.yml of the network,
which dispatches to install_agave.yml and install_jito.yml (and install_allnodes_jito.yml for validators), and `slv v install:solana
-v <version>` runs cmn/install_solana.yml, all without init.yml. Each of them begins with the same check, for the version that
it is going to install, and so does each of the installers when it is run directly:

  validator networks   the installers set the version as a play variable: -e wins, the version of the host is not read,
                       else the pin of the section is installed. The check is told the pin as that variable.
  RPC networks         the installers read agave_version or jito_version of the host or -e, else the pin of the section.
                       They build no Yellowstone plugin, so none is checked (floor_plugin: false).
  install_solana.yml   dispatches on validator_type, so the check reads the client of the type of each host.
  cmn/install_solana.yml  (deprecated) installs `version` of the host or -e, else the pin of the section that the group of the
                       host names, and has no version to fall back on.
  cmn/patch_sha256.yml   `slv patch:sha256` builds the source tag solana_version, which only -e gives: with none it stops, the
                       solana_version of the inventory is not taken, and the tag is held to the floor of the network that the
                       group of the host names. The patch play is recorded here, not run.

Like test_alpenglow_floor.py, whose helpers they take, the tests run the real ansible-playbook on this machine over a local
connection, without become, sudo, a network or a host, on each file cut after its import of the check. Run from the repository
root:

    python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_*.py' -v
"""

import copy
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
    CLIENT_OF,
    CLIENTS,
    GOOD_GEYSER,
    LABEL,
    OLD_GEYSER,
    OWN_KEY,
    RPC_SECTIONS,
    SECTION_NETWORK,
    below,
    check_import_index,
    make_floor_versions,
    network_of,
    pins_of_set,
    read,
)
from test_init_geyser_plugin import (  # noqa: E402
    ANSIBLE_DIR,
    WRITE_DOWN,
    make_home,
    module_of,
    prefetch,
    read_logs,
    recorded_copy_of,
    run_ansible,
    write_inventory,
)
from test_legacy_inits import LegacyResult  # noqa: E402

PIN_EXPRESSION = "{{ (%s | default({})).get('version_%s', '') }}"

# The install playbooks of each network and role: the section of versions.yml they read, the client they install (None: the
# client of validator_type of each host, which install_solana.yml dispatches on), and where the installer reads the version
# from besides the pin: "-e" for the validator networks, which set it as a play variable, "host" for the RPC networks.
INSTALLERS = {}
for _network, _role, _section in (
    ("mainnet", "validator", "mainnet_validators"), ("testnet", "validator", "testnet_validators"),
    ("mainnet", "rpc", "mainnet_rpcs"), ("testnet", "rpc", "testnet_rpcs"), ("devnet", "rpc", "devnet_rpcs"),
):
    for _name, _client in (("install_solana", None), ("install_agave", "agave"), ("install_jito", "jito")):
        INSTALLERS["%s-%s/%s.yml" % (_network, _role, _name)] = {
            "section": _section, "client": _client, "reads": "-e" if _role == "validator" else "host",
        }
# mainnet-validator/install_allnodes_jito.yml sets the version as a play variable too (the tag, with -allnodes added when it is missing)
INSTALLERS["mainnet-validator/install_allnodes_jito.yml"] = {"section": "mainnet_validators", "client": "allnodes", "reads": "-e"}
INSTALLERS["testnet-validator/install_allnodes_jito.yml"] = {"section": "testnet_validators", "client": "allnodes", "reads": "-e"}
# the client of each installer in its pin key of the section (allnodes is version_allnodes_jito)
PIN_SUFFIX = {"agave": "agave", "jito": "jito", "allnodes": "allnodes_jito"}

GOOD = {"agave": "5.0.0", "jito": "5.0.0-jito", "allnodes": "5.0.0-allnodes"}
OLD = {"agave": "3.1.10", "jito": "3.1.10-jito", "allnodes": "3.1.10-allnodes"}


def entries_of(path):
    return yaml.safe_load((ANSIBLE_DIR / path).read_text())


def types_of(path):
    """The validator_type of the hosts that the file is run for: both families, and allnodes-jito where it is installed."""
    flow = INSTALLERS[path]
    if flow["client"] is None:
        return ("agave", "jito", "allnodes-jito") if flow["section"].endswith("_validators") else ("agave", "jito")
    return ("agave", "jito")


# ---------------------------------------------------------------------------
# the file cut after its check
# ---------------------------------------------------------------------------


def make_install_flow(path, root):
    """The install playbook cut after its import of the check, and the check next to it."""
    entries = entries_of(path)
    index = check_import_index(entries)
    directory = root / path.split("/")[0]
    directory.mkdir()
    (root / "cmn").mkdir(exist_ok=True)
    shutil.copy(CHECK, root / "cmn" / CHECK.name)
    playbook = directory / "install.yml"
    playbook.write_text(yaml.safe_dump(entries[: index + 1], sort_keys=False))
    return playbook


def install_hosts(path):
    """Hosts of the types the file is run for, with the version of the host for the client the file installs (none, at the
    floor, below it, empty), and the version of another client."""
    flow = INSTALLERS[path]
    hosts = {}
    for validator_type in types_of(path):
        client = flow["client"] or CLIENT_OF[validator_type]
        other = "jito" if client == "agave" else "agave"
        base = {"validator_type": validator_type}
        if flow["section"] in RPC_SECTIONS:
            base["rpc_type"] = "Index RPC"  # no plugin: the plugin has a scenario of its own
        hosts["%s-plain" % validator_type] = dict(base)
        hosts["%s-host-good" % validator_type] = dict(base, **{OWN_KEY[client]: GOOD[client]})
        hosts["%s-host-old" % validator_type] = dict(base, **{OWN_KEY[client]: OLD[client]})
        hosts["%s-host-empty" % validator_type] = dict(base, **{OWN_KEY[client]: ""})
        hosts["%s-other-old" % validator_type] = dict(base, **{OWN_KEY[other]: OLD[other]})
    return hosts


@functools.lru_cache(maxsize=None)
def run_install(path, pin_set, extra=()):
    """The install file cut after the check, for the hosts of install_hosts, with the pins of a pin set; extra is a tuple of
    (variable, value) passed with -e."""
    section = INSTALLERS[path]["section"]
    with tempfile.TemporaryDirectory(prefix="slv-install-") as tmp:
        root = Path(tmp)
        home = make_home(root, make_floor_versions(section, pins_of_set(section, pin_set)))
        playbook = make_install_flow(path, root)
        hosts = install_hosts(path)
        write_inventory(root / "inventory.json", hosts)
        args = ["-i", "inventory.json", playbook]
        for key, value in extra:
            args += ["-e", "%s=%s" % (key, value)]
        return LegacyResult(run_ansible(args, root, home), hosts)


def expected(path, pin_set, variables, extra=()):
    """What the check has to do for a host: ("pass",), ("warn",) or ("stop", words of the message)."""
    flow = INSTALLERS[path]
    network = network_of(flow["section"])
    client = flow["client"] or CLIENT_OF[variables["validator_type"]]
    var = OWN_KEY[client]
    pin = pins_of_set(flow["section"], pin_set)[CLIENTS.index(client)]
    from_e = dict(extra).get(var)
    from_host = variables.get(var)
    # the validator installers set the version as a play variable: -e beats it and the host is shadowed; the RPC installers
    # read -e, then the host, then the pin
    override = from_e if from_e not in (None, "") else (from_host if flow["reads"] == "host" else None)
    text = str(override) if override not in (None, "") else (pin or "")
    if text == "":
        return ("stop", "No %s version for" % LABEL[client])
    if read(text) is None:
        return ("stop", "is not a version") if network == "mainnet" else ("warn",)
    return ("stop", "is older than Alpenglow runs on") if below(text, network) else ("pass",)


def pin_sets_of(path):
    """The pin sets that tell the hosts apart: for a file that installs one client, the pin of that client is all that
    counts; install_solana.yml reads the client of each host."""
    if INSTALLERS[path]["client"] is None:
        return ("good", "old", "none", "agave-old", "jito-old")
    return ("good", "old", "none")


# -e versions that all hosts get, for every client: below the floor over pins at it, and well above it over pins below it
E_CASES = (("good", tuple((OWN_KEY[c], OLD[c]) for c in CLIENTS)), ("old", tuple((OWN_KEY[c], GOOD[c]) for c in CLIENTS)))


# ---------------------------------------------------------------------------
# the tests
# ---------------------------------------------------------------------------


class InstallPlaybooksBeginWithTheCheck(unittest.TestCase):
    def test_i01_each_install_playbook_imports_the_check_first_for_the_version_it_installs(self):
        for path, flow in INSTALLERS.items():
            entries = entries_of(path)
            with self.subTest(path):
                index = check_import_index(entries)
                self.assertEqual(index, 0, "nothing comes before the check")
                imported = entries[index]
                self.assertNotIn("when", imported, "every host is checked")
                variables = imported["vars"]
                self.assertEqual(variables["versions_section"], flow["section"])
                if flow["client"] is None:
                    self.assertNotIn("floor_client", variables, "the client is the one of validator_type of each host")
                else:
                    self.assertEqual(variables["floor_client"], flow["client"])
                # RPC installers build no Yellowstone plugin; the validator networks have none to check
                if flow["section"] in RPC_SECTIONS:
                    self.assertIs(variables["floor_plugin"], False)
                else:
                    self.assertNotIn("floor_plugin", variables)
                # the validator installers set the version as a play variable, so the check is told the pin of the section
                # under that name and the version of the host does not count; the RPC installers read the host
                told = {key for key in variables if key in OWN_KEY.values()}
                if flow["reads"] == "-e":
                    clients = [flow["client"]] if flow["client"] else [
                        client for client in CLIENTS
                        if client != "allnodes" or flow["section"].endswith("_validators")
                    ]
                    self.assertEqual(told, {OWN_KEY[client] for client in clients})
                    for client in clients:
                        self.assertEqual(variables[OWN_KEY[client]], PIN_EXPRESSION % (flow["section"], PIN_SUFFIX[client]))
                else:
                    self.assertEqual(told, set())

    def test_i02_the_validator_installers_set_the_version_as_a_play_variable_and_the_rpc_installers_read_the_host(self):
        for path, flow in INSTALLERS.items():
            if flow["client"] is None:
                continue
            play = entries_of(path)[-1]
            variable = OWN_KEY[flow["client"]]
            with self.subTest(path):
                if flow["client"] == "allnodes":
                    self.assertIn(variable, play["vars"])
                elif flow["reads"] == "-e":
                    self.assertEqual(play["vars"][variable], "v{{ %s.version_%s }}" % (flow["section"], flow["client"]))
                else:
                    self.assertNotIn(variable, play["vars"])
                    self.assertIn("%s | default(%s.version_%s" % (variable, flow["section"], flow["client"]), yaml.safe_dump(play["tasks"][0]))


class InstallPlaybooksCheckTheFloor(unittest.TestCase):
    def test_i03_the_version_that_an_installer_installs_is_held_to_the_floor_of_its_network(self):
        prefetch(run_install, [(path, pin_set) for path in INSTALLERS for pin_set in pin_sets_of(path)])
        for path in INSTALLERS:
            for pin_set in pin_sets_of(path):
                result = run_install(path, pin_set)
                for name, variables in install_hosts(path).items():
                    want = expected(path, pin_set, variables)
                    with self.subTest("%s %s %s" % (path, pin_set, name)):
                        if want[0] == "stop":
                            self.assertTrue(result.stopped(name), result.output[-1500:])
                            self.assertIn(want[1], result.messages[name])
                            self.assertIn("Nothing was changed", result.messages[name])
                        else:
                            self.assertFalse(result.stopped(name), result.messages.get(name))
                            self.assertTrue(result.passed(name), result.output[-1500:])
                            self.assertEqual(name in result.warned, want[0] == "warn")

    def test_i04_a_version_given_with_e_counts_and_the_version_of_the_host_counts_only_where_the_installer_reads_it(self):
        cases = [(path, pin_set, extra) for path in INSTALLERS for pin_set, extra in E_CASES]
        prefetch(run_install, cases)
        for path, pin_set, extra in cases:
            result = run_install(path, pin_set, extra)
            for name, variables in install_hosts(path).items():
                want = expected(path, pin_set, variables, extra)
                with self.subTest("%s %s -e %s %s" % (path, pin_set, dict(extra), name)):
                    self.assertEqual(result.stopped(name), want[0] == "stop", result.output[-1500:])
                    if want[0] == "stop":
                        self.assertIn(want[1], result.messages[name])

    def test_i05_the_rpc_installers_build_no_plugin_and_check_none(self):
        for path, flow in INSTALLERS.items():
            if flow["section"] not in RPC_SECTIONS:
                continue
            section, network = flow["section"], network_of(flow["section"])
            hosts = {}
            for validator_type in ("agave", "jito"):
                for rpc_type in ("Geyser gRPC", "Index RPC + gRPC"):
                    hosts["%s-%s-pin" % (validator_type, rpc_type.split()[0].lower())] = {"validator_type": validator_type, "rpc_type": rpc_type}
                    hosts["%s-%s-host" % (validator_type, rpc_type.split()[0].lower())] = {
                        "validator_type": validator_type, "rpc_type": rpc_type, "geyser_version": OLD_GEYSER[network]}
            with self.subTest(path):
                with tempfile.TemporaryDirectory(prefix="slv-install-geyser-") as tmp:
                    root = Path(tmp)
                    home = make_home(root, make_floor_versions(section, pins_of_set(section, "good"), OLD_GEYSER[network]))
                    playbook = make_install_flow(path, root)
                    write_inventory(root / "inventory.json", hosts)
                    result = LegacyResult(run_ansible(["-i", "inventory.json", playbook], root, home), hosts)
                self.assertEqual(result.returncode, 0, result.output[-1500:])
                for name in hosts:
                    self.assertTrue(result.passed(name), "%s: %s" % (name, result.output[-1500:]))
                    self.assertNotIn("Yellowstone", result.output)
                self.assertNotEqual(OLD_GEYSER[network], GOOD_GEYSER[network])


# ---------------------------------------------------------------------------
# cmn/install_solana.yml
# ---------------------------------------------------------------------------

CMN_INSTALL = "cmn/install_solana.yml"
SECTIONS = tuple(SECTION_NETWORK)


def make_cmn_install_flow(root):
    """cmn/install_solana.yml cut after its import of the check, and the check next to it."""
    entries = entries_of(CMN_INSTALL)
    (index,) = [number for number, entry in enumerate(entries) if entry.get("import_playbook") == "check_alpenglow_floor.yml"]
    cmn = root / "cmn"
    cmn.mkdir()
    shutil.copy(CHECK, cmn / CHECK.name)
    playbook = cmn / "install_solana.yml"
    playbook.write_text(yaml.safe_dump(entries[: index + 1], sort_keys=False))
    return playbook


def write_grouped_inventory(path, hosts):
    """hosts maps a name to (groups, variables)."""
    local = {"ansible_connection": "local", "ansible_python_interpreter": sys.executable}
    children = {}
    for name, (groups, _variables) in hosts.items():
        for group in groups:
            children.setdefault(group, {"hosts": {}})["hosts"][name] = {}
    inventory = {"all": {"hosts": {name: dict(variables, **local) for name, (_groups, variables) in hosts.items()}, "children": children}}
    path.write_text(json.dumps(inventory))  # JSON is YAML


def cmn_hosts():
    """Hosts of each section, of both families, with the version of the host (none, at the floor, below it, empty), and a
    host whose solana_cli_type says jito over a validator_type of agave."""
    hosts = {}
    for section in SECTIONS:
        for client in ("agave", "jito"):
            base = {"validator_type": client}
            hosts["%s-%s-plain" % (section, client)] = ([section], dict(base))
            hosts["%s-%s-v-good" % (section, client)] = ([section], dict(base, version="v" + GOOD[client]))
            hosts["%s-%s-v-old" % (section, client)] = ([section], dict(base, version="v" + OLD[client]))
            hosts["%s-%s-v-empty" % (section, client)] = ([section], dict(base, version=""))
        hosts["%s-cli-jito" % section] = ([section], {"validator_type": "agave", "solana_cli_type": "jito"})
    return hosts


@functools.lru_cache(maxsize=None)
def run_cmn_install(pin_set, extra=(), only=None):
    """cmn/install_solana.yml cut after the check, for the hosts of cmn_hosts (or the one named in only, which is then not
    in the section) with the pins of a pin set for every section."""
    with tempfile.TemporaryDirectory(prefix="slv-cmn-install-") as tmp:
        root = Path(tmp)
        versions = {section: make_floor_versions(section, pins_of_set(section, pin_set))[section] for section in SECTIONS}
        home = make_home(root, versions)
        playbook = make_cmn_install_flow(root)
        hosts = cmn_hosts()
        if only is not None:
            hosts = {only: EXTRA_HOSTS[only]}
        write_grouped_inventory(root / "inventory.json", hosts)
        args = ["-i", "inventory.json", playbook]
        for key, value in extra:
            args += ["-e", "%s=%s" % (key, value)]
        return LegacyResult(run_ansible(args, root, home), hosts)


# a host that is in no section, and one that is in two of them: each stops the play on its own, so each has a run of its own
EXTRA_HOSTS = {
    "nowhere": ([], {"validator_type": "agave", "version": "v" + GOOD["agave"]}),
    "two-sections": (["mainnet_validators", "mainnet_rpcs"], {"validator_type": "agave", "version": "v" + GOOD["agave"]}),
}


def stop_messages(output):
    """host -> the msg of its fatal line; an assert prints its result over several lines, a fail on one."""
    return {
        host: json.loads(body).get("msg")
        for host, body in re.findall(r"^fatal: \[([^\]]+)\]: FAILED! => (\{.*?\})$", output, re.M | re.S)
    }


def expected_for_cmn_host(name, groups, variables, pin_set, extra=()):
    (section,) = groups
    network = network_of(section)
    client = variables.get("solana_cli_type") or ("jito" if "jito" in variables.get("validator_type", "agave") else "agave")
    pin = pins_of_set(section, pin_set)[CLIENTS.index(client)]
    version = dict(extra).get("version", variables.get("version"))
    text = str(version) if version not in (None, "") else (pin or "")
    if text == "":
        return ("stop", "No %s version for" % LABEL[client])
    if read(text) is None:
        return ("stop", "is not a version") if network == "mainnet" else ("warn",)
    return ("stop", "is older than Alpenglow runs on") if below(text, network) else ("pass",)


class DeprecatedInstallSolanaChecksTheVersion(unittest.TestCase):
    def test_i06_it_has_no_version_to_fall_back_on(self):
        text = (ANSIBLE_DIR / CMN_INSTALL).read_text()
        self.assertNotIn("v3.0.12", text)
        self.assertNotIn("default_version", text)
        entries = entries_of(CMN_INSTALL)
        (index,) = [number for number, entry in enumerate(entries) if entry.get("import_playbook") == "check_alpenglow_floor.yml"]
        # what comes before the check changes nothing: the play that works out the section and the client
        self.assertEqual(index, 1)
        for task in entries[0]["tasks"]:
            self.assertIn(module_of(task)[0], {"assert", "set_fact"})
        variables = entries[index]["vars"]
        self.assertEqual(variables["floor_version_var"], "version")
        self.assertIs(variables["floor_plugin"], False)
        self.assertNotIn("when", entries[index])

    def test_i07_the_version_it_installs_is_held_to_the_floor_of_the_section_of_the_group_of_the_host(self):
        scenarios = [(pin_set, ()) for pin_set in ("good", "old", "none")]
        scenarios += [("good", (("version", "v" + OLD["agave"]),)), ("old", (("version", "v" + GOOD["agave"]),))]
        prefetch(run_cmn_install, scenarios)
        for pin_set, extra in scenarios:
            result = run_cmn_install(pin_set, extra)
            for name, (groups, variables) in cmn_hosts().items():
                want = expected_for_cmn_host(name, groups, variables, pin_set, extra)
                with self.subTest("%s -e %s %s" % (pin_set, dict(extra), name)):
                    if want[0] == "stop":
                        self.assertTrue(result.stopped(name), result.output[-1500:])
                        self.assertIn(want[1], result.messages[name])
                        self.assertIn("Nothing was changed", result.messages[name])
                    else:
                        self.assertFalse(result.stopped(name), result.messages.get(name))
                        self.assertTrue(result.passed(name), result.output[-1500:])
                        self.assertEqual(name in result.warned, want[0] == "warn")

    def test_i08_a_host_that_is_in_no_section_or_in_two_stops_the_run_before_anything_is_changed(self):
        prefetch(run_cmn_install, [("good", (), name) for name in EXTRA_HOSTS])
        for name in EXTRA_HOSTS:
            result = run_cmn_install("good", (), name)
            with self.subTest(name):
                self.assertNotEqual(result.returncode, 0)
                message = stop_messages(result.output)[name]
                self.assertIn("exactly one of the groups mainnet_validators", message)
                self.assertIn("Nothing was changed", message)


# ---------------------------------------------------------------------------
# cmn/patch_sha256.yml
# ---------------------------------------------------------------------------

PATCH = "cmn/patch_sha256.yml"
PATCH_PLAY = "Patch Solana Validator with optimized SHA256 (no restart)"
# the version of the source tag, with -e: none, empty, the default that the playbook used to have (below every floor), a
# release at the floor of mainnet only, a release at every floor, and a value that is no version
PATCH_VERSIONS = (None, "", "v3.1.10-jito", "v4.3.2-jito", "v4.4.0-beta.1-jito", "latest")
# values that are not the form of a release tag (an optional v, then letters, digits, '.', '+' and '-'; no '/', no '..', no
# whitespace) although the floor reads a version out of most of them, and values that are
BAD_TAGS = ("4.3.2-jito/../x", "4.3.2;x", "v4.3.2-jito junk", "$(id)", "v4.3.2-jito\n", " v4.3.2-jito", "v4.3..2-jito",
            "../v4.3.2-jito", "v4.3.2_jito", "v4.3.2-jito'x", "-v4.3.2", "v4.3.2-jito/")
GOOD_TAGS = ("v4.3.2-jito", "4.3.2", "v4.4.0-beta.1-jito+build.5", "v4.3.0-allnodes.1")


def make_patch_flow(root):
    """cmn/patch_sha256.yml with its patch play recorded (what it would change on the host is written down in slv_ran, not
    done), after the play that works the section out and the check, which are as they are; the check next to it."""
    entries = entries_of(PATCH)
    (index,) = [number for number, entry in enumerate(entries) if entry.get("import_playbook") == "check_alpenglow_floor.yml"]
    patch = copy.deepcopy(entries[index + 1])
    assert patch["name"] == PATCH_PLAY and index + 2 == len(entries), "the patch play follows the check and is the last one"
    # a task is written down with its arguments in a string of an expression, and a double quote in them would end that
    # string: the record of a command says it with single quotes
    for task in patch["tasks"]:
        module, arguments = module_of(task)
        if module == "command" and isinstance(arguments, str):
            key = next(name for name in task if name.rsplit(".", 1)[-1] == "command")
            task[key] = arguments.replace('"', "'")
    cmn = root / "cmn"
    cmn.mkdir()
    shutil.copy(CHECK, cmn / CHECK.name)
    playbook = cmn / "patch_sha256.yml"
    playbook.write_text(yaml.safe_dump(entries[: index + 1] + [recorded_copy_of(patch)] + yaml.safe_load(WRITE_DOWN), sort_keys=False))
    return playbook


def is_jito_based(variables):
    validator_type = variables.get("validator_type", "")
    return "jito" in validator_type or validator_type == "firedancer"


def patch_hosts(section):
    """Hosts of one section, of every kind of validator_type, and hosts that carry a solana_version of their own (a good one
    and one below every floor, as the testnet hosts carry one for the snapshot finder)."""
    hosts = {}
    for validator_type in ("agave", "jito", "firedancer", "allnodes-jito", None):
        variables = {} if validator_type is None else {"validator_type": validator_type}
        hosts["%s-%s" % (section, validator_type or "untyped")] = ([section], variables)
    hosts["%s-host-good" % section] = ([section], {"validator_type": "jito", "solana_version": "v9.9.9-jito"})
    hosts["%s-host-old" % section] = ([section], {"validator_type": "agave", "solana_version": "v3.1.10"})
    return hosts


@functools.lru_cache(maxsize=None)
def run_patch(section, version=None, as_json=False):
    """cmn/patch_sha256.yml cut as make_patch_flow says, for the hosts of patch_hosts, with versions.yml pins at the floor
    (so that a pin that the playbook took in place of -e would show) and -e solana_version=<version> (none when None; as a
    JSON object when as_json, for a value with a space or a newline in it); the result maps each host to a FlowResult, and
    the process is the second item."""
    with tempfile.TemporaryDirectory(prefix="slv-patch-") as tmp:
        root = Path(tmp)
        home = make_home(root, make_floor_versions(section, pins_of_set(section, "good")))
        playbook = make_patch_flow(root)
        logs = root / "logs"
        logs.mkdir()
        hosts = patch_hosts(section)
        write_grouped_inventory(root / "inventory.json", hosts)
        args = ["-i", "inventory.json", playbook, "-e", "slv_log_dir=%s" % logs]
        if version is not None:
            args += ["-e", json.dumps({"solana_version": version}) if as_json else "solana_version=%s" % version]
        process = run_ansible(args, root, home)
        return read_logs(logs, {name: None for name in hosts}, process), process


def expected_patch(section, version):
    """What the playbook has to do for a host of the section run with -e solana_version=<version>: ("pass",), ("warn",) or
    ("stop", words of the message)."""
    if version in (None, ""):
        return ("stop", "needs solana_version")
    network = network_of(section)
    if read(version) is None:
        return ("stop", "is not a version") if network == "mainnet" else ("warn",)
    return ("stop", "is older than Alpenglow runs on") if below(version, network) else ("pass",)


class PatchSha256HasNoDefaultVersionAndChecksTheFloor(unittest.TestCase):
    def test_p01_it_begins_with_the_stop_and_the_check_and_has_no_version_of_its_own(self):
        text = (ANSIBLE_DIR / PATCH).read_text()
        self.assertNotIn("v3.1.10-jito", text)
        self.assertNotIn("default_version", text)
        entries = entries_of(PATCH)
        self.assertEqual(len(entries), 3)
        first, check, patch = entries
        # the play before the check changes nothing, and it stops every host together
        self.assertTrue(first["any_errors_fatal"])
        self.assertFalse(first["gather_facts"])
        for task in first["tasks"]:
            self.assertIn(module_of(task)[0], {"assert", "set_fact"})
        # the inventory's solana_version is below -e and above nothing: the plays hold an empty one of their own
        self.assertEqual(first["vars"]["solana_version"], "")
        self.assertEqual(patch["vars"]["solana_version"], "")
        # the check reads solana_version, for the section and the client that the first play worked out
        self.assertEqual(check["import_playbook"], "check_alpenglow_floor.yml")
        self.assertEqual(check["vars"], {
            "versions_section": "{{ slv_floor_section }}", "floor_client": "{{ slv_floor_client }}",
            "floor_version_var": "solana_version", "floor_plugin": False,
        })
        self.assertNotIn("when", check)
        # the client is the one the patch builds
        self.assertEqual(first["vars"]["is_jito_based"], patch["vars"]["is_jito_based"])
        self.assertEqual(patch["name"], PATCH_PLAY)

    def test_p02_a_run_without_a_version_or_with_one_below_the_floor_stops_before_anything_is_changed(self):
        sections = tuple(SECTION_NETWORK)
        prefetch(run_patch, [(section, version) for section in sections for version in PATCH_VERSIONS])
        for section in sections:
            for version in PATCH_VERSIONS:
                results, process = run_patch(section, version)
                want = expected_patch(section, version)
                messages = stop_messages(process.stdout)
                for name, (_groups, variables) in patch_hosts(section).items():
                    label = "jito" if is_jito_based(variables) else "agave"
                    with self.subTest("%s -e %r %s" % (section, version, name)):
                        if want[0] == "stop":
                            # the host got nowhere: not one task of the patch was written down
                            self.assertEqual(results[name].imports, [], process.stdout[-1500:])
                            self.assertIn(want[1], messages[name])
                            self.assertIn("Nothing was changed", messages[name])
                            if version not in (None, ""):
                                # the tag that -e gave, not the one of the host, and the client the patch builds
                                self.assertTrue(messages[name].startswith("%s %s" % (label, version)), messages[name])
                                self.assertIn(" on %s (solana_version of the host or -e)" % name, messages[name])
                        else:
                            self.assertNotIn(name, messages)
                            # the host reached the first task of the patch
                            self.assertEqual(results[name].imports[:1], ["apt"], process.stdout[-1500:])
                            self.assertEqual("WARNING %s:" % name in process.stdout, want[0] == "warn")

    def test_p04_a_value_that_is_not_the_form_of_a_release_tag_stops_every_host_before_anything_is_changed(self):
        sections = ("mainnet_validators", "testnet_rpcs")
        prefetch(run_patch, [(section, tag, True) for section in sections for tag in BAD_TAGS + GOOD_TAGS])
        for section in sections:
            for tag in BAD_TAGS:
                results, process = run_patch(section, tag, True)
                messages = stop_messages(process.stdout)
                for name in patch_hosts(section):
                    with self.subTest("%s %r %s" % (section, tag, name)):
                        # the host got nowhere: not one task of the patch was written down
                        self.assertEqual(results[name].imports, [], process.stdout[-1500:])
                        self.assertIn("is not a release tag", messages[name])
                        self.assertIn("Nothing was changed", messages[name])

    def test_p05_a_release_tag_goes_on_to_the_floor_and_the_patch(self):
        # a tag at the floor of mainnet or above it, in the forms that releases and builds are tagged with
        for tag in GOOD_TAGS:
            results, process = run_patch("mainnet_validators", tag, True)
            for name in patch_hosts("mainnet_validators"):
                with self.subTest("%r %s" % (tag, name)):
                    self.assertNotIn(name, stop_messages(process.stdout))
                    self.assertEqual(results[name].imports[:1], ["apt"], process.stdout[-1500:])

    def test_p03_a_host_that_is_in_no_section_or_in_two_stops_the_run_before_anything_is_changed(self):
        for name, groups in (("nowhere", []), ("two-sections", ["mainnet_validators", "mainnet_rpcs"])):
            with self.subTest(name):
                with tempfile.TemporaryDirectory(prefix="slv-patch-groups-") as tmp:
                    root = Path(tmp)
                    home = make_home(root, make_floor_versions("mainnet_validators", pins_of_set("mainnet_validators", "good")))
                    playbook = make_patch_flow(root)
                    logs = root / "logs"
                    logs.mkdir()
                    hosts = {name: (groups, {"validator_type": "jito"})}
                    write_grouped_inventory(root / "inventory.json", hosts)
                    process = run_ansible(["-i", "inventory.json", playbook, "-e", "slv_log_dir=%s" % logs, "-e", "solana_version=v4.3.2-jito"], root, home)
                    self.assertNotEqual(process.returncode, 0)
                    self.assertEqual(read_logs(logs, {name: None}, process)[name].imports, [])
                    message = stop_messages(process.stdout)[name]
                self.assertIn("exactly one of the groups mainnet_validators", message)
                self.assertIn("Nothing was changed", message)


if __name__ == "__main__":
    unittest.main()
