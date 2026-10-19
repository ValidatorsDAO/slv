"""Tests of the Alpenglow floor that the init playbooks of the validator and RPC networks check.

Alpenglow starts on mainnet with epoch 1064, and testnet and devnet already run it. ansible/cmn/check_alpenglow_floor.yml,
which the init.yml of mainnet-validator, testnet-validator and the three RPC networks import right after their type gate,
stops a node that is set to build an agave, jito or allnodes client older than the floor of its network (4.3.0 on
mainnet, 4.4.0-beta.0 on testnet and devnet), or a Yellowstone plugin built for such a release, before anything is changed.
mainnet-validator/init.yml also refuses firedancer-agave, firedancer-jito and frankendancer, which Alpenglow does not
support during the migration.

  vectors   tests/alpenglow_floor_vectors.json lists how a version is read and which networks it is below. The CLI
            (cli/lib/versionFloor.ts) answers the same list. Here the play is run on every case: cut before its two
            last tasks, with the findings written down, and whole, to see which hosts it stops.
  flow      the first play and the import of the check in each of the five init.yml are run as they are, for hosts
            of every validator_type with the pins of a versions.yml, version overrides of the host, and Yellowstone tags.
  parity    the version the check reads for a host is the version that cmn/build_solana.yml builds for it.
  geyser    geyser_build.yml of the three networks builds the geyser_version of the host, else the one of its section.

Like test_init_geyser_plugin.py, whose helpers they take, the tests run the real ansible-playbook on this machine
over a local connection, without become, sudo, a network or a host. Run from the repository root:

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

from test_init_geyser_plugin import (  # noqa: E402
    ANSIBLE_DIR,
    BUILD_CALLERS,
    BUILD_SCENARIOS,
    MISSING,
    RELEASE,
    REPOSITORY,
    builder_probe_copy_of,
    copy_validation_playbook,
    make_home,
    module_of,
    prefetch,
    run_ansible,
    run_build,
    write_inventory,
)

CHECK = ANSIBLE_DIR / "cmn" / "check_alpenglow_floor.yml"
VECTORS = json.loads((RELEASE / "tests" / "alpenglow_floor_vectors.json").read_text())
NETWORKS = ("mainnet", "testnet", "devnet")
FLOORS = VECTORS["floors"]
STOP_TASK = "Stop on a version that Alpenglow does not run on"

# the section of versions.yml of each network and role, and the network of each section
SECTION_NETWORK = {
    "mainnet_validators": "mainnet", "testnet_validators": "testnet",
    "mainnet_rpcs": "mainnet", "testnet_rpcs": "testnet", "devnet_rpcs": "devnet",
}
RPC_SECTIONS = ("mainnet_rpcs", "testnet_rpcs", "devnet_rpcs")
# the section that the vectors are run on, for each network
VECTOR_SECTION = {"mainnet": "mainnet_validators", "testnet": "testnet_validators", "devnet": "devnet_rpcs"}

# the init.yml that import the check, and the section each passes
FLOOR_CALLERS = {
    "mainnet-validator/init.yml": "mainnet_validators",
    "testnet-validator/init.yml": "testnet_validators",
    "mainnet-rpc/init.yml": "mainnet_rpcs",
    "testnet-rpc/init.yml": "testnet_rpcs",
    "devnet-rpc/init.yml": "devnet_rpcs",
}
RPC_CALLERS = tuple(caller for caller, section in FLOOR_CALLERS.items() if section in RPC_SECTIONS)

# The client that each validator_type builds (cmn/build_solana.yml), the variable of the host that names its version, the
# key of the section that pins it, and how the messages call it.
CLIENTS = ("agave", "jito", "allnodes")
CLIENT_OF = {
    "agave": "agave", "firedancer-agave": "agave", "jito": "jito", "firedancer-jito": "jito", "allnodes-jito": "allnodes",
}
OWN_KEY = {"agave": "agave_version", "jito": "jito_version", "allnodes": "allnodes_jito_version"}
PIN_KEY = {"agave": "version_agave", "jito": "version_jito", "allnodes": "version_allnodes_jito"}
LABEL = {"agave": "agave", "jito": "jito", "allnodes": "allnodes-jito"}
FIREDANCER = ("firedancer-agave", "firedancer-jito")
GEYSER_RPC_TYPES = ("Geyser gRPC", "Index RPC + gRPC")

# Pins of a section at the floor of its network, and below it: (agave, jito, allnodes). The RPC sections have no allnodes pin.
GOOD_PINS = {
    "mainnet": ("4.3.0", "4.3.0-jito.0", "4.3.0-allnodes.1"),
    "testnet": ("4.4.0-beta.0", "4.4.0-beta.0-jito", "4.4.0-beta.1-allnodes"),
    "devnet": ("4.4.0-beta.0", "4.4.0-beta.0-jito", None),
}
OLD_PINS = {
    "mainnet": ("4.2.9", "4.2.9-jito", "4.2.9-allnodes"),
    "testnet": ("4.3.2", "4.3.2-jito", "4.3.2-allnodes"),
    "devnet": ("4.3.2", "4.3.2-jito", None),
}
# Yellowstone tags built for the floor, and for the release before it
GOOD_GEYSER = {"mainnet": "v16.1.1+solana.4.3.0", "testnet": "v17.0.0-rc5+solana.4.4.0.beta.0", "devnet": "v17.0.0-rc5+solana.4.4.0.beta.0"}
OLD_GEYSER = {"mainnet": "v15.2.1+solana.4.2.2", "testnet": "v16.1.1+solana.4.3.0", "devnet": "v16.1.1+solana.4.3.0"}


def network_of(section):
    return SECTION_NETWORK[section]


def section_pins(section, pins):
    """The pins (agave, jito, allnodes) that a section can hold: the RPC sections have no allnodes pin."""
    return (pins[0], pins[1], None) if section in RPC_SECTIONS else tuple(pins)


def section_entry(section, pins, geyser):
    """The entry of a section of versions.yml: pins is (agave, jito, allnodes), None for a key that is left out."""
    entry = {"geyser_version": geyser} if section in RPC_SECTIONS else {}
    for client, value in zip(CLIENTS, section_pins(section, pins)):
        if value is not None:
            entry[PIN_KEY[client]] = value
    return entry


def make_floor_versions(section, pins, geyser=None):
    """A versions.yml with the five sections: the one under test has the given pins; the others are at the floor."""
    versions = {}
    for other, network in SECTION_NETWORK.items():
        if other == section:
            versions[other] = section_entry(other, pins, GOOD_GEYSER[network] if geyser is None else geyser)
        else:
            versions[other] = section_entry(other, GOOD_PINS[network], GOOD_GEYSER[network])
    return versions


def check_entries():
    return yaml.safe_load(CHECK.read_text())


def check_import_index(entries):
    found = [number for number, entry in enumerate(entries) if str(entry.get("import_playbook", "")).endswith("cmn/check_alpenglow_floor.yml")]
    assert len(found) == 1, "an init.yml is expected to import cmn/check_alpenglow_floor.yml once, not %d times" % len(found)
    return found[0]


def read(value):
    """The oracle of the tests: how a version is read (the grammar in the vectors file)."""
    match = re.match(r"^v?(\d+)\.(\d+)(?:\.(\d+))?(?:\.\d+)*(?:-(alpha|beta|rc)\.?(\d+)?)?", str(value).strip())
    if not match:
        return None
    major, minor, patch, pre, number = match.groups()
    return [int(major), int(minor), int(patch or 0), VECTORS["rank"][pre] if pre else VECTORS["rank"]["release"], int(number or 0)]


def below(value, network):
    reads = read(value)
    return reads is not None and reads < read(FLOORS[network])


# ---------------------------------------------------------------------------
# findings: the play cut before its last two tasks, with what it found written down
# ---------------------------------------------------------------------------


def findings_copy_of(play):
    """The play without its two last tasks (the one that says what cannot be compared and the one that stops), and a
    task that writes down the findings of the host."""
    tasks = play["tasks"]
    assert module_of(tasks[-1])[0] == "fail" and module_of(tasks[-2])[0] == "debug", "the play is expected to end with debug and fail"
    return dict(play, tasks=tasks[:-2] + [{
        "name": "write the findings down",
        "ansible.builtin.copy": {"content": "{{ slv_alpenglow_findings | to_json }}", "dest": "{{ slv_out }}/{{ inventory_hostname }}.json"},
    }])


def client_vector_hosts(section):
    """One agave host for each client vector, with the version as the host's own agave_version. An RPC host gets no plugin."""
    hosts = {}
    for number, case in enumerate(VECTORS["client_versions"]):
        variables = {"validator_type": "agave", "agave_version": case["value"]}
        if section in RPC_SECTIONS:
            variables["rpc_type"] = "Index RPC"
        hosts["c%03d" % number] = variables
    return hosts


