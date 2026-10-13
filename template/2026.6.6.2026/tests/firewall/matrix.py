#!/usr/bin/env python3
"""The cells of the firewall render matrix, and the structural check of what it renders.

Standard library only.  render_matrix.yml calls `cells` and `check-table`; the workflow that
renders the matrix calls `pins` and `shape` on the result.

    matrix.py cells [--version-file FILE]
        Print the cells as JSON.  A cell is one start configuration of a node:

          matrix     every valid (network, role, validator_type, rpc_type) for each of the two
                     inventories (inventories/*.yml), with the client version that
                     cmn/constants/version.ts pins for it
          scenario   one fixed start configuration with other firewall inputs (a verdict
                     case for netns_verdicts.sh, or a rule that no matrix cell turns on),
                     sometimes with a change to the derived model that no start
                     configuration can make (model_patch)
          probe      a pinned client version that no matrix cell uses, so that its profile
                     is still looked up

        Every `export const VERSION_*` of version.ts has to be known here: either as the
        version of a client (the table below) or as a version that carries no listen
        profile.  A new pin that is neither stops this command.

    matrix.py check-table
        Read startup_templates.yml as JSON on stdin and compare its keys with the cells,
        both ways: a cell without an entry or an entry without a cell is an error.

    matrix.py pins DIR [--golden DIR]
        Check that no cell under DIR (and under the golden directory, when given) stopped
        with no_profile: a client version that version.ts pins has to have a profile in the
        listen model. A profile that is missing is added in the model, never recorded as the
        golden result of its cell.

    matrix.py shape DIR
        Check that every *.nft file under DIR holds one table, `inet slv`, begins with the
        statements that create, delete and define it, and never flushes.
"""

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TEMPLATE_ROOT = HERE.parent.parent  # template/<release>
REPO_ROOT = TEMPLATE_ROOT.parent.parent
VERSION_FILE = REPO_ROOT / "cmn" / "constants" / "version.ts"

NETWORKS = ("mainnet", "testnet", "devnet")
INVENTORIES = ("cli_values", "template_defaults")

AGAVE_LINE = ("agave", "jito", "allnodes-jito")
FIREDANCER = ("firedancer-agave", "firedancer-jito")

# The start configurations an init playbook can draw, kept by hand: nothing reads the import
# conditions of the init playbooks, so a change to them is made here and in
# startup_templates.yml.  startup_templates.yml has to list exactly these (check-table).
VALIDATOR_TYPES = {
    ("mainnet", "validator"): ("agave", "jito", "allnodes-jito") + FIREDANCER,
    ("testnet", "validator"): ("agave", "jito") + FIREDANCER,
    ("mainnet", "rpc"): ("agave", "jito") + FIREDANCER,
    ("testnet", "rpc"): ("agave", "jito") + FIREDANCER,
    ("devnet", "rpc"): ("agave", "jito") + FIREDANCER,
}
RPC_TYPES_AGAVE_LINE = ("Geyser gRPC", "Index RPC", "SendTx RPC", "Index RPC + gRPC")
RPC_TYPES_FIREDANCER = ("Index RPC", "SendTx RPC")  # the CLI offers no more for Firedancer

