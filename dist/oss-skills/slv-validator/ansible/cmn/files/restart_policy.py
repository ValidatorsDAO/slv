#!/usr/bin/env python3
"""Inspect restart eligibility, or run one bounded, locked exit controller."""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import shlex
import shutil
import signal
import stat
import subprocess
import urllib.request

TESTNET_GENESIS = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY"
PUBKEY = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")
BIN = "/home/solv/.local/share/solana/install/active_release/bin"
CHECKS = (
    "processOwnedBySolv",
    "agaveProcess",
    "runtimeNoVoting",
    "noVoteAccountArgument",
    "unstakedIdentityPath",
    "startupUnitMatches",
    "startupNoVoting",
    "startupNoVoteAccount",
    "startupUnstakedIdentity",
    "publicIdentityMatchesUnstaked",
    "testnetGenesis",
    "healthy",
    "zeroActiveStake",
    "noVoteAccounts",
    "noLeaderSlots",
    "sameProcess",
)


def choose_policy(network, sync_only_requested, facts):
    eligible = (
        network == "testnet"
        and sync_only_requested is True
        and all(facts.get(name) is True for name in CHECKS)
    )
    return {
        "maxDelinquentStake": 100 if eligible else 10,
        "verifiedSyncOnly": eligible,
        "reason": (
            "Verified unstaked, non-voting testnet node; existing health, snapshot and leader checks are unchanged."
            if eligible else
            "Normal restart window; sync-only eligibility was not fully verified."
        ),
        "checks": {name: facts.get(name) is True for name in CHECKS},
    }


def command(arguments):
    result = subprocess.run(
        arguments, capture_output=True, text=True, timeout=5,
    )
    if result.returncode:
        raise RuntimeError("command_failed")
    return result.stdout.strip()


def process_snapshot(pid):
    path = Path("/proc") / str(pid)
    fields = (path / "stat").read_text().rsplit(") ", 1)[1].split()
    with (path / "cmdline").open("rb") as source:
        raw = source.read(65537)
    if len(raw) > 65536:
        raise RuntimeError("process_arguments_too_large")
    return {
        "pid": pid,
        "uid": path.stat().st_uid,
        "start": int(fields[19]),
        "exe": os.path.realpath(path / "exe").removesuffix(" (deleted)"),
        "args": [part.decode() for part in raw.split(b"\0") if part],
    }


def argument_values(arguments, names):
    values = []
    for index, argument in enumerate(arguments):
        name, separator, attached = argument.partition("=")
        if name in names:
            values.append(attached if separator else (
                arguments[index + 1] if index + 1 < len(arguments) else ""
            ))
    return values


def rpc(port, method, params=None):
    request = urllib.request.Request(
        "http://127.0.0.1:" + str(port),
        data=json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": method, "params": params or [],
        }).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
    if len(raw) > 4 * 1024 * 1024:
        raise RuntimeError("rpc_response_too_large")
    answer = json.loads(raw)
    error = answer.get("error")
    if error:
        # This pinned client's RPC explicitly reports an identity with no
        # leader slots using this error, also handled by its restart waiter.
        if method == "getLeaderSchedule" and error.get("code") == -32022:
            return {}
        raise RuntimeError("rpc_failed")
    if "result" not in answer:
        raise RuntimeError("rpc_result_missing")
    return answer["result"]


def vote_facts(votes, identity):
    if not isinstance(votes, dict) or any(
        not isinstance(votes.get(kind), list) for kind in ("current", "delinquent")
    ):
        raise ValueError("vote_accounts_incomplete")
    total = delinquent = own = matches = 0
    for kind in ("current", "delinquent"):
        for vote in votes[kind]:
            amount = vote.get("activatedStake")
            node = vote.get("nodePubkey")
            if (
                type(amount) is not int or amount < 0
                or not isinstance(node, str) or not PUBKEY.fullmatch(node)
            ):
                raise ValueError("vote_account_invalid")
            total += amount
            delinquent += amount if kind == "delinquent" else 0
            own += amount if node == identity else 0
            matches += node == identity
    # An empty/zero-stake response cannot prove the cluster was read correctly.
    if total == 0:
        raise ValueError("cluster_stake_unavailable")
    return own == 0, matches == 0, round(100 * delinquent / total, 3)