def geyser_vector_hosts(section):
    """One RPC host for each Yellowstone tag, with the tag as the host's own geyser_version and a client far above the floor."""
    return {
        "g%03d" % number: {"validator_type": "agave", "agave_version": "5.0.0", "rpc_type": "Geyser gRPC", "geyser_version": case["tag"]}
        for number, case in enumerate(VECTORS["geyser_tags"]) if case["tag"] != ""
    }


def good_versions(section):
    return make_floor_versions(section, GOOD_PINS[network_of(section)])


# scenario -> (the hosts for a section, the versions.yml for a section). The scenarios of the builders are those of
# test_init_geyser_plugin.py, whose versions.yml carries pins of its own for each section.
FINDING_SCENARIOS = {"clients": (client_vector_hosts, good_versions), "geyser": (geyser_vector_hosts, good_versions)}
for _name, (_hosts, _versions) in BUILD_SCENARIOS.items():
    FINDING_SCENARIOS["build-" + _name] = (lambda section, _hosts=_hosts: _hosts(), lambda section, _versions=_versions: _versions)


@functools.lru_cache(maxsize=None)
def run_findings(section, scenario):
    """The findings of the check play for the hosts of a scenario, with the section of versions.yml that the caller names;
    the result maps each host to its list of findings."""
    hosts_of, versions_of = FINDING_SCENARIOS[scenario]
    with tempfile.TemporaryDirectory(prefix="slv-floor-findings-") as tmp:
        root = Path(tmp)
        home = make_home(root, versions_of(section))
        playbook = root / "findings.yml"
        playbook.write_text(yaml.safe_dump([findings_copy_of(check_entries()[0])], sort_keys=False))
        out = root / "out"
        out.mkdir()
        hosts = hosts_of(section)
        write_inventory(root / "inventory.json", hosts)
        process = run_ansible(["-i", "inventory.json", playbook, "-e", "versions_section=%s" % section, "-e", "slv_out=%s" % out], root, home)
        findings = {}
        for name in hosts:
            path = out / (name + ".json")
            if not path.exists():
                raise AssertionError("no findings for %s:\n%s" % (name, process.stdout[-3000:]))
            findings[name] = json.loads(path.read_text())
        return findings