# Where cli/lib/config/defaultVersionsYml.ts puts each pin: the group of versions.yml and
# its key.  The key is also the name of the group's entry that the start templates read.
GROUPS = {
    ("mainnet", "validator"): "mainnet_validators",
    ("testnet", "validator"): "testnet_validators",
    ("mainnet", "rpc"): "mainnet_rpcs",
    ("testnet", "rpc"): "testnet_rpcs",
    ("devnet", "rpc"): "devnet_rpcs",
}
GROUP_KEYS = {
    "agave": "version_agave",
    "jito": "version_jito",
    "allnodes-jito": "version_allnodes_jito",
    "firedancer": "version_firedancer",
}
CLIENT_PINS = {
    ("mainnet", "validator"): {
        "agave": "VERSION_SOLANA_VALIDATOR_MAINNET",
        "jito": "VERSION_JITO_VALIDATOR_MAINNET",
        "allnodes-jito": "VERSION_ALLNODES_JITO_MAINNET",
        "firedancer": "VERSION_FIREDANCER_MAINNET",
    },
    ("testnet", "validator"): {
        "agave": "VERSION_SOLANA_TESTNET",
        "jito": "VERSION_JITO_TESTNET",
        "allnodes-jito": "VERSION_ALLNODES_JITO_TESTNET",
        "firedancer": "VERSION_FIREDANCER_TESTNET",
    },
    ("mainnet", "rpc"): {
        "agave": "VERSION_SOLANA_MAINNET",
        "jito": "VERSION_JITO_MAINNET",
        "firedancer": "VERSION_FIREDANCER_MAINNET",
    },
    ("testnet", "rpc"): {
        "agave": "VERSION_SOLANA_TESTNET",
        "jito": "VERSION_JITO_TESTNET",
        "firedancer": "VERSION_FIREDANCER_TESTNET",
    },
    ("devnet", "rpc"): {
        "agave": "VERSION_SOLANA_DEVNET",
        "jito": "VERSION_JITO_DEVNET",
        "firedancer": "VERSION_FIREDANCER_DEVNET",
    },
}
# Pins of things that have no listen profile: richat, Old Faithful and the Yellowstone
# plugin.  Their ports are read from the config that the start playbooks render for them (the
# Old Faithful address from its play), so the pin itself is not looked up.
OTHER_PINS = (
    "VERSION_RICHAT",
    "VERSION_OF1",
    "VERSION_GEYSER_YELLOWSTONE_TESTNNET",
    "VERSION_GEYSER_YELLOWSTONE_DEVNET",
    "VERSION_GEYSER_YELLOWSTONE_MAINNET",
)

# Firewall inputs and host facts that every matrix cell gets.  Only documentation ranges
# (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32) appear in them.
MGMT_V4 = "198.51.100.7"
META = {"generated_at": "2026-01-01T00:00:00Z", "controller_ip": MGMT_V4}

HOST_FACTS = {
    "default_route_ifaces": ["eno1"],
    "ifaces": ["lo", "eno1"],
    "bridges": [],
    "dhcp4_ifaces": ["eno1"],
    "dhcp6_ifaces": ["eno1"],
    "ra_ifaces": ["eno1"],
    "sshd_ports": [22],
    "ssh_socket_ports": [],
    "sshd_listen_ports": [22],
    "has_global_v6": True,
}

# The addresses, interfaces and ports of the netns topology that netns_verdicts.sh builds,
# written to verdict/topology.env so that the script reads the numbers the tables were
# rendered with.  peer reaches host over h0, host reaches far over h1.  The tables match the
# WireGuard tunnel (10.0.0.0/24) by the interface name wg0; one case makes a pair of virtual
# links, wg0 in host and wgp in peer, to stand in for it.  METRICS_PORT is the node exporter
# port, which every node has.
TOPOLOGY = {
    "CONSUMER_PORT": 10000,
    "FAR_V4": "203.0.113.2",
    "HOST_FAR_V4": "203.0.113.1",
    "HOST_LL": "fe80::1",
    "HOST_V4": "192.0.2.1",
    "HOST_V6": "2001:db8:1::1",
    "IF_FAR": "f0",
    "IF_HOST_FAR": "h1",
    "IF_HOST_PEER": "h0",
    "IF_PEER": "p0",
    "IF_WG": "wg0",
    "IF_WG_PEER": "wgp",
    "LB_V4": "192.0.2.10",
    "METRICS_PORT": 9100,
    "MGMT_V4": MGMT_V4,
    "MGMT_V6": "2001:db8:10::7",
    "NS_FAR": "slvfw-far",
    "NS_HOST": "slvfw-host",
    "NS_PEER": "slvfw-peer",
    "OTHER_V4": "198.51.100.77",
    "PEER_LL": "fe80::2",
    "PEER_V4": "192.0.2.2",
    "PEER_V6": "2001:db8:1::2",
    "PUB_UDP_PORT": 51821,
    "SOL_UDP_PORT": 8000,
    "SSH_PORT": 22,
    "UNSEEN_V4": "198.51.100.99",
    "WG_HOST_V4": "10.0.0.1",
    "WG_PEER_V4": "10.0.0.2",
    "WG_UDP_PORT": 51820,
}


def die(message):
    sys.stderr.write("matrix.py: %s\n" % message)
    sys.exit(2)


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


