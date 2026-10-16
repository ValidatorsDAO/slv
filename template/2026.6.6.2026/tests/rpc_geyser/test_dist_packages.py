"""Tests of the dist/oss-skills packages that build-skill-oss.sh writes: slv-validator, slv-rpc and slv-grpc-geyser.

A package is a copy of the playbooks and templates of its networks, the shared playbooks (cmn/) that they import and that its docs name,
and the docs (SKILL.md, AGENT.md, README.md, examples/, scripts/) from oss-skills/. A reader who is told by a doc of the package to
run cmn/optimize_node.yml has to find it in the package.

  docs        every playbook and template that a doc of a package names is in that package, except the files that are not
              part of a package: the inventory of the reader, versions.yml and the other files that slv keeps in ~/.slv,
              and overrides.yml, which create_overrides.yml writes on the host
  assets      a shared playbook of a package that copies files/<name> has that file next to it
  skill.json  each package has its skill.json: the installer and `slv skills sync` fetch it, and no source under oss-skills/ writes it
  README.md   dist/oss-skills/README.md is a copy of oss-skills/README.md: the build script writes the packages, not this file

The files are read; nothing is run. Run from the repository root:

    python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_*.py' -v
"""

import json
import os
import re
import sys
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_init_geyser_plugin import REPOSITORY  # noqa: E402

DIST = REPOSITORY / "dist" / "oss-skills"
PACKAGES = ("slv-validator", "slv-rpc", "slv-grpc-geyser")

# playbooks and templates, as a doc names them: a path or a bare file name. A placeholder such as {net}-validator/init.yml is no name.
NAME = re.compile(r"(?<![\w./~{}<>$*-])((?:~/\.slv/)?(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.(?:yml|yaml|j2))(?![\w-])")

# files that a doc names and that are not part of a package: the inventory of the reader, the files that slv keeps in ~/.slv, and the
# overrides.yml that create_overrides.yml writes on the host
NOT_PACKAGE = {"inventory.yml", "my-inventory.yml", "../my-inventory.yml", "versions.yml", "overrides.yml"}
SLV_CONFIG = re.compile(r"^~/\.slv/(versions\.yml|api\.yml|inventory\.[a-z.]+\.yml)$")


def doc_files(package):
    root = DIST / package
    files = [root / name for name in ("SKILL.md", "AGENT.md", "README.md") if (root / name).is_file()]
    for directory in ("examples", "scripts"):
        if (root / directory).is_dir():
            files += [path for path in sorted((root / directory).rglob("*")) if path.is_file()]
    return files


def held_by(package):
    """The playbooks and templates of the package: their paths relative to the package, and their base names."""
    root = DIST / package
    held, bases = set(), set()
    for part in ("ansible", "jinja"):
        for path in (root / part).rglob("*"):
            if path.is_file():
                held.add(str(path.relative_to(root)))
                bases.add(path.name)
    return held, bases


def names_missing(package):
    held, bases = held_by(package)
    root = DIST / package
    missing = {}
    for doc in doc_files(package):
        for match in NAME.finditer(doc.read_text(errors="replace")):
            name = match.group(1)
            if name in NOT_PACKAGE or SLV_CONFIG.match(name):
                continue
            key = name[len("~/.slv/"):] if name.startswith("~/.slv/") else name
            if "/" in key:
                found = any(candidate in held for candidate in (key, "ansible/" + key, "jinja/" + key)) or (root / key).exists()
            else:
                found = key in bases
            if not found:
                missing.setdefault(name, set()).add(str(doc.relative_to(root)))
    return missing


class PackagesHoldWhatTheirDocsName(unittest.TestCase):
    def test_d01_every_playbook_and_template_that_a_doc_of_a_package_names_is_in_the_package(self):
        for package in PACKAGES:
            with self.subTest(package):
                missing = names_missing(package)
                self.assertEqual({name: sorted(docs) for name, docs in missing.items()}, {})

    def test_d02_a_shared_playbook_that_copies_a_file_has_it_next_to_it(self):
        for package in PACKAGES:
            cmn = DIST / package / "ansible" / "cmn"
            for playbook in sorted(cmn.rglob("*.yml")):
                for asset in re.findall(r"src:\s*files/([A-Za-z0-9_.-]+)", playbook.read_text()):
                    with self.subTest("%s %s" % (package, playbook.relative_to(cmn))):
                        self.assertTrue((cmn / "files" / asset).is_file(), "files/%s is not there" % asset)

    def test_d03_a_shared_playbook_of_a_package_imports_only_playbooks_that_the_package_holds(self):
        for package in PACKAGES:
            cmn = DIST / package / "ansible" / "cmn"
            for playbook in sorted(cmn.glob("*.yml")):
                entries = yaml.safe_load(playbook.read_text())
                if not isinstance(entries, list):
                    continue
                for entry in entries:
                    target = entry.get("import_playbook") if isinstance(entry, dict) else None
                    if target and "{{" not in target:
                        with self.subTest("%s %s imports %s" % (package, playbook.name, target)):
                            self.assertTrue((playbook.parent / target).resolve().is_file())

    def test_d04_each_package_has_its_skill_json(self):
        for package in PACKAGES:
            path = DIST / package / "skill.json"
            with self.subTest(package):
                self.assertTrue(path.is_file(), "%s is not there" % path)
                skill = json.loads(path.read_text())
                self.assertEqual(skill["name"], package)
                self.assertIn("version", skill)
                self.assertEqual(skill["files"], {"skill": "SKILL.md", "agent": "AGENT.md"})
                self.assertTrue((DIST / package / "SKILL.md").is_file())
                self.assertTrue((DIST / package / "AGENT.md").is_file())

    def test_d05_the_readme_over_the_packages_is_a_copy_of_the_one_of_oss_skills(self):
        self.assertEqual((DIST / "README.md").read_text(), (REPOSITORY / "oss-skills" / "README.md").read_text())


if __name__ == "__main__":
    unittest.main()
