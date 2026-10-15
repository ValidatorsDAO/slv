"""Unit tests for the slv_listen_model filter plugin.

Run from the repository root:

    python3 -m unittest discover -s template/latest/tests/firewall -p 'test_*.py' -v

The plugin is loaded lazily, inside each test, so that a missing or broken plugin
fails each test that uses it by name instead of failing the whole module at import time.

The fixtures are real renders of the start templates, made with Ansible's
lookup('template') on the file and variables named in the header of each fixture.
They are snapshots, and nothing compares a fixture with its template: after a change
to a start template, render the fixtures again by hand and update the header (the
"source-sha256" and "source-state" lines say which text of the template the body was
rendered from).  A few tests change one line of a render to reach a case that no
template produces, and say so.
"""

import copy
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.normpath(
    os.path.join(HERE, "..", "..", "ansible", "cmn", "firewall", "filter_plugins", "slv_listen_model.py")
)
FIXTURES = os.path.join(HERE, "fixtures")

_loaded = []


def plugin():
    """Load the plugin module on first use (stdlib only, no Ansible needed)."""
    if not _loaded:
        spec = importlib.util.spec_from_file_location("slv_listen_model", PLUGIN)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _loaded.append(module)
    return _loaded[0]


FIXTURE_BEGIN = "# slv-fixture: begin\n"
FIXTURE_BODY = "# slv-fixture: body\n"


def fixture_header(name):
    with open(os.path.join(FIXTURES, name + ".fixture"), encoding="utf-8") as handle:
        text = handle.read()
    assert text.startswith(FIXTURE_BEGIN), "%s has no fixture header" % name
    cut = text.index(FIXTURE_BODY)
    header = {}
    for line in text[len(FIXTURE_BEGIN) : cut].splitlines():
        key, _, value = line[2:].partition(": ")
        header[key] = value
    return header, text[cut + len(FIXTURE_BODY) :]


def fixture(name):
    return fixture_header(name)[1]


def replaced(text, old, new, times=1):
    """str.replace that fails loudly when the render does not contain what the test edits."""
    if text.count(old) != times:
        raise AssertionError("expected %d x %r in the fixture, found %d" % (times, old, text.count(old)))
    return text.replace(old, new)


def P(*parts):
    """Closed port intervals from ints and (lo, hi) pairs: sorted, overlaps and neighbours merged."""
    merged = []
    for lo, hi in sorted((p, p) if isinstance(p, int) else tuple(p) for p in parts):
        if merged and lo <= merged[-1][1] + 1:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return merged


# ---------------------------------------------------------------------------
# Builders for the model's four arguments
# ---------------------------------------------------------------------------

ADMIN = "198.51.100.7"
CONTROLLER = "198.51.100.7"


def profile(client="agave", version="4.3.0", role="validator", network="mainnet", rpc_type=None):
    return {"client": client, "version": version, "role": role, "network": network, "rpc_type": rpc_type}


def inputs(**over):
    base = {"admin_ips": [ADMIN], "controller_ip": CONTROLLER}
    base.update(over)
    return base


def host_facts(**over):
    base = {
        "default_route_ifaces": ["eno1"],
        "ifaces": ["lo", "eno1"],
        "bridges": [],
        "dhcp4_ifaces": [],
        "dhcp6_ifaces": [],
        "ra_ifaces": [],
        "sshd_ports": [22],
        "ssh_socket_ports": [],
        "sshd_listen_ports": [22],
        "has_global_v6": False,
    }
    base.update(over)
    return base


def args_item(name_or_text, literal=False):
    return {"kind": "agave-args", "text": name_or_text if literal else fixture(name_or_text)}


def toml_item(name_or_text, literal=False):
    return {"kind": "fd-toml", "text": name_or_text if literal else fixture(name_or_text)}


def unit_item(name):
    return {"kind": "unit", "text": fixture(name)}


def richat_data():
    return json.loads(fixture("mainnet-rpc.richat-setting.from-yaml.json"))


def richat_item(data=None):
    return {"kind": "richat", "data": richat_data() if data is None else data}


def of1_item():
    return {"kind": "of1-listen", "text": fixture("mainnet-rpc.of1-listen.txt")}


def derive(rendered, prof=None, inp=None, facts=None):
    return plugin().slv_listen_model(
        rendered, prof or profile(), inputs() if inp is None else inp, host_facts() if facts is None else facts
    )


def agave_validator(**over):
    """The mainnet agave validator with the values `slv v init` writes (8900-8930, 7211)."""
    return derive([args_item("mainnet-validator.agave-4.3.0.start-validator.sh")], profile(), inputs(**over))


def validator_with_range(rng):
    """The mainnet agave validator render with another --dynamic-port-range, as the rendered list."""
    text = replaced(
        fixture("mainnet-validator.agave-4.3.0.start-validator.sh"),
        "--dynamic-port-range 8900-8930",
        "--dynamic-port-range %s" % rng,
    )
    return [args_item(text, literal=True)]


def richat_node(rng="8000-8030", quic=None):
    """The mainnet Geyser gRPC render with another --dynamic-port-range and, if given, another richat QUIC endpoint."""
    data = richat_data()
    if quic is not None:
        data["apps"]["richat"]["quic"]["endpoint"] = quic
    text = replaced(
        fixture("mainnet-rpc.geyser-grpc.start-validator.sh"),
        "--dynamic-port-range 8000-8030",
        "--dynamic-port-range %s" % rng,
    )
    return [args_item(text, literal=True), richat_item(data)]


def blank_model():
    """The model of the mainnet agave validator with every set of ports emptied, to build overlaps by hand."""
    model = copy.deepcopy(derive([args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]))
    for group, keys in (
        ("udp", ("public", "xdp", "pub", "allowlist")),
        ("tcp", ("public", "consumer", "mgmt", "metrics", "ssh", "wg_only")),
        ("local_only", ("tcp", "udp")),
    ):
        for key in keys:
            model[group][key] = []
    model["components"] = []
    model["host"]["dhcp4_ifaces"] = []
    model["host"]["dhcp6_ifaces"] = []
    return model


def port_setters():
    """(protocol, name, put) for each set of ports a table has a rule for or the model keeps local.

    put(model, intervals) puts the ports into that set of a model made by blank_model().
    """

    def plain(group, key):
        def put(model, ports):
            model[group][key] = ports

        return put

    def allowlist(model, ports):
        model["udp"]["allowlist"] = [{"component": "shred-relay", "ports": ports, "sources": {"v4": [], "v6": []}}]

    def interface_rule(proto):
        def put(model, ports):
            if not model["components"]:
                model["components"] = [{"id": "libvirt", "class": "host", "listeners": [], "iface_rules": []}]
            model["components"][0]["iface_rules"].append({"iifname": "virbr*", "proto": proto, "ports": ports})

        return put

    return (
        ("udp", "local_only.udp", plain("local_only", "udp")),
        ("udp", "udp.allowlist", allowlist),
        ("udp", "interface rule", interface_rule("udp")),
        ("udp", "udp.pub", plain("udp", "pub")),
        ("udp", "udp.public", plain("udp", "public")),
        ("udp", "udp.xdp", plain("udp", "xdp")),
        ("tcp", "local_only.tcp", plain("local_only", "tcp")),
        ("tcp", "interface rule", interface_rule("tcp")),
        ("tcp", "tcp.wg_only", plain("tcp", "wg_only")),
        ("tcp", "tcp.mgmt", plain("tcp", "mgmt")),
        ("tcp", "tcp.ssh", plain("tcp", "ssh")),
        ("tcp", "tcp.metrics", plain("tcp", "metrics")),
        ("tcp", "tcp.consumer", plain("tcp", "consumer")),
        ("tcp", "tcp.public", plain("tcp", "public")),
    )


def fd_rpc_toml():
    """The Frankendancer RPC render with a range that holds no fixed port.

    `slv rpc init` writes 8000-8030 for every client; that range holds 8001 and 8003
    (see test_b11), so tests that need a valid Frankendancer RPC config use 8900-8930.
    """
    return replaced(
        fixture("mainnet-rpc.firedancer-config.toml"),
        'dynamic_port_range = "8000-8030"',
        'dynamic_port_range = "8900-8930"',
    )


def rpc_profile(rpc_type, client="agave", version="4.3.0"):
    return profile(client, version, "rpc", "mainnet", rpc_type)


def geyser_rendered(text=None, name="mainnet-rpc.geyser-grpc.start-validator.sh"):
    """The start script of a Geyser gRPC node (a fixture, or `text` when a test edits it) and richat."""
    return [args_item(name) if text is None else args_item(text, literal=True), richat_item()]


def warning_codes(model):
    return [w["code"] for w in model["warnings"]]


class ModelTestCase(unittest.TestCase):
    def assertStops(self, code, *args, **kwargs):
        """The model must stop with this error code."""
        func = kwargs.pop("func", None) or plugin().slv_listen_model
        with self.assertRaises(plugin().ModelError) as caught:
            func(*args, **kwargs)
        self.assertEqual(caught.exception.code, code, str(caught.exception))
        return caught.exception

    def assertStopsDerive(self, code, rendered, prof=None, inp=None, facts=None):
        return self.assertStops(
            code,
            rendered,
            prof or profile(),
            inputs() if inp is None else inp,
            host_facts() if facts is None else facts,
        )


