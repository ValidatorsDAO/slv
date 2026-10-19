"""Tests of the command that the snapshot finder tasks render.

The tasks named "Run Snapshot Finder" put a version into a shell line: the solana_version of the host in the testnet-validator
playbooks (setup_snapshot_finder.yml, restart_agave_with_rm_ledger.yml, restart_firedancer_with_rm_ledger.yml), and the version_jito of
the section of versions.yml in mainnet-validator/run_snapshot_finder.yml and mainnet-rpc/run_snapshot_finder.yml. The line has to hand
the finder that version as one argument whatever characters it holds, and the same command as before for a version such as
4.4.0-beta.1 or v4.3.2-jito.

Ansible renders the command here (a copy task that writes the string of the shell task, with the variables of the host), and the
test reads it back the way a shell would: nothing is run. Run from the repository root:

    python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_*.py' -v
"""

import functools
import os
import shlex
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_init_geyser_plugin import ANSIBLE_DIR, make_home, prefetch, run_ansible, write_inventory  # noqa: E402

TESTNET_COMMAND = (
    "source ./venv/bin/activate && python3 snapshot-finder.py --snapshot_path /mnt/snapshot --version %s "
    "-r http://api.testnet.solana.com --min_download_speed 45\n"
)
MAINNET_COMMAND = (
    "source ./venv/bin/activate && python3 snapshot-finder.py --snapshot_path /mnt/snapshot --version %s "
    "--min_download_speed 45\n"
)
# the playbook, where its version comes from (the solana_version of the host, or version_jito of a section of versions.yml), and
# the command it renders for a version
FINDERS = {
    "testnet-validator/setup_snapshot_finder.yml": ("host", TESTNET_COMMAND),
    "testnet-validator/restart_agave_with_rm_ledger.yml": ("host", TESTNET_COMMAND),
    "testnet-validator/restart_firedancer_with_rm_ledger.yml": ("host", TESTNET_COMMAND),
    "mainnet-validator/run_snapshot_finder.yml": ("mainnet_validators", MAINNET_COMMAND),
    "mainnet-rpc/run_snapshot_finder.yml": ("mainnet_rpcs", MAINNET_COMMAND),
}
NORMAL = ("4.4.0-beta.1", "v4.3.2-jito", "4.4.0-beta.0-jito", "v4.3.2")
HOSTILE = (
    "4.4.0; touch /tmp/pwned", "4.4.0 && id", "$(id)", "`id`", "4.4.0 --min_download_speed 1", "a'b", 'a"b', "4.4.0|cat",
    "4.4.0>x", "x y", "4.4.0\nid", "4.4.0 # -r",
)


def finder_play_and_task(path):
    (found,) = [
        (play, task)
        for play in yaml.safe_load((ANSIBLE_DIR / path).read_text())
        for key in ("pre_tasks", "tasks")
        for task in play.get(key, [])
        if task.get("name") == "Run Snapshot Finder"
    ]
    return found


def render_flow(path, root):
    """A play that writes the string of the shell task of the finder to a file, with the vars_files of its play, so that
    Ansible renders it as it would for the shell module."""
    play, task = finder_play_and_task(path)
    (key,) = [name for name in task if name.rsplit(".", 1)[-1] == "shell"]
    command = task[key]
    assert isinstance(command, str), "the finder task is expected to be a shell line"
    playbook = root / "render.yml"
    playbook.write_text(yaml.safe_dump([{
        "name": "render",
        "hosts": "all",
        "gather_facts": False,
        "vars_files": play.get("vars_files", []),
        "tasks": [{"name": "write the command", "ansible.builtin.copy": {"content": command, "dest": "{{ slv_out }}/{{ inventory_hostname }}.cmd"}}],
    }], sort_keys=False))
    return playbook


@functools.lru_cache(maxsize=None)
def rendered(path, value=None):
    """The command that the finder task of the playbook renders. For a playbook that takes the version of the host: a
    mapping from each version of NORMAL + HOSTILE to its command (value is None). For one that takes it from a section of
    versions.yml: the command for the one version in value."""
    source, _command = FINDERS[path]
    with tempfile.TemporaryDirectory(prefix="slv-finder-") as tmp:
        root = Path(tmp)
        out = root / "out"
        out.mkdir()
        if source == "host":
            hosts = {"v%02d" % number: {"solana_version": version} for number, version in enumerate(NORMAL + HOSTILE)}
            versions = {}
        else:
            hosts = {"node": {}}
            versions = {source: {"version_jito": value}}
        home = make_home(root, versions)
        playbook = render_flow(path, root)
        write_inventory(root / "inventory.json", hosts)
        process = run_ansible(["-i", "inventory.json", playbook, "-e", "slv_out=%s" % out], root, home)
        assert process.returncode == 0, process.stdout[-2000:]
        if source == "host":
            return {version: (out / ("v%02d.cmd" % number)).read_text() for number, version in enumerate(NORMAL + HOSTILE)}
        return (out / "node.cmd").read_text()


def command_for(path, version):
    source, _command = FINDERS[path]
    return rendered(path)[version] if source == "host" else rendered(path, version)


class SnapshotFinderCommand(unittest.TestCase):
    def test_s01_a_version_such_as_4_4_0_beta_1_gives_the_same_command_as_before(self):
        prefetch(rendered, [(path,) for path, (source, _c) in FINDERS.items() if source == "host"]
                 + [(path, version) for path, (source, _c) in FINDERS.items() if source != "host" for version in NORMAL])
        for path, (_source, command) in FINDERS.items():
            for version in NORMAL:
                with self.subTest("%s %s" % (path, version)):
                    self.assertEqual(command_for(path, version), command % version)

    def test_s02_a_version_with_a_shell_metacharacter_is_one_argument_of_the_finder(self):
        prefetch(rendered, [(path,) for path, (source, _c) in FINDERS.items() if source == "host"]
                 + [(path, version) for path, (source, _c) in FINDERS.items() if source != "host" for version in HOSTILE])
        for path, (_source, command) in FINDERS.items():
            plain = shlex.split(command % "X")
            index = plain.index("--version")
            for version in HOSTILE:
                with self.subTest("%s %r" % (path, version)):
                    arguments = shlex.split(command_for(path, version))
                    # the same arguments as for a plain version, and the version as the one after --version
                    self.assertEqual(arguments[:index], plain[:index])
                    self.assertEqual(arguments[index], "--version")
                    self.assertEqual(arguments[index + 1], version)
                    self.assertEqual(arguments[index + 2:], plain[index + 2:])


if __name__ == "__main__":
    unittest.main()
