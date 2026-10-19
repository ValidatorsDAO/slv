"""Tests of build-skill-oss.sh, which builds the skill packages of dist/oss-skills from the template and oss-skills/.

A package holds the playbooks of its networks, the shared playbooks (ansible/cmn) that those import, the shared playbooks that
the docs of the skill name (cmn/<name>.yml in SKILL.md, AGENT.md, README.md, examples/ and scripts/), and what those import
and copy. The names in the docs come from text, so a name that is not a path under ansible/cmn stops the build before it
touches dist, and so does a file that resolves outside ansible/cmn once its links are followed. With no version argument the
script reads the whole version of cmn/constants/version.ts (a CalVer has four numbers).

Each test builds a small tree of its own in a temporary directory: a copy of the script, a template with a few playbooks, the
docs of a skill and a dist that already holds a package. No ansible, no network, no repository file is written. Run from the
repository root:

    python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_*.py' -v
"""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[4]
SCRIPT = REPOSITORY / "build-skill-oss.sh"

VERSION = "2026.6.6.2026"
SKILL = "validator"

VERSION_TS = """// e.g.: VERSION + SOLANA CLI NAME + NETWORK = '0.0.1' only numbers and dots
export const VERSION_SOLANA_MAINNET = '4.3.2'
export const VERSION_JITO_MAINNET = '4.3.2-jito'
export const VERSION = '%s'
export const SOMETHING_VERSION = '9.9.9'
"""

# the shared playbooks of the template tree: what they are for
CMN_FILES = {
    "alpha.yml": "- import_playbook: beta.yml\n- hosts: all\n  tasks:\n    - copy:\n        src: files/asset.sh\n        dest: /tmp/asset.sh\n",
    "beta.yml": "- hosts: all\n  tasks: []\n",
    "gamma.yml": "- hosts: all\n  tasks:\n    - include_tasks: tasks/step.yml\n",
    "doc_named.yml": "- import_playbook: doc_dep.yml\n- hosts: all\n  tasks: []\n",
    "doc_dep.yml": "- hosts: all\n  tasks: []\n",
    "sub/dir_named.yml": "- hosts: all\n  tasks: []\n",
    "from_example.yml": "- hosts: all\n  tasks: []\n",
    "from_script.yml": "- hosts: all\n  tasks: []\n",
    "not_named.yml": "- hosts: all\n  tasks: []\n",
    "tasks/step.yml": "- debug: {msg: step}\n",
    "files/asset.sh": "#!/bin/sh\necho asset\n",
    "files/unused.sh": "#!/bin/sh\necho unused\n",
}

PLAYBOOKS = {
    "mainnet-validator/init.yml": "- import_playbook: ../cmn/alpha.yml\n- import_playbook: ../cmn/gamma.yml\n",
    "testnet-validator/init.yml": "- import_playbook: ../cmn/beta.yml\n",
    "mainnet-rpc/init.yml": "- import_playbook: ../cmn/not_named.yml\n",
}

DOCS = {
    "SKILL.md": "# skill\n\nRun `cmn/doc_named.yml` with `ansible-playbook`. The nested one is `ansible/cmn/sub/dir_named.yml`.\n",
    "AGENT.md": "# agent\n\nSee cmn/alpha.yml.\n",
    "README.md": "# readme\n",
    "examples/inventory.yml": "# ansible-playbook -i inventory.yml cmn/from_example.yml\nall: {}\n",
    "scripts/run.sh": "#!/bin/sh\n# cmn/from_script.yml is run by hand\n",
}


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def make_tree(root, version=VERSION, version_ts=None, docs=None, extra_docs=None):
    """A tree that the script can build from: the script, version.ts, the template, the docs of the validator skill and a
    dist that holds a package already (a skill.json, which oss-skills has no source for, and a stale file)."""
    shutil.copy(SCRIPT, root / "build-skill-oss.sh")
    write(root / "cmn" / "constants" / "version.ts", (VERSION_TS % VERSION) if version_ts is None else version_ts)
    ansible = root / "template" / version / "ansible"
    for name, text in CMN_FILES.items():
        write(ansible / "cmn" / name, text)
    for name, text in PLAYBOOKS.items():
        write(ansible / name, text)
    for name in ("mainnet-validator", "testnet-validator", "mainnet-rpc"):
        write(root / "template" / version / "jinja" / name / "a.j2", "a\n")
    write(root / "template" / version / "jinja" / "cmn" / "c.j2", "c\n")
    for name, text in (DOCS if docs is None else docs).items():
        write(root / "oss-skills" / ("slv-" + SKILL) / name, text)
    for name, text in (extra_docs or {}).items():
        write(root / "oss-skills" / ("slv-" + SKILL) / name, text)
    dist = root / "dist" / "oss-skills" / ("slv-" + SKILL)
    write(dist / "skill.json", '{"name": "slv-validator", "version": "kept"}\n')
    write(dist / "stale.txt", "left over from an earlier build\n")
    return root


