"""Restart policy and owned-child cleanup, using local fixtures only."""

from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import socket
import struct
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "ansible/cmn/files/restart_policy.py"
spec = importlib.util.spec_from_file_location("slv_restart_policy", SOURCE)
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)
IDENTITY = "1" * 32
OTHER = "2" * 32
STARTUP = b"#!/bin/bash\nexec agave-validator -l /mnt/ledger --identity /home/solv/identity.json --no-voting\n"
FACTS = {name: True for name in policy.CHECKS}
META = {
    "servicePid": 123, "serviceStartTicks": 456,
    "startupSha256": hashlib.sha256(STARTUP).hexdigest(),
    "controllersKnown": True, "exitControllers": [],
    "targetVerified": True,
}


def options(**changes):
    value = {
        "network": "testnet", "sync_only_requested": True, "expected_pid": 123,
        "expected_start_ticks": 456, "expected_startup_sha256": META["startupSha256"],
        "expected_threshold": 100, "wait_seconds": 1,
    }
    value.update(changes)
    return SimpleNamespace(**value)


@contextmanager
def observation_fixture():
    with tempfile.TemporaryDirectory(prefix="slv-restart-observation-") as tmp:
        root = Path(tmp).resolve()
        ledger = root / "ledger"
        ledger.mkdir()
        snapshot = {
            "pid": 123, "uid": os.getuid(), "start": 456,
            "exe": "/example/agave-validator", "cwd": str(root),
            "args": ["agave-validator", "-l", str(ledger), "--identity",
                     "/home/solv/identity.json", "--no-voting", "--rpc-port", "8899"],
        }
        data = {"startup": STARTUP.replace(b"/mnt/ledger", str(ledger).encode())}
        def command(args):
            if "--property=MainPID" in args:
                return "123"
            if "--property=User,ExecStart" in args:
                return "User=solv\nExecStart={ path=/home/solv/start-validator.sh ; argv[]=/home/solv/start-validator.sh ; }"
            if args[0].endswith("/solana-keygen"):
                return IDENTITY
            raise AssertionError("Unexpected external command")
        def rpc(_port, method, _params=None):
            return {
                "getIdentity": {"identity": IDENTITY}, "getGenesisHash": policy.TESTNET_GENESIS,
                "getHealth": "ok", "getLeaderSchedule": {},
                "getVoteAccounts": {"current": [{"nodePubkey": OTHER, "activatedStake": 100}], "delinquent": []},
            }[method]
        realpath = os.path.realpath
        def resolve(path, *args, **kwargs):
            if str(path) == "/home/solv/identity.json":
                return "/home/solv/unstaked-identity.json"
            return realpath(path, *args, **kwargs)
        with (
            patch.object(policy, "LEDGER", str(ledger)),
            patch.object(policy, "command", side_effect=command),
            patch.object(policy, "process_snapshot", return_value=snapshot),
            patch.object(policy, "exit_controllers", return_value=[]),
            patch.object(policy, "rpc", side_effect=rpc),
            patch.object(policy, "admin_socket_matches", return_value=True),
            patch.object(policy, "read_startup", side_effect=lambda: data["startup"]),
            patch.object(policy.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=os.getuid())),
            patch.object(policy.os.path, "realpath", side_effect=resolve),
        ):
            yield root, snapshot, data