# ---------------------------------------------------------------------------
# outcome: what the whole play did to a host, read from the output of ansible
# ---------------------------------------------------------------------------


class Outcome:
    """What the stop task of the play did to a host: stopped it (fatal) or let it through (skipped); and whether the
    play warned about it. A host that did not get to the stop task is neither."""

    def __init__(self, output, name):
        block = next((part for part in re.split(r"\n(?=TASK \[|PLAY RECAP|PLAY \[)", output) if part.startswith("TASK [%s]" % STOP_TASK)), "")
        self.stopped = re.search(r"^fatal: \[%s\]: FAILED!" % re.escape(name), block, re.M) is not None
        self.passed = re.search(r"^skipping: \[%s\]" % re.escape(name), block, re.M) is not None
        self.warned = re.search(r"WARNING %s:" % re.escape(name), output) is not None
        self.message = None
        match = re.search(r"^fatal: \[%s\]: FAILED! => (\{.*\})" % re.escape(name), block, re.M)
        if match:
            self.message = json.loads(match.group(1)).get("msg")
        self.output = output


@functools.lru_cache(maxsize=None)
def run_whole(section, scenario):
    """The check play as it is, for the hosts of a scenario; the result maps each host to an Outcome."""
    hosts_of, versions_of = FINDING_SCENARIOS[scenario]
    with tempfile.TemporaryDirectory(prefix="slv-floor-whole-") as tmp:
        root = Path(tmp)
        home = make_home(root, versions_of(section))
        (root / "cmn").mkdir()
        shutil.copy(CHECK, root / "cmn" / CHECK.name)
        playbook = root / "probe.yml"
        playbook.write_text(yaml.safe_dump([{"import_playbook": "cmn/check_alpenglow_floor.yml", "vars": {"versions_section": section}}]))
        hosts = hosts_of(section)
        write_inventory(root / "inventory.json", hosts)
        process = run_ansible(["-i", "inventory.json", playbook], root, home)
        return {name: Outcome(process.stdout, name) for name in hosts}


# ---------------------------------------------------------------------------
# flow: the first play of an init.yml and its import of the check, as they are
# ---------------------------------------------------------------------------


def make_floor_flow(caller, root):
    """init.yml cut after its floor check, keeping all earlier validation and its real dependencies."""
    entries = yaml.safe_load((ANSIBLE_DIR / caller).read_text())
    index = check_import_index(entries)
    directory = root / caller.split("/")[0]
    directory.mkdir()
    (root / "cmn").mkdir(exist_ok=True)
    shutil.copy(CHECK, root / "cmn" / CHECK.name)
    for entry in entries[:index]:
        if "import_playbook" in entry:
            reference = entry["import_playbook"]
            copy_validation_playbook((ANSIBLE_DIR / caller).parent / reference, directory / reference)
    init = directory / "init.yml"
    init.write_text(yaml.safe_dump(entries[: index + 1], sort_keys=False))
    return init


def pins_of_set(section, pin_set):
    """(agave, jito, allnodes) of a pin set for a section: good (all at the floor), old (all below it), <client>-old (only
    that client below it), unreadable (no version number) or none (no pins at all)."""
    good, old = GOOD_PINS[network_of(section)], OLD_PINS[network_of(section)]
    if pin_set == "good":
        pins = good
    elif pin_set == "old":
        pins = old
    elif pin_set == "none":
        pins = (None, None, None)
    elif pin_set == "unreadable":
        pins = tuple(None if value is None else "latest" for value in good)
    else:
        client = pin_set[: -len("-old")]
        pins = tuple(old[number] if name == client else good[number] for number, name in enumerate(CLIENTS))
    return section_pins(section, pins)


PIN_SETS = ("good", "old", "agave-old", "jito-old", "allnodes-old", "unreadable", "none")


def client_hosts(caller):
    """Hosts of every validator_type that the first play of the caller lets through, with the versions of the host: none,
    its own client's at the floor, below it or empty, and another client's at the floor and below it."""
    network = network_of(FLOOR_CALLERS[caller])
    good, old = GOOD_PINS[network], OLD_PINS[network]
    types = ("agave", "jito", "allnodes-jito") + (() if caller == "mainnet-validator/init.yml" else FIREDANCER)
    hosts = {}
    for validator_type in types:
        client = CLIENT_OF[validator_type]
        number = CLIENTS.index(client)
        other = CLIENTS.index("jito" if client == "agave" else "agave")
        base = {"validator_type": validator_type}
        if caller in RPC_CALLERS:
            base["rpc_type"] = "Index RPC"  # no Yellowstone plugin: the plugin has its own scenario
        hosts["%s-plain" % validator_type] = dict(base)
        hosts["%s-own-good" % validator_type] = dict(base, **{OWN_KEY[client]: good[number] or "5.0.0"})
        hosts["%s-own-old" % validator_type] = dict(base, **{OWN_KEY[client]: old[number] or "3.1.10"})
        hosts["%s-own-empty" % validator_type] = dict(base, **{OWN_KEY[client]: ""})
        hosts["%s-other-old" % validator_type] = dict(base, **{OWN_KEY[CLIENTS[other]]: old[other] or "3.1.10"})
        hosts["%s-other-good" % validator_type] = dict(base, **{OWN_KEY[CLIENTS[other]]: good[other] or "5.0.0"})
    return hosts