def exit_controllers():
    """Only inspect argument metadata, never signal an existing process."""
    found = []
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            if (path / "comm").read_text().strip() != "agave-validator":
                continue
            with (path / "cmdline").open("rb") as source:
                raw = source.read(65537)
            if len(raw) > 65536:
                raise ValueError("controller_arguments_too_large")
            args = [part.decode() for part in raw.split(b"\0") if part]
            if "exit" in args and argument_values(args, {"-l", "--ledger"}) == ["/mnt/ledger"]:
                found.append(int(path.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
    return found


def observe():
    facts = {}
    metadata = {}
    try:
        pid = int(command([
            "systemctl", "show", "solv.service", "--property=MainPID", "--value",
        ]))
        if pid <= 0:
            raise RuntimeError("validator_not_running")
        before = process_snapshot(pid)
        metadata["servicePid"] = pid
        metadata["serviceStartTicks"] = before["start"]
        metadata["exitControllers"] = exit_controllers()
        metadata["controllersKnown"] = True
        args = before["args"]
        facts["processOwnedBySolv"] = before["uid"] == os.getuid() == pwd.getpwnam("solv").pw_uid
        facts["agaveProcess"] = Path(before["exe"]).name == "agave-validator"
        facts["runtimeNoVoting"] = args.count("--no-voting") == 1
        facts["noVoteAccountArgument"] = not any(
            arg.split("=", 1)[0] in ("--vote-account", "--authorized-voter")
            for arg in args
        )
        identities = argument_values(args, {"--identity", "-i"})
        facts["unstakedIdentityPath"] = (
            len(identities) == 1
            and os.path.realpath(identities[0]) == "/home/solv/unstaked-identity.json"
        )
        with Path("/home/solv/start-validator.sh").open("rb") as source:
            startup = source.read(65537)
        if len(startup) > 65536:
            raise ValueError("startup_too_large")
        metadata["startupSha256"] = hashlib.sha256(startup).hexdigest()
        startup_args = shlex.split(startup.decode().replace("\\\n", " "), comments=True)
        startup_identities = argument_values(startup_args, {"--identity", "-i"})
        facts["startupNoVoting"] = startup_args.count("--no-voting") == 1
        facts["startupNoVoteAccount"] = not any(
            arg.split("=", 1)[0] in ("--vote-account", "--authorized-voter")
            for arg in startup_args
        )
        facts["startupUnstakedIdentity"] = (
            len(startup_identities) == 1
            and os.path.realpath(startup_identities[0]) == "/home/solv/unstaked-identity.json"
        )
        unit = command([
            "systemctl", "show", "solv.service", "--property=User,ExecStart",
        ])
        properties = dict(line.split("=", 1) for line in unit.splitlines() if "=" in line)
        start = properties.get("ExecStart", "")
        executable = re.search(r"(?:^|[ {])path=([^ ;]+)", start)
        unit_args = re.search(r"argv\[\]=([^;]+)", start)
        facts["startupUnitMatches"] = (
            properties.get("User") == "solv"
            and executable is not None
            and executable.group(1) == "/home/solv/start-validator.sh"
            and unit_args is not None
            and unit_args.group(1).strip() == "/home/solv/start-validator.sh"
        )
        ports = argument_values(args, {"--rpc-port"})
        if len(ports) != 1 or not ports[0].isdigit() or not 0 < int(ports[0]) < 65536:
            raise ValueError("rpc_port_unknown")
        port = int(ports[0])
        identity = rpc(port, "getIdentity").get("identity")
        if not isinstance(identity, str) or not PUBKEY.fullmatch(identity):
            raise ValueError("identity_invalid")
        # Key bytes stay inside solana-keygen; only its public output is read.
        unstaked = command([BIN + "/solana-keygen", "pubkey", "/home/solv/unstaked-identity.json"])
        facts["publicIdentityMatchesUnstaked"] = (
            PUBKEY.fullmatch(unstaked) is not None and identity == unstaked
        )
        facts["testnetGenesis"] = rpc(port, "getGenesisHash") == TESTNET_GENESIS
        facts["healthy"] = rpc(port, "getHealth") == "ok"
        zero, no_accounts, percent = vote_facts(rpc(port, "getVoteAccounts"), identity)
        facts["zeroActiveStake"] = zero
        facts["noVoteAccounts"] = no_accounts
        metadata["delinquentStakePercent"] = percent
        leaders = rpc(port, "getLeaderSchedule", [None, {"identity": identity}])
        facts["noLeaderSlots"] = (
            isinstance(leaders, dict)
            and isinstance(leaders.get(identity, []), list)
            and len(leaders.get(identity, [])) == 0
        )
        after = process_snapshot(pid)
        facts["sameProcess"] = (
            before == after
            and command([
                "systemctl", "show", "solv.service", "--property=MainPID", "--value",
            ]) == str(pid)
            and rpc(port, "getIdentity").get("identity") == identity
        )
    except Exception as error:
        # Never print command output, raw RPC responses, arguments or key data.
        metadata["observationFailure"] = type(error).__name__
    return facts, metadata


def stop_owned_child(child):
    """Reap only the Popen child owned by this invocation, never the validator."""
    handlers = {sig: signal.signal(sig, signal.SIG_IGN) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        if child.poll() is None:
            child.terminate()
        try:
            return child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            return child.communicate(timeout=5)
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)


def request_exit(options, lock_path="/home/solv/.slv-restart.lock"):
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    child = None
    handlers = {}
    result = {"controllerStarted": False, "ownedControllerReaped": False}
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError("restart_lock_owner_or_type_mismatch")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        facts, metadata = observe()
        policy = choose_policy(options.network, options.sync_only_requested, facts)
        result["policy"] = policy
        if (
            metadata.get("controllersKnown") is not True
            or metadata.get("exitControllers") != []
            or metadata.get("servicePid") != options.expected_pid
            or metadata.get("serviceStartTicks") != options.expected_start_ticks
            or metadata.get("startupSha256") != options.expected_startup_sha256
            or policy["maxDelinquentStake"] != options.expected_threshold
        ):
            raise RuntimeError("restart_state_changed_or_controller_already_running")
        binary = shutil.which("agave-validator")
        if not binary:
            raise RuntimeError("validator_binary_unavailable")

        def interrupted(_signal, _frame):
            raise InterruptedError("restart_controller_interrupted")

        handlers = {
            sig: signal.signal(sig, interrupted)
            for sig in (signal.SIGINT, signal.SIGTERM)
        }
        # Keep the child in Ansible's process group: the outer async deadline
        # must also terminate it if this wrapper cannot perform its own cleanup.
        child = subprocess.Popen(
            [binary, "-l", "/mnt/ledger", "exit", "--max-delinquent-stake",
             str(policy["maxDelinquentStake"])],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        result["controllerStarted"] = True
        result["controllerPid"] = child.pid
        try:
            stdout, stderr = child.communicate(timeout=options.wait_seconds)
            result["outcome"] = "exit_controller_completed" if child.returncode == 0 else "exit_controller_failed"
        except subprocess.TimeoutExpired:
            result["cleanupAttempted"] = True
            stdout, stderr = stop_owned_child(child)
            result["outcome"] = "restart_window_timeout_service_state_must_be_checked"
        except (InterruptedError, KeyboardInterrupt):
            result["cleanupAttempted"] = True
            stdout, stderr = stop_owned_child(child)
            result["outcome"] = "restart_interrupted_service_state_must_be_checked"
        result["controllerExitCode"] = child.returncode
        result["ownedControllerReaped"] = child.poll() is not None
        # The exit CLI prints public identity/window diagnostics, not key bytes.
        result["stdout"] = stdout[-8192:]
        result["stderr"] = stderr[-8192:]
        result["remainingExitControllers"] = exit_controllers()
        if result["remainingExitControllers"]:
            result["outcome"] = "another_exit_controller_present_do_not_retry"
        return result
    except Exception as error:
        if child is not None:
            if not result.get("cleanupAttempted"):
                result["cleanupAttempted"] = True
                try:
                    stop_owned_child(child)
                except Exception as cleanup_error:
                    result["cleanupFailureType"] = type(cleanup_error).__name__
            result["ownedControllerReaped"] = child.poll() is not None
        result["outcome"] = "restart_not_confirmed_do_not_retry_without_read_only_check"
        result["failureType"] = type(error).__name__
        return result
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
        os.close(descriptor)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=("testnet", "other"), required=True)
    parser.add_argument("--sync-only-requested", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--expected-pid", type=int)
    parser.add_argument("--expected-start-ticks", type=int)
    parser.add_argument("--expected-startup-sha256")
    parser.add_argument("--expected-threshold", type=int, choices=(10, 100))
    parser.add_argument("--wait-seconds", type=int, default=600)
    options = parser.parse_args()
    if options.execute:
        if (
            not options.expected_pid or not options.expected_start_ticks
            or not re.fullmatch(r"[0-9a-f]{64}", options.expected_startup_sha256 or "")
            or options.expected_threshold is None
            or not 1 <= options.wait_seconds <= 600
        ):
            parser.error("Execution requires the observed PID, start time, startup hash and threshold.")
        result = request_exit(options)
        print(json.dumps(result))
        return 0 if (
            result.get("outcome") == "exit_controller_completed"
            and result.get("ownedControllerReaped") is True
            and result.get("remainingExitControllers") == []
        ) else 1
    facts, metadata = observe()
    result = choose_policy(options.network, options.sync_only_requested, facts)
    result.update(metadata)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