class PolicyEligibility(unittest.TestCase):
    def test_all_proofs_are_required_with_exact_booleans(self):
        self.assertEqual(policy.choose_policy("testnet", True, FACTS)["maxDelinquentStake"], 100)
        for name in policy.CHECKS:
            for value in (False, None, "true", 1):
                with self.subTest(name=name, value=value):
                    facts = dict(FACTS, **{name: value})
                    self.assertEqual(policy.choose_policy("testnet", True, facts)["maxDelinquentStake"], 10)

    def test_mainnet_and_non_explicit_intent_keep_normal_policy(self):
        for network, requested in (("other", True), ("mainnet", True), ("testnet", False), ("testnet", "true")):
            self.assertEqual(policy.choose_policy(network, requested, FACTS)["maxDelinquentStake"], 10)

    def test_vote_account_without_active_stake_is_not_eligible(self):
        votes = {"current": [{"nodePubkey": OTHER, "activatedStake": 100}], "delinquent": []}
        self.assertEqual(policy.vote_facts(votes, IDENTITY), (True, True, 0))
        votes["delinquent"].append({"nodePubkey": IDENTITY, "activatedStake": 0})
        self.assertEqual(policy.vote_facts(votes, IDENTITY), (True, False, 0))
        votes["delinquent"][0]["activatedStake"] = 100
        self.assertEqual(policy.vote_facts(votes, IDENTITY), (False, False, 50))

    def test_malformed_or_empty_stake_data_cannot_prove_safety(self):
        for value in ({}, {"current": [], "delinquent": []}, {
            "current": [{"nodePubkey": OTHER, "activatedStake": True}], "delinquent": [],
        }):
            with self.subTest(value=value), self.assertRaises(ValueError):
                policy.vote_facts(value, IDENTITY)

    def test_observation_checks_runtime_startup_and_rpc_identity(self):
        with observation_fixture():
            facts, metadata = policy.observe()
            self.assertTrue(all(facts.values()), (facts, metadata))
            self.assertTrue(metadata["targetVerified"])
            self.assertEqual(policy.choose_policy("testnet", True, facts)["maxDelinquentStake"], 100)
            with patch.object(policy, "rpc", side_effect=RuntimeError("fixture RPC unavailable")):
                facts, metadata = policy.observe()
                self.assertEqual(policy.choose_policy("testnet", True, facts)["maxDelinquentStake"], 10)
                self.assertEqual(metadata["observationFailure"], "RuntimeError")

    def test_runtime_and_startup_must_target_the_exit_ledger(self):
        for changed in ("runtime", "startup", "both"):
            with self.subTest(changed=changed), observation_fixture() as (root, snapshot, data):
                other = root / "another-ledger"
                other.mkdir()
                if changed in ("runtime", "both"):
                    snapshot["args"][2] = str(other)
                if changed in ("startup", "both"):
                    data["startup"] = STARTUP.replace(b"/mnt/ledger", str(other).encode())
                facts, metadata = policy.observe()
                self.assertEqual(policy.choose_policy("testnet", True, facts)["maxDelinquentStake"], 10)
                self.assertFalse(metadata["targetVerified"])

    def test_relative_runtime_path_is_resolved_from_process_cwd(self):
        with observation_fixture() as (_, snapshot, _):
            snapshot["args"][2] = "./ledger/"
            facts, metadata = policy.observe()
            self.assertTrue(metadata["targetVerified"])
            self.assertEqual(policy.choose_policy("testnet", True, facts)["maxDelinquentStake"], 100)

    def test_socket_mismatch_or_target_change_cannot_request_exit(self):
        for peers in ([False], [True, True, False]):
            with self.subTest(peers=peers), observation_fixture(), patch.object(
                policy, "admin_socket_matches", side_effect=peers,
            ):
                _, metadata = policy.observe()
                self.assertFalse(metadata["targetVerified"])


