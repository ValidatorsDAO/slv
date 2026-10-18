"""Unit tests for matrix.py, which makes the cells of the firewall render matrix from version.ts.

Run from the repository root, together with the other tests of this directory:

    python3 -m unittest discover -s template/latest/tests/firewall -p 'test_*.py' -v

matrix.py and the listen model plugin are loaded on first use (standard library only, no
Ansible), so that a file that does not load fails the tests that use it by name.
"""

import importlib.util
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MATRIX = os.path.join(HERE, "matrix.py")
PLUGIN = os.path.normpath(
    os.path.join(HERE, "..", "..", "ansible", "cmn", "firewall", "filter_plugins", "slv_listen_model.py")
)

_loaded = {}


def load(name, path):
    if name not in _loaded:
        spec = importlib.util.spec_from_file_location(name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _loaded[name] = module
    return _loaded[name]


def matrix():
    return load("matrix", MATRIX)


def plugin():
    return load("slv_listen_model", PLUGIN)


def pins():
    """The `export const VERSION_*` values of cmn/constants/version.ts, as matrix.py reads them."""
    return matrix().read_pins(matrix().VERSION_FILE)


class MatrixPins(unittest.TestCase):
    """How the pins of version.ts become the client versions of the cells."""

    def test_m01_matrix_py_knows_every_pin_of_version_ts(self):
        # check_pins_known stops the run (SystemExit) for a pin that is neither a client version nor an
        # OTHER_PINS entry, and for a client pin that version.ts no longer has
        matrix().check_pins_known(pins())

    def test_m02_the_validators_and_the_rpcs_of_a_network_take_their_own_pins(self):
        m, values = matrix(), pins()
        cells = dict((cell["id"], cell) for cell in m.all_cells(values))
        expected = (
            # (cell, the pin of its client, the key of its client in the versions.yml group)
            ("mainnet-validator/agave", "VERSION_SOLANA_VALIDATOR_MAINNET", "version_agave"),
            ("mainnet-validator/jito", "VERSION_JITO_VALIDATOR_MAINNET", "version_jito"),
            ("testnet-validator/agave", "VERSION_SOLANA_VALIDATOR_TESTNET", "version_agave"),
            ("testnet-validator/jito", "VERSION_JITO_VALIDATOR_TESTNET", "version_jito"),
            ("mainnet-rpc/agave/index-rpc", "VERSION_SOLANA_MAINNET", "version_agave"),
            ("mainnet-rpc/jito/index-rpc", "VERSION_JITO_MAINNET", "version_jito"),
            ("testnet-rpc/agave/index-rpc", "VERSION_SOLANA_TESTNET", "version_agave"),
            ("testnet-rpc/jito/index-rpc", "VERSION_JITO_TESTNET", "version_jito"),
            ("devnet-rpc/agave/index-rpc", "VERSION_SOLANA_DEVNET", "version_agave"),
            ("devnet-rpc/jito/index-rpc", "VERSION_JITO_DEVNET", "version_jito"),
        )
        for prefix, pin, key in expected:
            for inventory in m.INVENTORIES:
                with self.subTest("%s/%s" % (prefix, inventory)):
                    cell = cells["%s/%s" % (prefix, inventory)]
                    self.assertEqual(cell["pin"], pin)
                    self.assertEqual(cell["profile"]["version"], values[pin])
                    self.assertEqual(cell["group_versions"][key], values[pin])
        with self.subTest("the allnodes pin of the testnet validators is the one of its own"):
            group = cells["testnet-validator/agave/cli_values"]["group_versions"]
            self.assertEqual(group["version_allnodes_jito"], values["VERSION_ALLNODES_JITO_TESTNET"])

    def test_m03_every_client_version_of_a_cell_has_a_profile_in_the_listen_model(self):
        m, module = matrix(), plugin()
        versions = set()
        for cell in m.all_cells(pins()):
            versions.add((cell["profile"]["client"], cell["profile"]["version"]))
        self.assertTrue(versions)
        for client, version in sorted(versions):
            with self.subTest("%s %s" % (client, version)):
                module._find_profile(client, version)


if __name__ == "__main__":
    unittest.main()