def gate_hosts(caller):
    """Hosts of every kind of validator_type, for the type gate of the first play."""
    values = ["agave", "jito", "allnodes-jito", "firedancer-agave", "firedancer-jito", "frankendancer", "firedancer",
              "Firedancer-Agave", " frankendancer ", "FIREDANCER-JITO", "bogus", "", None, MISSING, 5]
    hosts = {}
    for number, value in enumerate(values):
        variables = {}
        if value is not MISSING:
            variables["validator_type"] = value
        if caller in RPC_CALLERS:
            variables["rpc_type"] = "Index RPC"
        hosts["t%02d" % number] = variables
    return hosts


def geyser_hosts(caller):
    """Hosts for the Yellowstone plugin: every validator_type that can have it, every RPC type, every geyser_plugin, and the
    geyser_version of the host (none, at the floor or below it)."""
    network = network_of(FLOOR_CALLERS[caller])
    hosts = {}
    for validator_type in ("agave", "jito", "firedancer-agave"):
        for rpc_type in ("Geyser gRPC", "Index RPC + gRPC", "Index RPC", "SendTx RPC"):
            for plugin in (None, "yellowstone", "richat"):
                for own in (None, "good", "old"):
                    variables = {"validator_type": validator_type, "rpc_type": rpc_type}
                    if plugin is not None:
                        variables["geyser_plugin"] = plugin
                    if own is not None:
                        variables["geyser_version"] = {"good": GOOD_GEYSER, "old": OLD_GEYSER}[own][network]
                    name = "%s-%s-%s-%s" % (validator_type, re.sub(r"[^a-z]+", "", rpc_type.lower()), plugin or "unset", own or "pin")
                    hosts[name] = variables
    return hosts


HOST_SETS = {"clients": client_hosts, "gate": gate_hosts, "geyser": geyser_hosts}
# the versions.yml of a scenario: a pin set, or the pins at the floor with a Yellowstone tag of the section at it or below it
VERSION_SETS = {name: (lambda caller, name=name: make_floor_versions(FLOOR_CALLERS[caller], pins_of_set(FLOOR_CALLERS[caller], name)))
                for name in PIN_SETS}
VERSION_SETS["geyser-good"] = lambda caller: make_floor_versions(FLOOR_CALLERS[caller], GOOD_PINS[network_of(FLOOR_CALLERS[caller])])
VERSION_SETS["geyser-old"] = lambda caller: make_floor_versions(
    FLOOR_CALLERS[caller], GOOD_PINS[network_of(FLOOR_CALLERS[caller])], OLD_GEYSER[network_of(FLOOR_CALLERS[caller])])


@functools.lru_cache(maxsize=None)
def run_flow(caller, host_set, version_set):
    """The first play and the check of an init.yml for the hosts of a host set, with the versions.yml of a version set; the
    result maps each host to an Outcome (of the stop task of the check), with the whole output."""
    with tempfile.TemporaryDirectory(prefix="slv-floor-flow-") as tmp:
        root = Path(tmp)
        home = make_home(root, VERSION_SETS[version_set](caller))
        init = make_floor_flow(caller, root)
        hosts = HOST_SETS[host_set](caller)
        write_inventory(root / "inventory.json", hosts)
        process = run_ansible(["-i", "inventory.json", init], root, home)
        results = {name: Outcome(process.stdout, name) for name in hosts}
        for outcome in results.values():
            outcome.returncode = process.returncode
        return results


def expected_clients(caller, pin_set, variables, name):
    """What the check has to do for a host of client_hosts: ("pass",), ("warn",) or ("stop", words of the message)."""
    network = network_of(FLOOR_CALLERS[caller])
    client = CLIENT_OF[variables["validator_type"]]
    pin = pins_of_set(FLOOR_CALLERS[caller], pin_set)[CLIENTS.index(client)]
    own = variables.get(OWN_KEY[client])
    text = str(own) if own not in (None, "") else (pin or "")
    if text == "":
        return ("stop", "No %s version for %s" % (LABEL[client], name))
    if read(text) is None:
        return ("stop", "is not a version") if network == "mainnet" else ("warn",)
    return ("stop", "is older than Alpenglow runs on") if below(text, network) else ("pass",)


# ---------------------------------------------------------------------------
# the tests
# ---------------------------------------------------------------------------


class VectorsAreConsistent(unittest.TestCase):
    """The list of cases agrees with the grammar written in it, whatever reads it."""

    def test_f01_the_floors_are_4_3_0_on_mainnet_and_4_4_0_beta_0_on_testnet_and_devnet(self):
        self.assertEqual(FLOORS, {"mainnet": "4.3.0", "testnet": "4.4.0-beta.0", "devnet": "4.4.0-beta.0"})

    def test_f02_every_case_reads_and_compares_the_way_the_file_says(self):
        for case in VECTORS["client_versions"]:
            with self.subTest(repr(case["value"])):
                self.assertEqual(case["reads"], read(case["value"]))
                for network in NETWORKS:
                    self.assertEqual(case["below"][network], below(case["value"], network), network)
        for case in VECTORS["geyser_tags"]:
            built = re.search(r"\+solana\.([^+\s]+)", case["tag"])
            built = re.sub(r"^(\d+\.\d+\.\d+)\.", r"\1-", built.group(1)) if built else None
            with self.subTest(repr(case["tag"])):
                self.assertEqual(case["built_for"], built)
                self.assertEqual(case["reads"], None if built is None else read(built))
                for network in NETWORKS:
                    self.assertEqual(case["below"][network], built is not None and below(built, network), network)

    def test_f03_the_cases_include_the_forms_an_operator_writes(self):
        values = {str(case["value"]) for case in VECTORS["client_versions"]}
        for value in ("4.2", "4.2.1.1", "3.1.10-bam", "latest", "main", "a1b2c3d", "4.3.0", "4.4.0-beta.0", "4.3.0-jito.0",
                      "4.3.0-allnodes.1", "4.4.0-beta.1-allnodes", "4.2.2-jito.1"):
            self.assertIn(value, values)
        self.assertTrue(any(isinstance(case["value"], float) for case in VECTORS["client_versions"]), "a numeric YAML value")