class LedgerAndControllers(unittest.TestCase):
    def test_equivalent_ledger_paths_detect_existing_controller(self):
        with tempfile.TemporaryDirectory(prefix="slv-restart-proc-") as tmp:
            root = Path(tmp).resolve()
            ledger = root / "ledger"
            ledger.mkdir()
            alias = root / "alias"
            alias.symlink_to(ledger, target_is_directory=True)
            proc = root / "proc"
            process = proc / "123"
            process.mkdir(parents=True)
            (process / "comm").write_text("agave-validator\n")
            (process / "cwd").symlink_to(root, target_is_directory=True)
            args = [
                ["-l", str(ledger)], ["-l", str(ledger) + "/"],
                ["--ledger", str(root) + "/./ledger"], ["-l", str(alias)],
                ["-l", "./ledger"], ["--ledger=ledger/"], ["-l" + str(ledger)],
                ["-l=" + str(ledger)],
            ]
            with patch.object(policy, "LEDGER", str(ledger)):
                for arguments in args:
                    with self.subTest(arguments=arguments):
                        (process / "cmdline").write_bytes(b"\0".join(
                            part.encode() for part in ["agave-validator", *arguments, "exit"]
                        ))
                        self.assertEqual(policy.exit_controllers(proc), [123])
                other = root / "another-ledger"
                other.mkdir()
                (process / "cmdline").write_bytes(
                    b"agave-validator\0-l\0" + str(other).encode() + b"\0exit\0",
                )
                self.assertEqual(policy.exit_controllers(proc), [])
                for arguments in ([], ["-l", "missing"], ["-l", str(ledger), "--ledger", str(other)]):
                    (process / "cmdline").write_bytes(b"\0".join(
                        part.encode() for part in ["agave-validator", *arguments, "exit"]
                    ))
                    with self.assertRaises(RuntimeError):
                        policy.exit_controllers(proc)

    def test_peer_credentials_must_match_pid_and_uid(self):
        with patch.object(policy.socket, "socket") as factory, patch.object(
            policy.socket, "SO_PEERCRED", 17, create=True,
        ):
            peer = factory.return_value.__enter__.return_value
            for pid, uid, expected in ((123, 10, True), (124, 10, False), (123, 11, False)):
                peer.getsockopt.return_value = struct.pack("iII", pid, uid, 10)
                self.assertIs(policy.admin_socket_matches(123, 10), expected)
            peer.send.assert_not_called()
            peer.sendall.assert_not_called()

    @unittest.skipUnless(sys.platform == "linux", "Linux server peer credentials")
    def test_real_unix_socket_is_bound_to_its_listening_process(self):
        with tempfile.TemporaryDirectory(prefix="slv-peer-") as tmp:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(Path(tmp) / "admin.rpc"))
                server.listen(4)
                with patch.object(policy, "LEDGER", tmp):
                    self.assertTrue(policy.admin_socket_matches(os.getpid(), os.getuid()))
                    self.assertFalse(policy.admin_socket_matches(os.getpid() + 1, os.getuid()))


@contextmanager
def controller_fixture(code, metadata=None, interrupt=False):
    """The only spawned process is a disposable Python fixture, never a validator."""
    real_popen = subprocess.Popen
    children = []
    seen = []
    with tempfile.TemporaryDirectory(prefix="slv-restart-controller-") as tmp:
        directory = Path(tmp)
        ready = directory / "ready"
        child_file = directory / "child.py"
        child_file.write_text(
            "import os,signal,sys,time\nfrom pathlib import Path\n"
            + code.replace("READY", repr(str(ready)))
        )
        def launch(argv, **kwargs):
            seen.append(argv)
            child = real_popen([sys.executable, str(child_file), *argv[1:]], **kwargs)
            children.append(child)
            deadline = time.monotonic() + 5
            while not ready.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(0.01)
            if not ready.exists():
                raise AssertionError("Fixture did not initialize")
            if interrupt:
                communicate = child.communicate
                first = True
                def interrupted_once(*args, **kwargs):
                    nonlocal first
                    if first:
                        first = False
                        raise InterruptedError("fixture interruption")
                    return communicate(*args, **kwargs)
                child.communicate = interrupted_once
            return child
        try:
            with (
                patch.object(policy, "observe", return_value=(FACTS, metadata or META)),
                patch.object(policy, "exit_controllers", return_value=[]),
                patch.object(policy.shutil, "which", return_value="/example/agave-validator"),
                patch.object(policy.subprocess, "Popen", side_effect=launch),
            ):
                yield str(directory / "lock"), seen, children
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=5)


