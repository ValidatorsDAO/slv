import base64
from datetime import datetime, timezone
import hashlib
import json
import unittest
from main import decision, stop_runners


SETTINGS = {
    "TARGET_PROJECT_ID": "example-runner",
    "PROVISIONER_SERVICE_ACCOUNT": "runner-controller@example-runner.iam.gserviceaccount.com",
    "BUDGET_DISPLAY_NAME": "runner-monthly-net",
    "BUDGET_CURRENCY": "EUR",
    "BUDGET_AMOUNT": "50",
}
NOW = datetime(2026, 10, 17, tzinfo=timezone.utc)


def event(**overrides):
    data = dict(budgetDisplayName="runner-monthly-net", currencyCode="EUR",
                costAmount=50, budgetAmount=50, costIntervalStart="2026-10-01T07:00:00Z")
    data.update(overrides)
    return {"data": base64.b64encode(json.dumps(data).encode()).decode()}


class BudgetTests(unittest.TestCase):
    def test_actual_threshold_and_overrun(self):
        self.assertTrue(decision(event(), SETTINGS, NOW))
        self.assertTrue(decision(event(costAmount=55), SETTINGS, NOW))
        self.assertFalse(decision(event(costAmount=49.99, forecastThresholdExceeded=1), SETTINGS, NOW))

    def test_other_budget_currency_or_period_cannot_stop(self):
        for override in [dict(currencyCode="USD"), dict(budgetAmount=100),
                         dict(budgetDisplayName="other"), dict(costAmount="NaN"),
                         dict(costIntervalStart="2026-09-01T00:00:00Z"),
                         dict(costIntervalStart="2026-11-01T00:00:00Z")]:
            with self.subTest(override=override):
                self.assertFalse(decision(event(**override), SETTINGS, NOW))
        self.assertFalse(decision({"data": "!not-base64"}, SETTINGS, NOW))

    def test_malformed_json_values_are_acknowledged_without_retry(self):
        for payload in [[], None, True, "text"]:
            encoded = base64.b64encode(json.dumps(payload).encode()).decode()
            self.assertFalse(decision({"data": encoded}, SETTINGS, NOW))
        self.assertFalse(decision(event(costIntervalStart=123), SETTINGS, NOW))

    def test_billing_month_uses_pacific_time_at_utc_month_boundary(self):
        early_november_utc = datetime(2026, 11, 1, 3, tzinfo=timezone.utc)
        self.assertTrue(decision(event(), SETTINGS, early_november_utc))
        november_pacific = datetime(2026, 11, 1, 8, tzinfo=timezone.utc)
        self.assertFalse(decision(event(), SETTINGS, november_pacific))

    def test_disable_precedes_deletion_and_only_owned_vm_deleted(self):
        repo_hash = hashlib.sha256(b"validatorsdao/slv").hexdigest()[:12]
        owned = {"name": f"slv-gha-{repo_hash[:10]}-123-1-build-aabbcc",
                 "zone": "https://www.googleapis.com/compute/v1/projects/example-runner/zones/europe-west4-a",
                 "labels": {"managed-by": "slv-gce-runner", "github-repo": repo_hash}}

        class API:
            def __init__(self):
                self.calls = []

            def call(self, method, url, body=None, allow_missing=False):
                self.calls.append((method, url))
                if "/aggregated/instances?" in url:
                    return {"items": {"zones/europe-west4-a": {"instances": [
                        owned, dict(owned, name="unrelated-database"), dict(owned, labels={})]}}}
                if method == "DELETE":
                    return {"name": "operation-123"}
                return {"status": "DONE"}

        api = API()
        stop_runners(SETTINGS, api)
        self.assertEqual(api.calls[0][0], "POST")
        self.assertTrue(api.calls[0][1].endswith(SETTINGS["PROVISIONER_SERVICE_ACCOUNT"] + ":disable"))
        deletes = [url for method, url in api.calls if method == "DELETE"]
        self.assertEqual(len(deletes), 1)
        self.assertTrue(deletes[0].endswith(owned["name"]))


if __name__ == "__main__":
    unittest.main()