class CheckReadsTheVectors(unittest.TestCase):
    """The play reads and compares every case of the list the way the file says."""

    def test_f04_the_findings_for_every_client_version_are_the_ones_of_the_vectors(self):
        prefetch(run_findings, [(VECTOR_SECTION[network], "clients") for network in NETWORKS])
        for network in NETWORKS:
            findings = run_findings(VECTOR_SECTION[network], "clients")
            for number, case in enumerate(VECTORS["client_versions"]):
                with self.subTest("%s %r" % (network, case["value"])):
                    (finding,) = findings["c%03d" % number]
                    self.assertEqual(finding["kind"], "client")
                    self.assertEqual(finding["text"], str(case["value"]).strip())
                    self.assertEqual(finding["reads"], case["reads"])
                    if case["reads"] is None:
                        self.assertEqual((finding["verdict"], finding["level"]), ("unreadable", "stop" if network == "mainnet" else "warn"))
                    elif case["below"][network]:
                        self.assertEqual((finding["verdict"], finding["level"]), ("below", "stop"))
                    else:
                        self.assertEqual((finding["verdict"], finding["level"]), ("ok", "none"))

    def test_f05_the_findings_for_every_yellowstone_tag_are_the_ones_of_the_vectors(self):
        prefetch(run_findings, [(section, "geyser") for section in RPC_SECTIONS])
        for section in RPC_SECTIONS:
            network = network_of(section)
            findings = run_findings(section, "geyser")
            for number, case in enumerate(VECTORS["geyser_tags"]):
                if case["tag"] == "":
                    continue
                with self.subTest("%s %r" % (network, case["tag"])):
                    got = findings["g%03d" % number]
                    self.assertEqual((got[0]["kind"], got[0]["verdict"]), ("client", "ok"))
                    plugin = [finding for finding in got if finding["kind"] == "geyser"]
                    if case["built_for"] is None:
                        self.assertEqual(plugin, [])
                    elif case["reads"] is None:
                        self.assertEqual([(finding["verdict"], finding["level"]) for finding in plugin], [("unchecked", "none")])
                    else:
                        self.assertEqual([finding["reads"] for finding in plugin], [case["reads"]])
                        self.assertEqual([(finding["verdict"], finding["level"]) for finding in plugin],
                                         [("below", "stop") if case["below"][network] else ("ok", "none")])

    def test_f06_the_whole_play_stops_a_version_below_the_floor_and_one_that_cannot_be_read_on_mainnet_and_says_it_elsewhere(self):
        prefetch(run_whole, [(VECTOR_SECTION[network], "clients") for network in NETWORKS])
        for network in NETWORKS:
            outcomes = run_whole(VECTOR_SECTION[network], "clients")
            for number, case in enumerate(VECTORS["client_versions"]):
                outcome = outcomes["c%03d" % number]
                stops = network == "mainnet" if case["reads"] is None else bool(case["below"][network])
                with self.subTest("%s %r" % (network, case["value"])):
                    self.assertEqual((outcome.stopped, outcome.passed), (stops, not stops))
                    self.assertEqual(outcome.warned, case["reads"] is None and network != "mainnet")

    def test_f07_the_whole_play_stops_a_plugin_built_for_a_release_below_the_floor(self):
        prefetch(run_whole, [(section, "geyser") for section in RPC_SECTIONS])
        for section in RPC_SECTIONS:
            network = network_of(section)
            outcomes = run_whole(section, "geyser")
            for number, case in enumerate(VECTORS["geyser_tags"]):
                if case["tag"] == "":
                    continue
                outcome = outcomes["g%03d" % number]
                with self.subTest("%s %r" % (network, case["tag"])):
                    self.assertEqual((outcome.stopped, outcome.passed, outcome.warned), (bool(case["below"][network]), not case["below"][network], False))


