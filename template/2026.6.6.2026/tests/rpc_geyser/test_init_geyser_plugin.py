"""Tests of the RPC init playbooks: the Geyser plugin they install, and the validator_type they accept.

For rpc_type "Geyser gRPC" and "Index RPC + gRPC" on agave and jito, ansible/<network>-rpc/init.yml
installs the Yellowstone plugin of the network (geyser_build.yml). The inventory variable
geyser_plugin: richat is the way to richat (geyser_richat_build.yml and install_richat.yml), but richat
has no release for agave 4.3 or later yet, so it stops the play, before anything is changed, on a node
that is set to run such an agave. Any other value stops the play too. A node that ran richat has
richat.service stopped and disabled when it is initialised with Yellowstone. A missing or unknown
validator_type stops init.yml of the three networks and update_startup_config.yml of testnet-rpc and
devnet-rpc the same way; none of them turns it into a Firedancer type. The RPC gateway takes the pubsub
of the node's own agave unless the node runs richat.

The tests run the real ansible-playbook on this machine over a local connection, without become,
sudo, a network or a host:

  flow      ansible/<network>-rpc/init.yml is copied and every playbook it imports is replaced by a stub
            that adds its own name to a list kept in a fact of the host. The first play of init.yml and
            the conditions of the imports are the real ones, so the list of a host is the plays that
            init runs for it.
  recorded  a playbook with one play (update_startup_config.yml of testnet-rpc or devnet-rpc,
            cmn/stop_richat.yml) is copied with every task that is not an assert, fail, set_fact or
            debug replaced by a record in the same kind of list (a template task records its template,
            a systemd task its arguments), under the task's own condition, so the list of a host is
            what the play would do for it. A stat task reports that the file exists when the host
            variable slv_stub_exists is true.
  render    the set_fact, git and template tasks of a plugin play run in a copy of that play: every
            template goes into a temporary directory and git is not run, only recorded. The other tasks
            (cargo, systemd, file, stat) are left out. HOME is a temporary directory whose .slv holds
            the jinja directories of this release and a versions.yml, as slv's own ~/.slv does.
  vars      the variables of the play of cmn/install_rpc_gateway.yml are evaluated for each host; the
            tasks of the play are not run.

Needs PyYAML and ansible-playbook (the one on PATH, or the one that ANSIBLE_PLAYBOOK names). Run from
the repository root:

    python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_*.py' -v

The whole set takes under a minute. The versions of ansible-core that slv is used with are 2.16
(what apt installs on Ubuntu 24.04) and 2.21; run the set with each. A test that is skipped is a test
that did not run: there is none.
"""

import functools
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

RELEASE = Path(__file__).resolve().parents[2]
REPOSITORY = RELEASE.parents[1]
ANSIBLE_DIR = RELEASE / "ansible"
STARTUP_TEMPLATES = ANSIBLE_DIR / "cmn" / "vars" / "startup_templates.yml"

NETWORKS = ("mainnet", "testnet", "devnet")
UPDATE_NETWORKS = ("testnet", "devnet")
AGAVE_LINE = ("agave", "jito")
FIREDANCER = ("firedancer-agave", "firedancer-jito")
SUPPORTED_TYPES = ("agave", "jito", "allnodes-jito") + FIREDANCER
GEYSER_RPC_TYPES = ("Geyser gRPC", "Index RPC + gRPC")
OTHER_RPC_TYPES = ("Index RPC", "SendTx RPC")

YELLOWSTONE_PLAYS = ["geyser_build.yml"]
RICHAT_PLAYS = ["geyser_richat_build.yml", "install_richat.yml"]
PLUGIN_PLAYS = tuple(YELLOWSTONE_PLAYS + RICHAT_PLAYS)
STOP_RICHAT = "../cmn/stop_richat.yml"

# where the start script of the node looks for the plugin config, and where richat keeps its own
GEYSER_JSON = "/home/solv/geyser.json"
RICHAT_CONFIG = "/home/solv/richat-config.yml"
RICHAT_UNIT = "/etc/systemd/system/richat.service"

# The client pins of a versions.yml: the RPC defaults of each network (agave 4.3.2 on mainnet, 4.4.0-beta.0
# on testnet and devnet), and pins below the first agave that richat has no release for.
PINS = {"mainnet": ("4.3.2", "4.3.2-jito"), "testnet": ("4.4.0-beta.0", "4.4.0-beta.0-jito"),
        "devnet": ("4.4.0-beta.0", "4.4.0-beta.0-jito")}
OLD_PINS = {network: ("4.2.9", "4.2.9-jito") for network in NETWORKS}


def make_versions(pins):
    """A versions.yml whose sections differ in the plugin versions, so that a play that reads another
    network's section shows. pins is {network: (agave, jito)}, or None for sections without a client pin."""
    sections = {}
    for network in NETWORKS:
        section = {
            "version_firedancer": "0.814.30108",
            "richat_version": "richat-of-%s" % network,
            "geyser_version": "yellowstone-of-%s" % network,
        }
        if pins is not None:
            section["version_agave"], section["version_jito"] = pins[network]
        sections["%s_rpcs" % network] = section
    return sections


VERSIONS = make_versions(PINS)
OLD_VERSIONS = make_versions(OLD_PINS)
NO_PINS = make_versions(None)

# Values that geyser_plugin must not take (None is an empty value in the inventory).
INVALID_PLUGINS = ("Richat", "RICHAT", "", "none", "both", "yellowstone ", "richat,yellowstone", "geyser", None,
                   True, ["richat"])

# Values that validator_type must not take. MISSING is a host that has no validator_type at all.
MISSING = object()
INVALID_TYPES = (MISSING, "", "frankendancer", "firedancer", "Agave", "bogus", None, 5)


def ansible_playbook():
    exe = os.environ.get("ANSIBLE_PLAYBOOK") or shutil.which("ansible-playbook")
    if not exe:
        raise RuntimeError("ansible-playbook is required: put it on PATH or set ANSIBLE_PLAYBOOK")
    return exe


