"""Real Ansible restart orchestration with a disposable local controller fixture."""

import json
import os
from pathlib import Path
import shlex
import tempfile
import unittest

import yaml

from test_init_geyser_plugin import ANSIBLE_DIR, make_home, run_ansible


FAKE = r'''
import json,os,sys
from pathlib import Path
args = sys.argv[1:]
network = args[args.index("--network") + 1]
sync = "--sync-only-requested" in args
threshold = 100 if network == "testnet" and sync else 10
execute = "--execute" in args
mode = os.environ.get("SLV_FIXTURE_MODE", "success")
event = {"execute": execute, "network": network, "sync": sync,
         "threshold": threshold, "probePath": __file__}
with open(os.environ["SLV_FIXTURE_LOG"], "a") as output:
    output.write(json.dumps(event) + "\n")
if execute:
    assert args[args.index("--expected-pid") + 1] == "123"
    assert args[args.index("--expected-start-ticks") + 1] == "456"
    assert args[args.index("--expected-startup-sha256") + 1] == "a" * 64
    assert args[args.index("--expected-threshold") + 1] == str(threshold)
    assert args[args.index("--wait-seconds") + 1] == "600"
    print(json.dumps({"outcome": "fixture completed"}))
    sys.exit(7 if mode == "failure" else 0)
print(json.dumps({
    "servicePid": 123, "serviceStartTicks": 456, "startupSha256": "a" * 64,
    "controllersKnown": True, "exitControllers": [999] if mode == "existing" else [],
    "maxDelinquentStake": threshold, "verifiedSyncOnly": threshold == 100,
    "delinquentStakePercent": 12.5, "reason": "fixture policy",
}))
'''


def flow(groups=("testnet_validators",), no_voting=True, mode="success", check=False):
    with tempfile.TemporaryDirectory(prefix="slv-restart-flow-") as tmp:
        root = Path(tmp)
        home = make_home(root, {})
        (home / ".profile").write_text("# isolated fixture\n")
        play = yaml.safe_load((ANSIBLE_DIR / "cmn/restart_solv.yml").read_text())
        play[0]["become"] = False
        play[0].pop("become_user", None)
        play[0]["gather_facts"] = False
        play[0]["vars"] = {"ansible_async_dir": str(root / "async")}
        def shorten_polling(tasks):
            for task in tasks:
                if "async" in task:
                    # Assert the packaged limits before shortening fixture polling.
                    assert task["async"] == 660 and task["poll"] == 10
                    task["async"], task["poll"] = 15, 1
                    shell = task["ansible.builtin.shell"]
                    assert shell.startswith(". ~/.profile &&")
                    task["ansible.builtin.shell"] = shell.replace(
                        ". ~/.profile &&", ". " + shlex.quote(str(home / ".profile")) + " &&", 1,
                    )
                for key in ("block", "rescue", "always"):
                    shorten_polling(task.get(key, []))
        shorten_polling(play[0]["tasks"])
        (root / "files").mkdir()
        (root / "files/restart_policy.py").write_text(FAKE)
        (root / "restart.yml").write_text(yaml.safe_dump(play, sort_keys=False))
        variables = {
            "ansible_connection": "local",
            "ansible_python_interpreter": os.sys.executable,
            "no_voting": no_voting,
        }
        inventory = {"all": {"children": {
            group: {"hosts": {"example": variables}} for group in groups
        }}}
        (root / "inventory.json").write_text(json.dumps(inventory))
        log = root / "events.jsonl"
        args = ["-i", root / "inventory.json", root / "restart.yml"]
        if check:
            args.append("--check")
        result = run_ansible(args, root, home, timeout=60, extra_env={
            "SLV_FIXTURE_LOG": str(log), "SLV_FIXTURE_MODE": mode,
        })
        events = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        for event in events:
            if Path(event["probePath"]).exists():
                raise AssertionError("Temporary controller was not cleaned up")
        return result, events


class RestartPlaybook(unittest.TestCase):
    def test_only_unambiguous_testnet_validator_and_boolean_true_request_relaxation(self):
        cases = [
            (("testnet_validators",), True, 100),
            (("testnet_validators",), False, 10),
            (("testnet_validators",), "true", 10),
            (("mainnet_validators",), True, 10),
            (("testnet_rpcs",), True, 10),
            (("testnet_validators", "mainnet_validators"), True, 10),
        ]
        for groups, intent, threshold in cases:
            with self.subTest(groups=groups, intent=intent):
                result, events = flow(groups, intent)
                self.assertEqual(result.returncode, 0, result.stdout[-2500:])
                self.assertEqual([event["execute"] for event in events], [False, True])
                self.assertEqual(events[-1]["threshold"], threshold)
                self.assertIn("Progress is polled every 10 seconds", result.stdout)

    def test_existing_controller_refuses_a_second_operation(self):
        result, events = flow(mode="existing")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([event["execute"] for event in events], [False])
        self.assertIn("another exit controller", result.stdout)

    def test_failed_controller_is_not_retried_and_fails_the_play(self):
        result, events = flow(mode="failure")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([event["execute"] for event in events], [False, True])
        self.assertIn("does not automatically retry", result.stdout)

    def test_check_mode_observes_without_requesting_restart(self):
        result, events = flow(check=True)
        self.assertEqual(result.returncode, 0, result.stdout[-2500:])
        self.assertEqual([event["execute"] for event in events], [False])


if __name__ == "__main__":
    unittest.main()
