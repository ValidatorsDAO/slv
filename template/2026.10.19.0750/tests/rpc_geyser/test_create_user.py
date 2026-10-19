"""Tests of ansible/cmn/create_user.yml: the key it authorizes for solv is the one the inventory connects with.

slv v init writes the private key it was given into the inventory as ansible_ssh_private_key_file, runs this play as the
first user, and then switches the inventory to solv with the same private key. So the key that the play puts into the
authorized_keys of solv has to be the public key of that private key, whatever its name or place, and not
~/.ssh/id_rsa.pub. A host whose inventory names no private key keeps ~/.ssh/id_rsa.pub. When the .pub file is not there
the play stops, before it changes anything, and says which file it looked for.

The play also gives solv sudo without a password, so the password it sets has to be a SHA-512 crypt hash ($6$<salt>$<hash>,
what `openssl passwd -6` makes): the user module hands any password that is not None to useradd/usermod -p, so an empty
value would leave solv with an empty password field. The play stops at its own task, before the user task and before it
changes anything, for a value that is empty, missing or not such a hash, and says so.

The tests run the real ansible-playbook on this machine over a local connection, without become, sudo, a network or a
host, with a temporary directory as HOME. The play's own vars: and its first two tasks (the look for the public key and the
stop) are run for hosts that name their private key in different ways, or name none, in a probe play that writes down the
path the play uses and whether the host got past the stop. Like test_init_geyser_plugin.py, whose helpers they take, they
need PyYAML and ansible-playbook (the one on PATH, or the one that ANSIBLE_PLAYBOOK names). Run from the repository root:

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

CREATE_USER = ANSIBLE_DIR / "cmn" / "create_user.yml"
LOOK = "Look for the public key to authorize"
STOP = "Stop when the public key to authorize does not exist"
KEY_TASK = "Add local public key to authorized_keys"
HASH_TASK = "Stop when the password hash of solv is empty or not a SHA-512 crypt hash"
USER_TASK = "Ensure solv user exists"
# a SHA-512 crypt hash, as `openssl passwd -6 -salt abcdefgh <password>` makes it
SHA512_HASH = "$6$abcdefgh$d3.qg23mdXQOkqqjZXZyUXFhKyznlA8rakh8ntGy3dYyBAMvwwuIKlodGzggq4uszLBsp6LVbpJBYP/NCc/8.1"
SHA512_DIGEST = SHA512_HASH.split("$")[3]


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


def probe_of_hash(play, remote_tmp, logs_var="slv_log_dir"):
    """The vars: of the play and every task of it that comes before the user task, as they are (the look for the public
    key, the stop, and whatever checks the password), and a task that marks the host as past them: the hosts that are
    past are the hosts that the play would let reach the user task. Only ansible_remote_tmp is a directory of the test."""
    marker = {"name": "mark the host past the checks before the user task",
              "ansible.builtin.copy": {"content": "past", "dest": "{{ %s }}/{{ inventory_hostname }}.past" % logs_var}}
    return {
        "name": "the tasks of create_user.yml before the user task",
        "hosts": "all",
        "gather_facts": False,
        "vars": dict(play["vars"], ansible_remote_tmp=str(remote_tmp)),
        "tasks": tasks_before(play, USER_TASK) + [marker],
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


# the value that ~/.slv/config.pwd.yml gives encrypted_password, one host each (a host variable stands for the vars_files)
HASHES = {
    "hash-sha512": {"encrypted_password": SHA512_HASH},
    "hash-sha512-long-salt": {"encrypted_password": "$6$" + "s" * 16 + "$" + SHA512_DIGEST},
    "hash-empty": {"encrypted_password": ""},
    "hash-null": {"encrypted_password": None},
    "hash-missing": {},
    "hash-plain": {"encrypted_password": "correct horse battery staple"},
    "hash-md5": {"encrypted_password": "$1$abcdefgh$4cUXz7pYd3jV6tQd9cR0D/"},
    "hash-sha256": {"encrypted_password": "$5$abcdefgh$" + "A" * 43},
    "hash-no-salt": {"encrypted_password": "$6$$" + SHA512_DIGEST},
    "hash-no-hash": {"encrypted_password": "$6$abcdefgh$"},
    "hash-newline": {"encrypted_password": SHA512_HASH + "\n"},
    "hash-locked": {"encrypted_password": "!"},
}
HASH_GOES_ON = {"hash-sha512", "hash-sha512-long-salt"}


@functools.lru_cache(maxsize=None)
def run_hashes():
    with tempfile.TemporaryDirectory(prefix="slv-create-user-hash-") as tmp:
        root = Path(tmp)
        home = root / "home"
        ssh = home / ".ssh"
        ssh.mkdir(parents=True)
        (ssh / "id_rsa.pub").write_text("ssh-key-of-id_rsa.pub\n")   # the public key is there: only the hash is in question
        logs = root / "logs"
        logs.mkdir()
        playbook = root / "probe.yml"
        playbook.write_text(yaml.safe_dump([probe_of_hash(play_of_create_user(), root / "remote-tmp")], sort_keys=False))
        write_inventory(root / "inventory.json", HASHES)
        process = run_ansible(["-i", "inventory.json", playbook, "-e", "slv_log_dir=%s" % logs], root, home)
        return Run(process, {}, {name for name in HASHES if (logs / (name + ".past")).exists()})


def tasks_before(play, name):
    names = [task.get("name") for task in play["tasks"]]
    return play["tasks"][:names.index(name)]


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


class CreateUserSetsOnlyASha512CryptPassword(unittest.TestCase):
    def test_c07_the_play_goes_on_with_a_sha512_crypt_hash(self):
        result = run_hashes()
        self.assertEqual(result.past & HASH_GOES_ON, HASH_GOES_ON, "a $6$ hash is refused:\n" + result.output[-3000:])

    def test_c08_the_play_stops_at_its_own_task_for_a_value_that_is_not_such_a_hash(self):
        result = run_hashes()
        refused = set(HASHES) - HASH_GOES_ON
        self.assertEqual(result.past, HASH_GOES_ON, "a value that is not a $6$ hash got past the check:\n" + result.output[-3000:])
        blocks = [block for block in re.split(r"^(?=TASK \[)", result.output, flags=re.M) if block.startswith("TASK [")]
        for name in sorted(refused):
            with self.subTest(host=name):
                failed = [block for block in blocks if re.search(r"fatal: \[%s\]: FAILED!" % re.escape(name), block)]
                self.assertEqual(len(failed), 1, "the host fails in one task:\n" + result.output[-3000:])
                self.assertIn("TASK [%s]" % HASH_TASK, failed[0], "and that is the task of the password hash")
                self.assertIn("the password hash in ~/.slv/config.pwd.yml is empty or not a $6$ hash; "
                              "nothing was changed on %s." % name, failed[0])

    def test_c09_the_check_comes_before_the_user_task_and_only_reads_before_it(self):
        play = play_of_create_user()
        before = tasks_before(play, USER_TASK)
        self.assertIn(task_named(play, HASH_TASK), before, "the check of the hash comes before the user task")
        modules = {key for task in before for key in task if key not in ("name", "become", "delegate_to", "register", "when", "follow", "quiet")}
        self.assertEqual(modules, {"stat", "fail", "ansible.builtin.assert"}, "nothing is changed before the user task")
        self.assertEqual(task_named(play, USER_TASK)["user"]["password"], "{{ encrypted_password }}",
                         "the user task sets the value that the check looked at")
        self.assertIn("encrypted_password", task_named(play, HASH_TASK)["ansible.builtin.assert"]["that"][0])


if __name__ == "__main__":
    unittest.main()
