#!/usr/bin/env python3
"""Failure-path and isolation tests; no Google/GitHub requests are made."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location("gce_runner", Path(__file__).with_name("gce_runner.py"))
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

LEASE = module.Lease("example/repository", "123456789", "1", "x64-baseline")
STARTUP = Path(__file__).with_name("gce-runner-startup.sh")
SECRET = "c2VjcmV0"


class FakeController(module.Controller):
    def __init__(self):
        super().__init__("test-project", LEASE.repository)
        self.vms = {}
        self.registered = {}
        self.events = []
        self.extra_service_account = False
        self.wrong_expiry = False
        self.wrong_image = False
        self.keep_metadata = False
        self.fail_create = False
        self.fail_delete = False
        self.busy = False
        self.online = True

    def github(self, endpoint, *, method="GET", payload=None, missing_ok=False):
        self.events.append(("github", method, endpoint))
        if endpoint.endswith("generate-jitconfig"):
            runner = {"id": 7, "name": payload["name"], "status": "offline", "busy": False,
                      "labels": [{"name": item} for item in payload["labels"]]}
            self.registered[7] = runner
            return {"runner": copy.deepcopy(runner), "encoded_jit_config": SECRET}
        if "?" in endpoint:
            return {"runners": copy.deepcopy(list(self.registered.values()))}
        runner_id = int(endpoint.rsplit("/", 1)[1])
        if method == "DELETE":
            self.registered.pop(runner_id, None)
            return None
        runner = copy.deepcopy(self.registered.get(runner_id))
        if runner:
            runner["status"] = "online" if self.online else "offline"
            runner["busy"] = self.busy
        return runner

    def compute(self, arguments, *, missing_ok=False):
        self.events.append(("compute", *arguments))
        action = arguments[1]
        image = "https://www.googleapis.com/compute/v1/projects/ubuntu-os-cloud/global/images/ubuntu-2404-pinned"
        if arguments[0] == "instance-templates":
            return {"properties": {"machineType": "c4-standard-16", "disks": [{
                "boot": True, "autoDelete": True, "initializeParams": {
                    "sourceImage": image, "diskSizeGb": "200", "diskType": "hyperdisk-balanced"
                }}]}}
        if arguments[0] == "disks":
            return {"sourceImage": "unexpected-debian" if self.wrong_image else image,
                    "sizeGb": "200", "type": "hyperdisk-balanced"}
        if action == "list":
            return copy.deepcopy(list(self.vms.values()))
        name = arguments[2]
        if action == "describe":
            return copy.deepcopy(self.vms.get(name))
        if action == "create":
            value = lambda flag: arguments[arguments.index(flag) + 1]
            labels = dict(item.split("=", 1) for item in value("--labels").split(","))
            files = dict(item.split("=", 1) for item in value("--metadata-from-file").split(","))
            secret_path = Path(files[module.JIT_KEY])
            assert stat.S_IMODE(secret_path.stat().st_mode) == 0o600
            assert secret_path.read_text() == SECRET
            assert SECRET not in " ".join(arguments)
            self.vms[name] = {
                "name": name, "labels": labels, "zone": "projects/test-project/zones/us-central1-a",
                "machineType": "zones/us-central1-a/machineTypes/c4-standard-16",
                "serviceAccounts": [{"email": "unexpected"}] if self.extra_service_account else [],
                "disks": [{"boot": True, "autoDelete": True, "source": f"zones/us-central1-a/disks/{name}"}],
                "scheduling": {"instanceTerminationAction": "DELETE", "terminationTime": value("--termination-time")},
                "metadata": {"items": [{"key": module.JIT_KEY, "value": SECRET}]},
            }
            if self.wrong_expiry:
                self.vms[name]["scheduling"]["terminationTime"] = "2099-01-01T00:00:00Z"
            if self.fail_create:
                raise module.ControlError("Simulated interrupted create response")
            return [copy.deepcopy(self.vms[name])]
        if action == "remove-metadata":
            if not self.keep_metadata:
                self.vms[name]["metadata"]["items"] = []
            return copy.deepcopy(self.vms[name])
        if action == "delete":
            if self.fail_delete:
                raise module.ControlError("Simulated deletion failure")
            self.vms.pop(name, None)
            return None
        raise AssertionError(arguments)

    def provision_default(self, **kwargs):
        return self.provision(LEASE, "us-central1-a", "test-template", STARTUP, 21600, 1, **kwargs)


class IsolationTests(unittest.TestCase):
    def test_names_are_bounded_deterministic_and_isolate_attempt_repository_job(self):
        longest = module.Lease("example/repository", "9" * 20, "9" * 5, "a" * 63)
        self.assertEqual(len(longest.name), 63)
        self.assertEqual(LEASE.name, module.Lease("EXAMPLE/REPOSITORY", "123456789", "1", "x64-baseline").name)
        names = {LEASE.name,
                 module.Lease(LEASE.repository, LEASE.run_id, "2", LEASE.job_key).name,
                 module.Lease("other/repository", LEASE.run_id, "1", LEASE.job_key).name,
                 module.Lease(LEASE.repository, LEASE.run_id, "1", "x64-modified").name}
        self.assertEqual(len(names), 4)

    def test_injection_and_noncanonical_numeric_ids_are_rejected(self):
        for run_id in ("1\nvalue=bad", "01", "-1", "1;echo x"):
            with self.subTest(run_id=run_id), self.assertRaises(module.ControlError):
                module.Lease(LEASE.repository, run_id, "1", LEASE.job_key)
        with self.assertRaises(module.ControlError):
            module.Lease(LEASE.repository, "1", "1", "../../other")

    def test_preexisting_instance_is_never_overwritten_or_deleted(self):
        fake = FakeController()
        fake.vms[LEASE.name] = {"name": LEASE.name, "labels": {}}
        with self.assertRaises(module.ControlError):
            fake.provision_default()
        self.assertIn(LEASE.name, fake.vms)
        self.assertFalse(any(event[1:3] == ("instances", "delete") for event in fake.events))

    def test_cleanup_refuses_foreign_instance_and_runner(self):
        fake = FakeController()
        fake.vms[LEASE.name] = {"name": LEASE.name, "labels": {"managed-by": module.MANAGED_BY}}
        fake.registered[7] = {"id": 7, "name": LEASE.name, "labels": []}
        with self.assertRaises(module.ControlError):
            fake.cleanup(LEASE, "us-central1-a")
        self.assertIn(LEASE.name, fake.vms)
        self.assertIn(7, fake.registered)


class LifecycleTests(unittest.TestCase):
    def test_success_releases_nonce_only_after_online_and_metadata_removal(self):
        fake = FakeController()
        with patch.object(module.time, "time", return_value=1700000000):
            outputs = fake.provision_default()
        self.assertRegex(outputs["runner_label"], r"^slv-gce-[a-f0-9]{12}-1700021600-[a-f0-9]{48}$")
        self.assertEqual(outputs["instance_name"], LEASE.name)
        self.assertEqual(fake.vms[LEASE.name]["metadata"]["items"], [])
        create = next(event for event in fake.events if event[1:3] == ("instances", "create"))
        self.assertIn("--no-service-account", create)
        self.assertIn("--no-scopes", create)
        self.assertFalse(any(arg.startswith("--boot-disk-") for arg in create))
        self.assertIn("--instance-termination-action=DELETE", create)
        self.assertEqual(fake.vms[LEASE.name]["labels"]["lease"], "1700021600")
        self.assertNotIn(SECRET, json.dumps(outputs))

    def test_attached_service_account_is_fail_closed_and_reclaimed(self):
        fake = FakeController()
        fake.extra_service_account = True
        with self.assertRaisesRegex(module.ControlError, "service account"):
            fake.provision_default()
        self.assertFalse(fake.vms)
        self.assertFalse(fake.registered)

    def test_predictable_routing_labels_are_rejected(self):
        fake = FakeController()
        fake.provision_default()
        runner = fake.registered[7]
        expected = runner["labels"][0]["name"]
        runner["labels"].append({"name": "self-hosted"})
        with self.assertRaises(module.ControlError):
            fake.verify_dispatch_label(runner, expected)
        # Unsafe registration still belongs to us and must remain reclaimable.
        fake.cleanup(LEASE, "us-central1-a")
        self.assertFalse(fake.registered)

    def test_invalid_ttl_is_rejected_before_registration_or_vm_creation(self):
        fake = FakeController()
        with self.assertRaises(module.ControlError):
            fake.provision(LEASE, "us-central1-a", "test-template", STARTUP, 21601, 1)
        self.assertFalse(fake.events)

    def test_metadata_removal_must_be_observed_before_dispatch(self):
        fake = FakeController()
        fake.keep_metadata = True
        with self.assertRaisesRegex(module.ControlError, "metadata was not removed"):
            fake.provision_default()
        self.assertFalse(fake.vms)
        self.assertFalse(fake.registered)

    def test_remote_deletion_deadline_must_match_requested_ttl(self):
        fake = FakeController()
        fake.wrong_expiry = True
        with self.assertRaisesRegex(module.ControlError, "deletion deadline"):
            fake.provision_default()
        self.assertFalse(fake.vms)
        self.assertFalse(fake.registered)

    def test_boot_disk_cannot_silently_fall_back_to_gcloud_default_image(self):
        fake = FakeController()
        fake.wrong_image = True
        with self.assertRaisesRegex(module.ControlError, "boot image differs"):
            fake.provision_default()
        self.assertFalse(fake.vms)
        self.assertFalse(fake.registered)

    def test_partial_create_failure_still_reclaims_both_resources(self):
        fake = FakeController()
        fake.fail_create = True
        with self.assertRaises(module.ControlError):
            fake.provision_default()
        self.assertFalse(fake.vms)
        self.assertFalse(fake.registered)

    def test_busy_before_release_is_rejected(self):
        fake = FakeController()
        fake.busy = True
        with self.assertRaisesRegex(module.ControlError, "before provisioning"):
            fake.provision_default()
        self.assertFalse(fake.vms)
        self.assertFalse(fake.registered)

    def test_bootstrap_timeout_cleans_both(self):
        fake = FakeController()
        with self.assertRaisesRegex(module.ControlError, "bootstrap deadline"):
            fake.provision_default(online_timeout=0)
        self.assertFalse(fake.vms)
        self.assertFalse(fake.registered)

    def test_cleanup_without_outputs_is_idempotent_after_jit_self_deregisters(self):
        fake = FakeController()
        fake.provision_default()
        fake.registered.clear()
        fake.cleanup(LEASE, "us-central1-a")
        fake.cleanup(LEASE, "us-central1-a")
        self.assertFalse(fake.vms)

    def test_cleanup_continues_github_removal_when_cloud_delete_fails(self):
        fake = FakeController()
        fake.provision_default()
        fake.fail_delete = True
        with self.assertRaises(module.ControlError):
            fake.cleanup(LEASE, "us-central1-a")
        self.assertFalse(fake.registered)
        self.assertTrue(fake.vms)

    def test_janitor_keeps_live_lease_and_reclaims_expired_owned_lease(self):
        fake = FakeController()
        with patch.object(module.time, "time", return_value=1700000000):
            fake.provision_default()
            self.assertEqual(fake.janitor(), 0)
        with patch.object(module.time, "time", return_value=1700021601):
            self.assertEqual(fake.janitor(), 1)
        self.assertFalse(fake.vms)
        self.assertFalse(fake.registered)

    def test_janitor_can_remove_expired_registration_after_native_vm_delete(self):
        fake = FakeController()
        with patch.object(module.time, "time", return_value=1700000000):
            fake.provision_default()
        fake.vms.clear()
        with patch.object(module.time, "time", return_value=1700021601):
            fake.janitor()
        self.assertFalse(fake.registered)


class SecretHandlingTests(unittest.TestCase):
    def test_tool_errors_do_not_reveal_jit_response_or_error_output(self):
        controller = module.Controller("test-project", LEASE.repository)
        result = subprocess.CompletedProcess(["gh"], 1, SECRET, f"failed with {SECRET}")
        with patch.dict(os.environ, {"GH_TOKEN": "test-token"}), patch.object(
            module.subprocess, "run", return_value=result
        ):
            with self.assertRaises(module.ControlError) as caught:
                controller.command(["gh", "api", "example"])
        self.assertNotIn(SECRET, str(caught.exception))
        self.assertNotIn("test-token", str(caught.exception))

    def test_gcloud_does_not_inherit_github_token_or_debug_setting(self):
        controller = module.Controller("test-project", LEASE.repository)
        result = subprocess.CompletedProcess(["gcloud"], 0, "{}", "")
        with patch.dict(os.environ, {"GH_TOKEN": "test-token", "GITHUB_TOKEN": "other-token", "GH_DEBUG": "api"}), patch.object(
            module.subprocess, "run", return_value=result
        ) as run:
            controller.command(["gcloud", "compute"])
        env = run.call_args.kwargs["env"]
        self.assertNotIn("GH_TOKEN", env)
        self.assertNotIn("GITHUB_TOKEN", env)
        self.assertNotIn("GH_DEBUG", env)

    def test_only_actual_not_found_is_idempotent_not_permission_denied(self):
        controller = module.Controller("test-project", LEASE.repository)
        with patch.dict(os.environ, {"GH_TOKEN": "test-token"}), patch.object(
            module.subprocess, "run", return_value=subprocess.CompletedProcess(["gh"], 1, "", "gh: Not Found (HTTP 404)")
        ):
            self.assertIsNone(controller.command(["gh", "api"], missing_ok=True))
        with patch.dict(os.environ, {"GH_TOKEN": "test-token"}), patch.object(
            module.subprocess, "run", return_value=subprocess.CompletedProcess(["gh"], 1, "", "gh: Forbidden (HTTP 403)")
        ):
            with self.assertRaises(module.ControlError):
                controller.command(["gh", "api"], missing_ok=True)


if __name__ == "__main__":
    unittest.main()
