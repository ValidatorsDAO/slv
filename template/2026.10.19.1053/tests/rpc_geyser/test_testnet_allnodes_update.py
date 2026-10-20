"""Exercise testnet installer dispatch and version resolution without building or connecting.

The real dispatch/check/wrapper plays run over local fixture hosts. Builders are
cut before their git task and record the resolved tag instead. No sudo, package
installation, source checkout, network access, or validator process is used.
"""

import json
import shutil
import tempfile
import unittest
from pathlib import Path

import yaml

from test_alpenglow_floor import CHECK, make_floor_versions
from test_init_geyser_plugin import (
    ANSIBLE_DIR,
    builder_probe_copy_of,
    make_home,
    run_ansible,
    write_inventory,
)


def observe_update(pin="4.4.0-beta.1-allnodes", override=None):
    with tempfile.TemporaryDirectory(prefix="slv-testnet-update-") as tmp:
        root = Path(tmp)
        cmn = root / "cmn"
        network = root / "testnet-validator"
        cmn.mkdir()
        network.mkdir()
        home = make_home(root, make_floor_versions(
            "testnet_validators", ("4.4.0-beta.1", "4.4.0-beta.1-jito", pin),
        ))
        shutil.copy(CHECK, cmn / CHECK.name)
        dispatch = yaml.safe_load(
            (ANSIBLE_DIR / "testnet-validator/install_solana.yml").read_text(),
        )
        # Only the empty parent play gathers facts; imports and their conditions
        # remain exactly as packaged, including the new Allnodes branch.
        for play in dispatch:
            if "import_playbook" not in play:
                play["gather_facts"] = False
                play["become"] = False
        (network / "install_solana.yml").write_text(yaml.safe_dump(dispatch))
        shutil.copy(
            ANSIBLE_DIR / "testnet-validator/install_allnodes_jito.yml", network,
        )
        for client in ("agave", "jito"):
            source = yaml.safe_load(
                (ANSIBLE_DIR / f"testnet-validator/install_{client}.yml").read_text(),
            )
            probe = builder_probe_copy_of(source[-1], client)
            (network / f"install_{client}.yml").write_text(yaml.safe_dump([probe]))
        source = yaml.safe_load((ANSIBLE_DIR / "cmn/build_allnodes_jito.yml").read_text())
        (cmn / "build_allnodes_jito.yml").write_text(yaml.safe_dump([
            builder_probe_copy_of(source[0], "allnodes"),
        ]))
        out = root / "out"
        out.mkdir()
        hosts = {
            "agave": {"validator_type": "agave"},
            "jito": {"validator_type": "jito"},
            # Validator update uses the pin rather than this stale host override.
            "allnodes": {
                "validator_type": "allnodes-jito",
                "allnodes_jito_version": "3.1.10-allnodes",
            },
        }
        write_inventory(root / "inventory.json", hosts)
        args = [
            "-i", "inventory.json", network / "install_solana.yml",
            "-e", f"slv_out={out}",
        ]
        if override is not None:
            args += ["-e", f"allnodes_jito_version={override}"]
        result = run_ansible(args, root, home)
        records = {
            host: {
                path.stem: json.loads(path.read_text())["args"]
                for path in (out / host).glob("*.json")
            }
            for host in hosts
        }
        return result, records


class TestnetAllnodesUpdate(unittest.TestCase):
    def test_dispatch_builds_each_client_and_allnodes_uses_the_testnet_pin(self):
        result, records = observe_update()
        self.assertEqual(result.returncode, 0, result.stdout[-2500:])
        self.assertEqual(set(records["agave"]), {"agave"})
        self.assertEqual(set(records["jito"]), {"jito"})
        self.assertEqual(set(records["allnodes"]), {"allnodes"})
        allnodes = records["allnodes"]["allnodes"]
        self.assertEqual(allnodes["repo"], "https://github.com/allnodes/solana-jito.git")
        self.assertEqual(allnodes["version"], "v4.4.0-beta.1-allnodes")

    def test_explicit_tags_have_one_v_prefix_and_one_allnodes_suffix(self):
        for version in ("v4.4.0-beta.1-allnodes", "4.4.0-beta.1"):
            with self.subTest(version):
                result, records = observe_update(override=version)
                self.assertEqual(result.returncode, 0, result.stdout[-2500:])
                self.assertEqual(
                    records["allnodes"]["allnodes"]["version"],
                    "v4.4.0-beta.1-allnodes",
                )

    def test_old_allnodes_version_is_refused_before_any_builder(self):
        for pin, override in (
            ("4.3.2-allnodes", None),
            ("4.4.0-beta.1-allnodes", "v4.3.2-allnodes"),
        ):
            with self.subTest(pin=pin, override=override):
                result, records = observe_update(pin, override)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("is older than Alpenglow runs on", result.stdout)
                self.assertTrue(all(not value for value in records.values()))


if __name__ == "__main__":
    unittest.main()