# ---------------------------------------------------------------------------
# version.ts
# ---------------------------------------------------------------------------

PIN_RE = re.compile(r"""export const (VERSION_[A-Z0-9_]+) = (['"])([^'"]*)\2\s*(?://.*)?$""")


def read_pins(path):
    """{name: value} of every `export const VERSION_* = '...'` line of the file."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError as exc:
        die("cannot read %s: %s" % (path, exc))
    pins = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.startswith("export const VERSION_"):
            continue
        match = PIN_RE.fullmatch(line.rstrip())
        if not match:
            die("%s:%d: not a plain `export const VERSION_X = '...'` line: %s" % (path, number, line))
        if match.group(1) in pins:
            die("%s:%d: %s is defined twice" % (path, number, match.group(1)))
        pins[match.group(1)] = match.group(3)
    if not pins:
        die("%s holds no `export const VERSION_*` line" % path)
    return pins


def client_family(validator_type):
    return "firedancer" if validator_type in FIREDANCER else validator_type


def check_pins_known(pins):
    clients = set()
    for table in CLIENT_PINS.values():
        clients.update(table.values())
    unknown = sorted(set(pins) - clients - set(OTHER_PINS))
    if unknown:
        die(
            "version.ts pins %s, which matrix.py does not know: add each to CLIENT_PINS "
            "(a client version, so that it gets a cell or a probe) or to OTHER_PINS" % ", ".join(unknown)
        )
    missing = sorted(clients - set(pins))
    if missing:
        die("matrix.py builds cells from %s, which version.ts no longer pins" % ", ".join(missing))


# ---------------------------------------------------------------------------
# Cells
# ---------------------------------------------------------------------------


def base_inputs(role):
    inputs = {
        "admin_ips": [MGMT_V4, "203.0.113.0/28", "2001:db8:10::/64"],
        "metrics_ips": ["192.0.2.20"],
        "controller_ip": MGMT_V4,
        "ssh_connection_port": 22,
    }
    if role == "rpc":
        inputs["lb_ips"] = ["192.0.2.10"]
    return inputs


def group_versions(pins, network, role):
    versions = {}
    for family, constant in CLIENT_PINS[(network, role)].items():
        versions[GROUP_KEYS[family]] = pins[constant]
    return versions


def make_cell(pins, kind, cell_id, directory, network, role, validator_type, rpc_type, inventory):
    family = client_family(validator_type)
    constant = CLIENT_PINS[(network, role)][family]
    version = pins[constant]
    group = GROUPS[(network, role)]
    return {
        "kind": kind,
        "id": cell_id,
        "dir": directory,
        "host": "cell-" + re.sub(r"[^A-Za-z0-9.-]+", "-", cell_id),
        "network": network,
        "role": role,
        "validator_type": validator_type,
        "rpc_type": rpc_type,
        "inventory": inventory,
        "xdp_answers": role == "validator" and validator_type in AGAVE_LINE,
        "group": group,
        "group_versions": group_versions(pins, network, role),
        "pin": constant,
        "profile": {
            "client": validator_type,
            "version": version,
            "role": role,
            "network": network,
            "rpc_type": rpc_type,
        },
        "inputs": base_inputs(role),
        "host_facts": dict(HOST_FACTS),
        "entries": None,
        "model_patch": None,
    }


def matrix_cells(pins):
    cells = []
    for network in NETWORKS:
        for role in ("validator", "rpc"):
            if (network, role) not in VALIDATOR_TYPES:
                continue
            for validator_type in VALIDATOR_TYPES[(network, role)]:
                if role == "validator":
                    rpc_types = (None,)
                elif validator_type in FIREDANCER:
                    rpc_types = RPC_TYPES_FIREDANCER
                else:
                    rpc_types = RPC_TYPES_AGAVE_LINE
                for rpc_type in rpc_types:
                    for inventory in INVENTORIES:
                        parts = ["%s-%s" % (network, role), validator_type]
                        if rpc_type:
                            parts.append(slug(rpc_type))
                        parts.append(inventory)
                        cell_id = "/".join(parts)
                        cells.append(
                            make_cell(
                                pins, "matrix", cell_id, "cells/" + cell_id,
                                network, role, validator_type, rpc_type, inventory,
                            )
                        )
    return cells


def scenario(pins, name, directory, rpc_type="Geyser gRPC", inputs=None, host_facts=None, entries=None, meta=None,
             model_patch=None):
    """A mainnet agave RPC with the CLI's inventory values and other firewall inputs.

    model_patch is merged into the derived model by hand (and the model is sealed again), for
    a case that no start configuration can produce.
    """
    cell = make_cell(pins, "scenario", name, directory, "mainnet", "rpc", "agave", rpc_type, "cli_values")
    cell["inputs"] = inputs if inputs is not None else cell["inputs"]
    cell["host_facts"] = host_facts if host_facts is not None else cell["host_facts"]
    cell["entries"] = entries
    cell["meta"] = meta if meta is not None else dict(META)
    cell["model_patch"] = model_patch
    return cell


def verdict_facts():
    t = TOPOLOGY
    return {
        "default_route_ifaces": [t["IF_HOST_FAR"]],
        "ifaces": ["lo", t["IF_HOST_PEER"], t["IF_HOST_FAR"]],
        "bridges": [],
        "dhcp4_ifaces": [t["IF_HOST_PEER"]],
        "dhcp6_ifaces": [t["IF_HOST_PEER"]],
        "ra_ifaces": [t["IF_HOST_PEER"]],
        "sshd_ports": [22],
        "ssh_socket_ports": [],
        "sshd_listen_ports": [22],
        "has_global_v6": True,
    }


def verdict_inputs(ssh_mode="refuse", lb_ips=None, deny_ips=None):
    t = TOPOLOGY
    return {
        "admin_ips": [t["MGMT_V4"], t["MGMT_V6"]],
        "lb_ips": [t["LB_V4"]] if lb_ips is None else lb_ips,
        "deny_ips": [] if deny_ips is None else deny_ips,
        "ssh_mode": ssh_mode,
        "controller_ip": t["MGMT_V4"],
        "ssh_connection_port": 22,
    }


def scenario_cells(pins):
    t = TOPOLOGY
    cells = [
        # Three of the four scenarios that netns_verdicts.sh loads (the fourth follows).  The
        # second differs from the first in the SSH mode, the third in having moved the load
        # balancer address from lb to deny.
        scenario(pins, "verdict/refuse", "verdict/refuse",
                 inputs=verdict_inputs(), host_facts=verdict_facts()),
        scenario(pins, "verdict/public-rate-limited", "verdict/public-rate-limited",
                 inputs=verdict_inputs(ssh_mode="public-rate-limited"), host_facts=verdict_facts()),
        scenario(pins, "verdict/deny", "verdict/deny",
                 inputs=verdict_inputs(lb_ips=[], deny_ips=[t["LB_V4"]]), host_facts=verdict_facts()),
        # The fallback table keeps the UDP port of the WireGuard tunnel and no other public UDP
        # port. The model has no second public UDP port (WireGuard is the only component that
        # has one), so one is added to the derived model by hand.
        scenario(pins, "verdict/wireguard", "verdict/wireguard",
                 inputs=dict(verdict_inputs(), components=["wireguard"]), host_facts=verdict_facts(),
                 model_patch={"udp": {"pub": [[t["WG_UDP_PORT"], t["WG_UDP_PORT"]],
                                              [t["PUB_UDP_PORT"], t["PUB_UDP_PORT"]]]}}),
        # mgmt is the address the run connects from
        scenario(pins, "scenarios/controller-only", "scenarios/controller-only",
                 inputs={"ssh_mode": "controller-only", "controller_ip": "198.51.100.200",
                         "lb_ips": ["192.0.2.10"], "ssh_connection_port": 22},
                 meta={"generated_at": META["generated_at"], "controller_ip": "198.51.100.200"}),
        # the optional address lists, interface lists and components in one table; the SSH mode
        # stays refuse (verdict/public-rate-limited has the other)
        scenario(
            pins, "scenarios/everything", "scenarios/everything", rpc_type="Index RPC + gRPC",
            inputs={
                "admin_ips": [MGMT_V4, "203.0.113.0/28", "2001:db8:10::/64"],
                "lb_ips": ["192.0.2.10", "2001:db8:20::10"],
                "metrics_ips": ["192.0.2.20", "2001:db8:30::/64"],
                "deny_ips": ["192.0.2.200", "2001:db8:bad::/48"],
                "trusted_ifaces": ["mgmt0", "br-*"],
                "components": [
                    "rpc-gateway",
                    {"id": "shred-relay", "sources": ["192.0.2.240", "2001:db8:50::/64"]},
                    "wireguard",
                    "gateway",
                    "nginx",
                    "libvirt",
                ],
                "public_rpc": True,
                "controller_ip": MGMT_V4,
                "ssh_connection_port": 22,
            },
            host_facts={
                "default_route_ifaces": ["eno1"],
                "ifaces": ["lo", "eno1", "eno2", "docker0", "mgmt0"],
                "bridges": ["docker0"],
                "dhcp4_ifaces": ["eno1", "eno2"],
                "dhcp6_ifaces": None,
                "ra_ifaces": None,
                "sshd_ports": [22, 2222],
                "ssh_socket_ports": [2223],
                "sshd_listen_ports": [22, 2222],
                "has_global_v6": True,
            },
        ),
        # the Yellowstone plugin in place of richat: the geyser.json route of the playbook
        scenario(
            pins, "scenarios/yellowstone", "scenarios/yellowstone",
            entries=[
                {"kind": "agave-args", "path": "mainnet-rpc/start-validator.sh.j2",
                 "play": "mainnet-rpc/create-start-validator-sh.yml"},
                {"kind": "unit", "path": "mainnet-rpc/solv.service.j2",
                 "play": "mainnet-rpc/setup-solv-service.yml"},
                {"kind": "yellowstone", "path": "mainnet-rpc/geyser.json.j2",
                 "play": "mainnet-rpc/geyser_build.yml"},
            ],
        ),
    ]
    return cells


def probe_cells(pins, cells):
    """One probe for each client pin that no cell uses."""
    used = set(cell["pin"] for cell in cells)
    probes = []
    for (network, role), table in sorted(CLIENT_PINS.items()):
        for family, constant in sorted(table.items()):
            if constant in used:
                continue
            used.add(constant)
            validator_type = "firedancer-jito" if family == "firedancer" else family
            probe = make_cell(
                pins, "probe", "probes/" + constant.lower(), "probes/" + constant.lower(), network, role,
                validator_type, "Index RPC" if role == "rpc" else None, "cli_values",
            )
            probes.append(probe)
    return probes


def all_cells(pins):
    cells = matrix_cells(pins)
    cells += scenario_cells(pins)
    cells += probe_cells(pins, cells)
    for cell in cells:
        cell.setdefault("meta", dict(META))
    ids = [cell["id"] for cell in cells]
    if len(ids) != len(set(ids)):
        die("two cells share an id")
    hosts = [cell["host"] for cell in cells]
    if len(hosts) != len(set(hosts)):
        die("two cells share a host name")
    return cells


def command_cells(args):
    pins = read_pins(args.version_file)
    check_pins_known(pins)
    out = {"cells": all_cells(pins), "pins": pins, "topology": TOPOLOGY}
    json.dump(out, sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# check-table: startup_templates.yml against the cells
# ---------------------------------------------------------------------------


def command_check_table(args):
    try:
        table = json.load(sys.stdin)["slv_startup_templates"]
    except (ValueError, KeyError, TypeError) as exc:
        die("stdin is not startup_templates.yml as JSON with an slv_startup_templates key: %s" % exc)
    listed = set()
    for network, roles in table.items():
        for role, clients in roles.items():
            for client, value in clients.items():
                if isinstance(value, dict):
                    for rpc_type in value:
                        listed.add((network, role, client, rpc_type))
                else:
                    listed.add((network, role, client, None))
    wanted = set()
    for network, role in VALIDATOR_TYPES:
        for validator_type in VALIDATOR_TYPES[(network, role)]:
            if role == "validator":
                wanted.add((network, role, validator_type, None))
            else:
                types = RPC_TYPES_FIREDANCER if validator_type in FIREDANCER else RPC_TYPES_AGAVE_LINE
                for rpc_type in types:
                    wanted.add((network, role, validator_type, rpc_type))
    problems = ["no entry in startup_templates.yml for %s" % (key,) for key in sorted(wanted - listed, key=str)]
    problems += ["startup_templates.yml lists %s, which no cell has" % (key,) for key in sorted(listed - wanted, key=str)]
    if problems:
        sys.stdout.write("FAIL startup_templates_match_cells\n")
        for problem in problems:
            sys.stdout.write("  %s\n" % problem)
        return 1
    sys.stdout.write("startup_templates.yml and the cells list the same %d start configurations\n" % len(wanted))
    return 0


# ---------------------------------------------------------------------------
# pins: no cell stopped for want of a profile
# ---------------------------------------------------------------------------


def stopped_for_profile(root):
    return sorted(
        path.parent.relative_to(root)
        for path in root.rglob("error")
        if path.is_file() and path.read_text(encoding="utf-8").strip() == "no_profile"
    )


def command_pins(args):
    problems = []
    checked = 0
    for label, directory in (("render", args.directory), ("golden", args.golden)):
        if directory is None:
            continue
        root = Path(directory)
        cells = [p for p in root.rglob("*") if p.is_file() and p.name in ("slv.nft", "error")] if root.is_dir() else []
        if not cells:
            problems.append("no cell under the %s directory %s" % (label, root))
            continue
        checked += len(cells)
        for cell in stopped_for_profile(root):
            problems.append("%s: %s has no profile for the version that version.ts pins" % (label, cell))
    if problems:
        for problem in problems:
            sys.stdout.write("FAIL b03_pinned_versions_have_profile: %s\n" % problem)
        return 1
    sys.stdout.write("PASS b03_pinned_versions_have_profile (%d results looked at)\n" % checked)
    return 0


# ---------------------------------------------------------------------------
# shape: the table of every rendered file
# ---------------------------------------------------------------------------

EXPECTED_START = ["table inet slv", "delete table inet slv", "table inet slv {"]


def shape_errors(text):
    statements = [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]
    errors = []
    if statements[:3] != EXPECTED_START:
        errors.append("does not begin with the statements %s" % " / ".join(EXPECTED_START))
    names = set()
    definitions = 0
    for line in statements:
        match = re.match(r"(?:(?:add|create|delete|destroy|flush)\s+)?table\s+(\S+)\s+(\S+?)\s*(\{)?$", line)
        if match:
            names.add((match.group(1), match.group(2)))
            if match.group(3):
                definitions += 1
    if names != {("inet", "slv")}:
        errors.append("names tables other than `inet slv`: %s" % sorted(names))
    if definitions != 1:
        errors.append("defines %d tables, not 1" % definitions)
    if re.search(r"\bflush\b", text, re.IGNORECASE):
        errors.append("contains the word flush")
    if statements and statements[-1] != "}":
        errors.append("does not end with the closing brace of the table")
    depth = 0
    for line in statements:
        code = line.split("#", 1)[0]
        depth += code.count("{") - code.count("}")
        if depth < 0:
            errors.append("closes a brace that was not opened")
            break
    if depth != 0:
        errors.append("braces are not balanced")
    return errors


def command_shape(args):
    root = Path(args.directory)
    files = sorted(root.rglob("*.nft"))
    if not files:
        sys.stdout.write("FAIL b04_table_shape: no .nft file under %s\n" % root)
        return 1
    failed = 0
    for path in files:
        errors = shape_errors(path.read_text(encoding="utf-8"))
        for error in errors:
            failed += 1
            sys.stdout.write("FAIL b04_table_shape: %s: %s\n" % (path.relative_to(root), error))
    if failed:
        return 1
    sys.stdout.write("PASS b04_table_shape (%d files)\n" % len(files))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    cells = sub.add_parser("cells", help="print the cells as JSON")
    cells.add_argument("--version-file", default=str(VERSION_FILE))
    cells.set_defaults(func=command_cells)
    check = sub.add_parser("check-table", help="compare startup_templates.yml (JSON on stdin) with the cells")
    check.set_defaults(func=command_check_table)
    pins = sub.add_parser("pins", help="check that no cell stopped with no_profile")
    pins.add_argument("directory")
    pins.add_argument("--golden")
    pins.set_defaults(func=command_pins)
    shape = sub.add_parser("shape", help="check the table of every .nft file under DIR")
    shape.add_argument("directory")
    shape.set_defaults(func=command_shape)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