class OwnedController(unittest.TestCase):
    def test_success_preserves_existing_health_snapshot_and_leader_checks(self):
        with controller_fixture("Path(READY).touch()\nprint('fixture complete')\n") as (lock, seen, children):
            result = policy.request_exit(options(), lock)
            self.assertEqual(result["outcome"], "exit_controller_completed")
            self.assertTrue(result["ownedControllerReaped"])
            self.assertEqual(len(children), 1)
            self.assertEqual(seen, [[
                "/example/agave-validator", "-l", "/mnt/ledger", "exit", "--max-delinquent-stake", "100",
            ]])

    def test_timeout_terminates_and_reaps_only_the_owned_child(self):
        code = "Path(READY).touch()\ntime.sleep(30)\n"
        with controller_fixture(code) as (lock, seen, children):
            result = policy.request_exit(options(), lock)
            self.assertEqual(result["outcome"], "restart_window_timeout_service_state_must_be_checked")
            self.assertTrue(result["ownedControllerReaped"])
            self.assertIsNotNone(children[0].poll())
            self.assertEqual(len(seen), 1)

    def test_term_resistant_child_is_killed_and_reaped_without_retry(self):
        code = "signal.signal(signal.SIGTERM, signal.SIG_IGN)\nPath(READY).touch()\ntime.sleep(30)\n"
        with controller_fixture(code) as (lock, seen, children):
            result = policy.request_exit(options(), lock)
            self.assertEqual(result["outcome"], "restart_window_timeout_service_state_must_be_checked")
            self.assertTrue(result["ownedControllerReaped"])
            self.assertLess(children[0].returncode, 0)
            self.assertEqual(len(seen), 1)

    def test_interruption_reaps_the_owned_child_without_retry(self):
        with controller_fixture(
            "Path(READY).touch()\ntime.sleep(30)\n", interrupt=True,
        ) as (lock, seen, children):
            result = policy.request_exit(options(), lock)
            self.assertEqual(result["outcome"], "restart_interrupted_service_state_must_be_checked")
            self.assertTrue(result["ownedControllerReaped"])
            self.assertIsNotNone(children[0].poll())
            self.assertEqual(len(seen), 1)

    def test_process_change_existing_waiter_and_policy_change_refuse_before_launch(self):
        cases = [
            dict(META, servicePid=124), dict(META, serviceStartTicks=457),
            dict(META, startupSha256="f" * 64), dict(META, exitControllers=[999]),
            dict(META, controllersKnown=False),
            dict(META, targetVerified=False),
        ]
        for metadata in cases:
            with self.subTest(metadata=metadata), controller_fixture(
                "Path(READY).touch()\n", metadata,
            ) as (lock, seen, _):
                result = policy.request_exit(options(), lock)
                self.assertFalse(result["controllerStarted"])
                self.assertEqual(seen, [])
        with controller_fixture("Path(READY).touch()\n") as (lock, seen, _):
            result = policy.request_exit(options(expected_threshold=10), lock)
            self.assertFalse(result["controllerStarted"])
            self.assertEqual(seen, [])
        with controller_fixture("Path(READY).touch()\n", dict(META, targetVerified=False)) as (lock, seen, _):
            result = policy.request_exit(options(network="other", expected_threshold=10), lock)
            self.assertFalse(result["controllerStarted"])
            self.assertEqual(seen, [])

    def test_concurrent_controller_lock_refuses_a_second_request(self):
        with controller_fixture("Path(READY).touch()\n") as (lock, seen, _):
            with open(lock, "w") as held:
                fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = policy.request_exit(options(), lock)
                self.assertEqual(result["failureType"], "BlockingIOError")
                self.assertEqual(seen, [])


if __name__ == "__main__":
    unittest.main()
