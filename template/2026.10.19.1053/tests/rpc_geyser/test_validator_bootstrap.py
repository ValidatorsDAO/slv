"""Render sync-only startup with Ansible's real Jinja filters; no node commands.

Run with the Python environment used by ansible-playbook (PyYAML and Ansible are
already requirements of the neighboring template tests). All shell checks use
`bash -n` only, never execute the rendered validator script.
"""
import subprocess
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import yaml
from ansible.parsing.dataloader import DataLoader
from ansible.template import Templar

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT.parents[1]
SCRIPTS = [
    "mainnet-validator/start-validator.sh.j2",
    "testnet-validator/start-validator.sh.j2",
    "testnet-validator/start-validator-agave.sh.j2",
    "testnet-validator/start-validator-jito.sh.j2",
]


def render(text, variables):
    return Templar(loader=DataLoader(), variables=variables).template(text)


class ValidatorBootstrap(unittest.TestCase):
    def test_actual_preflight_refuses_missing_or_old_packaged_templates_before_changes(self):
        for state in ("valid", "missing", "old"):
            with self.subTest(state=state), tempfile.TemporaryDirectory(prefix="slv-bootstrap-render-") as directory:
                temporary = Path(directory)
                playbook = temporary / "ansible/testnet-validator/check.json"
                playbook.parent.mkdir(parents=True)
                if state != "missing":
                    for relative in SCRIPTS:
                        path = temporary / "jinja" / relative
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text((ROOT / "jinja" / relative).read_text() if state == "valid" else "legacy template without bootstrap support")
                marker = temporary / "validated"
                playbook.write_text(json.dumps([{
                    "hosts": "localhost", "connection": "local", "gather_facts": False,
                    "vars": {"no_voting": True, "validator_type": "agave", "ansible_python_interpreter": "auto_silent"},
                    "tasks": [
                        {"ansible.builtin.import_tasks": str(ROOT / "ansible/cmn/tasks/validator_bootstrap.yml")},
                        {"ansible.builtin.copy": {"dest": str(marker), "content": "validated"}},
                    ],
                }]))
                environment = {"PATH": os.environ.get("PATH", ""), "HOME": directory, "ANSIBLE_LOCAL_TEMP": str(temporary / "local-tmp"), "ANSIBLE_REMOTE_TEMP": str(temporary / "remote-tmp")}
                result = subprocess.run([shutil.which("ansible-playbook"), "-i", "localhost,", str(playbook)], env=environment, text=True, capture_output=True)
                self.assertEqual(result.returncode == 0, state == "valid", result.stdout + result.stderr)
                self.assertEqual(marker.exists(), state == "valid")

    def test_startup_flags_and_shell_syntax(self):
        for relative in SCRIPTS:
            for mode in ("bootstrap", "bootstrap-explicit", "legacy"):
                with self.subTest(template=relative, mode=mode):
                    variables = {
                        "validator_type": "jito" if "jito" in relative else "agave",
                        "installed_agave_version": "4.4.0-beta.1",
                    }
                    if mode == "legacy":
                        variables["vote_account"] = "ExamplePublicVoteAccount"
                    else:
                        variables["no_voting"] = True
                    if mode == "bootstrap-explicit":
                        variables["expected_shred_version"] = 12345
                    script = render((ROOT / "jinja" / relative).read_text(), variables)
                    result = subprocess.run(["bash", "-n"], input=script, text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("--identity /home/solv/identity.json", script)
                    self.assertIn("--expected-genesis-hash ", script)
                    if mode == "legacy":
                        self.assertIn("--vote-account ExamplePublicVoteAccount", script)
                        self.assertNotIn("--no-voting", script)
                        self.assertIn("--expected-shred-version ", script)
                    else:
                        self.assertIn("--no-voting", script)
                        self.assertNotIn("--vote-account", script)
                        if mode == "bootstrap-explicit":
                            self.assertIn("--expected-shred-version 12345", script)
                        else:
                            self.assertNotIn("--expected-shred-version", script)
                    mirror = REPO / "dist/oss-skills/slv-validator/jinja" / relative
                    self.assertEqual((ROOT / "jinja" / relative).read_bytes(), mirror.read_bytes())

    def test_bootstrap_uses_packaged_startup_and_legacy_keeps_custom_path(self):
        seen = 0
        for network in ("mainnet", "testnet"):
            directory = ROOT / "ansible" / f"{network}-validator"
            for file in directory.glob("*.yml"):
                for play in yaml.safe_load(file.read_text()) or []:
                    for task in play.get("tasks", []):
                        src = task.get("template", {}).get("src", "")
                        if "jinja/" not in src or "start-validator" not in src:
                            continue
                        seen += 1
                        self.assertTrue(play.get("pre_tasks"), file)
                        for bootstrap in (True, False):
                            value = render(src, {"playbook_dir": str(directory), "no_voting": bootstrap})
                            if bootstrap:
                                selected = Path(value).resolve()
                                self.assertTrue(selected.is_file(), selected)
                                self.assertTrue(str(selected).startswith(str(ROOT / "jinja")))
                            else:
                                self.assertTrue(value.startswith(f"~/.slv/{network}-validator/"), value)
        self.assertGreaterEqual(seen, 6)

    def test_bootstrap_preflight_rejects_invalid_flags_and_shred_pins(self):
        tasks = yaml.safe_load((ROOT / "ansible/cmn/tasks/validator_bootstrap.yml").read_text())
        conditions = tasks[0]["ansible.builtin.assert"]["that"]
        for extra, accepted in [
            ({}, True),
            ({"no_voting": True}, True),
            ({"no_voting": True, "expected_shred_version": 12345}, True),
            ({"no_voting": True, "expected_shred_version": "12345"}, True),
            ({"no_voting": True, "expected_shred_version": 0}, False),
            ({"no_voting": True, "expected_shred_version": 65536}, False),
            ({"no_voting": True, "expected_shred_version": True}, False),
            ({"no_voting": "true"}, False),
            ({"no_voting": True, "validator_type": "firedancer-agave"}, False),
        ]:
            variables = {"validator_type": "agave", **extra}
            result = all(render("{{ (" + condition + ") }}", variables) is True for condition in conditions)
            self.assertEqual(result, accepted, variables)

    def test_legacy_activation_refuses_bootstrap_or_op_reference_first(self):
        for network in ("mainnet", "testnet"):
            for name in ("set_identity_key.yml", "switch_on_identity.yml", "nodowntime_migrate.yml"):
                path = ROOT / "ansible" / f"{network}-validator" / name
                play = yaml.safe_load(path.read_text())[0]
                assertion = play["tasks"][0]["ansible.builtin.assert"]
                self.assertIn("SLV_BOOTSTRAP_REFUSED", assertion["fail_msg"])
                for extra, accepted in [({}, True), ({"no_voting": True}, False), ({"identity_ref": "op://example/reference/keypair"}, False)]:
                    variables = {"inventory_hostname": "target", "source_host": "source", "target_host": "target", "hostvars": {"source": {}, "target": extra}}
                    result = all(render("{{ (" + condition + ") }}", variables) is True for condition in assertion["that"])
                    self.assertEqual(result, accepted, (network, name, extra))


if __name__ == "__main__":
    unittest.main()