class ListenModelBehaviors(ModelTestCase):
    """One test per behavior of the model (b01 to b39)."""

    def test_b01_mainnet_agave_validator_with_cli_values(self):
        model = agave_validator()
        self.assertEqual(model["udp"]["public"], P((8900, 8929)))
        self.assertEqual(model["tcp"]["mgmt"], P((7211, 7212)))
        self.assertEqual(model["tcp"]["metrics"], P(9100))
        self.assertEqual(model["tcp"]["consumer"], [])
        self.assertEqual(model["tcp"]["public"], [])
        self.assertEqual(model["udp"]["xdp"], [])
        self.assertEqual(model["local_only"], {"tcp": [], "udp": []})

    def test_b02_gossip_port_outside_the_range_is_public_and_its_tcp_needs_ip_echo_public(self):
        text = replaced(
            fixture("mainnet-validator.agave-4.3.0.start-validator.sh"),
            "--no-port-check \\\n",
            "--no-port-check \\\n--gossip-port 8001 \\\n",
        )
        closed = derive([args_item(text, literal=True)])
        self.assertEqual(closed["udp"]["public"], P(8001, (8900, 8929)))
        self.assertEqual(closed["tcp"]["public"], [])
        opened = derive([args_item(text, literal=True)], inp=inputs(ip_echo_public=True))
        self.assertEqual(opened["tcp"]["public"], P(8001))
        # a gossip port inside the range adds nothing to udp and is the ip-echo port
        inside = replaced(text, "--gossip-port 8001", "--gossip-port 8905")
        model = derive([args_item(inside, literal=True)], inp=inputs(ip_echo_public=True))
        self.assertEqual(model["udp"]["public"], P((8900, 8929)))
        self.assertEqual(model["tcp"]["public"], P(8905))

    def test_b03_mainnet_rpc_richat_geyser_grpc(self):
        model = derive(geyser_rendered(), rpc_profile("Geyser gRPC"))
        self.assertEqual(model["udp"]["public"], P((8000, 8029)))
        self.assertEqual(model["tcp"]["consumer"], P(7111, (7211, 7212), 10000))
        self.assertEqual(model["tcp"]["metrics"], P(9100, 10124))
        self.assertEqual(model["tcp"]["mgmt"], [])
        self.assertEqual(model["tcp"]["public"], [])
        self.assertEqual(model["local_only"]["tcp"], P(10100))
        self.assertEqual(model["local_only"]["udp"], P(10101))

    def test_b04_mainnet_rpc_index_serves_old_faithful_as_a_consumer_port(self):
        model = derive([args_item("mainnet-rpc.index-rpc.start-validator.sh"), of1_item()], rpc_profile("Index RPC"))
        self.assertEqual(model["tcp"]["consumer"], P((7211, 7212), 8888))
        self.assertEqual(model["tcp"]["public"], [])

    def test_b05_loopback_rpc_bind_is_local_only(self):
        geyser = fixture("mainnet-rpc.geyser-grpc.start-validator.sh")
        cases = {
            "--rpc-bind-address 127.0.0.1": replaced(
                geyser, "--rpc-bind-address 0.0.0.0", "--rpc-bind-address 127.0.0.1"
            ),
            "--private-rpc without a bind address": replaced(geyser, "--rpc-bind-address 0.0.0.0 \\\n", ""),
        }
        for name, text in cases.items():
            with self.subTest(name):
                model = derive(geyser_rendered(text), rpc_profile("Geyser gRPC"))
                self.assertEqual(model["local_only"]["tcp"], P((7211, 7212), 10100))
                self.assertEqual(model["tcp"]["consumer"], P(7111, 10000))
        with self.subTest("Frankendancer [rpc] private without bind_address"):
            toml = replaced(fd_rpc_toml(), '    bind_address = "0.0.0.0"\n', "")
            model = derive(
                [toml_item(toml, literal=True), of1_item()],
                rpc_profile("Index RPC", "firedancer-jito", "0.1204.40300"),
            )
            self.assertIn([7211, 7212], model["local_only"]["tcp"])
            self.assertEqual(model["tcp"]["consumer"], P(8888))
        with self.subTest("a validator without --private-rpc binds every interface"):
            model = derive(
                [args_item("testnet-validator.agave-4.4.0-beta.0.start-validator.sh")],
                profile("agave", "4.4.0-beta.0", "validator", "testnet"),
            )
            self.assertEqual(model["tcp"]["mgmt"], P((7211, 7212)))

    def test_b06_frankendancer_validator_reads_the_rendered_config(self):
        model = derive(
            [toml_item("mainnet-validator.firedancer-config.toml")],
            profile("firedancer-jito", "0.1204.40300"),
        )
        self.assertEqual(model["udp"]["public"], P(8001, 8003, (8900, 8929), 9001, 9007))
        self.assertEqual(model["udp"]["xdp"], P(8003, 9001, 9007))
        # the template reads rpc_port (default 8899), not the port_rpc 7211 the CLI wrote
        self.assertEqual(model["tcp"]["mgmt"], P((8899, 8900), 6001))
        self.assertEqual(model["tcp"]["metrics"], P(7999, 9100))
        self.assertEqual(model["tcp"]["consumer"], [])
        self.assertEqual(model["tcp"]["public"], [])

    def test_b07_socket_provider_keeps_the_ports_in_the_kernel(self):
        toml = fixture("mainnet-validator.firedancer-config.toml")
        for version in ("0.814.30108", "0.1204.40300"):
            fd = profile("firedancer-jito", version)
            with self.subTest(version):
                socket_model = derive([toml_item(toml + '\n[net]\n    provider = "socket"\n', literal=True)], fd)
                self.assertEqual(socket_model["udp"]["xdp"], [])
                self.assertEqual(socket_model["udp"]["public"], P(8001, 8003, (8900, 8929), 9001, 9007))
                for provider in ("bogus", "auto", ""):
                    self.assertStopsDerive(
                        "fd_provider_unknown",
                        [toml_item(toml + '\n[net]\n    provider = "%s"\n' % provider, literal=True)],
                        fd,
                    )

    def test_b08_receive_xdp_needs_an_explicit_acknowledgement(self):
        allnodes = profile("allnodes-jito", "4.3.0-allnodes.1")
        args = args_item("mainnet-validator.allnodes-4.3.0-allnodes.1.start-validator.sh")
        caps_on = unit_item("mainnet-validator.solv.service.xdp-on")
        self.assertStopsDerive("xdp_rx_bypass_unacknowledged", [args, caps_on], allnodes)
        self.assertStopsDerive(
            "xdp_rx_bypass_unacknowledged", [args, caps_on], allnodes, inputs(accept_xdp_rx_bypass=False)
        )
        accepted = derive([args, caps_on], allnodes, inputs(accept_xdp_rx_bypass=True))
        self.assertEqual(
            accepted["udp"]["xdp_rx_bypass"],
            [
                "ancestor_hashes",
                "block_id_repair",
                "repair",
                "serve_repair",
                "tpu_fwd_quic",
                "tpu_quic",
                "tpu_vote",
                "tvu",
            ],
        )
        self.assertIn("xdp_rx_bypass_accepted", warning_codes(accepted))
        net_only = {
            "kind": "unit",
            "text": replaced(fixture("mainnet-validator.solv.service.xdp-on"), " CAP_BPF CAP_PERFMON", "", times=2),
        }
        for name, unit in (
            ("CAP_NET_RAW and CAP_NET_ADMIN only", net_only),
            ("no capabilities", unit_item("mainnet-validator.solv.service.xdp-off")),
        ):
            with self.subTest(name):
                model = derive([args, unit], allnodes)
                self.assertEqual(model["udp"]["xdp_rx_bypass"], [])
                self.assertNotIn("xdp_rx_bypass_accepted", warning_codes(model))

    def test_b09_rpc_port_inside_the_dynamic_range_stops(self):
        # the template defaults: --dynamic-port-range 8900-8930 and --rpc-port 8899. Gossip binds the
        # first port of the range, 8900, which is the pubsub port (8899 + 1).
        self.assertStopsDerive(
            "rpc_port_in_range",
            geyser_rendered(name="mainnet-rpc.template-defaults.start-validator.sh"),
            rpc_profile("Geyser gRPC"),
        )
        # the RPC port itself on the first port of the range
        text = replaced(
            fixture("mainnet-validator.agave-4.3.0.start-validator.sh"), "--rpc-port 7211", "--rpc-port 8900"
        )
        self.assertStopsDerive("rpc_port_in_range", [args_item(text, literal=True)])

    def test_b10_range_narrower_than_the_client_accepts_stops(self):
        # the Frankendancer template default is 8900-8925, 25 wide
        self.assertStopsDerive(
            "range_too_narrow",
            [toml_item("mainnet-validator.firedancer-config.template-defaults.toml")],
            profile("firedancer-agave", "0.1204.40300"),
        )
        text = replaced(
            fixture("mainnet-validator.agave-4.3.0.start-validator.sh"),
            "--dynamic-port-range 8900-8930",
            "--dynamic-port-range 8900-8925",
        )
        self.assertStopsDerive("range_too_narrow", [args_item(text, literal=True)])

    def test_b11_frankendancer_fixed_port_inside_the_dynamic_range_stops(self):
        # `slv rpc init` writes 8000-8030 for every client: it holds 8001 and 8003
        exc = self.assertStopsDerive(
            "fd_fixed_port_in_range",
            [toml_item("mainnet-rpc.firedancer-config.toml"), of1_item()],
            rpc_profile("Index RPC", "firedancer-jito", "0.1204.40300"),
        )
        self.assertIn("8001", exc.detail)
        toml = replaced(
            fixture("mainnet-validator.firedancer-config.toml"),
            'dynamic_port_range = "8900-8930"',
            'dynamic_port_range = "8950-9020"',
        )
        exc = self.assertStopsDerive(
            "fd_fixed_port_in_range", [toml_item(toml, literal=True)], profile("firedancer-jito", "0.1204.40300")
        )
        self.assertIn("9001", exc.detail)

    def test_b12_deny_overlapping_an_allowed_source_stops(self):
        cases = (
            ("mgmt", {"admin_ips": ["198.51.100.7"], "deny_ips": ["198.51.100.0/24"]}),
            ("lb", {"lb_ips": ["192.0.2.10"], "deny_ips": ["192.0.2.0/25"]}),
            ("scrape", {"metrics_ips": ["203.0.113.9"], "deny_ips": ["203.0.113.8/29"]}),
            ("mgmt over IPv6", {"admin_ips": [ADMIN, "2001:db8:10::/64"], "deny_ips": ["2001:db8:10::5"]}),
        )
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        for name, over in cases:
            with self.subTest(name):
                self.assertStopsDerive("deny_overlaps_allow", rendered, inp=inputs(**over))
        model = derive(rendered, inp=inputs(deny_ips=["203.0.113.0/24", "2001:db8:dead::/48"]))
        self.assertEqual(model["sources"]["deny"], {"v4": ["203.0.113.0/24"], "v6": ["2001:db8:dead::/48"]})

    def test_b13_any_source_in_an_allowlist_stops(self):
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        for key in ("admin_ips", "lb_ips", "metrics_ips", "deny_ips"):
            for any_source in ("0.0.0.0/0", "::/0"):
                with self.subTest("%s %s" % (key, any_source)):
                    over = {key: [any_source]}
                    if key == "admin_ips":
                        over["controller_ip"] = None
                    self.assertStopsDerive("allowlist_has_any", rendered, inp=inputs(**over))
        with self.subTest("component sources"):
            self.assertStopsDerive(
                "allowlist_has_any",
                rendered,
                inp=inputs(components=[{"id": "shred-relay", "sources": ["0.0.0.0/0"]}]),
            )

    def test_b14_a_version_without_a_profile_stops(self):
        rendered_agave = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        cases = (
            ("unknown agave version", profile("agave", "9.9.9")),
            ("a jito version for the agave client", profile("agave", "4.3.0-jito.0")),
            ("an unlisted Frankendancer", profile("firedancer-jito", "0.1204.99999")),
            ("full Firedancer", profile("firedancer", "26.09.6")),
            ("unknown client", profile("solana-labs", "1.18.0")),
        )
        for name, prof in cases:
            with self.subTest(name):
                self.assertStopsDerive("no_profile", rendered_agave, prof)

    def test_b15_a_trusted_interface_that_is_the_uplink_stops(self):
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        for trusted in (["eno1"], ["wg0", "eno1"], ["eno*"]):
            with self.subTest(trusted):
                self.assertStopsDerive("trusted_iface_is_uplink", rendered, inp=inputs(trusted_ifaces=trusted))
        model = derive(rendered, inp=inputs(trusted_ifaces=["wg0", "br-*"]))
        self.assertEqual(model["trusted_ifaces"], ["br-*", "wg0"])

    def test_b16_refuse_with_no_admin_stops(self):
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        self.assertStopsDerive("admin_empty_refused", rendered, inp={"controller_ip": CONTROLLER})
        self.assertStopsDerive(
            "admin_empty_refused", rendered, inp={"ssh_mode": "refuse", "admin_ips": [], "controller_ip": CONTROLLER}
        )

    def test_b17_controller_only_without_admin_trusts_the_controller_alone(self):
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        inp = {"ssh_mode": "controller-only", "controller_ip": "203.0.113.9"}
        model = derive(rendered, inp=inp)
        self.assertEqual(model["sources"]["mgmt"], {"v4": ["203.0.113.9/32"], "v6": []})
        self.assertFalse(model["ssh"]["public"])
        self.assertTrue(model["ssh"]["controller_only"])
        self.assertIn("controller_only_mgmt", warning_codes(model))
        v6 = derive(rendered, inp={"ssh_mode": "controller-only", "controller_ip": "::ffff:203.0.113.9"})
        self.assertEqual(v6["sources"]["mgmt"]["v4"], ["203.0.113.9/32"], "an IPv4-mapped address is read as IPv4")
        self.assertStopsDerive("controller_unknown", rendered, inp={"ssh_mode": "controller-only"})

    def test_b18_public_rate_limited_opens_ssh_and_keeps_mgmt_as_admin(self):
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        inp = {"ssh_mode": "public-rate-limited", "admin_ips": [ADMIN], "controller_ip": "203.0.113.9"}
        model = derive(rendered, inp=inp)
        self.assertTrue(model["ssh"]["public"])
        self.assertIsNotNone(model["ssh"]["rate"])
        self.assertEqual(model["sources"]["mgmt"], {"v4": ["198.51.100.7/32"], "v6": []})
        self.assertEqual(model["ssh"]["mode"], "public-rate-limited")
        empty = derive(rendered, inp={"ssh_mode": "public-rate-limited"})
        self.assertTrue(empty["ssh"]["public"])
        self.assertEqual(empty["sources"]["mgmt"], {"v4": [], "v6": []})

    def test_b19_controller_outside_admin_stops_unless_ssh_is_public(self):
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        for mode in ("refuse", "controller-only"):
            with self.subTest(mode):
                self.assertStopsDerive(
                    "controller_not_in_admin",
                    rendered,
                    inp={"ssh_mode": mode, "admin_ips": [ADMIN], "controller_ip": "203.0.113.9"},
                )
        inside = derive(rendered, inp={"admin_ips": ["203.0.113.0/28"], "controller_ip": "203.0.113.9"})
        self.assertEqual(inside["sources"]["mgmt"]["v4"], ["203.0.113.0/28"])
        unknown = derive(rendered, inp={"admin_ips": [ADMIN]})
        self.assertEqual(unknown["sources"]["mgmt"]["v4"], ["198.51.100.7/32"])

    def test_b20_ssh_ports_are_the_union_of_every_source(self):
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        facts = host_facts(sshd_ports=[2022], ssh_socket_ports=[2023], sshd_listen_ports=[2024])
        model = derive(rendered, inp=inputs(ssh_connection_port=2222, ansible_port=2200), facts=facts)
        self.assertEqual(model["tcp"]["ssh"], [[2022, 2024], [2200, 2200], [2222, 2222]], "neighbours are merged")
        default = derive(rendered, facts=host_facts(sshd_ports=[], sshd_listen_ports=[]))
        self.assertEqual(default["tcp"]["ssh"], P(22), "ansible_port defaults to 22")
        text_ports = derive(
            rendered,
            inp=inputs(ansible_port="2200", ssh_connection_port="22"),
            facts=host_facts(sshd_ports=[], sshd_listen_ports=[]),
        )
        self.assertEqual(text_ports["tcp"]["ssh"], P(22, 2200))

    def test_b21_rpc_without_a_load_balancer_fails_closed_and_public_rpc_names_what_it_exposes(self):
        rendered = [
            args_item("mainnet-rpc.index-grpc.start-validator.sh"),
            richat_item(),
            of1_item(),
        ]
        prof = rpc_profile("Index RPC + gRPC")
        closed = derive(rendered, prof)
        self.assertIn("lb_empty_fail_closed", warning_codes(closed))
        self.assertFalse(closed["consumer_public"])
        self.assertEqual(closed["sources"]["lb"], {"v4": [], "v6": []})
        self.assertEqual(
            closed["sources"]["mgmt"], {"v4": ["198.51.100.7/32"], "v6": []}, "only mgmt can reach consumer ports"
        )
        self.assertNotIn("public_rpc_unauthenticated", warning_codes(closed))
        with_lb = derive(rendered, prof, inputs(lb_ips=["192.0.2.10"]))
        self.assertNotIn("lb_empty_fail_closed", warning_codes(with_lb))
        self.assertEqual(with_lb["sources"]["lb"], {"v4": ["192.0.2.10/32"], "v6": []})
        public = derive(rendered, prof, inputs(public_rpc=True))
        self.assertTrue(public["consumer_public"])
        self.assertNotIn("lb_empty_fail_closed", warning_codes(public))
        warning = [w for w in public["warnings"] if w["code"] == "public_rpc_unauthenticated"][0]
        named = sorted((x["port"], x["proto"]) for x in warning["listeners"])
        self.assertEqual(named, [(8888, "tcp"), (10000, "tcp")])
        self.assertIn("8888", warning["detail"])
        self.assertIn("10000", warning["detail"])
        with self.subTest("a richat gRPC with x_tokens is not named"):
            data = richat_data()
            data["apps"]["grpc"]["x_tokens"] = ["not-a-real-token"]
            guarded = derive([rendered[0], richat_item(data), rendered[2]], prof, inputs(public_rpc=True))
            warning = [w for w in guarded["warnings"] if w["code"] == "public_rpc_unauthenticated"][0]
            self.assertEqual([x["port"] for x in warning["listeners"]], [8888])
        with self.subTest("a validator has no consumer port"):
            model = derive([args_item("mainnet-validator.agave-4.3.0.start-validator.sh")], inp=inputs(public_rpc=True))
            self.assertIn("public_rpc_no_effect", warning_codes(model))
            self.assertFalse(model["consumer_public"])

    def test_b22_components_have_a_fixed_class(self):
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]

        def with_components(*components, **over):
            return derive(rendered, inp=inputs(components=list(components), **over))

        with self.subTest("rpc-gateway is a consumer port"):
            model = with_components("rpc-gateway")
            self.assertEqual(model["tcp"]["consumer"], P(8889))
            self.assertEqual(model["local_only"]["udp"], P(20000))
            self.assertEqual(model["components"][0]["class"], "consumer")
        with self.subTest("shred-relay is an allowlist for 20001 and local for 19999"):
            model = with_components({"id": "shred-relay", "sources": ["203.0.113.0/24"]})
            self.assertEqual(
                model["udp"]["allowlist"],
                [
                    {
                        "component": "shred-relay",
                        "ports": [[20001, 20001]],
                        "sources": {"v4": ["203.0.113.0/24"], "v6": []},
                    }
                ],
            )
            self.assertEqual(model["local_only"]["tcp"], P(19999))
            self.assertNotIn(20001, [p for lo, hi in model["udp"]["public"] for p in range(lo, hi + 1)])
        with self.subTest("wireguard is public and its tunnel is trusted like mgmt"):
            model = with_components("wireguard")
            self.assertEqual(model["udp"]["pub"], P(51820))
            self.assertEqual(model["wireguard"], {"enabled": True, "iface": "wg0", "subnet": "10.0.0.0/24"})
        with self.subTest("gateway is reachable through the tunnel only"):
            model = with_components("wireguard", "gateway")
            self.assertEqual(model["tcp"]["wg_only"], P(20026))
            for klass in ("public", "consumer", "mgmt", "metrics"):
                self.assertNotIn([20026, 20026], model["tcp"][klass])
            self.assertEqual(model["tcp"]["public"], [])
            self.assertEqual(model["tcp"]["consumer"], [])
        with self.subTest("nginx is public on 80 and 443"):
            self.assertEqual(with_components("nginx")["tcp"]["public"], P(80, 443))
        with self.subTest("libvirt is limited to the virbr interfaces"):
            model = with_components("libvirt")
            self.assertEqual(
                model["components"][0]["iface_rules"],
                [
                    {"iifname": "virbr*", "proto": "udp", "ports": [[53, 53], [67, 67]]},
                    {"iifname": "virbr*", "proto": "tcp", "ports": [[53, 53]]},
                ],
            )
            self.assertEqual(model["udp"]["pub"], [])
            self.assertEqual(model["tcp"]["public"], [])
        with self.subTest("unknown id"):
            self.assertStopsDerive("unknown_component", rendered, inp=inputs(components=["docker"]))
            self.assertStopsDerive("unknown_component", rendered, inp=inputs(components=[{"id": ["nginx"]}]))
            self.assertStopsDerive("unknown_component", rendered, inp=inputs(components=[{}]))
        with self.subTest("shred-relay needs sources"):
            self.assertStopsDerive("component_sources_required", rendered, inp=inputs(components=["shred-relay"]))
            self.assertStopsDerive(
                "component_sources_required", rendered, inp=inputs(components=[{"id": "shred-relay", "sources": []}])
            )
        with self.subTest("gateway can not be public"):
            for ask in ({"public": True}, {"class": "public"}, {"class": "consumer"}):
                self.assertStopsDerive(
                    "gateway_never_public", rendered, inp=inputs(components=[dict({"id": "gateway"}, **ask)])
                )

    def test_b23_host_facts_pick_the_interfaces_of_dhcp_and_ra(self):
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        ifaces = ["lo", "eno1", "eno2", "docker0"]
        determined = derive(
            rendered,
            facts=host_facts(ifaces=ifaces, dhcp4_ifaces=["eno1"], dhcp6_ifaces=["eno2"], ra_ifaces=["eno1"]),
        )
        host = determined["host"]
        self.assertEqual(
            (host["dhcp4_ifaces"], host["dhcp6_ifaces"], host["ra_ifaces"]), (["eno1"], ["eno2"], ["eno1"])
        )
        self.assertFalse(host["dhcp_undetermined"] or host["ra_undetermined"])
        self.assertNotIn("bridges_present", warning_codes(determined))
        unknown = derive(
            rendered, facts=host_facts(ifaces=ifaces, dhcp4_ifaces=None, dhcp6_ifaces=None, ra_ifaces=None)
        )
        host = unknown["host"]
        everywhere = ["eno1", "eno2"]  # docker0 is a bridge without a default route (see b37)
        self.assertEqual((host["dhcp4_ifaces"], host["dhcp6_ifaces"], host["ra_ifaces"]), (everywhere,) * 3)
        self.assertTrue(host["dhcp_undetermined"] and host["ra_undetermined"])
        mixed = derive(rendered, facts=host_facts(ifaces=ifaces, dhcp4_ifaces=None, ra_ifaces=["eno2"]))
        self.assertEqual(mixed["host"]["dhcp4_ifaces"], everywhere)
        self.assertEqual(mixed["host"]["ra_ifaces"], ["eno2"])
        self.assertTrue(mixed["host"]["dhcp_undetermined"])
        self.assertFalse(mixed["host"]["ra_undetermined"])
        bridged = derive(rendered, facts=host_facts(ifaces=ifaces, bridges=["docker0"]))
        self.assertIn("bridges_present", warning_codes(bridged))
        self.assertEqual(bridged["host"]["bridges"], ["docker0"])

    def test_b24_the_same_input_gives_the_same_bytes_and_checksum(self):
        def build(reverse):
            items = [args_item("mainnet-rpc.index-grpc.start-validator.sh"), richat_item(), of1_item()]
            inp = inputs(
                admin_ips=["203.0.113.0/28", ADMIN, "2001:db8:10::/64"],
                lb_ips=["192.0.2.10", "192.0.2.11"],
                components=[
                    "nginx",
                    "wireguard",
                    {"id": "shred-relay", "sources": ["203.0.113.64/26", "203.0.113.0/26"]},
                ],
                trusted_ifaces=["wg0", "br-*"],
                controller_ip=ADMIN,
            )
            facts = host_facts(ifaces=["lo", "eno1", "eno2"], dhcp4_ifaces=["eno2", "eno1"])
            prof = rpc_profile("Index RPC + gRPC")
            if reverse:
                items.reverse()
                inp = dict(reversed(list(inp.items())))
                for key in ("admin_ips", "lb_ips", "components", "trusted_ifaces"):
                    inp[key] = list(reversed(inp[key]))
                facts = dict(reversed(list(facts.items())))
                prof = dict(reversed(list(prof.items())))
            return derive(items, prof, inp, facts)

        first, second = build(False), build(True)
        module = plugin()
        self.assertEqual(module.canonical_json(first).encode("utf-8"), module.canonical_json(second).encode("utf-8"))
        self.assertEqual(first["model_sha256"], second["model_sha256"])
        body = dict(first)
        digest = body.pop("model_sha256")
        self.assertEqual(digest, hashlib.sha256(module.canonical_json(body).encode("utf-8")).hexdigest())
        self.assertEqual(json.loads(module.canonical_json(first)), first)
        # canonical: sorted keys, no spaces
        self.assertTrue(module.canonical_json(first).startswith('{"components":'))
        self.assertNotIn(" ", module.canonical_json({"a": [1, 2], "b": {"c": 3}}))
        changed = derive(
            [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")],
            inp=inputs(admin_ips=["198.51.100.8"], controller_ip=None),
        )
        self.assertNotEqual(changed["model_sha256"], agave_validator()["model_sha256"])

    def test_b25_union_adds_ports_per_class_and_takes_the_rest_from_the_new_model(self):
        old = agave_validator()
        new_text = replaced(
            replaced(
                fixture("mainnet-validator.agave-4.3.0.start-validator.sh"),
                "--dynamic-port-range 8900-8930",
                "--dynamic-port-range 8000-8030",
            ),
            "--rpc-port 7211",
            "--rpc-port 7300",
        )
        # the sources that reach the ports only the old model has are the same in both models, so the union is
        # allowed (b39 has the unions that would give such a port more sources); the deny entry and nginx
        # are the new model's own
        new = derive(
            [args_item(new_text, literal=True)],
            inp=inputs(deny_ips=["192.0.2.0/24"], components=["nginx"]),
        )
        union = plugin().slv_listen_model_union(old, new)
        self.assertEqual(union["udp"]["public"], P((8000, 8029), (8900, 8929)))
        self.assertEqual(union["tcp"]["mgmt"], P((7211, 7212), (7300, 7301)))
        self.assertEqual(union["tcp"]["metrics"], P(9100))
        self.assertEqual(union["tcp"]["public"], P(80, 443))
        self.assertEqual(union["tcp"]["consumer"], [])
        for key in ("sources", "ssh", "components", "warnings", "profile", "host", "trusted_ifaces", "wireguard"):
            self.assertEqual(union[key], new[key], key)
        self.assertNotEqual(union["sources"], old["sources"], "the deny entry is the new model's")
        self.assertNotEqual(union["components"], old["components"], "nginx is the new model's")
        body = dict(union)
        digest = body.pop("model_sha256")
        self.assertEqual(digest, hashlib.sha256(plugin().canonical_json(body).encode("utf-8")).hexdigest())
        self.assertNotIn(digest, (old["model_sha256"], new["model_sha256"]))
        # the inputs are not modified, and a class does not leak into another class
        self.assertEqual(old, agave_validator())
        self.assertEqual(plugin().slv_listen_model_union(new, new)["udp"], new["udp"])
        next_door = derive(
            [
                args_item(
                    replaced(fixture("mainnet-validator.agave-4.3.0.start-validator.sh"), "8900-8930", "8930-8960"),
                    literal=True,
                )
            ]
        )
        self.assertEqual(plugin().slv_listen_model_union(old, next_door)["udp"]["public"], [[8900, 8959]])
        tampered = copy.deepcopy(old)
        tampered["udp"]["public"] = P((1, 65535))
        self.assertStops("invalid_input", tampered, new, func=plugin().slv_listen_model_union)
        self.assertStops("invalid_input", {"schema": "other"}, new, func=plugin().slv_listen_model_union)

    def test_b26_rpc_port_collides_only_with_the_gossip_ip_echo_port(self):
        base = fixture("mainnet-validator.agave-4.3.0.start-validator.sh")

        def start(rng="8900-8930", rpc="7211", gossip=None):
            """The mainnet validator render with another range, RPC port and, if given, a pinned gossip port."""
            text = replaced(base, "--dynamic-port-range 8900-8930", "--dynamic-port-range %s" % rng)
            text = replaced(text, "--rpc-port 7211", "--rpc-port %s" % rpc)
            if gossip is not None:
                text = replaced(text, "--no-port-check \\\n", "--no-port-check \\\n--gossip-port %s \\\n" % gossip)
            return [args_item(text, literal=True)]

        builds = (
            # (what is special, range, rpc port, gossip port, public UDP the model must have)
            ("the agave default range holds 8899; gossip takes 8000", "8000-10000", "8899", None, P((8000, 9999))),
            ("an RPC port inside the range but not the first one", "8900-8930", "8910", None, P((8900, 8929))),
            ("RPC 8901 and pubsub 8902, neither is 8900", "8900-8930", "8901", None, P((8900, 8929))),
            ("8899 and 8900 with gossip pinned elsewhere", "8900-8930", "8899", "8001", P(8001, (8900, 8929))),
            ("a gossip port inside the range that is not an RPC port", "8900-8930", "7211", "8905", P((8900, 8929))),
        )
        for name, rng, rpc, gossip, public in builds:
            with self.subTest(name):
                model = derive(start(rng, rpc, gossip))
                self.assertEqual(model["udp"]["public"], public)
                self.assertEqual(model["tcp"]["mgmt"], P((int(rpc), int(rpc) + 1)))
        with self.subTest("no --dynamic-port-range at all is the same range"):
            no_flag = replaced(start("8000-10000", "8899")[0]["text"], "--dynamic-port-range 8000-10000 \\\n", "")
            model = derive([args_item(no_flag, literal=True)])
            self.assertEqual(model["udp"]["public"], P((8000, 9999)))
            self.assertEqual(model["tcp"]["mgmt"], P((8899, 8900)))
        stops = (
            ("8899 with the range 8900-8930: gossip takes 8900, the pubsub port", "8900-8930", "8899", None),
            ("the RPC port is the first port of the range", "8900-8930", "8900", None),
            ("--gossip-port 8899 and --rpc-port 8899, outside the range", "8900-8930", "8899", "8899"),
            ("the pinned gossip port is the pubsub port", "8900-8930", "8898", "8899"),
            ("the pinned gossip port is inside the range and is the RPC port", "8900-8930", "8905", "8905"),
        )
        for name, rng, rpc, gossip in stops:
            with self.subTest(name):
                exc = self.assertStopsDerive("rpc_port_in_range", start(rng, rpc, gossip))
                self.assertIn(str(int(gossip or 8900)), exc.detail)
        with self.subTest("Frankendancer pins [gossip].port, so its RPC range overlap never stops"):
            model = derive(
                [toml_item("mainnet-validator.firedancer-config.toml")], profile("firedancer-jito", "0.1204.40300")
            )
            self.assertEqual(model["tcp"]["mgmt"], P((8899, 8900), 6001))

    def test_b27_old_faithful_is_a_listener_only_where_init_installs_it(self):
        render = [args_item("testnet-rpc.index-rpc.start-validator.sh")]
        for network in ("testnet", "devnet"):
            # the model reads the network from the profile; the render is the testnet one for both
            prof = profile("agave", "4.0.0-beta.2", "rpc", network, "Index RPC")
            with self.subTest("%s: Index RPC derives without an of1-listen item" % network):
                model = derive(render, prof)
                self.assertEqual(model["tcp"]["consumer"], P((7211, 7212)))
                self.assertEqual(model["tcp"]["public"], [])
            with self.subTest("%s: an of1-listen item is refused" % network):
                self.assertStopsDerive("invalid_input", render + [of1_item()], prof)
        with self.subTest("mainnet: Index RPC still needs the item"):
            index = [args_item("mainnet-rpc.index-rpc.start-validator.sh")]
            self.assertStopsDerive("rendered_missing", index, rpc_profile("Index RPC"))
            model = derive(index + [of1_item()], rpc_profile("Index RPC"))
            self.assertEqual(model["tcp"]["consumer"], P((7211, 7212), 8888))

    # A port is in one class only: the table opens a port to the sources of each class that
    # holds it, and the model does not say which class the node means, so the model stops
    # with class_overlap (b28 to b35).  b28 to b30 are ranges and components that grow over a
    # public port; b31 and b32 are the SSH ports and the consumer ports; b33 is every pair of
    # the port sets of the model, b34 the DHCP client ports of the host and b35 the union of the
    # applied model and the new one.

    def test_b28_a_range_over_an_allowlist_port_stops(self):
        relay = inputs(components=[{"id": "shred-relay", "sources": ["203.0.113.0/24"]}])
        with self.subTest("the range 8000-30000 holds 20001, which only shred-relay's sources may reach"):
            exc = self.assertStopsDerive("class_overlap", validator_with_range("8000-30000"), inp=relay)
            for text in ("udp port 20001 ", "udp.allowlist (shred-relay)", "udp.public (8000-29999)"):
                self.assertIn(text, exc.detail)
        # the high end of --dynamic-port-range is not part of the range
        with self.subTest("a range that ends at 20001 stops short of it"):
            model = derive(validator_with_range("8000-20001"), inp=relay)
            self.assertEqual(model["udp"]["public"], P((8000, 20000)))
            self.assertEqual(model["udp"]["allowlist"][0]["ports"], [[20001, 20001]])
        with self.subTest("a range that ends at 20002 holds it"):
            self.assertStopsDerive("class_overlap", validator_with_range("8000-20002"), inp=relay)
        with self.subTest("the same range without the component is a table"):
            model = derive(validator_with_range("8000-30000"))
            self.assertEqual(model["udp"]["public"], P((8000, 29999)))
            self.assertEqual(model["udp"]["allowlist"], [])

    def test_b29_a_range_over_a_local_only_udp_port_stops(self):
        gateway = inputs(components=["rpc-gateway"])
        with self.subTest("rpc-gateway keeps UDP 20000 on the host and the range 8000-30000 holds it"):
            exc = self.assertStopsDerive("class_overlap", validator_with_range("8000-30000"), inp=gateway)
            for text in ("udp port 20000 ", "local_only.udp", "udp.public (8000-29999)"):
                self.assertIn(text, exc.detail)
        with self.subTest("a range that ends at 20000 stops short of it"):
            model = derive(validator_with_range("8000-20000"), inp=gateway)
            self.assertEqual(model["udp"]["public"], P((8000, 19999)))
            self.assertEqual(model["local_only"]["udp"], P(20000))
        with self.subTest("a range that ends at 20001 holds it"):
            self.assertStopsDerive("class_overlap", validator_with_range("8000-20001"), inp=gateway)
        # richat's QUIC endpoint (10101) is listed as local only whatever address it is bound to
        geyser = rpc_profile("Geyser gRPC")

        with self.subTest("a range that holds richat's QUIC port"):
            exc = self.assertStopsDerive("class_overlap", richat_node("8000-10200"), geyser)
            self.assertIn("udp port 10101 is in local_only.udp and in udp.public (8000-10199)", exc.detail)
        with self.subTest("a range that ends at it does not"):
            model = derive(richat_node("8000-10101"), geyser)
            self.assertEqual(model["udp"]["public"], P((8000, 10100)))
            self.assertEqual(model["local_only"]["udp"], P(10101))
        with self.subTest("a local-only port on the public WireGuard port"):
            wireguard = inputs(components=["wireguard"])
            self.assertStopsDerive("class_overlap", richat_node("8000-8030", "127.0.0.1:51820"), geyser, wireguard)
            model = derive(richat_node("8000-8030"), geyser, wireguard)
            self.assertEqual(model["udp"]["pub"], P(51820))
            self.assertEqual(model["local_only"]["udp"], P(10101))

    def test_b30_a_public_tcp_port_in_a_limited_class_stops(self):
        # tcp.public holds a pinned gossip port when ip_echo_public is true, and nginx's 80 and 443
        base = fixture("mainnet-validator.agave-4.3.0.start-validator.sh")

        def start(gossip=None, rpc="7211"):
            text = replaced(base, "--rpc-port 7211", "--rpc-port %s" % rpc)
            if gossip is not None:
                text = replaced(text, "--no-port-check \\\n", "--no-port-check \\\n--gossip-port %s \\\n" % gossip)
            return [args_item(text, literal=True)]

        relay = {"id": "shred-relay", "sources": ["203.0.113.0/24"]}
        stops = (
            # (class of the limited port, gossip port, RPC port, components, what the model says)
            ("local_only.tcp", "19999", "7211", [relay], "tcp port 19999 is in local_only.tcp and in tcp.public (19999)"),
            ("tcp.consumer", "8889", "7211", ["rpc-gateway"], "tcp port 8889 is in tcp.consumer and in tcp.public (8889)"),
            ("tcp.metrics", "9100", "7211", [], "tcp port 9100 is in tcp.metrics and in tcp.public (9100)"),
            ("tcp.wg_only", "20026", "7211", ["wireguard", "gateway"], "tcp port 20026 is in tcp.wg_only"),
            ("tcp.mgmt", None, "443", ["nginx"], "tcp port 443 is in tcp.mgmt and in tcp.public (80, 443)"),
            ("tcp.mgmt, the pubsub port", None, "79", ["nginx"], "tcp port 80 is in tcp.mgmt and in tcp.public (80, 443)"),
        )
        for klass, gossip, rpc, components, says in stops:
            with self.subTest(klass):
                exc = self.assertStopsDerive(
                    "class_overlap",
                    start(gossip, rpc),
                    inp=inputs(components=components, ip_echo_public=gossip is not None),
                )
                self.assertIn(says, exc.detail)
        with self.subTest("RPC and pubsub ports next to nginx's ports are a table"):
            for rpc in ("441", "444"):
                model = derive(start(None, rpc), inp=inputs(components=["nginx"]))
                self.assertEqual(model["tcp"]["public"], P(80, 443))
                self.assertEqual(model["tcp"]["mgmt"], P((int(rpc), int(rpc) + 1)))
        with self.subTest("a gossip port that no limited class holds is a table"):
            model = derive(start("8001"), inp=inputs(components=[relay], ip_echo_public=True))
            self.assertEqual(model["tcp"]["public"], P(8001))
            self.assertEqual(model["local_only"]["tcp"], P(19999))

    def test_b31_an_ssh_port_in_another_class_stops(self):
        base = fixture("mainnet-validator.agave-4.3.0.start-validator.sh")

        def start(gossip=None):
            text = base
            if gossip is not None:
                text = replaced(text, "--no-port-check \\\n", "--no-port-check \\\n--gossip-port %s \\\n" % gossip)
            return [args_item(text, literal=True)]

        ssh_443 = host_facts(sshd_ports=[443], sshd_listen_ports=[443])
        ssh_2222 = host_facts(sshd_ports=[2222], sshd_listen_ports=[2222])
        with self.subTest("sshd on 443 and nginx on 443"):
            exc = self.assertStopsDerive(
                "class_overlap", start(), inp=inputs(components=["nginx"]), facts=ssh_443
            )
            self.assertIn("tcp port 443 is in tcp.ssh and in tcp.public (80, 443)", exc.detail)
        with self.subTest("the same when SSH is open to everybody with a rate limit"):
            # the public accept comes before the rate limit, so the limit would not apply
            self.assertStopsDerive(
                "class_overlap",
                start(),
                inp=inputs(components=["nginx"], ssh_mode="public-rate-limited"),
                facts=ssh_443,
            )
        with self.subTest("sshd on the ip-echo port that ip_echo_public opens"):
            exc = self.assertStopsDerive(
                "class_overlap", start(2222), inp=inputs(ip_echo_public=True), facts=ssh_2222
            )
            self.assertIn("tcp port 2222 is in tcp.ssh and in tcp.public (2222)", exc.detail)
        with self.subTest("the ip-echo port is a table when it is not an SSH port"):
            model = derive(start(2223), inp=inputs(ip_echo_public=True), facts=ssh_2222)
            self.assertEqual(model["tcp"]["public"], P(2223))
            self.assertEqual(model["tcp"]["ssh"], P(22, 2222))
        with self.subTest("sshd on 443 without nginx is a table"):
            self.assertEqual(derive(start(), facts=ssh_443)["tcp"]["ssh"], P(22, 443))

    def test_b32_a_consumer_port_on_an_ssh_or_metrics_port_stops(self):
        geyser = rpc_profile("Geyser gRPC")
        start = fixture("mainnet-rpc.geyser-grpc.start-validator.sh")

        def node(rpc):
            text = replaced(start, "--rpc-port 7211", "--rpc-port %s" % rpc)
            return [args_item(text, literal=True), richat_item()]

        # --rpc-port N also opens N + 1 (the pubsub port)
        for public_rpc in (True, False):
            with self.subTest("public_rpc=%s: the RPC and pubsub ports are 21 and 22, and 22 is SSH" % public_rpc):
                exc = self.assertStopsDerive("class_overlap", node(21), geyser, inputs(public_rpc=public_rpc))
                self.assertIn("tcp port 22 is in tcp.ssh and in tcp.consumer (21-22, ", exc.detail)
            with self.subTest("public_rpc=%s: the RPC and pubsub ports are 9099 and 9100, and 9100 is metrics" % public_rpc):
                exc = self.assertStopsDerive("class_overlap", node(9099), geyser, inputs(public_rpc=public_rpc))
                self.assertIn("tcp port 9100 is in tcp.metrics and in tcp.consumer (", exc.detail)
        with self.subTest("public_rpc with ports that no other class holds is a table"):
            model = derive(node(7211), geyser, inputs(public_rpc=True))
            self.assertTrue(model["consumer_public"])
            self.assertEqual(model["tcp"]["consumer"], P(7111, (7211, 7212), 10000))

    def test_b33_a_port_in_two_classes_stops_for_every_pair_of_classes(self):
        # A model is built by hand, because the derivation cannot put a port into some of these
        # pairs.  The classes are the port sets of the model: the ones the table has a rule for
        # and local_only, which it has none for.
        base = blank_model()
        self.assertEqual(
            sorted(base["udp"]), sorted(["public", "xdp", "xdp_rx_bypass", "xdp_bind_address", "pub", "allowlist"])
        )
        self.assertEqual(sorted(base["tcp"]), sorted(["public", "consumer", "mgmt", "metrics", "ssh", "wg_only"]))
        self.assertEqual(sorted(base["local_only"]), ["tcp", "udp"])
        classes = port_setters()
        check = plugin()._refuse_class_overlap
        pairs = 0
        for i, (proto, name, put) in enumerate(classes):
            with self.subTest("%s alone is fine" % name):
                model = blank_model()
                put(model, [[4000, 4005]])
                self.assertIsNone(check(model))
            for other_proto, other_name, other_put in classes[i + 1 :]:
                if proto != other_proto:
                    with self.subTest("%s and %s hold the same number, as two different ports" % (name, other_name)):
                        model = blank_model()
                        put(model, [[4000, 4005]])
                        other_put(model, [[4003, 4009]])
                        self.assertIsNone(check(model))
                    continue
                pairs += 1
                model = blank_model()
                put(model, [[4000, 4005]])
                other_put(model, [[4003, 4009]])
                if (name, other_name) == ("udp.public", "udp.xdp"):
                    with self.subTest("%s inside %s is meant to overlap" % (other_name, name)):
                        self.assertIsNone(check(model))
                    continue
                with self.subTest("%s and %s" % (name, other_name)):
                    exc = self.assertStops("class_overlap", model, func=check)
                    self.assertIn("%s port 4003-4005 is in " % proto, exc.detail)
                with self.subTest("%s and %s next to each other are fine" % (name, other_name)):
                    model = blank_model()
                    put(model, [[4000, 4005]])
                    other_put(model, [[4006, 4009]])
                    self.assertIsNone(check(model))
        self.assertEqual(pairs, 15 + 28)  # the 6 UDP classes and the 8 TCP classes, every pair of each
        with self.subTest("a component's interface rule through the derivation"):
            # libvirt answers TCP 53 on virbr*; a validator RPC port of 53 also opens 54
            text = replaced(fixture("mainnet-validator.agave-4.3.0.start-validator.sh"), "--rpc-port 7211", "--rpc-port 53")
            exc = self.assertStopsDerive(
                "class_overlap", [args_item(text, literal=True)], inp=inputs(components=["libvirt"])
            )
            self.assertIn("tcp port 53 is in libvirt rule for virbr* and in tcp.mgmt (53-54)", exc.detail)

    def test_b34_the_dhcp_client_ports_of_the_host_are_classes_where_the_table_has_the_rules(self):
        # On the interfaces that the host names, the table accepts a packet on udp 68 (DHCPv4, from
        # source port 67) and on udp 546 (DHCPv6, from source port 547 and a link-local address).
        # The rules are stricter than the ports, but each port is a class of the model for as long as
        # dhcp4_ifaces or dhcp6_ifaces names an interface (null stands for every interface but lo).
        geyser = rpc_profile("Geyser gRPC")
        check = plugin()._refuse_class_overlap
        cases = (
            # (name, port, host fact, a dynamic port range over the port, the ports of udp.public, the other fact)
            ("DHCPv4", 68, "dhcp4_ifaces", "50-100", "50-99", "dhcp6_ifaces"),
            ("DHCPv6", 546, "dhcp6_ifaces", "520-570", "520-569", "dhcp4_ifaces"),
        )
        for name, port, key, rng, public, other_key in cases:
            rule = "host %s client rule" % name
            with self.subTest("%s: a local-only port on %d" % (name, port)):
                exc = self.assertStopsDerive(
                    "class_overlap", richat_node(quic="127.0.0.1:%d" % port), geyser, facts=host_facts(**{key: ["eno1"]})
                )
                self.assertIn("udp port %d is in local_only.udp and in %s (%d)" % (port, rule, port), exc.detail)
            with self.subTest("%s: a dynamic port range over %d" % (name, port)):
                exc = self.assertStopsDerive(
                    "class_overlap", richat_node(rng), geyser, facts=host_facts(**{key: ["eno1"]})
                )
                self.assertIn("udp port %d is in %s and in udp.public (%s)" % (port, rule, public), exc.detail)
            with self.subTest("%s: interfaces that the host could not tell count as named" % name):
                self.assertStopsDerive(
                    "class_overlap", richat_node(quic="127.0.0.1:%d" % port), geyser, facts=host_facts(**{key: None})
                )
            with self.subTest("%s: a host without those interfaces is unaffected" % name):
                model = derive(richat_node(quic="127.0.0.1:%d" % port), geyser, facts=host_facts())
                self.assertEqual(model["local_only"]["udp"], P(port))
                model = derive(richat_node(rng), geyser, facts=host_facts(**{other_key: ["eno1"]}))
                self.assertEqual(model["udp"]["public"], P((int(rng.split("-")[0]), int(rng.split("-")[1]) - 1)))
            # every other set of UDP ports, on a model built by hand
            for proto, other, put in port_setters():
                if proto != "udp":
                    continue
                with self.subTest("%s and %s" % (rule, other)):
                    model = blank_model()
                    put(model, [[port - 8, port + 8]])
                    model["host"][key] = ["eno1"]
                    exc = self.assertStops("class_overlap", model, func=check)
                    self.assertIn("udp port %d is in " % port, exc.detail)
                    self.assertIn(rule, exc.detail)
                with self.subTest("%s and %s next to each other are fine" % (rule, other)):
                    model = blank_model()
                    put(model, [[port + 1, port + 8]])
                    model["host"][key] = ["eno1"]
                    self.assertIsNone(check(model))
                with self.subTest("%s and %s with no such interface are fine" % (rule, other)):
                    model = blank_model()
                    put(model, [[port - 8, port + 8]])
                    self.assertIsNone(check(model))


    def test_b35_the_union_stops_when_a_port_changes_class_between_the_two_models(self):
        two_steps = "Apply the change in two steps: first a configuration without that port, then the new configuration."
        relay = inputs(components=[{"id": "shred-relay", "sources": ["203.0.113.0/24"]}])
        start = fixture("mainnet-validator.agave-4.3.0.start-validator.sh")

        def gossip(port):
            return [args_item(replaced(start, "--no-port-check \\\n", "--no-port-check \\\n--gossip-port %d \\\n" % port), literal=True)]

        def rpc(port):
            return [args_item(replaced(start, "--rpc-port 7211", "--rpc-port %d" % port), literal=True)]

        cases = (
            # (what changes, applied model, new model, what the detail says)
            (
                "UDP 20001 leaves the dynamic range and becomes shred-relay's allowlist",
                derive(validator_with_range("8000-30000")),
                derive(validator_with_range("8900-8930"), inp=relay),
                "udp port 20001 is in udp.allowlist (shred-relay) of the new model and in udp.public of the applied model",
            ),
            (
                "UDP 20000 leaves the dynamic range and becomes rpc-gateway's local port",
                derive(validator_with_range("8000-30000")),
                derive(validator_with_range("8900-8930"), inp=inputs(components=["rpc-gateway"])),
                "udp port 20000 is in local_only.udp of the new model and in udp.public of the applied model",
            ),
            (
                "TCP 8001 stops being the public ip-echo port and becomes the RPC port",
                derive(gossip(8001), inp=inputs(ip_echo_public=True)),
                derive(rpc(8001)),
                "tcp port 8001 is in tcp.mgmt of the new model and in tcp.public of the applied model",
            ),
            (
                "TCP 8001 stops being the RPC port and becomes the public ip-echo port",
                derive(rpc(8001)),
                derive(gossip(8001), inp=inputs(ip_echo_public=True)),
                "tcp port 8001 is in tcp.mgmt of the applied model and in tcp.public of the new model",
            ),
        )
        for what, applied, new, says in cases:
            with self.subTest(what):
                # each model is a table of its own
                self.assertEqual(plugin().slv_listen_model_union(applied, applied)["udp"], applied["udp"])
                exc = self.assertStops("class_overlap", applied, new, func=plugin().slv_listen_model_union)
                self.assertIn(says, exc.detail)
                self.assertIn(two_steps, exc.detail)
        with self.subTest("a port that stays in its class is a union (b25)"):
            moved = derive(validator_with_range("8930-8960"))
            self.assertEqual(
                plugin().slv_listen_model_union(derive(validator_with_range("8900-8930")), moved)["udp"]["public"],
                [[8900, 8959]],
            )
        with self.subTest("an applied model that holds a port in two classes itself says so"):
            applied = copy.deepcopy(agave_validator())
            applied["tcp"]["public"] = P(22)  # 22 is an SSH port
            applied = plugin()._seal(applied)
            exc = self.assertStops("class_overlap", applied, agave_validator(), func=plugin().slv_listen_model_union)
            self.assertIn("the applied model itself holds tcp port 22 in tcp.ssh and in tcp.public", exc.detail)

    def test_b36_an_address_list_that_covers_every_address_stops_like_a_single_slash_0(self):
        # the pieces collapse to the whole address space (admin_ips, lb_ips, metrics_ips, deny_ips and the
        # sources of a component are parsed by the same function)
        covering = (
            ("two IPv4 halves", ["0.0.0.0/1", "128.0.0.0/1"], "0.0.0.0/0"),
            ("two IPv6 halves", ["::/1", "8000::/1"], "::/0"),
            ("four IPv4 quarters", ["0.0.0.0/2", "64.0.0.0/2", "128.0.0.0/2", "192.0.0.0/2"], "0.0.0.0/0"),
            ("a half and two quarters", ["0.0.0.0/1", "128.0.0.0/2", "192.0.0.0/2"], "0.0.0.0/0"),
        )
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        lists = (
            ("admin_ips", lambda nets: inputs(admin_ips=nets)),
            ("lb_ips", lambda nets: inputs(lb_ips=nets)),
            ("metrics_ips", lambda nets: inputs(metrics_ips=nets)),
            ("deny_ips", lambda nets: inputs(deny_ips=nets)),
            (
                "components[shred-relay].sources",
                lambda nets: inputs(components=[{"id": "shred-relay", "sources": nets}]),
            ),
        )
        for what, nets, whole in covering:
            for name, make in lists:
                with self.subTest("%s in %s" % (what, name)):
                    exc = self.assertStopsDerive("allowlist_has_any", rendered, inp=make(nets))
                    self.assertIn("%s together cover %s" % (name, whole), exc.detail)
        with self.subTest("a single /0 still stops"):
            self.assertStopsDerive("allowlist_has_any", rendered, inp=inputs(admin_ips=["0.0.0.0/0"]))
        with self.subTest("a list that does not cover every address is a list"):
            for nets in (["0.0.0.0/1"], ["0.0.0.0/1", "128.0.0.0/2"], ["0.0.0.0/1", "::/1"], ["0.0.0.0/1", "0.0.0.0/2"]):
                model = derive(rendered, inp=inputs(admin_ips=nets + [ADMIN], controller_ip=ADMIN))
                self.assertTrue(model["sources"]["mgmt"]["v4"] or model["sources"]["mgmt"]["v6"])

    def test_b37_undetermined_dhcp_and_ra_interfaces_leave_out_the_bridges_without_a_default_route(self):
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        ifaces = ["lo", "eno1", "eno2", "docker0", "virbr0", "virbr1", "br-1", "br-lan"]

        def host(**over):
            facts = dict(
                ifaces=ifaces,
                bridges=["br-1", "br-lan"],
                default_route_ifaces=["eno1"],
                dhcp4_ifaces=None,
                dhcp6_ifaces=None,
                ra_ifaces=None,
            )
            facts.update(over)
            return derive(rendered, facts=host_facts(**facts))["host"]

        with self.subTest("docker0 and virbr* by name, the other bridges by host_facts.bridges"):
            section = host()
            self.assertEqual((section["dhcp4_ifaces"], section["dhcp6_ifaces"], section["ra_ifaces"]), (["eno1", "eno2"],) * 3)
            self.assertTrue(section["dhcp_undetermined"] and section["ra_undetermined"])
        with self.subTest("a bridge that carries the default route stays"):
            self.assertEqual(host(default_route_ifaces=["br-lan"])["dhcp4_ifaces"], ["br-lan", "eno1", "eno2"])
            self.assertEqual(host(default_route_ifaces=["docker0"])["ra_ifaces"], ["docker0", "eno1", "eno2"])
        with self.subTest("a list that the host determined is taken as it is"):
            section = host(dhcp4_ifaces=["docker0"], dhcp6_ifaces=[], ra_ifaces=["virbr0", "eno1"])
            self.assertEqual((section["dhcp4_ifaces"], section["dhcp6_ifaces"], section["ra_ifaces"]), (["docker0"], [], ["eno1", "virbr0"]))
        with self.subTest("the DHCP class of the overlap rule follows the interfaces that are left"):
            # richat's QUIC port on 68 meets the DHCPv4 rule that the table then has on eno1 and eno2
            geyser = rpc_profile("Geyser gRPC")
            facts = host_facts(ifaces=ifaces, bridges=["br-1", "br-lan"], dhcp4_ifaces=None)
            self.assertStopsDerive("class_overlap", richat_node(quic="127.0.0.1:68"), geyser, facts=facts)
            # and the same port is free on a host whose DHCP interfaces are all determined to be none
            model = derive(richat_node(quic="127.0.0.1:68"), geyser, facts=host_facts(ifaces=ifaces, dhcp4_ifaces=[]))
            self.assertEqual(model["local_only"]["udp"], P(68))
        with self.subTest("nothing is left to cover"):
            exc = self.assertStopsDerive(
                "invalid_input", rendered, facts=host_facts(ifaces=["lo", "docker0", "virbr0"], dhcp4_ifaces=None)
            )
            self.assertIn("besides lo and the bridges without a default route", exc.detail)

    def test_b38_the_header_of_an_nft_file_takes_a_timestamp_and_an_address_and_nothing_else(self):
        meta = plugin().slv_listen_model_meta
        with self.subTest("what the header takes"):
            self.assertEqual(
                meta({"generated_at": "2026-01-01T00:00:00Z", "controller_ip": "198.51.100.7"}),
                {"generated_at": "2026-01-01T00:00:00Z", "controller_ip": "198.51.100.7"},
            )
            self.assertEqual(
                meta({"generated_at": "2026-12-31T23:59:59.123456Z", "controller_ip": "2001:DB8::7"}),
                {"generated_at": "2026-12-31T23:59:59.123456Z", "controller_ip": "2001:db8::7"},
            )
            self.assertEqual(meta({"generated_at": "2026-01-01T00:00:00+00:00"})["controller_ip"], "")
            self.assertEqual(meta({"generated_at": "2026-01-01T00:00:00Z", "controller_ip": ""})["controller_ip"], "")
            self.assertEqual(meta({"generated_at": "2026-01-01T00:00:00Z", "controller_ip": None})["controller_ip"], "")
        stamp = "2026-01-01T00:00:00Z"
        controls = (
            ("a newline in the address ends the comment", {"generated_at": stamp, "controller_ip": "198.51.100.7\n# table inet evil"}),
            ("a newline after the timestamp", {"generated_at": stamp + "\n"}),
            ("a carriage return", {"generated_at": stamp, "controller_ip": "198.51.100.7\r"}),
            ("a line separator", {"generated_at": stamp, "controller_ip": "198.51.100.7\u2028"}),
            ("an escape", {"generated_at": "\x1b[2J" + stamp}),
            ("a NUL", {"generated_at": stamp, "controller_ip": "198.51.100.7\x00"}),
            ("a right-to-left override", {"generated_at": stamp, "controller_ip": "198.51.100.7\u202e"}),
        )
        for what, bad in controls:
            with self.subTest(what):
                exc = self.assertStops("invalid_meta", bad, func=meta)
                self.assertIn("control character", exc.detail)
                self.assertNotIn("\n", exc.detail)
                self.assertNotIn("\x1b", exc.detail)
        hostile = (
            ("a date that does not exist", {"generated_at": "2026-02-30T00:00:00Z"}),
            ("a time that does not exist", {"generated_at": "2026-01-01T24:00:00Z"}),
            ("a space instead of the T", {"generated_at": "2026-01-01 00:00:00Z"}),
            ("no zone", {"generated_at": "2026-01-01T00:00:00"}),
            ("a zone that is not UTC", {"generated_at": "2026-01-01T09:00:00+09:00"}),
            ("a word", {"generated_at": "yesterday"}),
            ("no timestamp", {"controller_ip": "198.51.100.7"}),
            ("a number", {"generated_at": 20260101}),
            ("a name instead of an address", {"generated_at": stamp, "controller_ip": "controller.example"}),
            ("an address with a space", {"generated_at": stamp, "controller_ip": " 198.51.100.7"}),
            ("an address with a scope", {"generated_at": stamp, "controller_ip": "fe80::1%eno1"}),
            ("a network", {"generated_at": stamp, "controller_ip": "198.51.100.0/24"}),
            ("a key that is not written", {"generated_at": stamp, "host": "node"}),
            ("a list", ["generated_at"]),
        )
        for what, bad in hostile:
            with self.subTest(what):
                exc = self.assertStops("invalid_meta", bad, func=meta)
                self.assertNotIn("\n", exc.detail)
                self.assertNotIn("\x1b", exc.detail)

    def test_b39_the_union_does_not_give_a_port_that_only_the_applied_model_has_more_sources(self):
        union_of = plugin().slv_listen_model_union
        validator = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        index = [args_item("mainnet-rpc.index-rpc.start-validator.sh"), of1_item()]
        index_node = rpc_profile("Index RPC")
        two_steps = (
            "Apply the change in two steps: first a configuration without that port (with the old sources), "
            "then the new configuration."
        )

        def rpc_port(port):
            text = replaced(
                fixture("mainnet-validator.agave-4.3.0.start-validator.sh"), "--rpc-port 7211", "--rpc-port %d" % port
            )
            return [args_item(text, literal=True)]

        def refused(applied, new, klass, ports, field):
            exc = self.assertStops("union_widens_reach", applied, new, func=union_of)
            self.assertIn("%s port %s is only in %s of the applied model" % (klass.split(".")[0], ports, klass), exc.detail)
            self.assertIn(field, exc.detail)
            self.assertIn(two_steps, exc.detail)

        def edited(model, *edits):
            model = copy.deepcopy(model)
            for edit in edits:
                edit(model)
            return plugin()._seal(model)

        # What is refused, on real renders (b25 has the union of two models with the same sources).
        with self.subTest("(a) public_rpc is turned on, and a consumer port is only in the applied model"):
            applied = derive(index, index_node, inputs(lb_ips=["192.0.2.10"], components=["rpc-gateway"]))
            new = derive(index, index_node, inputs(lb_ips=["192.0.2.10"], public_rpc=True))
            self.assertEqual((applied["consumer_public"], new["consumer_public"]), (False, True))
            refused(applied, new, "tcp.consumer", "8889", "consumer_public is true in the new model and false in the applied one")
        with self.subTest("(b) ssh_mode becomes public-rate-limited, and an SSH port is only in the applied model"):
            applied = derive(validator, facts=host_facts(sshd_ports=[22, 2222], sshd_listen_ports=[22, 2222]))
            new = derive(validator, inp=inputs(ssh_mode="public-rate-limited"))
            refused(applied, new, "tcp.ssh", "2222", "ssh.public is true in the new model and false in the applied one")
        with self.subTest("(c) admin_ips gains a network, and a mgmt port is only in the applied model"):
            new = derive(rpc_port(7300), inp=inputs(admin_ips=["203.0.113.0/28"], controller_ip="203.0.113.9"))
            refused(agave_validator(), new, "tcp.mgmt", "7211-7212", "sources.mgmt gained 203.0.113.0/28")
        with self.subTest("(d) lb_ips gains an address, and a consumer port is only in the applied model"):
            applied = derive(index, index_node, inputs(lb_ips=["192.0.2.10"], components=["rpc-gateway"]))
            new = derive(index, index_node, inputs(lb_ips=["192.0.2.10", "192.0.2.20"]))
            refused(applied, new, "tcp.consumer", "8889", "sources.lb gained 192.0.2.20/32")
        with self.subTest("(e) metrics_ips gains an address, and a metrics port is only in the applied model"):
            data = richat_data()
            data["metrics"]["endpoint"] = "0.0.0.0:10125"
            geyser = rpc_profile("Geyser gRPC")
            applied = derive(geyser_rendered(), geyser, inputs(metrics_ips=["192.0.2.50"]))
            moved = [args_item("mainnet-rpc.geyser-grpc.start-validator.sh"), richat_item(data)]
            new = derive(moved, geyser, inputs(metrics_ips=["192.0.2.50", "192.0.2.60"]))
            refused(applied, new, "tcp.metrics", "10124", "sources.scrape gained 192.0.2.60/32")
        with self.subTest("(f) deny_ips loses an entry, and a udp.public port is only in the applied model"):
            applied = derive(validator, inp=inputs(deny_ips=["192.0.2.0/24"]))
            new = derive(validator_with_range("8000-8030"))
            refused(applied, new, "udp.public", "8900-8929", "sources.deny lost 192.0.2.0/24")
        with self.subTest("(g) trusted_ifaces gains an interface, and a mgmt port is only in the applied model"):
            new = derive(rpc_port(7300), inp=inputs(trusted_ifaces=["br-int"]))
            refused(agave_validator(), new, "tcp.mgmt", "7211-7212", "trusted_ifaces gained br-int")
        with self.subTest("(h) the WireGuard tunnel is enabled, and a wg_only port is only in the applied model"):
            applied = derive(validator, inp=inputs(components=["gateway"]))
            new = derive(validator, inp=inputs(components=["wireguard"]))
            refused(applied, new, "tcp.wg_only", "20026", "wireguard is enabled in the new model and not in the applied one")
        with self.subTest("(h) the WireGuard tunnel is enabled, and a mgmt port is only in the applied model"):
            new = derive(rpc_port(7300), inp=inputs(components=["wireguard"]))
            refused(agave_validator(), new, "tcp.mgmt", "7211-7212", "wireguard is enabled in the new model and not in the applied one")
        with self.subTest("(h) the subnet of the tunnel is widened, and a wg_only port is only in the applied model"):
            applied = derive(validator, inp=inputs(components=["wireguard", "gateway"]))
            new = edited(
                derive(validator, inp=inputs(components=["wireguard"])),
                lambda m: m["wireguard"].update(subnet="10.0.0.0/16"),
            )
            refused(applied, new, "tcp.wg_only", "20026", "wireguard.subnet 10.0.0.0/16 is not within 10.0.0.0/24")

        # What is allowed.
        with self.subTest("the same sources and a moved port (b25)"):
            union = union_of(agave_validator(), derive(rpc_port(7300)))
            self.assertEqual(union["tcp"]["mgmt"], P((7211, 7212), (7300, 7301)))
        with self.subTest("admin_ips loses an entry, and a mgmt port is only in the applied model"):
            applied = derive(validator, inp=inputs(admin_ips=["198.51.100.0/28"]))
            new = derive(rpc_port(7300))
            union = union_of(applied, new)
            self.assertEqual(union["tcp"]["mgmt"], P((7211, 7212), (7300, 7301)))
            self.assertEqual(union["sources"]["mgmt"], new["sources"]["mgmt"])
        with self.subTest("deny_ips gains an entry, and a udp.public port is only in the applied model"):
            new = derive(validator_with_range("8000-8030"), inp=inputs(deny_ips=["192.0.2.0/24"]))
            union = union_of(derive(validator), new)
            self.assertEqual(union["udp"]["public"], P((8000, 8029), (8900, 8929)))
            self.assertEqual(union["sources"]["deny"], new["sources"]["deny"])
        with self.subTest("the reach is wider and no port is only in the applied model"):
            applied = derive(index, index_node, inputs(lb_ips=["192.0.2.10"], components=["rpc-gateway"]))
            new = derive(
                index,
                index_node,
                inputs(
                    lb_ips=["192.0.2.10", "192.0.2.20"],
                    components=["rpc-gateway"],
                    public_rpc=True,
                    admin_ips=["198.51.100.0/24"],
                    ssh_mode="public-rate-limited",
                    trusted_ifaces=["br-int"],
                    metrics_ips=["192.0.2.50"],
                ),
            )
            self.assertTrue(new["consumer_public"] and new["ssh"]["public"])
            union = union_of(applied, new)
            for group, key in plugin()._UNION_FIELDS:
                self.assertEqual(union[group][key], new[group][key], "%s.%s" % (group, key))
            self.assertEqual(union["tcp"]["consumer"], P((7211, 7212), (8888, 8889)))

        # The comparison itself, on models that hold one port, 5555, in the class under test.
        setters = {name: put for proto, name, put in port_setters()}
        mgmt_put = setters["tcp.mgmt"]
        with self.subTest("networks are compared as collapsed lists"):
            halves, whole = ["10.0.0.0/24", "10.0.1.0/24"], ["10.0.0.0/23"]
            for was, now in ((halves, whole), (whole, halves), (whole, ["10.0.0.0/25", "10.0.1.0/24"]), (halves, halves)):
                applied = edited(blank_model(), lambda m: mgmt_put(m, P(5555)), lambda m: m["sources"]["mgmt"].update(v4=was))
                new = edited(blank_model(), lambda m: m["sources"]["mgmt"].update(v4=now))
                self.assertEqual(union_of(applied, new)["tcp"]["mgmt"], P(5555), "%s -> %s" % (was, now))
            applied = edited(blank_model(), lambda m: mgmt_put(m, P(5555)), lambda m: m["sources"]["mgmt"].update(v4=halves))
            new = edited(blank_model(), lambda m: m["sources"]["mgmt"].update(v4=["10.0.0.0/22"]))
            refused(applied, new, "tcp.mgmt", "5555", "sources.mgmt gained 10.0.0.0/22")
            new = edited(blank_model(), lambda m: m["sources"]["mgmt"].update(v4=["10.0.0.0/24"], v6=["2001:db8::/32"]))
            refused(applied, new, "tcp.mgmt", "5555", "sources.mgmt gained 2001:db8::/32")
        with self.subTest("a public part that both models have is compared by the deny sources"):

            def deny(*nets):
                return lambda m: m["sources"]["deny"].update(v4=list(nets))

            both = {
                "tcp.ssh": lambda m: m["ssh"].update(public=True, rate=dict(plugin().SSH_RATE)),
                "tcp.consumer": lambda m: m.update(consumer_public=True),
            }
            for klass, make_public in both.items():
                applied = edited(blank_model(), lambda m: setters[klass](m, P(5555)), make_public, deny("192.0.2.0/24"))
                for nets in (["192.0.2.0/24"], ["192.0.2.0/24", "198.51.100.0/24"], ["192.0.2.0/23"]):
                    new = edited(blank_model(), make_public, deny(*nets))
                    self.assertEqual(union_of(applied, new)[klass.split(".")[0]][klass.split(".")[1]], P(5555), nets)
                for nets in ([], ["192.0.2.0/25"], ["198.51.100.0/24"]):
                    new = edited(blank_model(), make_public, deny(*nets))
                    refused(applied, new, klass, "5555", "sources.deny lost 192.0.2.0/24")
        with self.subTest("ssh.rate has to be the same where ssh is public in both"):
            public = lambda rate: (lambda m: m["ssh"].update(public=True, rate=rate))  # noqa: E731
            slower = dict(plugin().SSH_RATE, new_per_minute=5)
            applied = edited(blank_model(), lambda m: setters["tcp.ssh"](m, P(5555)), public(dict(plugin().SSH_RATE)))
            new = edited(blank_model(), public(slower))
            refused(applied, new, "tcp.ssh", "5555", "ssh.rate is")
        def tunnel(iface="wg0"):
            return lambda m: m["wireguard"].update(enabled=True, iface=iface, subnet="10.0.0.0/24")

        with self.subTest("the tunnel has to be the same interface"):
            applied = edited(blank_model(), lambda m: setters["tcp.wg_only"](m, P(5555)), tunnel("wg0"))
            refused(
                applied,
                edited(blank_model(), tunnel("wg1")),
                "tcp.wg_only",
                "5555",
                "wireguard.iface is wg1 in the new model and wg0 in the applied one",
            )
        with self.subTest("the rule for wg_only comes after the deny rules, so the new deny sources have to hold the old"):
            applied = derive(validator, inp=inputs(components=["wireguard", "gateway"], deny_ips=["10.0.0.0/28"]))
            refused(
                applied,
                derive(validator, inp=inputs(components=["wireguard"])),
                "tcp.wg_only",
                "20026",
                "sources.deny lost 10.0.0.0/28",
            )
            for nets in (["10.0.0.0/28"], ["10.0.0.0/24"]):
                new = derive(validator, inp=inputs(components=["wireguard"], deny_ips=nets))
                self.assertEqual(union_of(applied, new)["tcp"]["wg_only"], P(20026), nets)
            # the new model has no tunnel: the table has no rule for the port, and the deny sources do not matter
            applied = edited(
                blank_model(),
                lambda m: setters["tcp.wg_only"](m, P(5555)),
                tunnel(),
                lambda m: m["sources"]["deny"]["v4"].append("10.0.0.0/28"),
            )
            self.assertEqual(union_of(applied, edited(blank_model()))["tcp"]["wg_only"], P(5555))
        with self.subTest("the detail names the ports that the new model does not hold, and no others"):
            applied = edited(blank_model(), lambda m: mgmt_put(m, P((100, 200))))
            new = edited(
                blank_model(),
                lambda m: mgmt_put(m, P((150, 160), (190, 300))),
                lambda m: m["sources"]["mgmt"]["v4"].append("203.0.113.0/28"),
            )
            refused(applied, new, "tcp.mgmt", "100-149, 161-189", "sources.mgmt gained 203.0.113.0/28")
        with self.subTest("a v6 deny entry does not matter to the IPv4 Solana UDP ports, and matters to the others"):
            v6 = lambda m: m["sources"]["deny"].update(v6=["2001:db8:bad::/48"])  # noqa: E731
            for klass in ("udp.public", "udp.xdp"):
                applied = edited(blank_model(), lambda m: setters[klass](m, P(5555)), v6)
                self.assertEqual(union_of(applied, edited(blank_model()))["udp"][klass.split(".")[1]], P(5555), klass)
            for klass in ("udp.pub", "tcp.public"):
                applied = edited(blank_model(), lambda m: setters[klass](m, P(5555)), v6)
                refused(applied, edited(blank_model()), klass, "5555", "sources.deny lost 2001:db8:bad::/48")
        with self.subTest("local_only has no rule in the table, so it is not compared"):
            applied = edited(blank_model(), lambda m: setters["local_only.tcp"](m, P(5555)))
            new = edited(blank_model(), lambda m: m["trusted_ifaces"].append("br-int"), lambda m: m.update(consumer_public=True))
            self.assertEqual(union_of(applied, new)["local_only"]["tcp"], P(5555))
        with self.subTest("a model without its sources is invalid input"):
            applied = edited(blank_model(), lambda m: mgmt_put(m, P(5555)))
            del applied["model_sha256"], applied["sources"]["mgmt"]
            exc = self.assertStops("invalid_input", applied, edited(blank_model()), func=union_of)
            self.assertIn("sources.mgmt", exc.detail)

        # Each class is judged by the fields that its rule in the table uses, and by no others. (tcp.wg_only is
        # also judged by the IPv4 deny sources where the new model has the tunnel: that is the wg_only subtest
        # above, and this matrix turns the tunnel on in the new model only in its wireguard row.)
        changes = {
            # field: (what the applied model has, what the new model has)
            "sources.mgmt": (None, lambda m: m["sources"]["mgmt"]["v4"].append("203.0.113.0/28")),
            "trusted_ifaces": (None, lambda m: m["trusted_ifaces"].append("br-int")),
            "wireguard": (None, lambda m: m["wireguard"].update(enabled=True, iface="wg0", subnet="10.0.0.0/24")),
            "sources.lb": (None, lambda m: m["sources"]["lb"]["v4"].append("192.0.2.10/32")),
            "sources.scrape": (None, lambda m: m["sources"]["scrape"]["v4"].append("192.0.2.50/32")),
            "consumer_public": (None, lambda m: m.update(consumer_public=True)),
            "ssh.public": (None, lambda m: m["ssh"].update(public=True, rate=dict(plugin().SSH_RATE))),
            "deny v4": (lambda m: m["sources"]["deny"]["v4"].append("192.0.2.0/24"), None),
            "deny v6": (lambda m: m["sources"]["deny"]["v6"].append("2001:db8:bad::/48"), None),
        }
        says = {
            "sources.mgmt": "sources.mgmt gained 203.0.113.0/28",
            "trusted_ifaces": "trusted_ifaces gained br-int",
            "wireguard": "wireguard is enabled in the new model and not in the applied one",
            "sources.lb": "sources.lb gained 192.0.2.10/32",
            "sources.scrape": "sources.scrape gained 192.0.2.50/32",
            "consumer_public": "consumer_public is true in the new model and false in the applied one",
            "ssh.public": "ssh.public is true in the new model and false in the applied one",
            "deny v4": "sources.deny lost 192.0.2.0/24",
            "deny v6": "sources.deny lost 2001:db8:bad::/48",
        }
        mgmt_like = ("sources.mgmt", "trusted_ifaces", "wireguard")
        judged_by = (
            ("tcp.ssh", mgmt_like + ("ssh.public",)),
            ("tcp.mgmt", mgmt_like),
            ("tcp.consumer", mgmt_like + ("sources.lb", "consumer_public")),
            ("tcp.metrics", mgmt_like + ("sources.scrape",)),
            ("tcp.wg_only", ("wireguard",)),
            ("udp.public", ("deny v4",)),
            ("udp.xdp", ("deny v4",)),
            ("udp.pub", ("deny v4", "deny v6")),
            ("tcp.public", ("deny v4", "deny v6")),
        )

        def pair(klass, fields):
            applied, new = blank_model(), blank_model()
            setters[klass](applied, P(5555))
            for field in fields:
                on_applied, on_new = changes[field]
                for model, edit in ((applied, on_applied), (new, on_new)):
                    if edit:
                        edit(model)
            return plugin()._seal(applied), plugin()._seal(new)

        for klass, used in judged_by:
            proto, key = klass.split(".")
            with self.subTest("%s: nothing changes" % klass):
                self.assertEqual(union_of(*pair(klass, ()))[proto][key], P(5555))
            with self.subTest("%s: every field that it does not use changes" % klass):
                union = union_of(*pair(klass, [field for field in changes if field not in used]))
                self.assertEqual(union[proto][key], P(5555))
            for field in used:
                with self.subTest("%s: %s" % (klass, field)):
                    refused(*pair(klass, [field]), klass, "5555", says[field])


class ListenModelSupport(ModelTestCase):
    """Profiles, readers and input checks that the numbered behaviors rely on."""

    # The (client, version) pairs of the profiles that these tests derive a model for, with the
    # render that fits each.  A profile added to the plugin needs a line here.
    AGAVE_LINE = (
        ("agave", "3.1.10"),
        ("agave", "4.0.0-beta.2"),
        ("agave", "4.3.0"),
        ("agave", "4.4.0-beta.0"),
        ("jito", "3.1.10-jito"),
        ("jito", "4.0.0-beta.2-jito"),
        ("jito", "4.3.0-jito.0"),
        ("allnodes-jito", "3.1.14"),
        ("allnodes-jito", "4.3.0-allnodes.1"),
    )
    FRANKENDANCER = ("0.814.30108", "0.1204.40300")

    def test_x01_every_listed_version_has_a_profile(self):
        start_script = {
            "agave": "mainnet-validator.agave-4.3.0.start-validator.sh",
            "jito": "mainnet-validator.jito-4.3.0-jito.0.start-validator.sh",
            "allnodes-jito": "mainnet-validator.allnodes-4.3.0-allnodes.1.start-validator.sh",
        }
        for client, version in self.AGAVE_LINE:
            with self.subTest("%s %s" % (client, version)):
                rendered = [args_item(start_script[client])]
                over = {}
                if client == "allnodes-jito":
                    rendered.append(unit_item("mainnet-validator.solv.service.xdp-on"))
                    over["accept_xdp_rx_bypass"] = True
                model = derive(rendered, profile(client, version), inputs(**over))
                self.assertEqual(model["udp"]["public"], P((8900, 8929)))
                self.assertEqual(model["tcp"]["mgmt"], P((7211, 7212)))
                self.assertEqual(model["profile"]["version"], version)
                # only allnodes 4.3.0-allnodes.1 has a receive-XDP path
                self.assertEqual(bool(model["udp"]["xdp_rx_bypass"]), version == "4.3.0-allnodes.1")
        for client in ("firedancer-agave", "firedancer-jito", "frankendancer"):
            for version in self.FRANKENDANCER:
                with self.subTest("%s %s" % (client, version)):
                    model = derive([toml_item("mainnet-validator.firedancer-config.toml")], profile(client, version))
                    self.assertEqual(model["udp"]["xdp"], P(8003, 9001, 9007))
                    self.assertEqual(model["profile"]["id"], "frankendancer-" + version)
        with self.subTest("a leading v is read as the same version"):
            model = derive([args_item("mainnet-validator.agave-4.3.0.start-validator.sh")], profile("agave", "v4.3.0"))
            self.assertEqual(model["profile"]["version"], "4.3.0")

    def test_x02_the_richat_dict_is_what_from_yaml_makes_of_the_rendered_text(self):
        try:
            import yaml
        except ImportError:
            if os.environ.get("SLV_FW_REQUIRE_YAML"):
                self.fail("PyYAML is required here (SLV_FW_REQUIRE_YAML is set)")
            self.skipTest("PyYAML is not installed")
        self.assertEqual(yaml.safe_load(fixture("mainnet-rpc.richat-setting.yml")), richat_data())

    def test_x03_yellowstone_gets_a_consumer_port_and_a_metrics_port(self):
        data = json.loads(fixture("mainnet-rpc.geyser.json"))
        rendered = [args_item("mainnet-rpc.geyser-grpc.start-validator.sh"), {"kind": "yellowstone", "data": data}]
        model = derive(rendered, rpc_profile("Geyser gRPC"))
        self.assertEqual(model["tcp"]["consumer"], P((7211, 7212), 10000))
        self.assertEqual(model["tcp"]["metrics"], P(8999, 9100))
        public = derive(rendered, rpc_profile("Geyser gRPC"), inputs(public_rpc=True))
        warning = [w for w in public["warnings"] if w["code"] == "public_rpc_unauthenticated"][0]
        self.assertEqual(
            [(x["port"], x["name"].split()[0]) for x in warning["listeners"]], [(10000, "yellowstone-grpc")]
        )
        data["grpc"]["x_token"] = "not-a-real-token"
        guarded = derive(
            [rendered[0], {"kind": "yellowstone", "data": data}], rpc_profile("Geyser gRPC"), inputs(public_rpc=True)
        )
        self.assertNotIn("public_rpc_unauthenticated", warning_codes(guarded))

    def test_x04_every_fixture_says_where_it_came_from(self):
        names = sorted(n[: -len(".fixture")] for n in os.listdir(FIXTURES) if n.endswith(".fixture"))
        self.assertGreaterEqual(len(names), 17)
        for name in names:
            with self.subTest(name):
                header, body = fixture_header(name)
                for key in ("source", "source-sha256", "source-state", "vars", "render"):
                    self.assertIn(key, header)
                self.assertTrue(header["source"].startswith("template/2026.6.6.2026/"))
                self.assertRegex(header["source-sha256"], r"^[0-9a-f]{64}$")
                self.assertRegex(header["source-state"], r"^(unmodified|modified|untracked)")
                self.assertIsInstance(json.loads(header["vars"]), dict)
                self.assertTrue(body.strip())

    def test_x05_the_net_providers_follow_the_profile(self):
        toml = fixture("mainnet-validator.firedancer-config.toml") + '\n[net]\n    provider = "mlx5"\n'
        model = derive([toml_item(toml, literal=True)], profile("firedancer-jito", "0.1204.40300"))
        self.assertEqual(model["udp"]["xdp"], P(8003, 9001, 9007), "mlx5 delivers past netfilter like xdp")
        self.assertStopsDerive(
            "fd_provider_unknown", [toml_item(toml, literal=True)], profile("firedancer-jito", "0.814.30108")
        )
        bound = toml.replace('provider = "mlx5"', 'provider = "xdp"\n    bind_address = "192.0.2.80"')
        model = derive([toml_item(bound, literal=True)], profile("firedancer-jito", "0.1204.40300"))
        self.assertEqual(model["udp"]["xdp_bind_address"], "192.0.2.80")

    def test_x06_the_minimum_range_width_follows_the_profile(self):
        narrow = replaced(
            fixture("mainnet-validator.agave-4.3.0.start-validator.sh"),
            "--dynamic-port-range 8900-8930",
            "--dynamic-port-range 8900-8925",
        )
        self.assertStopsDerive("range_too_narrow", [args_item(narrow, literal=True)], profile("agave", "4.4.0-beta.0"))
        self.assertEqual(
            derive([args_item(narrow, literal=True)], profile("agave", "4.0.0-beta.2"))["udp"]["public"],
            P((8900, 8924)),
        )
        defaults = [toml_item("mainnet-validator.firedancer-config.template-defaults.toml")]
        self.assertEqual(
            derive(defaults, profile("firedancer-agave", "0.814.30108"))["udp"]["public"],
            P(8001, 8003, (8900, 8924), 9001, 9007),
        )
        self.assertStopsDerive("range_too_narrow", defaults, profile("firedancer-agave", "0.1204.40300"))

    def test_x07_only_allnodes_4_3_0_can_receive_past_netfilter(self):
        caps_on = unit_item("mainnet-validator.solv.service.xdp-on")
        args_agave = args_item("mainnet-validator.agave-4.3.0.start-validator.sh")
        self.assertEqual(derive([args_agave, caps_on], profile("agave", "4.3.0"))["udp"]["xdp_rx_bypass"], [])
        args_allnodes = args_item("mainnet-validator.allnodes-4.3.0-allnodes.1.start-validator.sh")
        old = derive([args_allnodes, caps_on], profile("allnodes-jito", "3.1.14"))
        self.assertEqual(old["udp"]["xdp_rx_bypass"], [])
        self.assertStopsDerive("rendered_missing", [args_allnodes], profile("allnodes-jito", "4.3.0-allnodes.1"))
        with self.subTest("an inverted AmbientCapabilities= grants everything it does not name"):
            unit = {"kind": "unit", "text": "[Service]\nAmbientCapabilities=~CAP_SYS_PTRACE\n"}
            self.assertStopsDerive(
                "xdp_rx_bypass_unacknowledged", [args_allnodes, unit], profile("allnodes-jito", "4.3.0-allnodes.1")
            )
        with self.subTest("an inverted CapabilityBoundingSet= is hardening and grants nothing"):
            unit = {"kind": "unit", "text": "[Service]\nCapabilityBoundingSet=~CAP_SYS_PTRACE\n"}
            self.assertEqual(
                derive([args_allnodes, unit], profile("allnodes-jito", "4.3.0-allnodes.1"))["udp"]["xdp_rx_bypass"], []
            )
        with self.subTest("lower case names and continued lines"):
            unit = {"kind": "unit", "text": "[Service]\nAmbientCapabilities=cap_net_raw \\\n  cap_bpf cap_perfmon\n"}
            self.assertStopsDerive(
                "xdp_rx_bypass_unacknowledged", [args_allnodes, unit], profile("allnodes-jito", "4.3.0-allnodes.1")
            )
        with self.subTest("an empty assignment resets the list"):
            unit = {
                "kind": "unit",
                "text": "[Service]\nAmbientCapabilities=CAP_BPF CAP_PERFMON\nAmbientCapabilities=\n",
            }
            self.assertEqual(
                derive([args_allnodes, unit], profile("allnodes-jito", "4.3.0-allnodes.1"))["udp"]["xdp_rx_bypass"], []
            )

    def test_x08_the_frankendancer_config_reader_reads_only_what_it_needs(self):
        base = fixture("mainnet-validator.firedancer-config.toml")
        profile_fd = profile("firedancer-jito", "0.1204.40300")
        with self.subTest("comments, separators and a multi-line array do not confuse it"):
            text = replaced(base, "gui_listen_port = 6001", "gui_listen_port = 6_001  # the gui")
            text += '\n[net]\n    skip = [\n      "[tiles.gui]",\n      "x",\n    ]\n    provider = "socket"\n'
            model = derive([toml_item(text, literal=True)], profile_fd)
            self.assertIn([6001, 6001], model["tcp"]["mgmt"])
            self.assertEqual(model["udp"]["xdp"], [])
        with self.subTest("a line it does not read may be anything"):
            model = derive([toml_item(base + "\nnot toml at all\n[[also.odd]]\n", literal=True)], profile_fd)
            self.assertEqual(model["udp"]["xdp"], P(8003, 9001, 9007))
        with self.subTest("dotted keys and single-quoted strings"):
            text = base + "\n[tiles]\n    shred.shred_listen_port = 8004\n[net]\n    provider = 'socket'\n"
            model = derive([toml_item(text, literal=True)], profile_fd)
            self.assertIn([8004, 8004], model["udp"]["public"])
        with self.subTest("a gui and a metric bound to loopback are local only"):
            text = replaced(base, 'gui_listen_address = "0.0.0.0"', 'gui_listen_address = "127.0.0.1"')
            text = replaced(text, 'prometheus_listen_address = "0.0.0.0"', 'prometheus_listen_address = "127.0.0.1"')
            model = derive([toml_item(text, literal=True)], profile_fd)
            self.assertEqual(model["local_only"]["tcp"], P(6001, 7999))
            self.assertEqual(model["tcp"]["metrics"], P(9100))
        unreadable = (
            ("a used key with a non-number", replaced(base, "    port = 8899\n", "    port = nope\n")),
            ("a used key that is given twice", base + '\n[net]\n    provider = "xdp"\n    provider = "socket"\n'),
            (
                "an unterminated string",
                replaced(base, 'dynamic_port_range = "8900-8930"', 'dynamic_port_range = "8900-8930'),
            ),
            ("a boolean that is not one", replaced(base, "private = false", "private = maybe")),
            ("a range that is not MIN-MAX", replaced(base, "8900-8930", "8900:8930")),
            ("a port out of range", replaced(base, "gui_listen_port = 6001", "gui_listen_port = 70000")),
            ("template markers left in the text", base + "{{ leftover }}\n"),
            ("a bind address that is not an IPv4 address", base + '\n[net]\n    bind_address = "not-an-address"\n'),
        )
        for name, text in unreadable:
            with self.subTest(name):
                self.assertStopsDerive("fd_config_unreadable", [toml_item(text, literal=True)], profile_fd)

    def test_x09_the_start_script_reader_follows_the_shell(self):
        def script(*flags):
            return "#!/bin/bash\nexec agave-validator \\\n" + "".join("%s \\\n" % f for f in flags)

        def parse(*flags):
            return derive([args_item(script(*flags), literal=True)])

        with self.subTest("--flag=value, quotes and a path to the binary"):
            text = "exec /home/solv/bin/agave-validator --dynamic-port-range='8100-8130' --rpc-port \"8300\"\n"
            model = derive([args_item(text, literal=True)])
            self.assertEqual(model["udp"]["public"], P((8100, 8129)))
            self.assertEqual(model["tcp"]["mgmt"], P((8300, 8301)))
        with self.subTest("no --rpc-port means no RPC listener, and the default range applies"):
            model = parse("--identity /x")
            self.assertEqual(model["udp"]["public"], P((8000, 9999)))
            self.assertEqual(model["tcp"]["mgmt"], [])
        with self.subTest("--gossip-port 0 is the same as not giving it"):
            self.assertStopsDerive(
                "gossip_port_unpinned",
                [args_item(script("--gossip-port 0"), literal=True)],
                inp=inputs(ip_echo_public=True),
            )
        with self.subTest("a flag that follows a comment starts a new command"):
            text = "exec agave-validator --rpc-port 7300 \\\n# comment\n--dynamic-port-range 8100-8130\n"
            model = derive([args_item(text, literal=True)])
            self.assertEqual(model["udp"]["public"], P((8000, 9999)), "bash would not pass the flag either")
        with self.subTest("--bind-address decides the RPC bind when nothing else does"):
            model = parse("--rpc-port 7300", "--bind-address 127.0.0.1")
            self.assertEqual(model["local_only"]["tcp"], P((7300, 7301)))
        unreadable = (
            ("no agave-validator command", "exec solana-keygen new\n"),
            ("a value that is not resolved", script("--rpc-port $PORT")),
            ("a command substitution", script("--rpc-port $(cat /etc/port)")),
            ("a missing value", script("--rpc-port")),
            ("a flag given twice", script("--rpc-port 8300", "--rpc-port 8400")),
            ("a range with the ends swapped", script("--dynamic-port-range 8130-8100")),
            ("a port that is not a number", script("--gossip-port abc")),
            ("--rpc-port 0", script("--rpc-port 0")),
            ("an RPC port with no room for pubsub", script("--rpc-port 65535")),
            ("an unterminated quote", script('--identity "/x')),
            ("template markers", script("--identity {{ x }}")),
            ("--private-rpc given a value", script("--private-rpc=false")),
        )
        for name, text in unreadable:
            with self.subTest(name):
                self.assertStopsDerive("agave_args_unreadable", [args_item(text, literal=True)])

    def test_x10_inputs_are_checked_strictly(self):
        rendered = [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")]
        cases = (
            ("a boolean given as a string", inputs(public_rpc="false")),
            ("an unknown input", inputs(lb_ip=["192.0.2.10"])),
            ("a list given as a string", inputs(admin_ips=ADMIN)),
            ("an address with host bits set", inputs(admin_ips=["198.51.100.7/24"], controller_ip=None)),
            ("an address with a scope id", inputs(admin_ips=["fe80::1%eth0"], controller_ip=None)),
            ("a controller address with a scope id", inputs(controller_ip="fe80::1%eth0")),
            ("an interface name that ends in a newline", inputs(trusted_ifaces=["wg0\n"])),
            ("a port that ends in a newline", inputs(ansible_port="22\n")),
            ("not an address", inputs(lb_ips=["lb.example.test"])),
            ("an interface name that is not one", inputs(trusted_ifaces=['wg0"; drop'])),
            ("an unknown ssh mode", inputs(ssh_mode="open")),
            ("a port out of range", inputs(ansible_port=70000)),
            ("a boolean for a port", inputs(ansible_port=True)),
            ("an unknown component key", inputs(components=[{"id": "nginx", "port": 8080}])),
            ("a component listed twice", inputs(components=["nginx", "nginx"])),
            (
                "sources on a component that takes none",
                inputs(components=[{"id": "nginx", "sources": ["192.0.2.0/24"]}]),
            ),
            ("a class change for a component", inputs(components=[{"id": "nginx", "class": "consumer"}])),
        )
        for name, inp in cases:
            with self.subTest(name):
                self.assertStopsDerive("invalid_input", rendered, inp=inp)
        with self.subTest("host_facts is required"):
            self.assertStops("invalid_input", rendered, profile(), inputs(), None)
            partial = host_facts()
            del partial["sshd_ports"]
            self.assertStops("invalid_input", rendered, profile(), inputs(), partial)
        with self.subTest("an unknown render kind, a repeated kind, text where data belongs"):
            self.assertStopsDerive("invalid_input", rendered + [{"kind": "nginx", "text": "x"}])
            self.assertStopsDerive("invalid_input", rendered + rendered)
            self.assertStopsDerive(
                "invalid_input",
                [args_item("mainnet-rpc.geyser-grpc.start-validator.sh"), {"kind": "richat", "text": "x: y"}],
                rpc_profile("Geyser gRPC"),
            )
        with self.subTest("the profile"):
            self.assertStopsDerive("invalid_input", rendered, profile(role="router"))
            self.assertStopsDerive("invalid_input", rendered, profile(network="localnet"))
            self.assertStopsDerive("invalid_input", rendered, profile(role="rpc"))
            self.assertStopsDerive("invalid_input", rendered, dict(profile(), extra=1))
        with self.subTest("an interface list that must cover every interface needs one"):
            self.assertStopsDerive("invalid_input", rendered, facts=host_facts(ifaces=["lo"], dhcp4_ifaces=None))

    def test_x11_the_render_must_match_the_rpc_type(self):
        index = [args_item("mainnet-rpc.index-rpc.start-validator.sh")]
        self.assertStopsDerive("rendered_missing", index, rpc_profile("Index RPC"))
        self.assertStopsDerive(
            "rendered_missing", [args_item("mainnet-rpc.geyser-grpc.start-validator.sh")], rpc_profile("Geyser gRPC")
        )
        self.assertStopsDerive("rendered_missing", [richat_item()], rpc_profile("Geyser gRPC"))
        self.assertStopsDerive("invalid_input", index + [of1_item(), richat_item()], rpc_profile("Index RPC"))
        both = [
            args_item("mainnet-rpc.geyser-grpc.start-validator.sh"),
            richat_item(),
            {"kind": "yellowstone", "data": {}},
        ]
        self.assertStopsDerive("invalid_input", both, rpc_profile("Geyser gRPC"))
        self.assertStopsDerive("invalid_input", geyser_rendered(), profile())  # richat on a validator
        with self.subTest("a dict that is not the file it should be"):
            args = args_item("mainnet-rpc.geyser-grpc.start-validator.sh")
            self.assertStopsDerive(
                "invalid_input", [args, richat_item({"grpc": {"address": "0.0.0.0:10000"}})], rpc_profile("Geyser gRPC")
            )
            self.assertStopsDerive(
                "invalid_input", [args, {"kind": "yellowstone", "data": richat_data()}], rpc_profile("Geyser gRPC")
            )
            self.assertStopsDerive(
                "invalid_input",
                [args, richat_item({"apps": {"pubsub": {"endpoint": 7111}}})],
                rpc_profile("Geyser gRPC"),
            )
        sendtx = derive([args_item("mainnet-rpc.index-rpc.start-validator.sh")], rpc_profile("SendTx RPC"))
        self.assertEqual(sendtx["tcp"]["consumer"], P((7211, 7212)))
        fd_profile = rpc_profile("Index RPC", "firedancer-jito", "0.1204.40300")
        model = derive([toml_item(fd_rpc_toml(), literal=True), of1_item()], fd_profile)
        self.assertEqual(model["tcp"]["consumer"], P((7211, 7212), 8888))
        self.assertEqual(model["tcp"]["mgmt"], P(6001), "the gui stays mgmt-only")
        self.assertStopsDerive("rendered_missing", [toml_item(fd_rpc_toml(), literal=True)], fd_profile)
        self.assertStopsDerive(
            "invalid_input", [toml_item(fd_rpc_toml(), literal=True), of1_item(), richat_item()], fd_profile
        )
        self.assertStopsDerive(
            "invalid_input",
            [
                args_item("mainnet-validator.agave-4.3.0.start-validator.sh"),
                toml_item("mainnet-validator.firedancer-config.toml"),
            ],
        )
        self.assertStopsDerive(
            "rendered_missing", [toml_item("mainnet-validator.firedancer-config.toml")], profile("agave", "4.3.0")
        )

    def test_x12_ip_echo_needs_a_pinned_gossip_port(self):
        self.assertStopsDerive(
            "gossip_port_unpinned",
            [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")],
            inp=inputs(ip_echo_public=True),
        )
        model = derive(
            [toml_item("mainnet-validator.firedancer-config.toml")],
            profile("firedancer-jito", "0.1204.40300"),
            inputs(ip_echo_public=True),
        )
        self.assertEqual(model["tcp"]["public"], P(8001), "a Frankendancer always pins [gossip].port")

    def test_x13_the_model_does_not_depend_on_the_process(self):
        code = (
            "import importlib.util, json, sys\n"
            "spec = importlib.util.spec_from_file_location('slv_listen_model', sys.argv[1])\n"
            "mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)\n"
            "args = json.loads(sys.argv[2])\n"
            "print(mod.slv_listen_model(*args)['model_sha256'])\n"
        )
        arguments = [
            [args_item("mainnet-rpc.index-grpc.start-validator.sh"), richat_item(), of1_item()],
            rpc_profile("Index RPC + gRPC"),
            inputs(
                admin_ips=["203.0.113.0/28", ADMIN, "2001:db8:10::/64"],
                lb_ips=["192.0.2.10"],
                components=["nginx", "wireguard", "libvirt", "gateway"],
                trusted_ifaces=["wg0", "br-*"],
            ),
            host_facts(ifaces=["lo", "eno1", "eno2"], dhcp4_ifaces=None, bridges=["br-1"]),
        ]
        digests = set()
        for seed in ("0", "1", "12345"):
            env = dict(os.environ, PYTHONHASHSEED=seed)
            out = subprocess.run(
                [sys.executable, "-c", code, PLUGIN, json.dumps(arguments)],
                env=env,
                stdout=subprocess.PIPE,
                universal_newlines=True,
                check=True,
            ).stdout.strip()
            digests.add(out)
        self.assertEqual(len(digests), 1, digests)
        self.assertEqual(digests, {plugin().slv_listen_model(*arguments)["model_sha256"]})

    def test_x14_the_filters_raise_the_ansible_error_only_when_ansible_is_there(self):
        module = plugin()
        filters = module.FilterModule().filters()
        self.assertEqual(
            sorted(filters),
            ["slv_listen_model", "slv_listen_model_canonical_json", "slv_listen_model_meta", "slv_listen_model_union"],
        )
        arguments = (
            [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")],
            profile("agave", "9.9.9"),
            inputs(),
            host_facts(),
        )
        if importlib.util.find_spec("ansible") is None:
            with self.assertRaises(module.ModelError):
                filters["slv_listen_model"](*arguments)
        saved = dict((k, sys.modules.get(k)) for k in ("ansible", "ansible.errors"))
        errors = types.ModuleType("ansible.errors")

        class AnsibleFilterError(Exception):
            pass

        errors.AnsibleFilterError = AnsibleFilterError
        sys.modules["ansible"] = types.ModuleType("ansible")
        sys.modules["ansible.errors"] = errors
        try:
            with self.assertRaises(AnsibleFilterError) as caught:
                filters["slv_listen_model"](*arguments)
            self.assertIn("no_profile", str(caught.exception))
            self.assertIsInstance(caught.exception.__cause__, module.ModelError)
            good = filters["slv_listen_model"](
                [args_item("mainnet-validator.agave-4.3.0.start-validator.sh")], profile(), inputs(), host_facts()
            )
            self.assertEqual(filters["slv_listen_model_canonical_json"](good), module.canonical_json(good))
            with self.assertRaises(AnsibleFilterError):
                filters["slv_listen_model_union"]({"schema": "x"}, good)
            with self.assertRaises(AnsibleFilterError) as caught:
                filters["slv_listen_model_meta"]({"generated_at": "yesterday"})
            self.assertIn("invalid_meta", str(caught.exception))
            self.assertEqual(
                filters["slv_listen_model_meta"]({"generated_at": "2026-01-01T00:00:00Z"}),
                {"generated_at": "2026-01-01T00:00:00Z", "controller_ip": ""},
            )
        finally:
            for key, value in saved.items():
                if value is None:
                    sys.modules.pop(key, None)
                else:
                    sys.modules[key] = value


if __name__ == "__main__":
    unittest.main()
