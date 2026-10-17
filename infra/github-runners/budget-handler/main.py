"""Stop disposable runners when the configured monthly net budget is reached.

The Pub/Sub topic is dedicated to one project budget. Only the billing service
may publish to it. All resource names and limits come from deployment settings,
never from the notification. No billing-account or Terraform-state mutation.
"""

import base64
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo


class StopError(RuntimeError):
    pass


def decision(event, settings, now=None):
    """Fail closed on malformed/unrelated/stale events; never act on forecasts."""
    now = now or datetime.now(timezone.utc)
    try:
        raw = event["data"]
        if not isinstance(raw, str) or len(raw) > 32768:
            return False
        data = json.loads(base64.b64decode(raw, validate=True))
        if not isinstance(data, dict):
            return False
        if data.get("budgetDisplayName") != settings["BUDGET_DISPLAY_NAME"]:
            return False
        if data.get("currencyCode") != settings["BUDGET_CURRENCY"]:
            return False
        limit = Decimal(settings["BUDGET_AMOUNT"])
        notified_limit = Decimal(str(data["budgetAmount"]))
        cost = Decimal(str(data["costAmount"]))
        if not all(n.is_finite() for n in (limit, notified_limit, cost)):
            return False
        if limit <= 0 or notified_limit != limit or cost < limit:
            return False
        if not isinstance(data.get("costIntervalStart"), str):
            return False
        start = datetime.fromisoformat(data["costIntervalStart"].replace("Z", "+00:00"))
        if start.tzinfo is None or start > now:
            return False
        # Billing periods start at the beginning of the calendar month. Ignore
        # delayed notifications for a previous month after manual recovery.
        billing_zone = ZoneInfo("America/Los_Angeles")
        start = start.astimezone(billing_zone)
        current = now.astimezone(billing_zone)
        return (start.year, start.month) == (current.year, current.month)
    except (KeyError, TypeError, ValueError, InvalidOperation):
        return False


class GoogleAPI:
    def __init__(self):
        request = urllib.request.Request(
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
            headers={"Metadata-Flavor": "Google"},
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            self.token = json.load(response)["access_token"]

    def call(self, method, url, body=None, allow_missing=False):
        # URLs are assembled from validated deployment config and API responses.
        payload = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, data=payload, method=method, headers={
            "Authorization": "Bearer " + self.token,
            "Content-Type": "application/json",
        })
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                result = response.read()
                return json.loads(result) if result else {}
        except urllib.error.HTTPError as error:
            if allow_missing and error.code == 404:
                return None
            # Do not log response bodies, headers, tokens, or event payloads.
            raise StopError(f"Google API returned HTTP {error.code}") from None


def stop_runners(settings, api):
    project = settings["TARGET_PROJECT_ID"]
    sa = settings["PROVISIONER_SERVICE_ACCOUNT"]
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise StopError("Invalid deployment project")
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]@" + re.escape(project) + r"\.iam\.gserviceaccount\.com", sa):
        raise StopError("Invalid provisioner identity")

    # The handler can disable only this SA, and has no permission to enable it.
    # Disable first: automatic recovery must never race the resource cleanup.
    api.call("POST", "https://iam.googleapis.com/v1/projects/-/serviceAccounts/"
             + urllib.parse.quote(sa, safe="@.") + ":disable", {})
    repo_hash = hashlib.sha256(b"validatorsdao/slv").hexdigest()[:12]
    base = f"https://compute.googleapis.com/compute/v1/projects/{project}"
    query = {"filter": f"labels.managed-by=slv-gce-runner AND labels.github-repo={repo_hash}"}
    instances = []
    while True:
        page = api.call("GET", base + "/aggregated/instances?" + urllib.parse.urlencode(query))
        for scope in page.get("items", {}).values():
            instances.extend(scope.get("instances", []))
        if not page.get("nextPageToken"):
            break
        query["pageToken"] = page["nextPageToken"]

    operations = []
    for instance in instances:
        labels = instance.get("labels", {})
        name = instance.get("name", "")
        zone_url = instance.get("zone", "")
        zone = zone_url.rsplit("/", 1)[-1]
        if (labels.get("managed-by") != "slv-gce-runner"
                or labels.get("github-repo") != repo_hash
                or not re.fullmatch(r"slv-gha-" + repo_hash[:10] + r"-[a-z0-9-]+", name)
                or not re.fullmatch(r"[a-z]+-[a-z]+[0-9]+-[a-z]", zone)
                or not zone_url.endswith(f"/projects/{project}/zones/{zone}")):
            continue
        # Delete only the explicitly disposable runner; don't force-delete any
        # disk that was attached later with autoDelete=false.
        operation = api.call("DELETE", base + f"/zones/{zone}/instances/{name}", allow_missing=True)
        if operation:
            operation_name = operation.get("name", "")
            if not re.fullmatch(r"[a-zA-Z0-9_-]+", operation_name):
                raise StopError("Invalid deletion operation")
            operations.append(base + f"/zones/{zone}/operations/{operation_name}")

    deadline = time.monotonic() + 70
    while operations:
        pending = []
        for url in operations:
            operation = api.call("GET", url)
            if operation.get("error"):
                raise StopError("Runner deletion failed; notification will retry")
            if operation.get("status") != "DONE":
                pending.append(url)
        operations = pending
        if operations:
            if time.monotonic() >= deadline:
                raise StopError("Runner deletion still pending; notification will retry")
            time.sleep(2)
    print(json.dumps({"action": "runner-budget-stop", "provisioner_disabled": True,
                      "owned_runners_found": len(instances)}))


def stop_runner_spend(event, context):
    del context
    if decision(event, os.environ):
        stop_runners(os.environ, GoogleAPI())
    else:
        print('{"action":"runner-budget-notification","stop":false}')