class CheckSaysWhatItFound(unittest.TestCase):
    """The words of the stop and of the warning."""

    @staticmethod
    def finding(section, text):
        findings = run_findings(section, "clients")
        name = next(name for name, found in findings.items() if found[0]["text"] == text)
        return name, findings[name][0]

    def test_f08_a_version_below_the_floor_is_named_with_its_reading_its_source_and_the_way_out(self):
        name, finding = self.finding("mainnet_validators", "3.1.10-bam")
        self.assertEqual(
            finding["message"],
            "agave 3.1.10-bam (read as 3.1.10) on %s (agave_version of the host or -e) is older than Alpenglow runs on: Alpenglow starts on mainnet at epoch 1064 and needs 4.3.0 or later. Set it to 4.3.0 or later. Nothing was changed." % name,
        )
        self.assertIn("agave 4.2 (read as 4.2.0) on", self.finding("mainnet_validators", "4.2")[1]["message"])
        self.assertIn("agave 4.2.1.1 (read as 4.2.1) on", self.finding("mainnet_validators", "4.2.1.1")[1]["message"])
        self.assertNotIn("read as", self.finding("mainnet_validators", "3.1.10")[1]["message"])
        self.assertIn("testnet already runs Alpenglow and needs 4.4.0-beta.0 or later", self.finding("testnet_validators", "4.3.2")[1]["message"])

    def test_f09_a_version_that_cannot_be_read_is_refused_on_mainnet_and_warned_about_elsewhere(self):
        _, latest = self.finding("mainnet_validators", "latest")
        self.assertRegex(latest["message"], r"^agave latest on c\d+ \(agave_version of the host or -e\) is not a version \(X\.Y\.Z\), and mainnet takes no value that cannot be checked against 4\.3\.0, the oldest release Alpenglow runs on\. Set it to 4\.3\.0 or later\. Nothing was changed\.$")
        name, latest = self.finding("testnet_validators", "latest")
        self.assertRegex(latest["message"], r"^WARNING c\d+: agave latest \(agave_version of the host or -e\) is not a version \(X\.Y\.Z\), so it is not checked against 4\.4\.0-beta\.0, the oldest release Alpenglow runs on testnet\. The play goes on\.$")
        outcome = run_whole("testnet_validators", "clients")[name]
        self.assertEqual((outcome.warned, outcome.stopped, outcome.passed), (True, False, True))

    def test_f10_a_plugin_below_the_floor_is_named_with_the_release_it_is_built_for(self):
        number = next(number for number, case in enumerate(VECTORS["geyser_tags"]) if case["tag"] == "v16.1.1+solana.4.3.0")
        name = "g%03d" % number
        (plugin,) = [finding for finding in run_findings("testnet_rpcs", "geyser")[name] if finding["kind"] == "geyser"]
        self.assertEqual(
            plugin["message"],
            "Yellowstone geyser_version v16.1.1+solana.4.3.0 (built for solana 4.3.0) on %s (geyser_version of the host or -e) is older than Alpenglow runs on: testnet already runs Alpenglow and needs 4.4.0-beta.0 or later. Set geyser_version to a Yellowstone release built for solana 4.4.0-beta.0 or later. Nothing was changed." % name,
        )

    def test_f11_the_caller_has_to_say_which_section_holds_the_pins(self):
        for section in ("", "mainnet", "mainnet_validator", "devnet_validators"):
            with tempfile.TemporaryDirectory(prefix="slv-floor-section-") as tmp:
                root = Path(tmp)
                home = make_home(root, make_floor_versions("mainnet_validators", GOOD_PINS["mainnet"]))
                (root / "cmn").mkdir()
                shutil.copy(CHECK, root / "cmn" / CHECK.name)
                playbook = root / "probe.yml"
                playbook.write_text(yaml.safe_dump([{"import_playbook": "cmn/check_alpenglow_floor.yml", "vars": {"versions_section": section}}]))
                write_inventory(root / "inventory.json", {"h": {"validator_type": "agave"}})
                process = run_ansible(["-i", "inventory.json", playbook], root, home)
                with self.subTest(repr(section)):
                    self.assertNotEqual(process.returncode, 0)
                    self.assertIn("cmn/check_alpenglow_floor.yml needs versions_section", process.stdout)
                    self.assertIn("Nothing was changed.", process.stdout)

    def test_f12_a_validator_type_that_the_build_does_not_know_is_stopped_too(self):
        findings = run_findings("mainnet_validators", "build-no-pins")
        self.assertEqual({name: [(finding["verdict"], finding["level"]) for finding in found] for name, found in findings.items()},
                         {"stopped-agave": [("missing", "stop")], "stopped-jito": [("missing", "stop")], "stopped-allnodes-jito": [("missing", "stop")]})
        with tempfile.TemporaryDirectory(prefix="slv-floor-type-") as tmp:
            root = Path(tmp)
            home = make_home(root, good_versions("mainnet_validators"))
            (root / "cmn").mkdir()
            shutil.copy(CHECK, root / "cmn" / CHECK.name)
            playbook = root / "probe.yml"
            playbook.write_text(yaml.safe_dump([{"import_playbook": "cmn/check_alpenglow_floor.yml", "vars": {"versions_section": "mainnet_validators"}}]))
            write_inventory(root / "inventory.json", {"bogus": {"validator_type": "frankendancer"}, "nothing": {}})
            process = run_ansible(["-i", "inventory.json", playbook], root, home)
            self.assertNotEqual(process.returncode, 0)
            outcomes = {name: Outcome(process.stdout, name) for name in ("bogus", "nothing")}
            self.assertIn("validator_type 'frankendancer' is not one that cmn/build_solana.yml builds", outcomes["bogus"].message)
            self.assertIn("validator_type '' is not one that cmn/build_solana.yml builds", outcomes["nothing"].message)