def run_build(root, version=VERSION):
    """Build the validator skill of the tree; version=None passes no version, so that the script reads it from version.ts."""
    return subprocess.run(
        ["bash", str(root / "build-skill-oss.sh"), SKILL] + ([] if version is None else [version]), cwd=str(root), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120,
        env=dict(os.environ, LC_ALL="C.UTF-8"),
    )


def files_under(path):
    return sorted(str(p.relative_to(path)) for p in path.rglob("*") if p.is_file() or p.is_symlink())


def package_of(root):
    return root / "dist" / "oss-skills" / ("slv-" + SKILL)


class BuildTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="slv-build-skill-")
        self.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name)
        self.root = self.base / "tree"
        self.root.mkdir()

    def outside_the_package(self):
        """Every file of the temporary directory except the package: what a build must leave as it was."""
        package = package_of(self.root)
        return sorted(
            str(p.relative_to(self.base)) for p in self.base.rglob("*")
            if (p.is_file() or p.is_symlink()) and package not in p.parents
        )


class VersionIsReadWhole(BuildTest):
    def test_b01_with_no_version_argument_the_script_reads_the_four_numbers_of_a_calver(self):
        make_tree(self.root)
        result = run_build(self.root, None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("(v%s)" % VERSION, result.stdout)
        self.assertTrue((package_of(self.root) / "ansible" / "mainnet-validator" / "init.yml").is_file())

    def test_b02_a_version_of_three_numbers_is_read_as_it_is(self):
        make_tree(self.root, version="1.2.3", version_ts=VERSION_TS % "1.2.3")
        result = run_build(self.root, None)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("(v1.2.3)", result.stdout)

    def test_b03_a_version_argument_wins_over_version_ts(self):
        make_tree(self.root)
        # a second template, whose playbook says which one was built
        write(self.root / "template" / "2.0.0" / "ansible" / "mainnet-validator" / "init.yml", "# the second template\n")
        write(self.root / "template" / "2.0.0" / "ansible" / "testnet-validator" / "init.yml", "# the second template\n")
        write(self.root / "template" / "2.0.0" / "ansible" / "cmn" / "beta.yml", "# the second template\n")
        for name in ("mainnet-validator", "testnet-validator"):
            write(self.root / "template" / "2.0.0" / "jinja" / name / "a.j2", "a\n")
        result = run_build(self.root, "2.0.0")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("(v2.0.0)", result.stdout)
        self.assertEqual((package_of(self.root) / "ansible" / "mainnet-validator" / "init.yml").read_text(), "# the second template\n")

    def test_b04_a_version_ts_with_no_version_stops_the_build_and_says_what_to_do(self):
        make_tree(self.root, version_ts="export const VERSION_SOLANA_MAINNET = '4.3.2'\n")
        result = run_build(self.root, None)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Could not detect version", result.stderr)


class PackageHoldsWhatItNames(BuildTest):
    def test_b05_the_package_holds_the_shared_playbooks_that_its_playbooks_import_and_that_its_docs_name_with_what_they_import_and_copy(self):
        make_tree(self.root)
        result = run_build(self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        cmn = files_under(package_of(self.root) / "ansible" / "cmn")
        self.assertEqual(
            cmn,
            sorted([
                # imported by the playbooks of the package, with a sibling it imports, the file it copies and the tasks it includes
                "alpha.yml", "beta.yml", "files/asset.sh", "gamma.yml", "tasks/step.yml",
                # named by the docs: SKILL.md (twice, one with the directory), examples/ and scripts/, with what they import
                "doc_named.yml", "doc_dep.yml", "sub/dir_named.yml", "from_example.yml", "from_script.yml",
            ]),
        )

    def test_b06_a_name_in_the_docs_that_no_file_answers_is_left_out_and_does_not_stop_the_build(self):
        make_tree(self.root, extra_docs={"NOTES.md": "Nothing is called cmn/does_not_exist.yml here.\n"})
        result = run_build(self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((package_of(self.root) / "ansible" / "cmn" / "does_not_exist.yml").exists())

    def test_b07_skill_json_that_oss_skills_has_no_source_for_is_kept_and_the_rest_of_the_old_package_is_replaced(self):
        make_tree(self.root)
        result = run_build(self.root)
        self.assertEqual(result.returncode, 0, result.stderr)
        package = package_of(self.root)
        self.assertEqual((package / "skill.json").read_text(), '{"name": "slv-validator", "version": "kept"}\n')
        self.assertFalse((package / "stale.txt").exists())
        for doc in ("SKILL.md", "AGENT.md", "README.md", "examples/inventory.yml", "scripts/run.sh"):
            self.assertEqual((package / doc).read_text(), (self.root / "oss-skills" / ("slv-" + SKILL) / doc).read_text(), doc)


class NamesFromTextAreChecked(BuildTest):
    """A doc names a shared playbook as text. A name that is not a path under ansible/cmn stops the build before it touches
    dist, and nothing is copied from or to anywhere else."""

    def make_decoys(self):
        """Files outside ansible/cmn that a name with .. or an absolute path would reach."""
        ansible = self.root / "template" / VERSION / "ansible"
        write(ansible / "outside.yml", "- hosts: all\n  tasks: []\n")
        write(self.root / "secret.yml", "- hosts: all\n  tasks: []\n")
        write(self.base / "elsewhere.yml", "- hosts: all\n  tasks: []\n")

    def refused(self, doc_name, line, mentions):
        make_tree(self.root, extra_docs={doc_name: line + "\n"})
        self.make_decoys()
        before_outside = self.outside_the_package()
        before_package = {name: (package_of(self.root) / name).read_text() for name in files_under(package_of(self.root))}
        result = run_build(self.root)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(doc_name, result.stderr)
        self.assertIn(mentions, result.stderr)
        self.assertIn("Nothing was built", result.stderr)
        # the old package is as it was, and nothing was written anywhere else
        self.assertEqual({name: (package_of(self.root) / name).read_text() for name in files_under(package_of(self.root))}, before_package)
        self.assertEqual(self.outside_the_package(), before_outside)

    def test_b08_a_name_with_dot_dot_is_refused_with_the_doc_and_the_name(self):
        self.refused("NOTES.md", "Run cmn/../outside.yml next.", "cmn/../outside.yml")

    def test_b09_a_name_that_climbs_out_of_the_template_is_refused_and_copies_nothing_out_of_it_or_into_dist(self):
        self.refused("NOTES.md", "Run cmn/../../../../secret.yml next.", "cmn/../../../../secret.yml")
        self.assertFalse((self.root / "dist" / "secret.yml").exists())

    def test_b10_a_dot_dot_in_the_middle_of_a_name_is_refused(self):
        self.refused("NOTES.md", "Run cmn/sub/../../outside.yml next.", "cmn/sub/../../outside.yml")

    def test_b11_an_absolute_path_after_cmn_is_refused(self):
        self.refused("NOTES.md", "Run cmn//etc/hosts.yml next.", "cmn//etc/hosts.yml")

    def test_b12_a_file_of_examples_is_read_as_a_doc(self):
        self.refused("examples/extra.yml", "# cmn/../outside.yml", "cmn/../outside.yml")

    def test_b13_a_file_of_scripts_is_read_as_a_doc(self):
        self.refused("scripts/extra.sh", "# cmn/../outside.yml", "cmn/../outside.yml")

    def test_b14_a_name_that_is_a_link_out_of_ansible_cmn_is_refused_before_dist_is_touched(self):
        make_tree(self.root, extra_docs={"NOTES.md": "Run cmn/linked.yml next.\n"})
        self.make_decoys()
        os.symlink(self.base / "elsewhere.yml", self.root / "template" / VERSION / "ansible" / "cmn" / "linked.yml")
        before_outside = self.outside_the_package()
        before_package = files_under(package_of(self.root))
        result = run_build(self.root)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("NOTES.md", result.stderr)
        self.assertIn("cmn/linked.yml", result.stderr)
        self.assertIn("outside ansible/cmn", result.stderr)
        self.assertEqual(files_under(package_of(self.root)), before_package)
        self.assertEqual(self.outside_the_package(), before_outside)

    def test_b15_a_shared_playbook_that_the_template_imports_and_that_is_a_link_out_of_ansible_cmn_is_refused(self):
        make_tree(self.root)
        self.make_decoys()
        ansible = self.root / "template" / VERSION / "ansible"
        os.symlink(self.base / "elsewhere.yml", ansible / "cmn" / "linked.yml")
        write(ansible / "testnet-validator" / "init.yml", "- import_playbook: ../cmn/linked.yml\n")
        before_outside = self.outside_the_package()
        result = run_build(self.root)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("linked.yml", result.stderr)
        self.assertIn("outside ansible/cmn", result.stderr)
        self.assertEqual(self.outside_the_package(), before_outside)
        self.assertFalse((package_of(self.root) / "ansible" / "cmn" / "linked.yml").exists())

    def test_b16_a_file_that_a_shared_playbook_copies_and_that_is_a_link_out_of_ansible_cmn_is_refused(self):
        make_tree(self.root)
        self.make_decoys()
        files = self.root / "template" / VERSION / "ansible" / "cmn" / "files"
        write(self.base / "elsewhere.sh", "#!/bin/sh\necho elsewhere\n")
        (files / "asset.sh").unlink()
        os.symlink(self.base / "elsewhere.sh", files / "asset.sh")
        before_outside = self.outside_the_package()
        result = run_build(self.root)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("files/asset.sh", result.stderr)
        self.assertIn("outside ansible/cmn", result.stderr)
        self.assertEqual(self.outside_the_package(), before_outside)
        self.assertFalse((package_of(self.root) / "ansible" / "cmn" / "files" / "asset.sh").exists())


if __name__ == "__main__":
    unittest.main()
