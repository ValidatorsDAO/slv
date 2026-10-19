"""Tests of the workflow that runs these tests, .github/workflows/slv-template-tests.yml.

The job is named for the ansible-core that apt installs and the workflow pins (ANSIBLE_CORE_VERSION), but the tests start
whatever ansible-playbook comes first on PATH, and the ubuntu-24.04 runner image has an ansible-core of its own (pipx, in
/opt/pipx_bin) ahead of /usr/bin. So the install step puts /usr/bin first and names the pinned binary in ANSIBLE_PLAYBOOK, and
every step that runs a test begins with tests/assert-pinned-ansible.sh, which fails the step on any other ansible-playbook.
The workflow also has to run when the files that the tests read change.

The script is run here with ansible-playbooks of its own that print what ansible-playbook prints on its first line; nothing
else is run. Run from the repository root:

    python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_*.py' -v
"""

import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_init_geyser_plugin import RELEASE, REPOSITORY  # noqa: E402

WORKFLOW = REPOSITORY / ".github" / "workflows" / "slv-template-tests.yml"
ASSERT = RELEASE / "tests" / "assert-pinned-ansible.sh"
ASSERT_COMMAND = "bash template/latest/tests/assert-pinned-ansible.sh"


def workflow():
    return yaml.safe_load(WORKFLOW.read_text())


def steps():
    return workflow()["jobs"]["template-tests"]["steps"]


def install_step():
    return next(step for step in steps() if str(step.get("name", "")).startswith("Install ansible-core"))


def test_steps():
    """The steps after the install step: each of them runs a test."""
    all_steps = steps()
    return all_steps[all_steps.index(install_step()) + 1:]


def commands(step):
    """The lines of the run script of a step that do something: no comments, no set."""
    return [line.strip() for line in str(step["run"]).splitlines()
            if line.strip() and not line.strip().startswith("#") and not line.strip().startswith("set ")]


def fake_ansible_playbook(directory, first_line, status=0):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "ansible-playbook"
    path.write_text("#!/bin/sh\nprintf '%%s\\n' '%s' '  config file = None' '  python version = 3.12.3'\nexit %d\n" % (first_line, status))
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return path


def run_assert(path_dirs, playbook, core="2.16.3"):
    """Run the script with PATH made of path_dirs (and the system's bin directories, for the commands the script uses)."""
    env = {"PATH": ":".join([str(directory) for directory in path_dirs] + ["/usr/bin", "/bin"]), "LC_ALL": "C.UTF-8"}
    if playbook is not None:
        env["ANSIBLE_PLAYBOOK"] = str(playbook)
    if core is not None:
        env["ANSIBLE_CORE_VERSION"] = core
    return subprocess.run(["bash", str(ASSERT)], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)


class TemplateTestsWorkflowRunsThePinnedAnsible(unittest.TestCase):
    def test_w01_every_step_that_runs_a_test_begins_by_checking_that_it_runs_the_pinned_ansible_playbook(self):
        steps_after = test_steps()
        self.assertGreaterEqual(len(steps_after), 5, "the steps that run a test")
        for step in steps_after:
            with self.subTest(step["name"]):
                self.assertEqual(commands(step)[0], ASSERT_COMMAND)

    def test_w02_the_install_step_puts_the_pinned_binary_first_for_the_steps_after_it_and_checks_that_it_does(self):
        script = str(install_step()["run"])
        self.assertIn('echo "/usr/bin" >> "$GITHUB_PATH"', script)
        self.assertIn('echo "ANSIBLE_PLAYBOOK=/usr/bin/ansible-playbook" >> "$GITHUB_ENV"', script)
        self.assertIn('PATH="/usr/bin:$PATH" ANSIBLE_PLAYBOOK=/usr/bin/ansible-playbook ' + ASSERT_COMMAND, script)
        env = workflow()["env"]
        self.assertTrue(env["ANSIBLE_CORE_APT_VERSION"].startswith(env["ANSIBLE_CORE_VERSION"] + "-"))

    def test_w03_the_workflow_runs_when_a_file_that_the_tests_read_changes(self):
        triggers = workflow()[True]
        for event in ("pull_request", "push"):
            with self.subTest(event):
                for path in ("template/**", "oss-skills/**", "dist/oss-skills/**", "build-skill-oss.sh",
                             "cli/lib/fdctlMainnetGuard.ts", ".github/workflows/slv-template-tests.yml"):
                    self.assertIn(path, triggers[event]["paths"])