class InitPlaysCheckTheFloor(unittest.TestCase):
    """The first play and the check of each init.yml, run for hosts of every validator_type."""

    def test_f18_copied_validator_flow_executes_bootstrap_validation_before_the_floor(self):
        for network in ("mainnet", "testnet"):
            with self.subTest(network), tempfile.TemporaryDirectory(prefix="slv-floor-bootstrap-") as tmp:
                root = Path(tmp)
                caller = "%s-validator/init.yml" % network
                home = make_home(root, VERSION_SETS["good"](caller))
                init = make_floor_flow(caller, root)
                write_inventory(root / "inventory.json", {"rig": {"validator_type": "agave", "no_voting": "false"}})
                process = run_ansible(["-i", "inventory.json", init], root, home)
                self.assertNotEqual(process.returncode, 0, process.stdout)
                self.assertIn("Sync-only bootstrap requires boolean no_voting", process.stdout)
                self.assertNotIn("TASK [%s]" % STOP_TASK, process.stdout,
                                 "the invalid policy must stop before any later validation or mutation")

    def test_f13_every_init_imports_the_check_once_with_its_own_section_before_it_changes_anything(self):
        read_only = {"assert", "fail", "set_fact", "debug", "stat"}

        def check_tasks(tasks, directory):
            for task in tasks:
                module, args = module_of(task)
                if module == "import_tasks":
                    imported = directory / args
                    check_tasks(yaml.safe_load(imported.read_text()), imported.parent)
                else:
                    self.assertIn(module, read_only, "%s changes the host before the check" % task.get("name"))
                    if module == "stat":
                        self.assertEqual(task.get("delegate_to"), "localhost", "template checks only read the controller")
                        self.assertIs(task.get("become"), False)

        for caller, section in FLOOR_CALLERS.items():
            entries = yaml.safe_load((ANSIBLE_DIR / caller).read_text())
            index = check_import_index(entries)
            with self.subTest(caller):
                self.assertEqual(entries[index].get("vars"), {"versions_section": section})
                self.assertNotIn("when", entries[index], "every host is checked")
                expected_imports = ["../cmn/assert_validator_bootstrap.yml"] if section.endswith("_validators") else []
                self.assertEqual([entry["import_playbook"] for entry in entries[:index] if "import_playbook" in entry],
                                 expected_imports, "only the explicit bootstrap validation may precede the type gate")
                self.assertEqual(index, len(expected_imports) + 1, "the floor check follows the type gate")
                for earlier in entries[:index]:
                    path = (ANSIBLE_DIR / caller).parent
                    plays = [earlier]
                    if "import_playbook" in earlier:
                        imported = path / earlier["import_playbook"]
                        plays = yaml.safe_load(imported.read_text())
                        path = imported.parent
                    for play in plays:
                        self.assertTrue(play.get("any_errors_fatal"), "one host that stops ends the run for all")
                        check_tasks(play.get("pre_tasks", []) + play["tasks"], path)

    def test_f14_hosts_are_stopped_or_let_through_by_the_client_they_are_going_to_build(self):
        prefetch(run_flow, [(caller, "clients", pin_set) for caller in FLOOR_CALLERS for pin_set in PIN_SETS])
        for caller in FLOOR_CALLERS:
            for pin_set in PIN_SETS:
                result = run_flow(caller, "clients", pin_set)
                for name, variables in client_hosts(caller).items():
                    expected = expected_clients(caller, pin_set, variables, name)
                    with self.subTest("%s %s %s" % (caller, pin_set, name)):
                        outcome = result[name]
                        if expected[0] == "stop":
                            self.assertEqual((outcome.stopped, outcome.passed), (True, False), outcome.output[-1500:])
                            self.assertIn(expected[1], outcome.message)
                        else:
                            self.assertEqual((outcome.stopped, outcome.passed), (False, True), outcome.output[-1500:])
                            self.assertEqual(outcome.warned, expected[0] == "warn")

    def test_f15_a_yellowstone_plugin_that_the_init_builds_is_checked_and_one_it_does_not_build_is_not(self):
        prefetch(run_flow, [(caller, "geyser", version_set) for caller in RPC_CALLERS for version_set in ("geyser-good", "geyser-old")])
        for caller in RPC_CALLERS:
            network = network_of(FLOOR_CALLERS[caller])
            for version_set in ("geyser-good", "geyser-old"):
                result = run_flow(caller, "geyser", version_set)
                for name, variables in geyser_hosts(caller).items():
                    builds = (variables["validator_type"] in ("agave", "jito") and variables["rpc_type"] in GEYSER_RPC_TYPES
                              and variables.get("geyser_plugin", "yellowstone") == "yellowstone")
                    tag = variables.get("geyser_version", OLD_GEYSER[network] if version_set == "geyser-old" else GOOD_GEYSER[network])
                    stops = builds and below(re.sub(r"^(\d+\.\d+\.\d+)\.", r"\1-", tag.split("+solana.")[1]), network)
                    with self.subTest("%s %s %s" % (caller, version_set, name)):
                        outcome = result[name]
                        self.assertEqual((outcome.stopped, outcome.passed), (stops, not stops), outcome.output[-1500:])
                        if stops:
                            self.assertIn("Yellowstone geyser_version %s" % tag, outcome.message)

    def test_f16_mainnet_validator_init_refuses_firedancer_and_frankendancer_with_the_words_of_the_cli(self):
        guard = (REPOSITORY / "cli" / "lib" / "fdctlMainnetGuard.ts").read_text()
        note = re.search(r"const ALPENGLOW_NOTE =\s*'([^']+)'", guard).group(1)
        way_out = re.search(r"const WAY_OUT =\s*'([^']+)'", guard).group(1)
        prefetch(run_flow, [(caller, "gate", "good") for caller in ("mainnet-validator/init.yml", "testnet-validator/init.yml")])
        mainnet = run_flow("mainnet-validator/init.yml", "gate", "good")
        for name, variables in gate_hosts("mainnet-validator/init.yml").items():
            value = variables.get("validator_type", MISSING)
            text = "" if value is MISSING or value is None else str(value)
            firedancer = text.strip().lower() == "frankendancer" or text.strip().lower().startswith("firedancer")
            with self.subTest("mainnet %r" % (text if value is not MISSING else "<missing>")):
                outcome = mainnet[name]
                self.assertTrue(outcome.returncode != 0)
                if firedancer:
                    self.assertIn("A mainnet voting validator cannot be %s. %s %s Nothing was changed on %s." % (text, note, way_out, name), outcome.output.replace("\\n", "\n"))
                elif text in ("agave", "jito", "allnodes-jito"):
                    self.assertNotIn("is not supported on %s" % name, outcome.output)
                else:
                    self.assertIn("validator_type '%s' is not supported on %s. Set it in the inventory to one of agave, jito, allnodes-jito. Nothing was changed." % (text if value is not MISSING else "undefined", name), outcome.output)

    def test_f17_testnet_validator_init_still_takes_the_firedancer_types(self):
        result = run_flow("testnet-validator/init.yml", "gate", "good")
        for name, variables in gate_hosts("testnet-validator/init.yml").items():
            value = variables.get("validator_type", MISSING)
            with self.subTest("testnet %r" % (value if value is not MISSING else "<missing>")):
                self.assertNotIn("A mainnet voting validator cannot be", result[name].output)
                if value in ("agave", "jito", "allnodes-jito", "firedancer-agave", "firedancer-jito"):
                    self.assertNotIn("is not supported on %s" % name, result[name].output)
                else:
                    self.assertIn("is not supported on %s. Set it in the inventory to one of agave, jito, allnodes-jito, firedancer-agave, firedancer-jito." % name, result[name].output)