def setUpModule():
    version = subprocess.run(
        [ansible_playbook(), "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, check=True,
    ).stdout.splitlines()[0]
    sys.stderr.write("tests of the RPC init playbooks, run with %s\n" % version)


def slug(text):
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def host_name(validator_type, rpc_type, plugin):
    return "%s-%s-%s" % (validator_type, slug(rpc_type), "unset" if plugin is None else plugin)


# ---------------------------------------------------------------------------
# the hosts of a run
# ---------------------------------------------------------------------------


def valid_hosts():
    """Every validator type and RPC type, with each value of geyser_plugin that selects a plugin (or none)."""
    hosts = {}
    for validator_type in AGAVE_LINE + FIREDANCER:
        for rpc_type in GEYSER_RPC_TYPES + OTHER_RPC_TYPES:
            for plugin in (None, "yellowstone", "richat"):
                variables = {"validator_type": validator_type, "rpc_type": rpc_type}
                if plugin is not None:
                    variables["geyser_plugin"] = plugin
                hosts[host_name(validator_type, rpc_type, plugin)] = variables
    return hosts


def invalid_plugin_hosts():
    hosts = {}
    for number, value in enumerate(INVALID_PLUGINS):
        hosts["invalid-plugin-%02d" % number] = {
            "validator_type": "agave", "rpc_type": "Geyser gRPC", "geyser_plugin": value,
        }
    # an invalid value stops a node that would not use a plugin as well
    hosts["invalid-plugin-index-rpc"] = {"validator_type": "jito", "rpc_type": "Index RPC", "geyser_plugin": "bogus"}
    return hosts


def invalid_type_hosts():
    hosts = {}
    for number, value in enumerate(INVALID_TYPES):
        variables = {"rpc_type": "Geyser gRPC"}
        if value is not MISSING:
            variables["validator_type"] = value
        hosts["invalid-type-%02d" % number] = variables
    return hosts


def good_hosts():
    return {
        "good-agave": {"validator_type": "agave", "rpc_type": "Geyser gRPC"},
        "good-jito": {"validator_type": "jito", "rpc_type": "Index RPC"},
    }


def richat_host(validator_type, rpc_type, **versions):
    return dict({"validator_type": validator_type, "rpc_type": rpc_type, "geyser_plugin": "richat"}, **versions)


def richat_refused_hosts():
    """Richat nodes whose client is agave 4.3.0 or later: by the pin of the network, or by a version of the
    host (which the start script and the builders read before the pin)."""
    return {
        "refused-agave-geyser": richat_host("agave", "Geyser gRPC"),
        "refused-agave-index-grpc": richat_host("agave", "Index RPC + gRPC"),
        "refused-jito-geyser": richat_host("jito", "Geyser gRPC"),
        "refused-jito-index-grpc": richat_host("jito", "Index RPC + gRPC"),
        "refused-boundary": richat_host("agave", "Geyser gRPC", agave_version="4.3.0"),
        "refused-v-prefix": richat_host("agave", "Geyser gRPC", agave_version="v4.3.1"),
        "refused-prerelease": richat_host("agave", "Geyser gRPC", agave_version="4.4.0-beta.0"),
        "refused-next-major": richat_host("agave", "Geyser gRPC", agave_version="5.0.0"),
        "refused-jito-version": richat_host("jito", "Geyser gRPC", jito_version="4.3.0-jito"),
    }


def richat_allowed_hosts():
    """Richat nodes whose client is older than agave 4.3.0, by a version of the host (the pins of the
    network are newer). A jito node reads jito_version, and any other node agave_version."""
    return {
        "allowed-just-below": richat_host("agave", "Geyser gRPC", agave_version="4.2.9"),
        "allowed-two-digit-patch": richat_host("agave", "Geyser gRPC", agave_version="3.1.10"),
        "allowed-v-prefix": richat_host("agave", "Index RPC + gRPC", agave_version="v4.1.0"),
        "allowed-jito": richat_host("jito", "Index RPC + gRPC", jito_version="4.2.0-jito"),
        "allowed-jito-ignores-agave-version": richat_host("jito", "Geyser gRPC", agave_version="4.4.0", jito_version="4.2.0-jito"),
        "allowed-agave-ignores-jito-version": richat_host("agave", "Geyser gRPC", agave_version="4.2.9", jito_version="4.4.0-jito"),
    }


def richat_unknown_hosts():
    """Richat nodes with no version of the client anywhere."""
    return {
        "unknown-agave": richat_host("agave", "Geyser gRPC"),
        "unknown-jito": richat_host("jito", "Index RPC + gRPC"),
    }


def richat_inert_hosts():
    """geyser_plugin: richat on nodes that would not install richat."""
    return {
        "inert-agave-index": richat_host("agave", "Index RPC"),
        "inert-agave-sendtx": richat_host("agave", "SendTx RPC"),
        "inert-firedancer-index": richat_host("firedancer-jito", "Index RPC"),
    }


# scenario -> (the hosts, the versions.yml). The pins of "valid" are below the first agave that richat has no
# release for, so that its richat hosts reach the richat plays; the other scenarios say what their pins are.
SCENARIOS = {
    "valid": (valid_hosts, OLD_VERSIONS),
    "invalid-plugin": (invalid_plugin_hosts, VERSIONS),
    "invalid-type": (invalid_type_hosts, VERSIONS),
    # two good hosts with one host that stops the play: nothing runs for the good ones either
    "ends-run-plugin": (lambda: dict(good_hosts(), **{"bad-plugin": {"validator_type": "agave", "rpc_type": "Geyser gRPC", "geyser_plugin": "bogus"}}), VERSIONS),
    "ends-run-type": (lambda: dict(good_hosts(), **{"bad-type": {"rpc_type": "Geyser gRPC"}}), VERSIONS),
    "richat-refused": (richat_refused_hosts, VERSIONS),
    "richat-allowed": (richat_allowed_hosts, VERSIONS),
    "richat-unknown-version": (richat_unknown_hosts, NO_PINS),
    "richat-inert": (richat_inert_hosts, VERSIONS),
}

# playbook, scenario -> the hosts of a recorded run
RECORDED_SCENARIOS = {
    "update-valid": lambda: {"update-" + name: {"validator_type": name} for name in SUPPORTED_TYPES},
    "update-invalid-type": invalid_type_hosts,
    "richat-unit": lambda: {"unit-present": {"slv_stub_exists": True}, "unit-absent": {"slv_stub_exists": False}},
}

# host -> its variables, and the pubsub the RPC gateway should take (None: whatever it takes, see the test)
GATEWAY_HOSTS = {
    "default-port": ({"port_rpc": 7211}, "ws://localhost:7212"),
    "yellowstone-port": ({"geyser_plugin": "yellowstone", "port_rpc": 7211}, "ws://localhost:7212"),
    "other-port": ({"port_rpc": 8899}, "ws://localhost:8900"),
    "no-port": ({}, "ws://localhost:8900"),
    "empty-port": ({"port_rpc": ""}, "ws://localhost:8900"),
    "richat": ({"geyser_plugin": "richat", "port_rpc": 7211}, "ws://localhost:7111"),
    "chosen": ({"rpc_gateway_pubsub_ws": "ws://example.invalid:1234", "port_rpc": 7211}, "ws://example.invalid:1234"),
    "chosen-richat": ({"rpc_gateway_pubsub_ws": "ws://example.invalid:1234", "geyser_plugin": "richat"}, "ws://example.invalid:1234"),
}


def render_hosts():
    """The hosts of a render run: the agave and jito nodes that install a plugin, by default and with richat."""
    return {
        host_name(validator_type, rpc_type, plugin): dict(
            {"validator_type": validator_type, "rpc_type": rpc_type}, **({} if plugin is None else {"geyser_plugin": plugin})
        )
        for validator_type in AGAVE_LINE for rpc_type in GEYSER_RPC_TYPES for plugin in (None, "richat")
    }


def expected_plugin_plays(variables):
    """The plugin plays that init has to run for a host: what these tests compare the logs with."""
    if variables["validator_type"] not in AGAVE_LINE or variables["rpc_type"] not in GEYSER_RPC_TYPES:
        return []
    return RICHAT_PLAYS if variables.get("geyser_plugin", "yellowstone") == "richat" else YELLOWSTONE_PLAYS


# ---------------------------------------------------------------------------
# running ansible
# ---------------------------------------------------------------------------


def environment(home):
    env = dict(os.environ)
    env.pop("ANSIBLE_CONFIG", None)
    env.update(
        HOME=str(home),
        ANSIBLE_HOME=str(home / ".ansible-home"),
        ANSIBLE_NOCOLOR="1",
        ANSIBLE_LOCALHOST_WARNING="False",
        ANSIBLE_INVENTORY_UNPARSED_WARNING="False",
        ANSIBLE_DEPRECATION_WARNINGS="False",
        ANSIBLE_RETRY_FILES_ENABLED="0",
        ANSIBLE_HOST_KEY_CHECKING="False",
        ANSIBLE_FORKS="32",
        LC_ALL="C.UTF-8",
        PYTHONDONTWRITEBYTECODE="1",
    )
    return env


def run_ansible(args, work, home, timeout=900, extra_env=None):
    return subprocess.run(
        [ansible_playbook()] + [str(arg) for arg in args], cwd=str(work), env=dict(environment(home), **(extra_env or {})),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout,
    )


def make_stub_collection(root, namespace, name, modules):
    """A collection of empty modules: enough for --syntax-check to find the module a task names, which
    ansible-core, unlike the ansible package, does not bring. Returns the collections path."""
    collections = root / "collections"
    base = collections / "ansible_collections" / namespace / name
    (base / "plugins" / "modules").mkdir(parents=True, exist_ok=True)
    (base / "galaxy.yml").write_text("namespace: %s\nname: %s\nversion: 1.0.0\n" % (namespace, name))
    for module in modules:
        (base / "plugins" / "modules" / (module + ".py")).write_text("")
    return collections


def write_inventory(path, hosts):
    local = {"ansible_connection": "local", "ansible_python_interpreter": sys.executable}
    inventory = {"all": {"hosts": {name: dict(variables, **local) for name, variables in hosts.items()}}}
    path.write_text(json.dumps(inventory))  # JSON is YAML


def make_home(root, versions=VERSIONS):
    """A home like the one slv works from: ~/.slv holds the jinja directories of this release and the
    versions.yml that the plays read."""
    home = root / "home"
    slv = home / ".slv"
    slv.mkdir(parents=True)
    for entry in sorted((RELEASE / "jinja").iterdir()):
        (slv / entry.name).symlink_to(entry)
    (slv / "versions.yml").write_text(yaml.safe_dump(versions))
    return home


# ---------------------------------------------------------------------------
# flow: the plays that init runs
# ---------------------------------------------------------------------------

STUB = """---
- name: stub of {play}
  hosts: all
  gather_facts: false
  tasks:
    - name: ran {play}
      ansible.builtin.set_fact:
        slv_ran: "{{{{ (slv_ran | default([])) + ['{play}'] }}}}"
"""

# appended to the copy of a playbook: a host that stopped before it never gets here
WRITE_DOWN = """
- name: write down what ran
  hosts: all
  gather_facts: false
  tasks:
    - name: the log of the host
      ansible.builtin.copy:
        content: "{{ slv_ran | default([]) | to_json }}"
        dest: "{{ slv_log_dir }}/{{ inventory_hostname }}.json"
"""


class FlowResult:
    def __init__(self, imports, output, returncode):
        self.imports = imports  # what ran for the host (as init.yml names the plays), in order; [] when it stopped
        self.output = output
        self.returncode = returncode

    @property
    def plugin_plays(self):
        return [play for play in self.imports if play in PLUGIN_PLAYS]


def make_flow_copy(network, root):
    """A copy of init.yml of <network>-rpc under root, with a stub for every playbook it imports."""
    directory = root / ("%s-rpc" % network)
    directory.mkdir()
    init = directory / "init.yml"
    shutil.copy(ANSIBLE_DIR / ("%s-rpc" % network) / "init.yml", init)
    imported = re.findall(r"^- import_playbook:\s*(\S+)\s*$", init.read_text(), re.M)
    assert imported, "no import_playbook line in %s" % init
    with init.open("a") as handle:
        handle.write(WRITE_DOWN)
    for play in imported:
        stub = (directory / play).resolve()
        stub.parent.mkdir(parents=True, exist_ok=True)
        stub.write_text(STUB.format(play=play))
    return init


def read_logs(logs, hosts, process):
    results = {}
    for name in hosts:
        log = logs / (name + ".json")
        results[name] = FlowResult(json.loads(log.read_text()) if log.exists() else [], process.stdout, process.returncode)
    return results


@functools.lru_cache(maxsize=None)
def run_init(network, scenario="valid"):
    """Run init.yml of <network>-rpc against the hosts of a scenario with every imported playbook stubbed;
    the result maps each host to a FlowResult."""
    hosts_of, versions = SCENARIOS[scenario]
    with tempfile.TemporaryDirectory(prefix="slv-rpc-flow-") as tmp:
        root = Path(tmp)
        home = make_home(root, versions)
        init = make_flow_copy(network, root)
        logs = root / "logs"
        logs.mkdir()
        hosts = hosts_of()
        write_inventory(root / "inventory.json", hosts)
        process = run_ansible(["-i", "inventory.json", init, "-e", "slv_log_dir=%s" % logs], root, home)
        return read_logs(logs, hosts, process)


# ---------------------------------------------------------------------------
# recorded: what a playbook would do
# ---------------------------------------------------------------------------

_KEYWORDS = frozenset(
    "name vars when become become_user register loop with_items args environment ignore_errors changed_when "
    "failed_when delegate_to notify tags no_log check_mode until retries delay run_once block rescue always "
    "any_errors_fatal".split()
)


def module_of(task):
    names = [key for key in task if key not in _KEYWORDS]
    if len(names) != 1:
        raise AssertionError("cannot tell the module of the task %r" % (task.get("name"),))
    return names[0].rsplit(".", 1)[-1], task[names[0]]


def recorded_copy_of(play):
    """The play with every task that is not an assert, fail, set_fact or debug replaced by a record of itself
    in the fact slv_ran (a template task records its template, a systemd task its arguments), under the same
    condition. A task that registers a result gets one that says it succeeded; a stat says that the file
    exists when slv_stub_exists is true."""
    tasks = []
    for task in play["tasks"]:
        module, args = module_of(task)
        if module in ("assert", "fail", "set_fact", "debug"):
            tasks.append({key: value for key, value in task.items() if key not in ("become", "become_user")})
            continue
        entry = module
        if module == "template":
            entry += " " + args["src"]
        elif module == "systemd":
            entry += " " + " ".join("%s=%s" % (key, args[key]) for key in sorted(args))
        facts = {"slv_ran": "{{ (slv_ran | default([])) + [%s] }}" % json.dumps(entry)}
        if "register" in task:
            if module == "stat":
                facts[task["register"]] = {"stat": {"exists": "{{ slv_stub_exists | default(true) | bool }}"}}
            else:
                facts[task["register"]] = {"rc": 0, "stdout": "4.3.2", "stderr": ""}
        recorded = {"name": task.get("name", module), "ansible.builtin.set_fact": facts}
        if "when" in task:
            recorded["when"] = task["when"]
        tasks.append(recorded)
    return {
        "name": "recorded copy of %s" % play.get("name", ""),
        "hosts": "all",
        "gather_facts": False,
        "vars_files": play.get("vars_files", []),
        "tasks": tasks,
    }


@functools.lru_cache(maxsize=None)
def run_recorded(playbook, scenario):
    """Run the recorded copy of ansible/<playbook> against the hosts of a recorded scenario; the result maps
    each host to a FlowResult whose imports are the records."""
    with tempfile.TemporaryDirectory(prefix="slv-rpc-recorded-") as tmp:
        root = Path(tmp)
        home = make_home(root)
        source = yaml.safe_load((ANSIBLE_DIR / playbook).read_text())
        assert isinstance(source, list) and len(source) == 1, "one play is expected"
        copy = root / "recorded.yml"
        copy.write_text(yaml.safe_dump([recorded_copy_of(source[0])] + yaml.safe_load(WRITE_DOWN), sort_keys=False))
        logs = root / "logs"
        logs.mkdir()
        hosts = RECORDED_SCENARIOS[scenario]()
        write_inventory(root / "inventory.json", hosts)
        process = run_ansible(["-i", "inventory.json", copy, "-e", "slv_log_dir=%s" % logs], root, home)
        return read_logs(logs, hosts, process)


# ---------------------------------------------------------------------------
# vars: the variables of the RPC gateway play
# ---------------------------------------------------------------------------


@functools.lru_cache(maxsize=None)
def run_gateway_pubsub():
    """The rg_pubsub of the play of cmn/install_rpc_gateway.yml for each host of GATEWAY_HOSTS."""
    with tempfile.TemporaryDirectory(prefix="slv-rpc-gateway-") as tmp:
        root = Path(tmp)
        home = make_home(root)
        source = yaml.safe_load((ANSIBLE_DIR / "cmn" / "install_rpc_gateway.yml").read_text())
        assert isinstance(source, list) and len(source) == 1, "one play is expected"
        probe = {
            "name": "the variables of the gateway play",
            "hosts": "all",
            "gather_facts": False,
            "vars": source[0]["vars"],
            "tasks": [{
                "name": "write rg_pubsub down",
                "ansible.builtin.copy": {"content": "{{ rg_pubsub }}", "dest": "{{ slv_log_dir }}/{{ inventory_hostname }}.pubsub"},
            }],
        }
        playbook = root / "gateway.yml"
        playbook.write_text(yaml.safe_dump([probe], sort_keys=False))
        logs = root / "logs"
        logs.mkdir()
        write_inventory(root / "inventory.json", {name: variables for name, (variables, _) in GATEWAY_HOSTS.items()})
        process = run_ansible(["-i", "inventory.json", playbook, "-e", "slv_log_dir=%s" % logs], root, home)
        results = {}
        for name in GATEWAY_HOSTS:
            path = logs / (name + ".pubsub")
            if not path.exists():
                raise AssertionError("no rg_pubsub for %s:\n%s" % (name, process.stdout[-3000:]))
            results[name] = path.read_text()
        return results


# ---------------------------------------------------------------------------
# render: what the plugin plays template, and the version they clone
# ---------------------------------------------------------------------------


def render_copy_of(play):
    """The play with only its set_fact, git and template tasks. A git task is recorded, not run, with the
    arguments it would get; a template task is recorded and then rendered into the output directory."""
    tasks = [{
        "name": "a directory for the host",
        "ansible.builtin.file": {"path": "{{ slv_out }}/{{ inventory_hostname }}", "state": "directory"},
    }]
    for number, task in enumerate(play["tasks"]):
        module, args = module_of(task)
        if module not in ("set_fact", "git", "template"):
            continue
        for key in ("when", "loop", "with_items", "block"):
            if key in task:
                raise AssertionError("the render copy cannot follow %r on %r" % (key, task.get("name")))
        task_vars = dict(task.get("vars") or {})
        if module == "set_fact":
            kept = {"name": task.get("name", "set_fact"), "ansible.builtin.set_fact": args}
            if task_vars:
                kept["vars"] = task_vars
            tasks.append(kept)
            continue
        base = "{{ slv_out }}/{{ inventory_hostname }}/%02d" % number
        tasks.append({
            "name": "record %02d" % number,
            "ansible.builtin.copy": {"content": "{{ slv_record | to_json }}", "dest": base + ".json"},
            "vars": dict(task_vars, slv_record={"module": module, "task": task.get("name", ""), "args": args}),
        })
        if module == "template":
            tasks.append({
                "name": "render %02d" % number,
                "ansible.builtin.template": {"src": args["src"], "dest": base + ".text"},
                "vars": dict(task_vars),
                "register": "slv_rendered",
                "ignore_errors": True,
            })
            tasks.append({
                "name": "outcome %02d" % number,
                "ansible.builtin.copy": {
                    "content": "{{ {'failed': slv_rendered.failed | default(false), 'msg': slv_rendered.msg | default('')} | to_json }}",
                    "dest": base + ".outcome.json",
                },
            })
    return {
        "name": "render copy of %s" % play.get("name", ""),
        "hosts": "all",
        "gather_facts": False,
        "vars_files": play.get("vars_files", []),
        "vars": play.get("vars", {}),
        "tasks": tasks,
    }


class Record:
    """One git or template task of a plugin play, as it was asked of the host."""

    def __init__(self, module, task, args, text, failed, message):
        self.module = module
        self.task = task
        self.args = args  # evaluated
        self.text = text  # the rendered text of a template; None for git, and for a template that failed
        self.failed = failed
        self.message = message


@functools.lru_cache(maxsize=None)
def run_render(network, play_name):
    """Run the render copy of <network>-rpc/<play_name> for every host of render_hosts(); the result maps
    each host to its records, in task order."""
    with tempfile.TemporaryDirectory(prefix="slv-rpc-render-") as tmp:
        root = Path(tmp)
        home = make_home(root)
        source = yaml.safe_load((ANSIBLE_DIR / ("%s-rpc" % network) / play_name).read_text())
        assert isinstance(source, list) and len(source) == 1, "%s is expected to hold one play" % play_name
        playbook = root / "render.yml"
        playbook.write_text(yaml.safe_dump([render_copy_of(source[0])], sort_keys=False))
        out = root / "out"
        out.mkdir()
        hosts = render_hosts()
        write_inventory(root / "inventory.json", hosts)
        process = run_ansible(["-i", "inventory.json", playbook, "-e", "slv_out=%s" % out], root, home)
        results = {}
        for name in hosts:
            records = []
            for path in sorted((out / name).glob("[0-9][0-9].json")):
                recorded = json.loads(path.read_text())
                text_path = path.with_suffix(".text")
                outcome_path = path.with_suffix(".outcome.json")
                outcome = json.loads(outcome_path.read_text()) if outcome_path.exists() else {}
                records.append(Record(
                    recorded["module"], recorded["task"], recorded["args"],
                    text_path.read_text() if text_path.exists() else None,
                    outcome.get("failed", False), outcome.get("msg", ""),
                ))
            if not records:
                raise AssertionError(
                    "%s-rpc/%s recorded nothing for %s:\n%s" % (network, play_name, name, process.stdout[-3000:])
                )
            results[name] = records
        return results


def rendered_configs(network, host, plays):
    """{dest: Record} of the template tasks of the given plays of init, for a host."""
    configs = {}
    for play in plays:
        for record in run_render(network, play)[host]:
            if record.module == "template":
                configs[record.args["dest"]] = record
    return configs


# ---------------------------------------------------------------------------
# the tests
# ---------------------------------------------------------------------------


def type_message(host):
    return r"validator_type '[^\n]*' is not supported on %s\. Set it in the inventory to one of agave, jito, allnodes-jito, firedancer-agave, firedancer-jito\. Nothing was changed\." % re.escape(host)


def plugin_message(host):
    return r"geyser_plugin must be yellowstone or richat \(or left out for yellowstone\), not [^\n]*\. Nothing was changed on %s\." % re.escape(host)


def refusal_message(host, version=None):
    middle = r"richat has no release for agave 4\.3 or later yet, and this node is set to run %s\." % (
        re.escape(version) if version else r"[^\n]*")
    return r"geyser_plugin: richat cannot be used on %s: %s Remove geyser_plugin from the inventory to get Yellowstone, the default\. Nothing was changed\." % (re.escape(host), middle)


def unknown_version_message(host):
    return r"geyser_plugin: richat cannot be used on %s: no version of agave or jito is set for it [^\n]*richat has no release for agave 4\.3 or later yet\. Remove geyser_plugin from the inventory to get Yellowstone, the default\. Nothing was changed\." % re.escape(host)


class InitInstallsTheGeyserPlugin(unittest.TestCase):
    """Which plugin plays init runs for a host, and what they render."""

    def test_g01_geyser_nodes_get_the_yellowstone_plugin_unless_the_inventory_says_otherwise(self):
        for network in NETWORKS:
            flow = run_init(network)
            for name, variables in valid_hosts().items():
                if "geyser_plugin" in variables:
                    continue
                with self.subTest("%s %s" % (network, name)):
                    self.assertEqual(flow[name].plugin_plays, expected_plugin_plays(variables))
            with self.subTest("%s: the plugin is built after the start script is written and before the node starts" % network):
                imports = flow[host_name("agave", "Geyser gRPC", None)].imports
                self.assertIn("geyser_build.yml", imports)
                start = next(i for i, play in enumerate(imports) if play.endswith("start_solv.yml"))
                self.assertLess(imports.index("geyser_build.yml"), start)
                self.assertGreater(imports.index("geyser_build.yml"), imports.index("create-start-validator-sh.yml"))

    def test_g02_geyser_plugin_selects_between_yellowstone_and_richat(self):
        # on the pins of "valid", which are older than the first agave that richat has no release for
        for network in NETWORKS:
            flow = run_init(network)
            for name, variables in valid_hosts().items():
                if "geyser_plugin" not in variables:
                    continue
                with self.subTest("%s %s" % (network, name)):
                    self.assertEqual(flow[name].plugin_plays, expected_plugin_plays(variables))
            for plugin, plays in (("yellowstone", YELLOWSTONE_PLAYS), ("richat", RICHAT_PLAYS)):
                with self.subTest("%s: geyser_plugin: %s on a Geyser gRPC node" % (network, plugin)):
                    self.assertEqual(flow[host_name("agave", "Geyser gRPC", plugin)].plugin_plays, plays)

    def test_g03_richat_is_built_before_its_daemon_is_installed(self):
        for network in NETWORKS:
            with self.subTest(network):
                imports = run_init(network)[host_name("jito", "Index RPC + gRPC", "richat")].imports
                self.assertEqual([play for play in imports if play in RICHAT_PLAYS], RICHAT_PLAYS)

    def test_g04_any_other_value_of_geyser_plugin_stops_the_play_before_anything_runs(self):
        for network in NETWORKS:
            flow = run_init(network, "invalid-plugin")
            for name, variables in invalid_plugin_hosts().items():
                with self.subTest("%s %s: geyser_plugin %r" % (network, name, variables["geyser_plugin"])):
                    self.assertEqual(flow[name].imports, [])
                    self.assertNotEqual(flow[name].returncode, 0)
                    self.assertRegex(flow[name].output, r"fatal: \[%s\]: FAILED!" % re.escape(name))
                    self.assertRegex(flow[name].output, plugin_message(name))

    def test_g05_the_default_config_of_the_node_is_the_yellowstone_one(self):
        for network in NETWORKS:
            flow = run_init(network)
            for validator_type in AGAVE_LINE:
                for rpc_type in GEYSER_RPC_TYPES:
                    name = host_name(validator_type, rpc_type, None)
                    with self.subTest("%s %s" % (network, name)):
                        configs = rendered_configs(network, name, flow[name].plugin_plays)
                        self.assertEqual(list(configs), [GEYSER_JSON])
                        record = configs[GEYSER_JSON]
                        self.assertFalse(record.failed, record.message)
                        config = json.loads(record.text)
                        self.assertTrue(config["libpath"].endswith("/libyellowstone_grpc_geyser.so"), config["libpath"])
                        self.assertEqual(config["grpc"]["address"], "0.0.0.0:10000")
                        self.assertEqual(config["prometheus"]["address"], "0.0.0.0:8999")

    def test_g06_the_richat_config_is_rendered_when_the_inventory_asks_for_richat(self):
        # testnet-rpc and devnet-rpc have no richat templates (their plays name ones that jinja/ does
        # not have), so only mainnet can render them
        flow = run_init("mainnet")
        for validator_type in AGAVE_LINE:
            for rpc_type in GEYSER_RPC_TYPES:
                name = host_name(validator_type, rpc_type, "richat")
                with self.subTest(name):
                    configs = rendered_configs("mainnet", name, flow[name].plugin_plays)
                    self.assertEqual(sorted(configs), sorted([GEYSER_JSON, RICHAT_CONFIG, RICHAT_UNIT]))
                    for record in configs.values():
                        self.assertFalse(record.failed, record.message)
                    self.assertEqual(json.loads(configs[GEYSER_JSON].text)["libpath"], "/home/solv/librichat_plugin_agave.so")
                    daemon = yaml.safe_load(configs[RICHAT_CONFIG].text)
                    self.assertEqual(daemon["apps"]["grpc"]["server"]["endpoint"], "0.0.0.0:10000")
                    self.assertIn("ExecStart=/home/solv/richat --config /home/solv/richat-config.yml", configs[RICHAT_UNIT].text)

    def test_g07_testnet_and_devnet_clone_the_yellowstone_version_of_their_own_section(self):
        for network in NETWORKS:
            name = host_name("agave", "Geyser gRPC", None)
            with self.subTest(network):
                clones = [r for r in run_render(network, "geyser_build.yml")[name] if r.module == "git"]
                self.assertEqual(len(clones), 1)
                self.assertEqual(clones[0].args["version"], "yellowstone-of-%s" % network)

    def test_g08_startup_templates_name_the_plugin_config_that_init_renders(self):
        table = yaml.safe_load(STARTUP_TEMPLATES.read_text())["slv_startup_templates"]
        for network in NETWORKS:
            flow = run_init(network)
            rpc = table[network]["rpc"]
            for validator_type in AGAVE_LINE + FIREDANCER:
                for rpc_type, entries in rpc[validator_type].items():
                    plugin_entries = [entry for entry in entries if entry["kind"] in ("yellowstone", "richat")]
                    label = "%s %s %s" % (network, validator_type, rpc_type)
                    if validator_type in FIREDANCER or rpc_type not in GEYSER_RPC_TYPES:
                        with self.subTest(label + " has no plugin"):
                            self.assertEqual(plugin_entries, [])
                        continue
                    with self.subTest(label):
                        self.assertEqual(len(plugin_entries), 1)
                        entry = plugin_entries[0]
                        name = host_name(validator_type, rpc_type, None)
                        self.assertEqual(entry["kind"], "yellowstone")
                        # the play of the entry is a play that init runs for this node by default ...
                        self.assertEqual(entry["play"], "%s-rpc/%s" % (network, flow[name].plugin_plays[0]))
                        # ... and the template of the entry is the one that play renders into geyser.json
                        record = rendered_configs(network, name, flow[name].plugin_plays)[GEYSER_JSON]
                        self.assertEqual(record.args["src"], "~/.slv/" + entry["path"])
                        self.assertTrue((RELEASE / "jinja" / entry["path"]).is_file())

    def test_g09_the_changed_playbooks_pass_the_syntax_check(self):
        # init.yml is checked in its flow copy: the plays it imports are not changed, and those of
        # testnet-rpc and devnet-rpc need collections (community.general) that ansible-core lacks
        with tempfile.TemporaryDirectory(prefix="slv-rpc-syntax-") as tmp:
            root = Path(tmp)
            home = make_home(root)
            playbooks = {}
            for network in NETWORKS:
                copies = root / network
                copies.mkdir()
                playbooks["%s-rpc/init.yml (flow copy)" % network] = make_flow_copy(network, copies)
                playbooks["%s-rpc/geyser_build.yml" % network] = ANSIBLE_DIR / ("%s-rpc" % network) / "geyser_build.yml"
            for network in UPDATE_NETWORKS:
                playbooks["%s-rpc/update_startup_config.yml" % network] = ANSIBLE_DIR / ("%s-rpc" % network) / "update_startup_config.yml"
            for path in ("cmn/stop_richat.yml", "cmn/install_rpc_gateway.yml", "mainnet-rpc/update_startup_config.yml"):
                playbooks[path] = ANSIBLE_DIR / path
            # the gateway play uses openssh_keypair, which community.crypto has
            collections = make_stub_collection(root, "community", "crypto", ["openssh_keypair"])
            for name, playbook in playbooks.items():
                with self.subTest(name):
                    self.assertTrue(playbook.is_file(), "%s is not there" % playbook)
                    process = run_ansible(
                        ["--syntax-check", "-i", "localhost,", playbook], root, home,
                        extra_env={"ANSIBLE_COLLECTIONS_PATH": str(collections)},
                    )
                    self.assertEqual(process.returncode, 0, process.stdout)


class ValidatorTypeIsNeverDefaulted(unittest.TestCase):
    """A missing or unknown validator_type stops the play; it does not become a Firedancer type."""

    def test_g10_init_stops_on_a_missing_or_unknown_validator_type_before_anything_runs(self):
        for network in NETWORKS:
            flow = run_init(network, "invalid-type")
            for name, variables in invalid_type_hosts().items():
                with self.subTest("%s %s: validator_type %r" % (network, name, variables.get("validator_type", "<missing>"))):
                    self.assertEqual(flow[name].imports, [])
                    self.assertNotEqual(flow[name].returncode, 0)
                    self.assertRegex(flow[name].output, r"fatal: \[%s\]: FAILED!" % re.escape(name))
                    self.assertRegex(flow[name].output, type_message(name))

    def test_g11_one_host_that_stops_the_play_ends_the_run_for_the_others(self):
        for network in NETWORKS:
            for scenario in ("ends-run-plugin", "ends-run-type"):
                flow = run_init(network, scenario)
                for name in SCENARIOS[scenario][0]():
                    with self.subTest("%s %s: %s" % (network, scenario, name)):
                        self.assertEqual(flow[name].imports, [])
                        self.assertNotEqual(flow[name].returncode, 0)

    def test_g12_update_startup_config_of_testnet_and_devnet_does_the_same(self):
        templates = {
            "agave": "start-validator.sh.j2", "jito": "start-validator.sh.j2",
            "firedancer-agave": "firedancer-config.toml.j2", "firedancer-jito": "firedancer-config.toml.j2",
        }
        for network in UPDATE_NETWORKS:
            playbook = "%s-rpc/update_startup_config.yml" % network
            valid = run_recorded(playbook, "update-valid")
            for validator_type in SUPPORTED_TYPES:
                with self.subTest("%s %s" % (network, validator_type)):
                    ran = [entry for entry in valid["update-" + validator_type].imports if entry.startswith("template ")]
                    expected = ["template ~/.slv/%s-rpc/%s" % (network, templates[validator_type])] if validator_type in templates else []
                    self.assertEqual(ran, expected)
            invalid = run_recorded(playbook, "update-invalid-type")
            for name, variables in invalid_type_hosts().items():
                with self.subTest("%s %s: validator_type %r" % (network, name, variables.get("validator_type", "<missing>"))):
                    self.assertEqual(invalid[name].imports, [])
                    self.assertNotEqual(invalid[name].returncode, 0)
                    self.assertRegex(invalid[name].output, r"fatal: \[%s\]: FAILED!" % re.escape(name))
                    self.assertRegex(invalid[name].output, type_message(name))


class RichatIsRefusedWhereNoReleaseSupportsTheClient(unittest.TestCase):
    """geyser_plugin: richat stops the play, before anything is built, for an agave that richat has no release for."""

    def test_g13_richat_is_accepted_below_agave_4_3_0_and_refused_from_it(self):
        for network in NETWORKS:
            refused = run_init(network, "richat-refused")
            for name, variables in richat_refused_hosts().items():
                with self.subTest("%s %s" % (network, name)):
                    self.assertEqual(refused[name].imports, [])
                    self.assertNotEqual(refused[name].returncode, 0)
                    self.assertRegex(refused[name].output, r"fatal: \[%s\]: FAILED!" % re.escape(name))
                    # the version the node is set to run: the host's own, else the pin of the network
                    pin = PINS[network][1 if variables["validator_type"] == "jito" else 0]
                    own = variables.get("jito_version" if variables["validator_type"] == "jito" else "agave_version", pin)
                    self.assertRegex(refused[name].output, refusal_message(name, own))
            allowed = run_init(network, "richat-allowed")
            for name in richat_allowed_hosts():
                with self.subTest("%s %s" % (network, name)):
                    self.assertEqual(allowed[name].plugin_plays, RICHAT_PLAYS)
                    self.assertEqual(allowed[name].returncode, 0, allowed[name].output[-2000:])

    def test_g14_richat_is_refused_when_the_version_of_the_client_is_not_known(self):
        for network in NETWORKS:
            flow = run_init(network, "richat-unknown-version")
            for name in richat_unknown_hosts():
                with self.subTest("%s %s" % (network, name)):
                    self.assertEqual(flow[name].imports, [])
                    self.assertNotEqual(flow[name].returncode, 0)
                    self.assertRegex(flow[name].output, unknown_version_message(name))

    def test_g15_richat_chosen_on_a_node_that_installs_no_plugin_is_not_refused(self):
        for network in NETWORKS:
            flow = run_init(network, "richat-inert")
            for name in richat_inert_hosts():
                with self.subTest("%s %s" % (network, name)):
                    self.assertEqual(flow[name].returncode, 0, flow[name].output[-2000:])
                    self.assertEqual(flow[name].plugin_plays, [])
                    self.assertNotEqual(flow[name].imports, [])


class RichatIsStoppedWhereYellowstoneTakesOver(unittest.TestCase):
    """A node that ran richat does not keep it next to the Yellowstone plugin."""

    def test_g16_init_stops_richat_after_the_yellowstone_build_and_before_the_node_starts(self):
        for network in NETWORKS:
            flow = run_init(network)
            for name, variables in valid_hosts().items():
                with self.subTest("%s %s" % (network, name)):
                    imports = flow[name].imports
                    if variables.get("geyser_plugin", "yellowstone") == "yellowstone" and expected_plugin_plays(variables):
                        self.assertIn(STOP_RICHAT, imports)
                        start = next(i for i, play in enumerate(imports) if play.endswith("start_solv.yml"))
                        self.assertEqual(imports.index(STOP_RICHAT), imports.index("geyser_build.yml") + 1)
                        self.assertLess(imports.index(STOP_RICHAT), start)
                    else:
                        self.assertNotIn(STOP_RICHAT, imports)

    def test_g17_stop_richat_stops_and_disables_the_unit_when_there_is_one_and_does_nothing_otherwise(self):
        playbook = ANSIBLE_DIR / "cmn" / "stop_richat.yml"
        self.assertTrue(playbook.is_file(), "%s is not there" % playbook)
        result = run_recorded("cmn/stop_richat.yml", "richat-unit")
        self.assertEqual(
            result["unit-present"].imports, ["stat", "systemd enabled=False name=richat.service state=stopped"],
        )
        self.assertEqual(result["unit-absent"].imports, ["stat"])


class RpcGatewayFollowsThePlugin(unittest.TestCase):
    """The pubsub that the RPC gateway reads."""

    def test_g18_the_pubsub_of_the_gateway_is_the_one_of_the_agave_of_the_node_unless_the_node_runs_richat(self):
        pubsub = run_gateway_pubsub()
        for name, (_, expected) in GATEWAY_HOSTS.items():
            with self.subTest(name):
                self.assertEqual(pubsub[name], expected)


class DocsNameTheDefaultPlugin(unittest.TestCase):
    """The docs of the RPC skills and of the template say which plugin is the default and what became of richat."""

    DOCS = [
        "template/2026.6.6.2026/AGENTS.md",
    ] + [
        "%s/%s/%s" % (root, skill, name)
        for root in ("oss-skills", "dist/oss-skills")
        for skill in ("slv-rpc", "slv-grpc-geyser")
        for name in ("SKILL.md", "AGENT.md")
    ]

    def test_g19_the_docs_make_yellowstone_the_default_and_say_richat_has_no_release_for_agave_4_3(self):
        if not (REPOSITORY / "oss-skills").is_dir():
            self.skipTest("%s holds no oss-skills: these docs are in the repository" % REPOSITORY)
        for doc in self.DOCS:
            with self.subTest(doc):
                text = (REPOSITORY / doc).read_text()
                self.assertIn("geyser_plugin", text)
                self.assertRegex(text, r"(?i)yellowstone[^\n]*default|default[^\n]*yellowstone")
                self.assertRegex(text, r"(?i)richat has no release for agave 4\.3 or later yet")
                self.assertNotRegex(text, r"(?i)richat[^\n]*recommended|recommended[^\n]*richat")


if __name__ == "__main__":
    unittest.main()