class AssertPinnedAnsibleScript(unittest.TestCase):
    def test_w04_it_passes_for_the_pinned_ansible_playbook_when_it_comes_first(self):
        with tempfile.TemporaryDirectory(prefix="slv-pinned-") as tmp:
            root = Path(tmp)
            pinned = fake_ansible_playbook(root / "usr-bin", "ansible-playbook [core 2.16.3]")
            fake_ansible_playbook(root / "pipx", "ansible-playbook [core 2.21.5]")
            process = run_assert([root / "usr-bin", root / "pipx"], pinned)
            self.assertEqual(process.returncode, 0, process.stdout)
            self.assertIn("pinned ansible-playbook: %s, ansible-playbook [core 2.16.3]" % pinned, process.stdout)

    def test_w05_it_fails_when_another_ansible_playbook_comes_first_on_path(self):
        # what the runner image does: its own ansible-core, from pipx, is ahead of /usr/bin
        with tempfile.TemporaryDirectory(prefix="slv-pinned-") as tmp:
            root = Path(tmp)
            pinned = fake_ansible_playbook(root / "usr-bin", "ansible-playbook [core 2.16.3]")
            fake_ansible_playbook(root / "pipx", "ansible-playbook [core 2.21.5]")
            process = run_assert([root / "pipx", root / "usr-bin"], pinned)
            self.assertNotEqual(process.returncode, 0)
            self.assertIn("the ansible-playbook on PATH is %s/pipx/ansible-playbook, not the pinned %s" % (root, pinned), process.stdout)

    def test_w06_it_fails_when_the_pinned_binary_reports_another_ansible_core(self):
        with tempfile.TemporaryDirectory(prefix="slv-pinned-") as tmp:
            root = Path(tmp)
            for line in ("ansible-playbook [core 2.21.5]", "ansible-playbook [core 2.16.30]", "ansible-playbook [core 2.16]", "ansible-playbook 2.16.3"):
                pinned = fake_ansible_playbook(root / "usr-bin", line)
                process = run_assert([root / "usr-bin"], pinned)
                with self.subTest(line):
                    self.assertNotEqual(process.returncode, 0)
                    self.assertIn("reports '%s', not ansible-core 2.16.3" % line, process.stdout)

    def test_w07_it_fails_when_it_is_not_told_what_is_pinned_or_nothing_runs(self):
        with tempfile.TemporaryDirectory(prefix="slv-pinned-") as tmp:
            root = Path(tmp)
            pinned = fake_ansible_playbook(root / "usr-bin", "ansible-playbook [core 2.16.3]")
            for label, process in (
                ("no ANSIBLE_PLAYBOOK", run_assert([root / "usr-bin"], None)),
                ("no ANSIBLE_CORE_VERSION", run_assert([root / "usr-bin"], pinned, core=None)),
                ("no ansible-playbook on PATH", run_assert([root / "empty"], pinned)),
            ):
                with self.subTest(label):
                    self.assertNotEqual(process.returncode, 0)
                    self.assertIn("FAIL pinned_ansible", process.stdout)
            broken = fake_ansible_playbook(root / "broken", "ansible-playbook [core 2.16.3]", status=3)
            process = run_assert([root / "broken"], broken)
            self.assertNotEqual(process.returncode, 0)
            self.assertIn("--version failed", process.stdout)


if __name__ == "__main__":
    unittest.main()