class CheckReadsWhatTheBuildBuilds(unittest.TestCase):
    """The version that the check reads for a host is the version that cmn/build_solana.yml builds for it."""

    def test_f18_check_and_build_use_the_same_version_for_every_host_of_every_caller(self):
        prefetch(run_build, [(caller, scenario) for caller in BUILD_CALLERS for scenario in BUILD_SCENARIOS])
        prefetch(run_findings, [(section, "build-" + scenario) for section in BUILD_CALLERS.values() for scenario in BUILD_SCENARIOS])
        for caller, section in BUILD_CALLERS.items():
            for scenario in BUILD_SCENARIOS:
                built = run_build(caller, scenario)
                findings = run_findings(section, "build-" + scenario)
                for name, tags in ((name, result.tags) for name, result in built.items()):
                    client = [finding for finding in findings[name] if finding["kind"] in ("client", "type")]
                    with self.subTest("%s %s %s" % (caller, scenario, name)):
                        self.assertEqual(len(client), 1)
                        if not tags:
                            self.assertEqual(client[0]["verdict"], "missing", "the build stops, so the check stops")
                            continue
                        self.assertNotEqual(client[0]["verdict"], "missing", "the build builds, so the check has a version")
                        ((builder, tag),) = tags.items()
                        text = client[0]["text"]
                        self.assertEqual(tag, "v" + (text if builder != "build_allnodes_jito" or "-allnodes" in text else text + "-allnodes"))


GEYSER_BUILD_HOSTS = {
    "pin": {},
    "own": {"geyser_version": "v1.2.3+solana.9.9.9"},
    "empty": {"geyser_version": ""},
}


@functools.lru_cache(maxsize=None)
def run_geyser_build(network):
    """The Yellowstone version that geyser_build.yml of a network clones (its git task, recorded), for the hosts of
    GEYSER_BUILD_HOSTS, with the sections of test_init_geyser_plugin.make_versions."""
    with tempfile.TemporaryDirectory(prefix="slv-floor-geyser-") as tmp:
        root = Path(tmp)
        home = make_home(root)
        plays = yaml.safe_load((ANSIBLE_DIR / ("%s-rpc" % network) / "geyser_build.yml").read_text())
        assert len(plays) == 1
        playbook = root / "geyser.yml"
        playbook.write_text(yaml.safe_dump([builder_probe_copy_of(plays[0], "geyser_build")], sort_keys=False))
        out = root / "out"
        out.mkdir()
        write_inventory(root / "inventory.json", GEYSER_BUILD_HOSTS)
        process = run_ansible(["-i", "inventory.json", playbook, "-e", "slv_out=%s" % out], root, home)
        tags = {}
        for name in GEYSER_BUILD_HOSTS:
            record = out / name / "geyser_build.json"
            if not record.exists():
                raise AssertionError("no clone recorded for %s:\n%s" % (name, process.stdout[-3000:]))
            tags[name] = json.loads(record.read_text())["args"]["version"]
        return tags


class GeyserBuildReadsTheHostBeforeTheSection(unittest.TestCase):
    """The check reads geyser_version of the host, else of the section; geyser_build.yml builds the same."""

    def test_f19_every_network_clones_the_geyser_version_of_the_host_else_of_its_own_section(self):
        prefetch(run_geyser_build, [(network,) for network in NETWORKS])
        for network in NETWORKS:
            with self.subTest(network):
                self.assertEqual(run_geyser_build(network), {
                    "pin": "yellowstone-of-%s" % network, "own": "v1.2.3+solana.9.9.9", "empty": "yellowstone-of-%s" % network,
                })


if __name__ == "__main__":
    unittest.main()
