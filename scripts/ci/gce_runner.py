#!/usr/bin/env python3
"""Create one-job GCE runners from trusted GitHub-hosted control jobs.

GH_TOKEN is a repository-scoped GitHub App installation token. Google credentials
come from Workload Identity Federation. Neither credential is sent to the guest.
JIT configuration is deliberately outside Terraform and removed before dispatch.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any


# Official asset digest, verified against the release asset and release notes:
# https://github.com/actions/runner/releases/tag/v2.338.0
RUNNER_VERSION = "2.338.0"
RUNNER_SHA256 = "af4b794c1bc41d73d40535e3fe092a39f9679cd8d965954c2aca25a05ca41d32"
MANAGED_BY = "slv-gce-runner"
JIT_KEY = "slv-jit-config"


class ControlError(RuntimeError):
    """An error safe to print: never include tool output or credential values."""


def digest(value: str, length: int) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:length]


def checked(value: str, pattern: str, field: str) -> str:
    if not re.fullmatch(pattern, value):
        raise ControlError(f"Invalid {field}")
    return value


@dataclass(frozen=True)
class Lease:
    repository: str
    run_id: str
    run_attempt: str
    job_key: str

    def __post_init__(self) -> None:
        checked(self.repository, r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", "repository")
        checked(self.run_id, r"[1-9][0-9]{0,19}", "run ID")
        checked(self.run_attempt, r"[1-9][0-9]{0,4}", "run attempt")
        checked(self.job_key, r"[a-z][a-z0-9-]{0,62}", "job key")

    @property
    def repo_hash(self) -> str:
        return digest(self.repository.lower(), 12)

    @property
    def name(self) -> str:
        name = (
            f"slv-gha-{self.repo_hash[:10]}-{self.run_id}-{self.run_attempt}-"
            f"{self.job_key[:10]}-{digest(self.job_key, 6)}"
        )
        return checked(name, r"[a-z][a-z0-9-]{0,61}[a-z0-9]", "instance name")

    @property
    def ownership(self) -> dict[str, str]:
        return {
            "managed-by": MANAGED_BY,
            "github-repo": self.repo_hash,
            "github-run-id": self.run_id,
            "github-run-attempt": self.run_attempt,
            "job-key": self.job_key,
        }


class Controller:
    def __init__(self, project: str, repository: str) -> None:
        self.project = checked(project, r"[a-z][a-z0-9-]{4,28}[a-z0-9]", "project")
        checked(repository, r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", "repository")
        self.repository = repository

    def command(self, argv: list[str], *, stdin: str | None = None,
                missing_ok: bool = False) -> str | None:
        env = os.environ.copy()
        env.pop("GH_DEBUG", None)
        if argv[0] == "gh":
            if not env.get("GH_TOKEN"):
                raise ControlError("GH_TOKEN must contain a GitHub App installation token")
            env["GH_HOST"] = "github.com"
        else:
            # Google CLI does not need the GitHub control-plane credential.
            env.pop("GH_TOKEN", None)
            env.pop("GITHUB_TOKEN", None)
        try:
            result = subprocess.run(argv, input=stdin, capture_output=True,
                                    text=True, env=env, timeout=240, check=False)
        except (OSError, subprocess.TimeoutExpired):
            raise ControlError(f"{argv[0]} invocation failed or timed out") from None
        if result.returncode:
            absent = (
                argv[0] == "gh" and "(HTTP 404)" in result.stderr
            ) or (
                argv[0] == "gcloud" and re.search(
                    r"(?:was not found|could not be found|NOT_FOUND)", result.stderr
                ) is not None
            )
            if missing_ok and absent:
                return None
            # Responses to instance/JIT requests may contain secrets. Do not log
            # argv, stdout, stderr, or CalledProcessError even on failure.
            raise ControlError(f"{argv[0]} request failed (exit {result.returncode})")
        return result.stdout

    def github(self, endpoint: str, *, method: str = "GET",
               payload: dict[str, Any] | None = None,
               missing_ok: bool = False) -> Any:
        argv = ["gh", "api", "--hostname", "github.com", "--method", method,
                "-H", "Accept: application/vnd.github+json",
                "-H", "X-GitHub-Api-Version: 2022-11-28", endpoint]
        if payload is not None:
            argv.extend(["--input", "-"])
        raw = self.command(argv, stdin=json.dumps(payload) if payload is not None else None,
                           missing_ok=missing_ok)
        if not raw:
            return None
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            raise ControlError("GitHub returned an invalid response") from None

    def compute(self, arguments: list[str], *, missing_ok: bool = False) -> Any:
        raw = self.command(["gcloud", "compute", *arguments, "--project", self.project,
                            "--quiet", "--verbosity=error", "--format=json"],
                           missing_ok=missing_ok)
        if not raw:
            return None
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            raise ControlError("Google Cloud returned an invalid response") from None

    @property
    def runners_path(self) -> str:
        return f"repos/{self.repository}/actions/runners"

    def runners(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for page in range(1, 1001):
            body = self.github(f"{self.runners_path}?per_page=100&page={page}")
            batch = body["runners"]
            result.extend(batch)
            if len(batch) < 100:
                return result
        raise ControlError("Runner listing exceeded its page limit")

    def instance(self, name: str, zone: str) -> dict[str, Any] | None:
        return self.compute(["instances", "describe", name, "--zone", zone], missing_ok=True)

    @staticmethod
    def verify_instance(instance: dict[str, Any], lease: Lease) -> None:
        labels = instance.get("labels", {})
        if instance.get("name") != lease.name or any(
            labels.get(key) != value for key, value in lease.ownership.items()
        ):
            raise ControlError("Refusing to modify an instance without matching ownership")

    def runner_expiry(self, runner: dict[str, Any]) -> int | None:
        pattern = rf"slv-gce-{digest(self.repository.lower(), 12)}-([0-9]{{1,12}})-[a-f0-9]{{48}}"
        matches = [re.fullmatch(pattern, label.get("name", "")) for label in runner.get("labels", [])]
        matches = [match for match in matches if match]
        return int(matches[0][1]) if len(matches) == 1 else None

    @staticmethod
    def verify_dispatch_label(runner: dict[str, Any], expected: str) -> None:
        # Any predictable label (including self-hosted/Linux/X64) would permit
        # another workflow to schedule a job before this lease is released.
        if [item.get("name") for item in runner.get("labels", [])] != [expected]:
            raise ControlError("Runner has unexpected routing labels")

    def owned_runner(self, runner: dict[str, Any], name: str) -> bool:
        return runner.get("name") == name and self.runner_expiry(runner) is not None

    def delete_runner(self, runner: dict[str, Any], name: str) -> None:
        if not self.owned_runner(runner, name):
            raise ControlError("Refusing to remove a runner without matching ownership")
        runner_id = checked(str(runner.get("id")), r"[1-9][0-9]*", "runner ID")
        self.github(f"{self.runners_path}/{runner_id}", method="DELETE", missing_ok=True)

    def cleanup(self, lease: Lease, zone: str) -> None:
        errors = []
        try:
            instance = self.instance(lease.name, zone)
            if instance is not None:
                self.verify_instance(instance, lease)
                self.compute(["instances", "delete", lease.name, "--zone", zone],
                             missing_ok=True)
        except ControlError as exc:
            errors.append(str(exc))
        # A JIT runner might have already deregistered, or VM creation might
        # have failed after JIT registration. Clean both independently.
        try:
            for runner in self.runners():
                if runner.get("name") == lease.name:
                    self.delete_runner(runner, lease.name)
        except ControlError as exc:
            errors.append(str(exc))
        if errors:
            raise ControlError("Cleanup incomplete: " + "; ".join(errors))

    def provision(self, lease: Lease, zone: str, template: str, startup: Path,
                  ttl_seconds: int, runner_group_id: int,
                  online_timeout: int = 600) -> dict[str, str]:
        if not 900 <= ttl_seconds <= 21600:
            raise ControlError("TTL must be between 900 and 21600 seconds")
        if runner_group_id < 1:
            raise ControlError("Runner group ID must be positive")
        if not startup.is_file():
            raise ControlError("Runner startup script does not exist")
        checked(template, r"[A-Za-z0-9_./:-]+", "instance template")
        template_resource = self.compute(["instance-templates", "describe", template])
        properties = template_resource.get("properties", {})
        template_boot_disks = [disk for disk in properties.get("disks", []) if disk.get("boot")]
        if len(template_boot_disks) != 1 or not template_boot_disks[0].get("autoDelete"):
            raise ControlError("Runner template must have exactly one auto-deleted boot disk")
        expected_disk = template_boot_disks[0].get("initializeParams", {})
        expected_image = expected_disk.get("sourceImage", "")
        if not expected_image or "/images/" not in expected_image or "/family/" in expected_image:
            raise ControlError("Runner template must pin an exact boot image")
        # Never replace an earlier lease or delete a pre-existing collision.
        if self.instance(lease.name, zone) is not None:
            raise ControlError("Instance already exists; clean this lease before provisioning")
        if any(runner.get("name") == lease.name for runner in self.runners()):
            raise ControlError("Runner already exists; clean this lease before provisioning")
        expires = int(time.time()) + ttl_seconds
        termination_time = datetime.fromtimestamp(expires, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        runner_label = f"slv-gce-{lease.repo_hash}-{expires}-{secrets.token_hex(24)}"
        labels = [runner_label]
        try:
            result = self.github(f"{self.runners_path}/generate-jitconfig", method="POST",
                                 payload={"name": lease.name, "runner_group_id": runner_group_id,
                                          "labels": labels, "work_folder": "_work"})
            runner = result["runner"]
            runner_id = checked(str(runner["id"]), r"[1-9][0-9]*", "runner ID")
            if not self.owned_runner(runner, lease.name):
                raise ControlError("GitHub returned an unexpected JIT runner identity")
            self.verify_dispatch_label(runner, runner_label)
            jit = result["encoded_jit_config"]
            if not isinstance(jit, str) or not re.fullmatch(r"[A-Za-z0-9+/=]+", jit):
                raise ControlError("GitHub returned an invalid JIT configuration")
            vm_labels = dict(lease.ownership, lease=str(expires))
            # The encoded config is never a command-line value, output, artifact,
            # template, Terraform variable, or state entry. Temporary files are 0600.
            with tempfile.TemporaryDirectory(prefix="slv-gce-jit-") as directory:
                secret_file = Path(directory) / "jit-config"
                secret_file.touch(mode=0o600)
                secret_file.write_text(jit)
                self.compute([
                    "instances", "create", lease.name, "--zone", zone,
                    "--source-instance-template", template,
                    "--no-service-account", "--no-scopes", "--no-restart-on-failure",
                    # Any --boot-disk-* override can replace the entire template
                    # disk with gcloud defaults, including an unpinned Debian OS.
                    # Inherit the disk unchanged and verify its actual properties.
                    "--instance-termination-action=DELETE",
                    "--termination-time", termination_time,
                    "--labels", ",".join(f"{key}={value}" for key, value in vm_labels.items()),
                    "--metadata", f"slv-runner-version={RUNNER_VERSION},slv-runner-sha256={RUNNER_SHA256}",
                    "--metadata-from-file", f"startup-script={startup.resolve()},{JIT_KEY}={secret_file}",
                ])
            # Verify the deployed VM, not only the intended template/CLI flags.
            instance = self.instance(lease.name, zone)
            if instance is None:
                raise ControlError("Created instance could not be found")
            self.verify_instance(instance, lease)
            if instance.get("serviceAccounts"):
                raise ControlError("Runner instance unexpectedly has a service account")
            disks = instance.get("disks", [])
            if not any(disk.get("boot") for disk in disks) or not all(disk.get("autoDelete") for disk in disks):
                raise ControlError("Runner disks must be deleted with their instance")
            boot_disk = next(disk for disk in disks if disk.get("boot"))
            disk_name = boot_disk.get("source", "").rsplit("/", 1)[-1]
            if disk_name != lease.name:
                raise ControlError("Runner boot disk has an unexpected identity")
            actual_disk = self.compute(["disks", "describe", disk_name, "--zone", zone])
            if (actual_disk.get("sourceImage") != expected_image
                    or str(actual_disk.get("sizeGb")) != str(expected_disk.get("diskSizeGb"))
                    or actual_disk.get("type", "").rsplit("/", 1)[-1] != expected_disk.get("diskType", "").rsplit("/", 1)[-1]
                    or instance.get("machineType", "").rsplit("/", 1)[-1] != properties.get("machineType", "").rsplit("/", 1)[-1]):
                raise ControlError("Runner hardware or boot image differs from its pinned template")
            schedule = instance.get("scheduling", {})
            try:
                actual_expiry = int(datetime.fromisoformat(
                    schedule.get("terminationTime", "").replace("Z", "+00:00")
                ).timestamp())
            except (ValueError, TypeError, OverflowError):
                actual_expiry = None
            if schedule.get("instanceTerminationAction") != "DELETE" or actual_expiry != expires:
                raise ControlError("Runner instance has no automatic deletion deadline")
            deadline = time.monotonic() + online_timeout
            while time.monotonic() < deadline:
                online = self.github(f"{self.runners_path}/{runner_id}", missing_ok=True)
                if online is not None:
                    if not self.owned_runner(online, lease.name):
                        raise ControlError("Runner identity changed while bootstrapping")
                    self.verify_dispatch_label(online, runner_label)
                    if online.get("busy"):
                        raise ControlError("Runner accepted a job before provisioning completed")
                    if online.get("status") == "online":
                        break
                time.sleep(5)
            else:
                raise ControlError("Runner did not come online within the bootstrap deadline")
            self.compute(["instances", "remove-metadata", lease.name, "--zone", zone,
                          "--keys", JIT_KEY])
            instance = self.instance(lease.name, zone)
            if instance is None:
                raise ControlError("Runner instance disappeared during bootstrap")
            self.verify_instance(instance, lease)
            if any(item.get("key") == JIT_KEY for item in instance.get("metadata", {}).get("items", [])):
                raise ControlError("JIT metadata was not removed")
            return {"runner_label": runner_label, "instance_name": lease.name, "runner_id": runner_id}
        except BaseException:
            try:
                self.cleanup(lease, zone)
            except ControlError:
                print("Provision cleanup incomplete; native VM expiry remains active", file=sys.stderr)
            raise

    def janitor(self) -> int:
        repo_hash = digest(self.repository.lower(), 12)
        instances = self.compute([
            "instances", "list", "--filter",
            f"labels.managed-by={MANAGED_BY} AND labels.github-repo={repo_hash}",
        ]) or []
        now = int(time.time())
        removed = 0
        failed = False
        for instance in instances:
            labels = instance.get("labels", {})
            try:
                # Treat malformed/missing expiry as unowned, never as expired.
                expiry = labels.get("lease", "")
                if not re.fullmatch(r"[0-9]{1,12}", expiry) or int(expiry) > now:
                    continue
                lease = Lease(self.repository, labels.get("github-run-id", ""),
                              labels.get("github-run-attempt", ""), labels.get("job-key", ""))
                self.verify_instance(instance, lease)
                zone = checked(instance.get("zone", "").rsplit("/", 1)[-1],
                               r"[a-z][a-z0-9-]+", "zone")
                self.cleanup(lease, zone)
                removed += 1
            except ControlError:
                failed = True
                print("Could not reclaim one expired runner lease", file=sys.stderr)
        # Native GCE deletion may already have removed the VM. The corresponding
        # unused JIT registration can still be reclaimed using its ownership tags.
        for runner in self.runners():
            name = runner.get("name", "")
            if not name.startswith(f"slv-gha-{repo_hash[:10]}-") or not self.owned_runner(runner, name):
                continue
            expiry = self.runner_expiry(runner)
            if expiry is not None and expiry <= now:
                try:
                    self.delete_runner(runner, name)
                except ControlError:
                    failed = True
        if failed:
            raise ControlError("Janitor could not reclaim every expired lease")
        return removed


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    for name in ("provision", "cleanup", "janitor"):
        command = commands.add_parser(name)
        command.add_argument("--project", required=True)
        command.add_argument("--repository", required=True)
        if name != "janitor":
            command.add_argument("--zone", required=True)
            command.add_argument("--run-id", required=True)
            command.add_argument("--run-attempt", required=True)
            command.add_argument("--job-key", required=True)
        if name == "provision":
            command.add_argument("--template", required=True)
            command.add_argument("--ttl-seconds", type=int, default=21600)
            command.add_argument("--runner-group-id", type=int, default=1,
                                 help="Repository default runner group (override if configured otherwise)")
            command.add_argument("--startup-script", type=Path,
                                 default=Path(__file__).with_name("gce-runner-startup.sh"))
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        controller = Controller(args.project, args.repository)
        if args.command == "janitor":
            count = controller.janitor()
            print(f"Reclaimed {count} expired VM leases")
            return 0
        zone = checked(args.zone, r"[a-z][a-z0-9-]+", "zone")
        lease = Lease(args.repository, args.run_id, args.run_attempt, args.job_key)
        if args.command == "cleanup":
            controller.cleanup(lease, zone)
            print("Runner lease cleanup complete")
        else:
            outputs = controller.provision(lease, zone, args.template, args.startup_script,
                                           args.ttl_seconds, args.runner_group_id)
            if os.environ.get("GITHUB_OUTPUT"):
                with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                    for key, value in outputs.items():
                        stream.write(f"{key}={value}\n")
            else:
                # These fields contain only non-secret dispatch identifiers.
                print(json.dumps(outputs))
            print("Runner online; JIT metadata removed", file=sys.stderr)
        return 0
    except ControlError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Controller interrupted", file=sys.stderr)
        return 130
    except Exception:
        # An unexpected schema/tool exception must not dump a JIT-bearing object.
        print("Runner controller failed unexpectedly; inspect control-plane status", file=sys.stderr)
        return 1


if __name__ == "__main__":
    def interrupted(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    sys.exit(main())
