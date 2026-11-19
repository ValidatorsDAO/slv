"""The 443 vhost that install-nginx.yaml renders is served over HTTP/1.1 only.

The vhost proxies to a loopback service and does not need HTTP/2. The listen
lines carry no Jinja, so the YAML literal of the "Render vhost file" task is
what ansible renders and no ansible run is needed.

Run from the repository root:
python3 -m unittest discover -s template/latest/tests/rpc_geyser -p 'test_install_nginx.py' -v
"""

from pathlib import Path
import unittest

import yaml

RELEASE = Path(__file__).resolve().parents[2]
PLAYBOOK = RELEASE / "ansible" / "cmn" / "software" / "install-nginx.yaml"
TASK_NAME = "Render vhost file"
H2 = "http2"


def vhost_content():
    plays = yaml.safe_load(PLAYBOOK.read_text(encoding="utf-8"))
    for play in plays:
        for task in play.get("tasks") or []:
            if task.get("name") == TASK_NAME:
                return task["copy"]["content"]
    raise AssertionError(f"task {TASK_NAME!r} not found in {PLAYBOOK}")


class InstallNginxVhostTest(unittest.TestCase):
    def test_443_vhost_is_http1_only(self):
        content = vhost_content()
        self.assertIsInstance(content, str)
        directives = [
            line.strip() for line in content.splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        listen_443 = [
            line for line in directives
            if line.startswith("listen") and "443" in line
        ]
        self.assertTrue(listen_443, "no 443 listen directive in the vhost")
        for line in listen_443:
            tokens = [token.rstrip(";") for token in line.split()]
            self.assertNotIn(H2, tokens, f"443 listen line enables HTTP/2: {line}")
        for line in directives:
            self.assertNotEqual(
                line.split(), [H2, "on;"], f"HTTP/2 directive in the vhost: {line}"
            )


if __name__ == "__main__":
    unittest.main()
