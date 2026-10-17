"""Tests of ansible/cmn/create_user.yml: the key it authorizes for solv is the one the inventory connects with.

slv v init writes the private key it was given into the inventory as ansible_ssh_private_key_file, runs this play as the
first user, and then switches the inventory to solv with the same private key. So the key that the play puts into the
authorized_keys of solv has to be the public key of that private key, whatever its name or place, and not
~/.ssh/id_rsa.pub. A host whose inventory names no private key keeps ~/.ssh/id_rsa.pub. When the .pub file is not there
the play stops, before it changes anything, and says which file it looked for.

The tests run the real ansible-playbook on this machine over a local connection, without become, sudo, a network or a
host, with a temporary directory as HOME. The play's own vars: and its first two tasks (the look for the public key and the
stop) are run for hosts that name their private key in different ways, or name none, in a probe play that writes down the
path the play uses and whether the host got past the stop. Like test_init_geyser_plugin.py, whose helpers they take, they
need PyYAML and ansible-playbook (the one on PATH, or the one that ANSIBLE_PLAYBOOK names). Run from the repository root:

    python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_*.py' -v
"""

import functools
import os
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_init_geyser_plugin import ANSIBLE_DIR, run_ansible, write_inventory  # noqa: E402

CREATE_USER = ANSIBLE_DIR / "cmn" / "create_user.yml"
LOOK = "Look for the public key to authorize"
STOP = "Stop when the public key to authorize does not exist"
KEY_TASK = "Add local public key to authorized_keys"


def play_of_create_user():
    source = yaml.safe_load(CREATE_USER.read_text())
    assert isinstance(source, list) and len(source) == 1, "one play is expected"
    return source[0]


def task_named(play, name):
    found = [task for task in play["tasks"] if task.get("name") == name]
    assert len(found) == 1, "%s: expected one task named %r, found %d" % (CREATE_USER, name, len(found))
    return found[0]


def probe_of(play, remote_tmp, with_stop, logs_var="slv_log_dir"):
    """The vars: of the play, as they are, and a task that writes down the path of the public key; with with_stop, the
    first two tasks of the play as they are (the look for the public key and the stop) and a task that marks the host as
    past the stop. Only ansible_remote_tmp, where the modules of the probe keep their files, is a directory of the test
    instead of /tmp/ansible_tmp."""
    tasks = [{"name": "write the path down",
              "ansible.builtin.copy": {"content": "{{ local_public_key_path }}",
                                       "dest": "{{ %s }}/{{ inventory_hostname }}.path" % logs_var}}]
    if with_stop:
        guard = [task_named(play, LOOK), task_named(play, STOP)]
        assert play["tasks"][:2] == guard, "the look for the public key and the stop come first, before anything is changed"
        tasks += guard + [{"name": "mark the host past the stop",
                           "ansible.builtin.copy": {"content": "past",
                                                    "dest": "{{ %s }}/{{ inventory_hostname }}.past" % logs_var}}]
    return {
        "name": "the public key of create_user.yml",
        "hosts": "all",
        "gather_facts": False,
        "vars": dict(play["vars"], ansible_remote_tmp=str(remote_tmp)),
        "tasks": tasks,
    }


class Run:
    def __init__(self, process, paths, past):
        self.output = process.stdout
        self.paths = paths   # host -> the path the play used
        self.past = past     # the hosts that got past the stop


@functools.lru_cache(maxsize=None)
def run(scenario, with_stop):
    """scenario: "keys" (the .pub files of the keys are there, and ~/.ssh/id_rsa.pub) or "bare" (no .pub file at all)."""
    with tempfile.TemporaryDirectory(prefix="slv-create-user-") as tmp:
        root = Path(tmp)
        home = root / "home"
        ssh = home / ".ssh"
        ssh.mkdir(parents=True)
        keys = root / "keys"
        keys.mkdir()
        if scenario == "keys":
            for pub in (ssh / "id_rsa.pub", ssh / "id_ed25519_slv.pub", keys / "ops_key.pub"):
                pub.write_text("ssh-key-of-%s\n" % pub.name)
        hosts = {
            "named-relative": {"ansible_ssh_private_key_file": "~/.ssh/id_ed25519_slv"},
            "named-absolute": {"ansible_ssh_private_key_file": str(keys / "ops_key")},
            "named-missing": {"ansible_ssh_private_key_file": "~/.ssh/id_missing"},
            "named-empty": {"ansible_ssh_private_key_file": ""},
            "named-none": {},
        }
        logs = root / "logs"
        logs.mkdir()
        playbook = root / "probe.yml"
        playbook.write_text(yaml.safe_dump([probe_of(play_of_create_user(), root / "remote-tmp", with_stop)], sort_keys=False))
        write_inventory(root / "inventory.json", hosts)
        process = run_ansible(["-i", "inventory.json", playbook, "-e", "slv_log_dir=%s" % logs], root, home)
        paths = {name: (logs / (name + ".path")).read_text() for name in hosts if (logs / (name + ".path")).exists()}
        past = {name for name in hosts if (logs / (name + ".past")).exists()}
        return Run(process, {name: path.replace(str(home), "~") for name, path in paths.items()}, past), str(home), str(keys)


class CreateUserAuthorizesTheKeyOfTheInventory(unittest.TestCase):
    def test_c01_the_public_key_is_the_one_of_the_private_key_that_the_inventory_names(self):
        result, _, keys = run("keys", False)
        self.assertEqual(result.paths["named-relative"], "~/.ssh/id_ed25519_slv.pub",
                         "a private key named with ~ in the inventory:\n" + result.output[-2000:])
        self.assertEqual(result.paths["named-absolute"], keys + "/ops_key.pub", "an absolute path in the inventory")

    def test_c02_a_host_whose_inventory_names_no_private_key_keeps_id_rsa(self):
        result, _, _ = run("keys", False)
        self.assertEqual(result.paths["named-none"], "~/.ssh/id_rsa.pub", "no ansible_ssh_private_key_file")
        self.assertEqual(result.paths["named-empty"], "~/.ssh/id_rsa.pub", "an empty ansible_ssh_private_key_file")

    def test_c03_the_play_goes_on_where_the_public_key_is_there(self):
        result, _, _ = run("keys", True)
        self.assertEqual(result.past, {"named-relative", "named-absolute", "named-empty", "named-none"})

    def test_c04_the_play_stops_before_changing_anything_where_the_public_key_is_not_there(self):
        result, home, _ = run("keys", True)
        self.assertNotIn("named-missing", result.past)
        self.assertIn("The public key %s/.ssh/id_missing.pub does not exist" % home, result.output)
        self.assertIn("for solv on named-missing", result.output)
        self.assertIn("ssh-keygen -y -f ~/.ssh/id_missing > %s/.ssh/id_missing.pub" % home, result.output,
                      "the message says how to make the public key of the private key the inventory names")
        self.assertIn("Nothing was changed on named-missing", result.output)

    def test_c05_the_default_key_is_named_when_the_inventory_names_none_and_id_rsa_pub_is_not_there(self):
        result, home, _ = run("bare", True)
        self.assertEqual(result.past, set(), "no host has a public key to authorize")
        self.assertIn("The public key %s/.ssh/id_rsa.pub does not exist" % home, result.output)
        self.assertIn("The inventory names no ansible_ssh_private_key_file for this host", result.output)

    def test_c06_the_line_that_is_authorized_is_the_content_of_that_path(self):
        task = task_named(play_of_create_user(), KEY_TASK)
        self.assertEqual(task["lineinfile"]["line"], "{{ lookup('file', local_public_key_path) }}")


if __name__ == "__main__":
    unittest.main()
