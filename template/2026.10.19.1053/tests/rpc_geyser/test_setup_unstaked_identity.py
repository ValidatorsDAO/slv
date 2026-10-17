"""Test of ansible/cmn/setup_unstaked_identity.yml: the unstaked key is made without showing its seed phrase.

solana-keygen new prints the seed phrase of the key it makes unless it is given --silent, and the output of a task reaches
the log of a verbose run. The task that makes /home/solv/unstaked-identity.json passes --silent and keeps its output out of
the log (no_log), and the key file it writes is the same. The test runs that task with ansible-playbook at -vvv on this
machine, with a temporary directory for HOME and for the paths of the node, and a solana-keygen that shows a seed phrase
unless it is silent. Like test_init_geyser_plugin.py, whose helpers it takes, it needs PyYAML and ansible-playbook. Run from
the repository root:

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
from test_keyless_deploy import move_to  # noqa: E402

SETUP_UNSTAKED = ANSIBLE_DIR / "cmn" / "setup_unstaked_identity.yml"
SEED_PHRASE = "SEED-PHRASE-OF-THE-UNSTAKED-KEY"


@functools.lru_cache(maxsize=None)
def run_key_generation():
    """The task of setup_unstaked_identity.yml that makes unstaked-identity.json, with a solana-keygen that shows a seed
    phrase unless it is given --silent and always says that it wrote the key, run at -vvv."""
    with tempfile.TemporaryDirectory(prefix="slv-unstaked-key-") as tmp:
        root = Path(tmp)
        home = root / "home"
        home.mkdir()
        (home / ".profile").write_text("")
        (root / "solv").mkdir()
        calls = root / "calls.log"
        calls.write_text("")
        bin_dir = root / "bin"
        bin_dir.mkdir()
        # sudo -u solv <command>: no other user here
        (bin_dir / "sudo").write_text('#!/bin/bash\nshift 2\nexec "$@"\n')
        (bin_dir / "solana-keygen").write_text(
            '#!/bin/bash\necho "solana-keygen $*" >>"%s"\nout=\nsilent=0\nwhile [ $# -gt 0 ]; do\n'
            '  case "$1" in --outfile) out="$2"; shift ;; --silent) silent=1 ;; esac\n  shift\ndone\n'
            'printf "[1,2,3]" >"$out"\necho "Wrote new keypair to $out"\n[ "$silent" = 1 ] || echo "%s one two three"\nexit 0\n'
            % (calls, SEED_PHRASE))
        for name in ("sudo", "solana-keygen"):
            (bin_dir / name).chmod(0o755)
        play = yaml.safe_load(move_to(SETUP_UNSTAKED.read_text(), root))[0]
        probe = {"name": "the key of setup_unstaked_identity.yml", "hosts": "all", "gather_facts": False,
                 "tasks": play["tasks"][:1]}
        playbook = root / "probe.yml"
        playbook.write_text(yaml.safe_dump([probe], sort_keys=False))
        write_inventory(root / "inventory.json", {"node": {}})
        process = run_ansible(["-vvv", "-i", "inventory.json", playbook, "-e", "ansible_become=false"], root, home,
                              extra_env={"PATH": "%s:%s" % (bin_dir, os.environ.get("PATH", ""))})
        key = root / "solv" / "unstaked-identity.json"
        return {"rc": process.returncode, "output": process.stdout, "calls": calls.read_text().splitlines(),
                "key": key.read_text() if key.exists() else None, "outfile": str(key)}


class TheUnstakedKeyIsMadeWithoutShowingItsSeedPhrase(unittest.TestCase):
    def test_s01_solana_keygen_is_silent_and_the_log_does_not_carry_the_seed_phrase(self):
        result = run_key_generation()
        self.assertEqual(result["rc"], 0, result["output"][-2000:])
        self.assertEqual(result["key"], "[1,2,3]", "the key file is written as before")
        self.assertEqual(result["calls"], ["solana-keygen new --silent --outfile %s --no-passphrase" % result["outfile"]])
        self.assertNotIn(SEED_PHRASE, result["output"], "the seed phrase of the key reached the output")
        # no_log: what the command prints, even when it is silent, is not in the log either
        self.assertNotIn("Wrote new keypair", result["output"], "the output of the task is in the log")


if __name__ == "__main__":
    unittest.main()
