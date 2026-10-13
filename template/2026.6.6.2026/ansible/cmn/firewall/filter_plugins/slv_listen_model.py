# -*- coding: utf-8 -*-
"""slv_listen_model: derive the listen model of an slv validator or RPC node.

The model is a plain dict (JSON compatible) that says which ports the node
listens on and who may reach each of them.  It is derived from text that the
start playbooks render, from the profile of the client version, from the operator's
firewall variables and from a snapshot of host facts, plus the ports that this file
fixes for the node exporter and for each opt-in component (no host is touched, no nft
is involved).  A renderer turns the model into nftables.  The model is meant to be the
only source of the ports of the firewall; nothing in this release enforces that.

Three Jinja filters are provided:

    rendered | slv_listen_model(profile, inputs, host_facts)
    old_model | slv_listen_model_union(new_model)
    slv_fw_meta | slv_listen_model_meta

the last one checks generated_at and controller_ip, which the nft templates write into the
header comment of their files (see Errors, invalid_meta); and, because the model is meant to
be stored on the host as JSON, one helper that writes the canonical form the checksum is
computed from:

    model | slv_listen_model_canonical_json

Apart from the optional import of ansible.errors in the filter wrappers, this file
uses the Python standard library only, and it runs on Python 3.10 or newer.  For each
case listed under Errors the function raises ModelError(code, detail) instead of
guessing; the filter wrappers turn that into an AnsibleFilterError when Ansible can be
imported.

Input: rendered
    A list of items.  Each item is {"kind": <kind>, "text": <str>} or
    {"kind": <kind>, "data": <dict>}:
      agave-args   text  the start script of agave, jito or allnodes
      fd-toml      text  the Frankendancer config
      unit         text  the systemd unit (capabilities are read from it)
      richat       data  richat-setting.yml parsed with from_yaml
      yellowstone  data  geyser.json parsed with from_json
      of1-listen   text  the Old Faithful listen address, e.g. ":8888"
    Required: agave-args for agave, jito and allnodes-jito, fd-toml for the
    Frankendancer clients, and unit as well for allnodes 4.3.0-allnodes.1 (the
    capabilities decide whether packets bypass netfilter).  For role rpc: of1-listen
    for rpc_type "Index RPC" and "Index RPC + gRPC" on mainnet (init installs Old
    Faithful there and nowhere else), and richat or yellowstone (not both) for
    "Geyser gRPC" and "Index RPC + gRPC" on the agave line.  Any other kind is
    refused, so a rendered item for a listener that init does not deploy (an of1-listen
    item on testnet or devnet, for example) gives the model no port.  The ports of the
    opt-in components come from the components input, not from these items.

Input: profile
    {"client", "version", "role", "network", "rpc_type"}.  client is the slv
    validator_type: agave, jito, allnodes-jito, firedancer-agave,
    firedancer-jito or frankendancer.  role is validator or rpc, network is
    mainnet, testnet or devnet.  rpc_type is required for role rpc.

Input: inputs (each key may be left out; names are the firewall variables without slv_fw_)
    With no admin_ips and the default ssh_mode the model stops with admin_empty_refused.
    admin_ips, lb_ips, metrics_ips, deny_ips      lists of address or CIDR
    trusted_ifaces                                 list of interface names
    components                                     ["rpc-gateway", {"id": "shred-relay",
                                                   "sources": [...]}, ...]
    ip_echo_public, public_rpc, accept_xdp_rx_bypass   booleans (never strings)
    ssh_mode                  refuse (default), controller-only, public-rate-limited
    controller_ip, ssh_connection_port, ansible_port

Input: host_facts (every key is required)
    default_route_ifaces, ifaces, bridges, dhcp4_ifaces, dhcp6_ifaces,
    ra_ifaces, sshd_ports, ssh_socket_ports, sshd_listen_ports, has_global_v6.
    dhcp4_ifaces, dhcp6_ifaces and ra_ifaces are null when the host could not
    tell; the model then covers every interface of ifaces except lo and the bridges that
    carry no default route: docker0 and virbr* by name, and every entry of bridges, unless
    it is in default_route_ifaces.

Output (schema "slv-listen-model/1")
    schema, profile, udp{public, xdp, xdp_rx_bypass, xdp_bind_address, pub,
    allowlist}, tcp{public, consumer, mgmt, metrics, ssh, wg_only},
    local_only{tcp, udp}, sources{mgmt, lb, scrape, deny}{v4, v6}, ssh{mode,
    public, rate, controller_only}, consumer_public, trusted_ifaces, wireguard,
    host, components, warnings, model_sha256.
    Ports are closed intervals [lo, hi], sorted, with overlaps and neighbours
    merged.  udp.public holds the public UDP ports of the Solana client (the dynamic
    port range, a pinned gossip port, the fixed ports of Frankendancer); the public UDP
    ports of components are in udp.pub.  udp.xdp is the subset of udp.public that a
    Frankendancer net tile with a bypass provider (xdp or mlx5) takes before netfilter
    sees it; the receive-XDP sockets of an agave build are listed by name in
    udp.xdp_rx_bypass, and their ports are in udp.public like the other ports of the
    dynamic port range.  The same input gives the same canonical JSON and the same
    model_sha256, the sha256 of the canonical JSON without the model_sha256 key.
    A port is in one class only (a UDP and a TCP port of one number are two ports).  The
    table opens a port to the sources of each class that holds it, and to everybody, past
    the limit of the other class, when one of them is public; the model does not say which
    class the node means.  So it stops with class_overlap, naming the port and the two
    classes, when a port is in two of: udp.public, udp.xdp, udp.pub, udp.allowlist (each
    component), local_only.udp, the interface rules of a component (libvirt), the DHCP
    client ports of the host (udp 68 where dhcp4_ifaces names interfaces, udp 546 where
    dhcp6_ifaces does), and for TCP tcp.public, tcp.consumer, tcp.mgmt, tcp.metrics, tcp.ssh,
    tcp.wg_only, local_only.tcp.  The one overlap it allows is udp.xdp inside udp.public:
    the same ports for the same sources.  The DHCP rules of the table are stricter than the
    ports: they accept a packet on udp 68 only from source port 67 (from any IPv4 address)
    and on udp 546 only from source port 547 and a link-local address.  A listener on one
    of the two ports is refused all the same: the model says nothing about who may reach
    it, and the rule lets in whatever comes from the server port.
    slv_listen_model_union applies the same rule to its result.
      udp.pub            public UDP ports of components (wireguard)
      udp.allowlist      [{"component", "ports", "sources": {"v4", "v6"}}]: UDP ports
                         that only the listed sources may reach (shred-relay)
      udp.xdp_rx_bypass  names of the sockets that a receive-XDP build can take past
                         netfilter (the unit grants CAP_BPF and CAP_PERFMON)
      tcp.consumer       the ports of lb_ips and mgmt, or of everybody when
                         consumer_public is true; tcp.mgmt is mgmt only; tcp.metrics
                         is metrics_ips and mgmt; tcp.wg_only is reached through wg0.
                         Here mgmt is the mgmt sources and what the table treats like
                         them: trusted_ifaces and the WireGuard tunnel
      local_only         ports bound to loopback, or that are never opened
      ssh                {"mode", "public", "rate": {"burst", "new_per_minute",
                         "v6_prefix"} or null, "controller_only"}
      wireguard          {"enabled", "iface", "subnet"}; the tunnel is trusted like mgmt
      host               {"bridges", "dhcp4_ifaces", "dhcp6_ifaces", "dhcp_undetermined",
                         "ra_ifaces", "ra_undetermined"}
      components         [{"id", "class", "listeners": [{"proto", "ports", "class"}],
                         "iface_rules": [{"iifname", "proto", "ports"}]}]

Errors (ModelError.code)
    no_profile, range_too_narrow, rpc_port_in_range, fd_fixed_port_in_range,
    fd_provider_unknown, fd_config_unreadable, xdp_rx_bypass_unacknowledged,
    deny_overlaps_allow, allowlist_has_any, trusted_iface_is_uplink,
    unknown_component, component_sources_required, gateway_never_public,
    admin_empty_refused, controller_unknown, controller_not_in_admin,
    agave_args_unreadable, rendered_missing, gossip_port_unpinned, class_overlap,
    invalid_input, invalid_meta.

Warnings (model["warnings"], each {"code", "detail", ...})
    lb_empty_fail_closed, public_rpc_unauthenticated, public_rpc_no_effect,
    xdp_rx_bypass_accepted, admin_without_v6, bridges_present,
    controller_only_mgmt.
"""

import datetime
import fnmatch
import hashlib
import ipaddress
import json
import os
import re
import unicodedata
from collections import namedtuple

SCHEMA = "slv-listen-model/1"


class ModelError(Exception):
    """The model cannot be derived (or must not be): code is a stable name."""

    def __init__(self, code, detail=""):
        self.code = code
        self.detail = detail
        Exception.__init__(self, "%s: %s" % (code, detail) if detail else code)

    def __reduce__(self):
        return (self.__class__, (self.code, self.detail))


def _invalid(what, why):
    raise ModelError("invalid_input", "%s: %s" % (what, why))


# ---------------------------------------------------------------------------
# Small helpers: ports, intervals, addresses, names
# ---------------------------------------------------------------------------


def _merge(intervals):
    """Sort closed intervals and merge overlapping and adjacent ones."""
    merged = []
    for lo, hi in sorted((int(a), int(b)) for a, b in intervals):
        if merged and lo <= merged[-1][1] + 1:
            if hi > merged[-1][1]:
                merged[-1][1] = hi
        else:
            merged.append([lo, hi])
    return merged


def _port(value, what, allow_zero=False):
    """An int port from an int or a decimal string (Ansible may pass either)."""
    if isinstance(value, bool):
        _invalid(what, "must be a port number, got a boolean")
    if isinstance(value, int):
        port = value
    elif isinstance(value, str) and re.fullmatch(r"[0-9]{1,5}", value):
        port = int(value)
    else:
        _invalid(what, "must be a port number, got %r" % (value,))
    low = 0 if allow_zero else 1
    if not low <= port <= 65535:
        _invalid(what, "port %d is out of range" % port)
    return port


def _list(value, what):
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    _invalid(what, "must be a list")


def _bool(value, what):
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    _invalid(what, "must be a boolean (got %r); convert with | bool" % (value,))


_IFACE_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,14}")
_IFACE_WILDCARD_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,13}\*")


def _iface(value, what, wildcard=False):
    if isinstance(value, str) and (_IFACE_RE.fullmatch(value) or (wildcard and _IFACE_WILDCARD_RE.fullmatch(value))):
        return value
    _invalid(what, "%r is not a valid interface name" % (value,))


def _iface_list(value, what, wildcard=False):
    return sorted(set(_iface(v, what, wildcard) for v in _list(value, what)))


def _network(text, what):
    if not isinstance(text, str) or not text.strip() or "%" in text:
        _invalid(what, "%r is not an address or CIDR" % (text,))
    try:
        net = ipaddress.ip_network(text.strip(), strict=True)
    except ValueError as exc:
        _invalid(what, "%r: %s" % (text, exc))
    if net.prefixlen == 0:
        raise ModelError("allowlist_has_any", "%s contains %s" % (what, net))
    return net


def _networks(values, what):
    """Parse addresses and CIDRs into collapsed (v4, v6) lists of networks.

    A list that covers every address stops the model like a single /0 does, whether it is
    written as /0 or as pieces (two /1 networks, four /2 networks) that collapse to it.
    """
    v4, v6 = [], []
    for item in _list(values, what):
        net = _network(item, what)
        (v4 if net.version == 4 else v6).append(net)
    collapsed = (list(ipaddress.collapse_addresses(v4)), list(ipaddress.collapse_addresses(v6)))
    for net in collapsed[0] + collapsed[1]:
        if net.prefixlen == 0:
            raise ModelError("allowlist_has_any", "%s together cover %s" % (what, net))
    return collapsed


def _net_strings(pair):
    return {"v4": [str(n) for n in pair[0]], "v6": [str(n) for n in pair[1]]}


def _ip_in(pair, ip):
    nets = pair[0] if ip.version == 4 else pair[1]
    return any(ip in net for net in nets)


def _overlaps(pair_a, pair_b):
    for nets_a, nets_b in ((pair_a[0], pair_b[0]), (pair_a[1], pair_b[1])):
        for a in nets_a:
            for b in nets_b:
                if a.overlaps(b):
                    return (a, b)
    return None


def _ip_address(text, what):
    if text is None or text == "":
        return None
    if not isinstance(text, str) or "%" in text:
        _invalid(what, "%r is not an IP address" % (text,))
    try:
        ip = ipaddress.ip_address(text.strip())
    except ValueError as exc:
        _invalid(what, "%r: %s" % (text, exc))
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip


def _split_hostport(text, what):
    """'0.0.0.0:10000', ':8888', '[::]:8000' -> (host, port)."""
    if not isinstance(text, str) or not text.strip():
        _invalid(what, "must be a 'host:port' string, got %r" % (text,))
    value = text.strip()
    if value.startswith("["):
        end = value.find("]")
        if end < 0 or value[end + 1 : end + 2] != ":":
            _invalid(what, "%r is not 'host:port'" % (text,))
        host, port = value[1:end], value[end + 2 :]
    else:
        host, sep, port = value.rpartition(":")
        if not sep:
            _invalid(what, "%r is not 'host:port'" % (text,))
    return host, _port(port, what)


def _is_loopback(host):
    """True for localhost and the loopback addresses, which another machine does not reach."""
    host = (host or "").strip().lower()
    if host in ("localhost", "ip6-localhost"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback


def canonical_json(obj):
    """The one JSON form that is hashed, and that is meant to be written to disk."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _seal(model):
    body = dict(model)
    body.pop("model_sha256", None)
    digest = hashlib.sha256(canonical_json(body).encode("ascii")).hexdigest()
    body["model_sha256"] = digest
    return body


# ---------------------------------------------------------------------------
# Profiles: what each client version is known to listen on
# ---------------------------------------------------------------------------
#
# A profile is looked up by client (the slv validator_type) and an exact
# version string.  Every version listed was read from its tag; a version that
# is not listed has no profile and the model refuses (no_profile) until
# someone reads that tag and adds it.
#
# Facts that are the same for every agave-line profile below (read from each
# tag listed; the files and line numbers differ a little between tags).  Each one is
# about the files named for it: a listener opened somewhere else in the client is not in
# the model.
#   * Every UDP socket of Node::new_with_external_ip is bound inside
#     --dynamic-port-range (first free port, scanning up from MIN), except the
#     gossip socket, which is the pinned --gossip-port or the first port in
#     the range where UDP and TCP both bind.  gossip/src/node.rs
#     new_with_external_ip, net-utils/src/sockets.rs bind_gossip_port_in_range.
#   * Without --gossip-port the value is the literal 0 (validator/src/commands/
#     run/execute.rs: find_available_port_in_range(addr, (0, 1)) returns 0), so
#     the gossip port is picked inside the range at start.
#   * The only TCP sockets that the validator itself opens are the ip-echo listener
#     on the gossip port and the RPC and pubsub listeners on --rpc-port and
#     --rpc-port + 1 (a Geyser plugin loaded into it opens its own: see _add_richat and
#     _add_yellowstone).  The RPC bind address is --rpc-bind-address, else 127.0.0.1
#     with --private-rpc, else --bind-address (default 0.0.0.0): execute.rs "let
#     rpc_bind_address".
#   * --dynamic-port-range MIN-MAX is the half-open range [MIN, MAX); it is
#     refused when MAX - MIN is below MINIMUM_VALIDATOR_PORT_RANGE_WIDTH:
#     validator/src/cli.rs port_range_validator, net-utils/src/lib.rs.
#   * The default range is 8000-10000: net-utils/src/lib.rs VALIDATOR_PORT_RANGE.
#   * jito-solana and allnodes/solana-jito add no inbound listener over agave
#     (their additions are gRPC clients and a UDP sampler on an ephemeral port).
#
# Facts that differ between profiles are the fields of the tuples below.

_Profile = namedtuple(
    "_Profile",
    "id family clients versions min_range_width rx_xdp net_providers",
)

DEFAULT_RANGE = (8000, 10000)  # half-open, the agave default

# allnodes/solana-jito@v4.3.0-allnodes.1 validator/src/commands/run/xdp_receive.rs
# (groups(): tpu_quic, tvu, repair, serve_repair, ancestor_hashes_requests,
# block_id_repair, tpu_vote, tpu_forwards_quic) redirect these eight UDP sockets
# with AF_XDP past netfilter when CAP_BPF and CAP_PERFMON are available
# (receive_capabilities(); README.md "Only the first pair is required").
_ALLNODES_RX_XDP = (
    "ancestor_hashes",
    "block_id_repair",
    "repair",
    "serve_repair",
    "tpu_fwd_quic",
    "tpu_quic",
    "tpu_vote",
    "tvu",
)

# Frankendancer sockets (the same in both tags below; each statement is about the files
# named for it):
#   * The Agave child process is started with the config values --gossip-port,
#     --dynamic-port-range, --rpc-port, --private-rpc, --rpc-bind-address and
#     --bind-address (src/app/fdctl/commands/run_agave.c), so it follows the
#     agave-line facts above; its gossip port is [gossip].port (default 8001).
#   * The net tile gets only shred_listen_port, quic_transaction_listen_port
#     and legacy_transaction_listen_port (src/app/fdctl/topology.c,
#     fd_topo_configure_tile): the UDP ports 8003, 9007 and 9001 by default.
#     With provider "xdp" (or "mlx5") the tile takes those three before netfilter
#     sees them (a packet it does not take still reaches the kernel); with "socket"
#     they are ordinary kernel sockets.
#   * fdctl refuses a config where one of those three ports is inside the
#     dynamic port range (src/app/shared/fd_config.c, "must be outside the
#     dynamic port range"); the default.toml comment says the range must not
#     overlap any static port, so [gossip].port is held to the same rule here.
#   * [tiles.gui] and [tiles.metric] default to 127.0.0.1 (ports 80 and 7999).
#   * [rpc].port defaults to 0 (JSON RPC off).
_FD_DEFAULTS = {
    "dynamic_port_range": "8900-9000",
    "gossip_port": 8001,
    "rpc_port": 0,
    "rpc_private": False,
    "rpc_bind_address": "",
    "net_provider": "xdp",
    "net_bind_address": "",
    "shred_port": 8003,
    "tpu_port": 9001,
    "tpu_quic_port": 9007,
    "gui_enabled": True,
    "gui_address": "127.0.0.1",
    "gui_port": 80,
    "metric_address": "127.0.0.1",
    "metric_port": 7999,
}

_PROFILES = (
    # anza-xyz/agave@v3.1.10
    #   net-utils/src/lib.rs:70 MINIMUM_VALIDATOR_PORT_RANGE_WIDTH = 25, :60 default range
    #   gossip/src/node.rs:84 new_with_external_ip: 22 UDP sockets in the range plus gossip
    #   validator/src/commands/run/execute.rs gossip_port:792 rpc_bind_address:248 rpc_addrs:545
    #   xdp-ebpf has no redirect: nothing is received past netfilter
    _Profile("agave-3.1.10", "agave", ("agave",), ("3.1.10",), 25, (), {}),
    # anza-xyz/agave@v4.0.0-beta.2
    #   net-utils/src/lib.rs:60 width 25, :50 default range
    #   gossip/src/node.rs:135: 19 UDP sockets in the range plus gossip
    #   execute.rs gossip_port:210 rpc_bind_address:477 rpc_addrs:786
    _Profile("agave-4.0.0-beta.2", "agave", ("agave",), ("4.0.0-beta.2",), 25, (), {}),
    # anza-xyz/agave@v4.3.0 and anza-xyz/agave@v4.4.0-beta.0 (gossip/src/node.rs is identical)
    #   net-utils/src/lib.rs width 26 (v4.3.0:62, v4.4.0-beta.0:63), default range (:52, :53)
    #   gossip/src/node.rs:122: 17 UDP sockets in the range plus gossip
    #   execute.rs gossip_port rpc_bind_address rpc_addrs: v4.3.0 222 537 807, v4.4.0-beta.0 221 537 806
    #   xdp-ebpf has no redirect: nothing is received past netfilter
    _Profile("agave-4.3.0", "agave", ("agave",), ("4.3.0", "4.4.0-beta.0"), 26, (), {}),
    # jito-foundation/jito-solana@v3.1.10-jito
    #   net-utils/src/lib.rs:70 width 25; gossip/src/node.rs:84 (the agave 3.1.10 sockets)
    #   execute.rs gossip_port:878 rpc_bind_address:254 rpc_addrs:623
    _Profile("jito-3.1.10-jito", "agave", ("jito",), ("3.1.10-jito",), 25, (), {}),
    # jito-foundation/jito-solana@v4.0.0-beta.2-jito
    #   net-utils/src/lib.rs:60 width 25; gossip/src/node.rs:135 (identical to agave 4.0.0-beta.2)
    #   execute.rs gossip_port:216 rpc_bind_address:483 rpc_addrs:852
    _Profile("jito-4.0.0-beta.2-jito", "agave", ("jito",), ("4.0.0-beta.2-jito",), 25, (), {}),
    # jito-foundation/jito-solana@v4.3.0-jito.0
    #   net-utils/src/lib.rs:62 width 26; gossip/src/node.rs:122 (identical to agave 4.3.0)
    #   execute.rs gossip_port:230 rpc_bind_address:545 rpc_addrs:877
    _Profile("jito-4.3.0-jito.0", "agave", ("jito",), ("4.3.0-jito.0",), 26, (), {}),
    # allnodes/solana-jito@v3.1.14-allnodes
    #   net-utils/src/lib.rs:70 width 25; gossip/src/node.rs:84 (the agave 3.1.10 sockets)
    #   execute.rs gossip_port:846 rpc_bind_address:239 rpc_addrs:626
    #   No validator/src/commands/run/xdp_receive.rs, and xdp-ebpf/src/bin/agave-xdp-prog.rs only
    #   returns XDP_PASS or XDP_DROP: nothing is received past netfilter.
    _Profile("allnodes-3.1.14", "agave", ("allnodes-jito",), ("3.1.14",), 25, (), {}),
    # allnodes/solana-jito@v4.3.0-allnodes.1
    #   net-utils/src/lib.rs:62 width 26; gossip/src/node.rs:122
    #   execute.rs gossip_port:258 rpc_bind_address:679 rpc_addrs:1019
    #   Receive XDP: validator/src/commands/run/xdp_receive.rs (see _ALLNODES_RX_XDP).
    _Profile(
        "allnodes-4.3.0-allnodes.1",
        "agave",
        ("allnodes-jito",),
        ("4.3.0-allnodes.1",),
        26,
        _ALLNODES_RX_XDP,
        {},
    ),
    # firedancer-io/firedancer@v0.814.30108 (Frankendancer)
    #   src/app/fdctl/config/default.toml: :62 dynamic_port_range, :289 [gossip].port, :295 [rpc].port,
    #   :307 [rpc].private, :313 [rpc].bind_address, :928 [net].provider, :947 [net].bind_address,
    #   :1096 and :1101 quic ports, :1385 shred port, :1412-:1416 metric, :1433-:1436 gui
    #   src/app/fdctl/topology.c:423-425 (the three ports the net tile gets)
    #   src/app/shared/fd_config.c:166-185 (those ports outside the range), :550 (provider "xdp" or "socket")
    #   Its Agave child is firedancer-io/agave@3e1fa5c5837c4e3f77646adcfaaf6fb2501bc917:
    #   net-utils/src/lib.rs:70 width 25, gossip/src/node.rs:84, execute.rs gossip_port:865 rpc_bind_address:321
    _Profile(
        "frankendancer-0.814.30108",
        "frankendancer",
        ("firedancer-agave", "firedancer-jito", "frankendancer"),
        ("0.814.30108",),
        25,
        (),
        {"xdp": "bypass", "socket": "kernel"},
    ),
    # firedancer-io/firedancer@v0.1204.40300 (Frankendancer)
    #   src/app/fdctl/config/default.toml: :62, :298 [gossip].port, :304 [rpc].port, :316 private,
    #   :322 bind_address, :920 [net].provider, :936 [net].bind_address, :1170 and :1175 quic ports,
    #   :1455 shred port, :1482-:1486 metric, :1503-:1506 gui
    #   src/app/fdctl/topology.c:428-430; src/app/shared/fd_config.c:198-217 (ports outside the range),
    #   :568-610 (provider "xdp", "socket" or "mlx5"; "auto" exists only in full Firedancer and
    #   fdctl rejects it)
    #   Its Agave child is firedancer-io/agave@535ec972e6f0037b6a4c5a5e98cff4597781e678:
    #   net-utils/src/lib.rs:62 width 26, gossip/src/node.rs:122, execute.rs gossip_port:294 rpc_bind_address:621
    _Profile(
        "frankendancer-0.1204.40300",
        "frankendancer",
        ("firedancer-agave", "firedancer-jito", "frankendancer"),
        ("0.1204.40300",),
        26,
        (),
        {"xdp": "bypass", "mlx5": "bypass", "socket": "kernel"},
    ),
)

ROLES = ("validator", "rpc")
NETWORKS = ("mainnet", "testnet", "devnet")
RPC_TYPES = ("Geyser gRPC", "Index RPC", "Index RPC + gRPC", "SendTx RPC")


def _find_profile(client, version):
    for prof in _PROFILES:
        if client in prof.clients and version in prof.versions:
            return prof
    known = sorted(set(v for p in _PROFILES if client in p.clients for v in p.versions))
    raise ModelError(
        "no_profile",
        "no profile for client %r version %r (versions with a profile for this client: %s)"
        % (client, version, ", ".join(known) if known else "none"),
    )


# ---------------------------------------------------------------------------
# Reading the rendered start script (agave, jito, allnodes)
# ---------------------------------------------------------------------------

_TEMPLATE_MARKER_RE = re.compile(r"\{\{|\{%")


class _Words(object):
    """Collects words and commands while _shell_commands walks the script."""

    def __init__(self):
        self.commands = []
        self.words = []
        self.buf = []
        self.in_word = False

    def add(self, text):
        self.buf.append(text)
        self.in_word = True

    def end_word(self):
        if self.in_word:
            self.words.append("".join(self.buf))
            self.buf = []
            self.in_word = False

    def end_command(self):
        self.end_word()
        if self.words:
            self.commands.append(self.words)
            self.words = []


def _shell_commands(text):
    """Split a shell script into commands, each a list of words.

    Enough shell for a rendered start script: line continuations, comments
    (only at the start of a word), single and double quotes, and the command
    separators newline ; & | < > ( ).  Variables and command substitutions are
    not expanded; a word that still contains one is rejected by the caller.
    """
    out = _Words()
    i, n = 0, len(text)
    while i < n:
        ch = text[i]
        if ch == "\\":
            if text[i + 1 : i + 2] == "\n":
                i += 2
            elif text[i + 1 : i + 3] == "\r\n":
                i += 3
            elif i + 1 < n:
                out.add(text[i + 1])
                i += 2
            else:
                i += 1
        elif ch == "'":
            end = text.find("'", i + 1)
            if end < 0:
                raise ValueError("unterminated single quote")
            out.add(text[i + 1 : end])
            i = end + 1
        elif ch == '"':
            i += 1
            out.add("")
            while True:
                if i >= n:
                    raise ValueError("unterminated double quote")
                c = text[i]
                if c == '"':
                    i += 1
                    break
                if c == "\\" and i + 1 < n and text[i + 1] in '"\\$`\n':
                    if text[i + 1] != "\n":
                        out.add(text[i + 1])
                    i += 2
                else:
                    out.add(c)
                    i += 1
        elif ch == "#" and not out.in_word:
            while i < n and text[i] != "\n":
                i += 1
        elif ch in " \t\r":
            out.end_word()
            i += 1
        elif ch == "\n" or ch in "|&;<>()":
            out.end_command()
            i += 1
        else:
            out.add(ch)
            i += 1
    out.end_command()
    return out.commands


_WRAPPERS = ("exec", "env", "nohup", "command")
_VALIDATOR_BINARIES = ("agave-validator", "solana-validator")
_AGAVE_VALUE_FLAGS = (
    "--dynamic-port-range",
    "--gossip-port",
    "--rpc-port",
    "--rpc-bind-address",
    "--bind-address",
)


def _parse_port_range(text, what, error_code):
    """MIN-MAX as agave and fdctl read it -> (min, max); the range is [min, max)."""
    parts = text.split("-")
    if len(parts) != 2 or not all(re.fullmatch(r"\+?[0-9]+", p) for p in parts):
        raise ModelError(error_code, "%s %r is not MIN-MAX" % (what, text))
    low, high = int(parts[0]), int(parts[1])
    if high > 65535 or high < low:
        raise ModelError(error_code, "%s %r is not a valid port range" % (what, text))
    return low, high


def _parse_agave_args(text):
    """Read the flags that decide what the node listens on from a start script."""
    code = "agave_args_unreadable"
    if _TEMPLATE_MARKER_RE.search(text):
        raise ModelError(code, "the start script still contains template markers")
    try:
        commands = _shell_commands(text)
    except ValueError as exc:
        raise ModelError(code, "the start script cannot be read: %s" % exc)
    args = None
    for words in commands:
        rest = list(words)
        while rest and (rest[0] in _WRAPPERS or re.match(r"[A-Za-z_][A-Za-z0-9_]*=", rest[0])):
            rest.pop(0)
        if rest and os.path.basename(rest[0]) in _VALIDATOR_BINARIES:
            args = rest[1:]
            break
    if args is None:
        raise ModelError(code, "no agave-validator command in the start script")

    single = {}
    bind_addresses = []
    private_rpc = False
    i = 0
    while i < len(args):
        word = args[i]
        i += 1
        if not word.startswith("--"):
            continue
        name, equals, value = word.partition("=")
        if name == "--private-rpc":
            if equals:
                raise ModelError(code, "--private-rpc takes no value")
            private_rpc = True
            continue
        if name not in _AGAVE_VALUE_FLAGS:
            continue
        if not equals:
            if i >= len(args):
                raise ModelError(code, "%s has no value" % name)
            value = args[i]
            i += 1
        if re.search(r"[$`{}]", value):
            raise ModelError(code, "%s value %r cannot be resolved" % (name, value))
        if name == "--bind-address":
            bind_addresses.append(value)
        elif name in single:
            raise ModelError(code, "%s is given more than once" % name)
        else:
            single[name] = value

    result = {
        "range": None,
        "gossip_port": None,
        "rpc_port": None,
        "rpc_bind": single.get("--rpc-bind-address"),
        "bind": bind_addresses[0] if bind_addresses else "0.0.0.0",
        "private_rpc": private_rpc,
    }
    if "--dynamic-port-range" in single:
        result["range"] = _parse_port_range(single["--dynamic-port-range"], "--dynamic-port-range", code)
    for flag, key, zero_ok in (
        ("--gossip-port", "gossip_port", True),
        ("--rpc-port", "rpc_port", False),
    ):
        if flag in single:
            try:
                number = _port(single[flag], flag, allow_zero=zero_ok)
            except ModelError as exc:
                raise ModelError(code, exc.detail)
            # agave treats --gossip-port 0 as "not given" (bind_gossip_port_in_range)
            result[key] = number or None
    if result["rpc_port"] is not None and result["rpc_port"] > 65534:
        raise ModelError(code, "--rpc-port %d leaves no port for pubsub" % result["rpc_port"])
    return result


def _agave_rpc_loopback(args):
    """The RPC bind address rule of validator/src/commands/run/execute.rs."""
    if args["rpc_bind"] is not None:
        return _is_loopback(args["rpc_bind"])
    if args["private_rpc"]:
        return True
    return _is_loopback(args["bind"])


# ---------------------------------------------------------------------------
# Reading the rendered Frankendancer config (a small, strict TOML subset)
# ---------------------------------------------------------------------------

_TOML_HEADER_RE = re.compile(r"\[\s*([^\[\]]+?)\s*\]\s*(?:#.*)?")
_TOML_KEY_RE = re.compile(r"([A-Za-z0-9_-]+(?:\s*\.\s*[A-Za-z0-9_-]+)*)\s*=\s*(.*)", re.DOTALL)

# (table, key) -> type of the keys this reader returns; the other key lines are read past
_FD_KEYS = {
    ("", "dynamic_port_range"): "str",
    ("gossip", "port"): "int",
    ("rpc", "port"): "int",
    ("rpc", "private"): "bool",
    ("rpc", "bind_address"): "str",
    ("net", "provider"): "str",
    ("net", "bind_address"): "str",
    ("tiles.shred", "shred_listen_port"): "int",
    ("tiles.quic", "regular_transaction_listen_port"): "int",
    ("tiles.quic", "quic_transaction_listen_port"): "int",
    ("tiles.gui", "enabled"): "bool",
    ("tiles.gui", "gui_listen_address"): "str",
    ("tiles.gui", "gui_listen_port"): "int",
    ("tiles.metric", "prometheus_listen_address"): "str",
    ("tiles.metric", "prometheus_listen_port"): "int",
}

_TOML_ESCAPES = {"b": "\b", "t": "\t", "n": "\n", "f": "\f", "r": "\r", '"': '"', "\\": "\\"}


def _toml_unreadable(where, why):
    raise ModelError("fd_config_unreadable", "%s: %s" % (where, why))


def _toml_value_extent(rest, lines, index):
    """Join the lines of a multi-line string, array or inline table.

    Returns (text, index of the next unread line).  It is called for every key line, so
    that the lines inside a multi-line value are not mistaken for keys or table headers; a
    key that this reader returns must have a one-line value (_read_fd_toml refuses the
    others).
    """
    stripped = rest.lstrip()
    for quote in ('"""', "'''"):
        if stripped.startswith(quote) and quote not in stripped[3:]:
            parts = [rest]
            while index < len(lines):
                parts.append(lines[index])
                index += 1
                if quote in parts[-1]:
                    break
            return "\n".join(parts), index
    if stripped[:1] not in ("[", "{"):
        return rest, index
    parts, depth = [rest], 0
    current = rest
    while True:
        quote_char = None  # a single-line string cannot continue on the next line
        i = 0
        while i < len(current):
            c = current[i]
            if quote_char:
                if c == "\\" and quote_char == '"':
                    i += 1
                elif c == quote_char:
                    quote_char = None
            elif c in "\"'":
                quote_char = c
            elif c == "#":
                break
            elif c in "[{":
                depth += 1
            elif c in "]}":
                depth -= 1
            i += 1
        if depth <= 0 or index >= len(lines):
            return "\n".join(parts), index
        current = lines[index]
        parts.append(current)
        index += 1


def _toml_scalar(raw, kind, where):
    text = raw.strip()
    if kind == "str":
        if text.startswith('"') and not text.startswith('"""'):
            out, i = [], 1
            while True:
                if i >= len(text):
                    _toml_unreadable(where, "unterminated string")
                c = text[i]
                if c == '"':
                    i += 1
                    break
                if c == "\\":
                    nxt = text[i + 1 : i + 2]
                    if nxt in _TOML_ESCAPES:
                        out.append(_TOML_ESCAPES[nxt])
                        i += 2
                        continue
                    _toml_unreadable(where, "unsupported escape in string")
                out.append(c)
                i += 1
            tail = text[i:].strip()
        elif text.startswith("'") and not text.startswith("'''"):
            end = text.find("'", 1)
            if end < 0:
                _toml_unreadable(where, "unterminated string")
            out, tail = [text[1:end]], text[end + 1 :].strip()
        else:
            _toml_unreadable(where, "expected a single-line string")
        if tail and not tail.startswith("#"):
            _toml_unreadable(where, "unexpected text after the string")
        return "".join(out)
    if kind == "bool":
        match = re.fullmatch(r"(true|false)\s*(?:#.*)?", text)
        if not match:
            _toml_unreadable(where, "expected true or false")
        return match.group(1) == "true"
    match = re.fullmatch(
        r"([+-]?[0-9]+(?:_[0-9]+)*|0x[0-9A-Fa-f]+(?:_[0-9A-Fa-f]+)*"
        r"|0o[0-7]+(?:_[0-7]+)*|0b[01]+(?:_[01]+)*)\s*(?:#.*)?",
        text,
    )
    if not match:
        _toml_unreadable(where, "expected an integer")
    digits = match.group(1).replace("_", "")
    base = {"0x": 16, "0o": 8, "0b": 2}.get(digits[:2].lower(), 10)
    return int(digits, base)


def _read_fd_toml(text):
    """Return {(table, key): value} for the keys in _FD_KEYS found in the text."""
    if _TEMPLATE_MARKER_RE.search(text):
        _toml_unreadable("fd-toml", "the config still contains template markers")
    values = {}
    table = ""
    lines = text.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        index += 1
        if not line or line.startswith("#"):
            continue
        if line.startswith("[["):
            table = None  # array of tables: none of the keys we read live there
            continue
        header = _TOML_HEADER_RE.fullmatch(line)
        if header:
            names = [p.strip() for p in header.group(1).split(".")]
            table = ".".join(names) if all(re.fullmatch(r"[A-Za-z0-9_-]+", p) for p in names) else None
            continue
        key_match = _TOML_KEY_RE.fullmatch(line)
        if not key_match:
            continue
        key_path = re.sub(r"\s+", "", key_match.group(1))
        rest, index = _toml_value_extent(key_match.group(2), lines, index)
        if table is None:
            continue
        sub_table, _, key = key_path.rpartition(".")
        full_table = ".".join(p for p in (table, sub_table) if p)
        kind = _FD_KEYS.get((full_table, key))
        if kind is None:
            continue
        where = "%s.%s" % (full_table, key) if full_table else key
        if "\n" in rest:
            _toml_unreadable(where, "the value spans several lines")
        if (full_table, key) in values:
            _toml_unreadable(where, "the key is given more than once")
        values[(full_table, key)] = _toml_scalar(rest, kind, where)
    return values


def _parse_fd_config(text):
    """The listen-relevant values of a Frankendancer config, defaults filled in."""
    found = _read_fd_toml(text)

    def get(table, key, default):
        return found.get((table, key), default)

    d = _FD_DEFAULTS
    cfg = {
        "dynamic_port_range": get("", "dynamic_port_range", d["dynamic_port_range"]),
        "gossip_port": get("gossip", "port", d["gossip_port"]),
        "rpc_port": get("rpc", "port", d["rpc_port"]),
        "rpc_private": get("rpc", "private", d["rpc_private"]),
        "rpc_bind_address": get("rpc", "bind_address", d["rpc_bind_address"]),
        "net_provider": get("net", "provider", d["net_provider"]),
        "net_bind_address": get("net", "bind_address", d["net_bind_address"]),
        "shred_port": get("tiles.shred", "shred_listen_port", d["shred_port"]),
        "tpu_port": get("tiles.quic", "regular_transaction_listen_port", d["tpu_port"]),
        "tpu_quic_port": get("tiles.quic", "quic_transaction_listen_port", d["tpu_quic_port"]),
        "gui_enabled": get("tiles.gui", "enabled", d["gui_enabled"]),
        "gui_address": get("tiles.gui", "gui_listen_address", d["gui_address"]),
        "gui_port": get("tiles.gui", "gui_listen_port", d["gui_port"]),
        "metric_address": get("tiles.metric", "prometheus_listen_address", d["metric_address"]),
        "metric_port": get("tiles.metric", "prometheus_listen_port", d["metric_port"]),
    }
    cfg["range"] = _parse_port_range(cfg["dynamic_port_range"], "dynamic_port_range", "fd_config_unreadable")
    if cfg["net_bind_address"]:
        try:
            ipaddress.IPv4Address(cfg["net_bind_address"])
        except ValueError:
            _toml_unreadable("net.bind_address", "%r is not an IPv4 address" % cfg["net_bind_address"])
    for key in ("gossip_port", "shred_port", "tpu_port", "tpu_quic_port", "gui_port", "metric_port"):
        if not 1 <= cfg[key] <= 65535:
            _toml_unreadable(key, "port %d is out of range" % cfg[key])
    if not 0 <= cfg["rpc_port"] <= 65534:
        _toml_unreadable("rpc.port", "port %d is out of range" % cfg["rpc_port"])
    return cfg


def _fd_rpc_loopback(cfg):
    if cfg["rpc_bind_address"]:
        return _is_loopback(cfg["rpc_bind_address"])
    if cfg["rpc_private"]:
        return True
    return _is_loopback(cfg["net_bind_address"]) if cfg["net_bind_address"] else False


# ---------------------------------------------------------------------------
# Reading the rendered systemd unit
# ---------------------------------------------------------------------------


def _directive_lists(text, directive):
    """(positive names, [inverted name sets]) of every <directive>= line in a unit.

    Lines may be continued with a trailing backslash; an empty assignment resets
    the list, as in systemd.
    """
    positive, inverted = [], []
    logical, carry = [], ""
    for raw in text.splitlines():
        line = carry + raw.strip() if carry else raw.strip()
        carry = ""
        if line.endswith("\\"):
            carry = line[:-1] + " "
            continue
        logical.append(line)
    for line in logical:
        if not line or line[0] in "#;[":
            continue
        name, equals, value = line.partition("=")
        if not equals or name.strip() != directive:
            continue
        tokens = value.split()
        if not tokens:
            positive, inverted = [], []
        elif tokens[0].startswith("~"):
            inverted.append(set(t.lstrip("~").upper() for t in tokens))
        else:
            positive.extend(t.upper() for t in tokens)
    return positive, inverted


def _unit_may_grant(text, capability):
    """True when the unit gives the process the capability, or lets it be raised.

    AmbientCapabilities= grants (a positive list, or an inverted list that does not
    name it).  CapabilityBoundingSet= only limits, but a positive list there is what
    lets a file capability on the binary take effect, so it counts too.  An inverted
    bounding set is ordinary hardening and does not.
    """
    ambient, ambient_inverted = _directive_lists(text, "AmbientCapabilities")
    bounding, _ = _directive_lists(text, "CapabilityBoundingSet")
    return capability in ambient or capability in bounding or any(capability not in names for names in ambient_inverted)


# ---------------------------------------------------------------------------
# Validating the inputs
# ---------------------------------------------------------------------------

SSH_MODES = ("refuse", "controller-only", "public-rate-limited")
SSH_RATE = {"burst": 5, "new_per_minute": 10, "v6_prefix": 64}

_INPUT_KEYS = (
    "admin_ips",
    "lb_ips",
    "metrics_ips",
    "deny_ips",
    "trusted_ifaces",
    "components",
    "ip_echo_public",
    "public_rpc",
    "accept_xdp_rx_bypass",
    "ssh_mode",
    "controller_ip",
    "ssh_connection_port",
    "ansible_port",
)

_HOST_FACT_KEYS = (
    "default_route_ifaces",
    "ifaces",
    "bridges",
    "dhcp4_ifaces",
    "dhcp6_ifaces",
    "ra_ifaces",
    "sshd_ports",
    "ssh_socket_ports",
    "sshd_listen_ports",
    "has_global_v6",
)

# The class of each opt-in component is fixed here; an installer can only pass
# parameters (sources).  The port numbers are the defaults of the installers, not read
# from an inventory.  rpc-gateway: bound to 0.0.0.0, no authentication, so a consumer
# port.  shred-relay: UDP 20001 is reachable from an allowlist only; install_local_shred_relay.yml
# passes the proxy a gRPC port (19999) and no bind address, so the firewall is what keeps
# that port from other machines.  wireguard: 51820/udp is public and the tunnel (wg0,
# 10.0.0.0/24) is trusted like mgmt.  gateway: reachable through the tunnel only.  nginx:
# 80 and 443 are public.  libvirt: DHCP and DNS for the VMs, from virbr* interfaces only.
_COMPONENT_CLASS = {
    "rpc-gateway": "consumer",
    "shred-relay": "allowlist",
    "wireguard": "public",
    "gateway": "wg_only",
    "nginx": "public",
    "libvirt": "iface",
}
WIREGUARD_IFACE = "wg0"
WIREGUARD_SUBNET = "10.0.0.0/24"


def _profile_input(profile):
    if not isinstance(profile, dict):
        _invalid("profile", "must be a mapping")
    extra = sorted(str(k) for k in profile if k not in ("client", "version", "role", "network", "rpc_type"))
    if extra:
        _invalid("profile", "unknown keys: %s" % ", ".join(extra))
    for key in ("client", "version"):
        if not isinstance(profile.get(key), str) or not profile[key].strip():
            _invalid("profile.%s" % key, "must be a non-empty string")
    role = profile.get("role")
    if role not in ROLES:
        _invalid("profile.role", "must be one of %s" % ", ".join(ROLES))
    network = profile.get("network")
    if network not in NETWORKS:
        _invalid("profile.network", "must be one of %s" % ", ".join(NETWORKS))
    rpc_type = profile.get("rpc_type") or None
    if role == "rpc":
        if rpc_type not in RPC_TYPES:
            _invalid("profile.rpc_type", "must be one of %s for role rpc" % ", ".join(RPC_TYPES))
    else:
        rpc_type = None
    version = profile["version"].strip()
    return {
        "client": profile["client"].strip(),
        "version": version[1:] if version.startswith("v") else version,
        "role": role,
        "network": network,
        "rpc_type": rpc_type,
    }


def _component_list(values):
    seen = set()
    result = []
    for item in _list(values, "components"):
        if isinstance(item, str):
            item = {"id": item}
        if not isinstance(item, dict):
            _invalid("components", "each entry is an id or a mapping with an id")
        extra = sorted(str(k) for k in item if k not in ("id", "sources", "public", "class"))
        if extra:
            _invalid("components", "unknown keys: %s" % ", ".join(extra))
        cid = item.get("id")
        if not isinstance(cid, str) or cid not in _COMPONENT_CLASS:
            raise ModelError(
                "unknown_component",
                "component %r is not one of %s" % (cid, ", ".join(sorted(_COMPONENT_CLASS))),
            )
        if cid in seen:
            _invalid("components", "component %s is listed twice" % cid)
        seen.add(cid)
        fixed = _COMPONENT_CLASS[cid]
        public = item.get("public")
        if public is not None and not isinstance(public, bool):
            _invalid("components[%s].public" % cid, "must be a boolean")
        requested = item.get("class")
        if cid == "gateway" and (public or requested in ("public", "consumer")):
            raise ModelError(
                "gateway_never_public",
                "the gateway port is reachable through the tunnel only; it cannot be public or consumer",
            )
        if public and fixed != "public":
            _invalid("components[%s].public" % cid, "the class of %s is fixed (%s)" % (cid, fixed))
        if requested is not None and requested != fixed:
            _invalid("components[%s].class" % cid, "the class of %s is fixed (%s)" % (cid, fixed))
        sources = None
        if item.get("sources") is not None:
            if cid != "shred-relay":
                _invalid("components[%s].sources" % cid, "this component takes no sources")
            sources = _networks(item["sources"], "components[%s].sources" % cid)
        if cid == "shred-relay" and not (sources and (sources[0] or sources[1])):
            raise ModelError(
                "component_sources_required",
                "shred-relay needs the sender addresses it accepts shreds from",
            )
        result.append({"id": cid, "class": fixed, "sources": sources})
    return sorted(result, key=lambda c: c["id"])


def _inputs(inputs):
    if inputs is None:
        inputs = {}
    if not isinstance(inputs, dict):
        _invalid("inputs", "must be a mapping")
    extra = sorted(str(k) for k in inputs if k not in _INPUT_KEYS)
    if extra:
        _invalid("inputs", "unknown keys: %s" % ", ".join(extra))
    mode = inputs.get("ssh_mode") or "refuse"
    if mode not in SSH_MODES:
        _invalid("inputs.ssh_mode", "must be one of %s" % ", ".join(SSH_MODES))
    ssh_connection_port = inputs.get("ssh_connection_port")
    ansible_port = inputs.get("ansible_port")
    return {
        "admin": _networks(inputs.get("admin_ips"), "admin_ips"),
        "lb": _networks(inputs.get("lb_ips"), "lb_ips"),
        "scrape": _networks(inputs.get("metrics_ips"), "metrics_ips"),
        "deny": _networks(inputs.get("deny_ips"), "deny_ips"),
        "trusted_ifaces": _iface_list(inputs.get("trusted_ifaces"), "trusted_ifaces", wildcard=True),
        "components": _component_list(inputs.get("components")),
        "ip_echo_public": _bool(inputs.get("ip_echo_public"), "inputs.ip_echo_public"),
        "public_rpc": _bool(inputs.get("public_rpc"), "inputs.public_rpc"),
        "accept_xdp_rx_bypass": _bool(inputs.get("accept_xdp_rx_bypass"), "inputs.accept_xdp_rx_bypass"),
        "ssh_mode": mode,
        "controller_ip": _ip_address(inputs.get("controller_ip"), "inputs.controller_ip"),
        "ssh_connection_port": (
            None if ssh_connection_port in (None, "") else _port(ssh_connection_port, "inputs.ssh_connection_port")
        ),
        "ansible_port": None if ansible_port in (None, "") else _port(ansible_port, "inputs.ansible_port"),
    }


def _port_list(value, what):
    return sorted(set(_port(p, what) for p in _list(value, what)))


def _host_facts(facts):
    if not isinstance(facts, dict):
        _invalid("host_facts", "is required and must be a mapping")
    missing = [k for k in _HOST_FACT_KEYS if k not in facts]
    if missing:
        _invalid("host_facts", "missing keys: %s" % ", ".join(missing))

    def optional_ifaces(key):
        return None if facts[key] is None else _iface_list(facts[key], "host_facts.%s" % key)

    has_v6 = facts["has_global_v6"]
    if not isinstance(has_v6, bool):
        _invalid("host_facts.has_global_v6", "must be a boolean")
    return {
        "default_route_ifaces": _iface_list(facts["default_route_ifaces"], "host_facts.default_route_ifaces"),
        "ifaces": _iface_list(facts["ifaces"], "host_facts.ifaces"),
        "bridges": _iface_list(facts["bridges"], "host_facts.bridges"),
        "dhcp4_ifaces": optional_ifaces("dhcp4_ifaces"),
        "dhcp6_ifaces": optional_ifaces("dhcp6_ifaces"),
        "ra_ifaces": optional_ifaces("ra_ifaces"),
        "sshd_ports": _port_list(facts["sshd_ports"], "host_facts.sshd_ports"),
        "ssh_socket_ports": _port_list(facts["ssh_socket_ports"], "host_facts.ssh_socket_ports"),
        "sshd_listen_ports": _port_list(facts["sshd_listen_ports"], "host_facts.sshd_listen_ports"),
        "has_global_v6": has_v6,
    }


_TEXT_KINDS = ("agave-args", "fd-toml", "unit", "of1-listen")
_DATA_KINDS = ("richat", "yellowstone")


def _rendered_items(rendered, prof, role, network, rpc_type):
    """Check the list of rendered items against what this profile and role need."""
    items = {}
    for entry in _list(rendered, "rendered"):
        if not isinstance(entry, dict):
            _invalid("rendered", "each item is a mapping with a kind")
        kind = entry.get("kind")
        if kind in _TEXT_KINDS:
            if set(entry) != set(("kind", "text")) or not isinstance(entry["text"], str):
                _invalid("rendered[%s]" % kind, "must be {kind, text} with a string text")
            value = entry["text"]
        elif kind in _DATA_KINDS:
            if set(entry) != set(("kind", "data")) or not isinstance(entry["data"], dict):
                _invalid("rendered[%s]" % kind, "must be {kind, data} with a parsed mapping")
            value = entry["data"]
        else:
            _invalid("rendered", "unknown kind %r" % (kind,))
        if kind in items:
            _invalid("rendered", "kind %s is given twice" % kind)
        items[kind] = value

    main, other = ("agave-args", "fd-toml") if prof.family == "agave" else ("fd-toml", "agave-args")
    if main not in items:
        raise ModelError("rendered_missing", "kind %s is required for client family %s" % (main, prof.family))
    if other in items:
        _invalid("rendered", "kind %s does not belong to %s" % (other, prof.id))
    if prof.rx_xdp and "unit" not in items:
        raise ModelError(
            "rendered_missing",
            "kind unit is required for %s: its capabilities decide whether packets bypass netfilter" % prof.id,
        )

    groups = []  # each group: one of these kinds must be present
    if role == "rpc":
        if rpc_type in ("Geyser gRPC", "Index RPC + gRPC") and prof.family == "agave":
            groups.append(("richat", "yellowstone"))
        # init installs Old Faithful on mainnet only: elsewhere Index RPC has no such listener
        if rpc_type in ("Index RPC", "Index RPC + gRPC") and network == "mainnet":
            groups.append(("of1-listen",))
    allowed = set(k for g in groups for k in g)
    for kind in ("richat", "yellowstone", "of1-listen"):
        if kind in items and kind not in allowed:
            _invalid(
                "rendered",
                "kind %s is not expected for role %s%s on %s (%s)"
                % (kind, role, " " + rpc_type if rpc_type else "", prof.id, network),
            )
    for group in groups:
        present = [k for k in group if k in items]
        if not present:
            raise ModelError(
                "rendered_missing",
                "%s is required for rpc_type %s" % (" or ".join(group), rpc_type),
            )
        if len(present) > 1:
            _invalid("rendered", "%s cannot both be deployed" % " and ".join(present))
    return items


# ---------------------------------------------------------------------------
# Collecting listeners
# ---------------------------------------------------------------------------

NODE_EXPORTER_PORT = 9100  # setup_node_exporter.yml passes no flags: every interface, 9100


class _Buckets(object):
    """Port intervals per class while the model is being built."""

    def __init__(self):
        self.udp_public = []
        self.udp_xdp = []
        self.udp_pub = []
        self.udp_allow = []
        self.tcp_public = []
        self.tcp_consumer = []
        self.tcp_mgmt = []
        self.tcp_metrics = []
        self.tcp_wg_only = []
        self.local_tcp = []
        self.local_udp = []
        self.unauthenticated = []  # consumer listeners that have no authentication


def _add_rpc(b, role, port, loopback):
    """--rpc-port and the pubsub port next to it."""
    ports = (port, port + 1)
    if loopback:
        b.local_tcp.append(ports)
    elif role == "rpc":
        b.tcp_consumer.append(ports)
    else:
        b.tcp_mgmt.append(ports)


def _listener(b, klass, endpoint, what, proto="tcp"):
    """Add one 'host:port' listener to a class; loopback binds are local only.

    Returns the port when it is reachable from other machines, else None.
    """
    host, port = _split_hostport(endpoint, what)
    if _is_loopback(host):
        (b.local_tcp if proto == "tcp" else b.local_udp).append((port, port))
        return None
    target = {"consumer": b.tcp_consumer, "metrics": b.tcp_metrics, "mgmt": b.tcp_mgmt}[klass]
    target.append((port, port))
    return port


def _fixed_local(b, endpoint, what, proto):
    """A listener that is never opened, whatever address it is bound to."""
    _, port = _split_hostport(endpoint, what)
    (b.local_tcp if proto == "tcp" else b.local_udp).append((port, port))


def _dig(data, path):
    current = data
    for key in path:
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def _endpoint(data, path, what):
    value = _dig(data, path)
    if value is None:
        return None
    if not isinstance(value, str):
        _invalid(what, "must be a 'host:port' string, got %r" % (value,))
    return value


def _has_token(value):
    if value is None:
        return False
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) > 0
    return bool(str(value).strip())


def _add_richat(b, data):
    """richat-setting.yml: gRPC and pubsub are consumer ports, metrics is a metrics port, and
    the richat gRPC and QUIC endpoints of the node itself are never opened."""
    endpoint = _endpoint(data, ("metrics", "endpoint"), "richat metrics.endpoint")
    if endpoint is not None:
        _listener(b, "metrics", endpoint, "richat metrics.endpoint")
    endpoint = _endpoint(data, ("apps", "richat", "grpc", "endpoint"), "richat apps.richat.grpc.endpoint")
    if endpoint is not None:
        _fixed_local(b, endpoint, "richat apps.richat.grpc.endpoint", "tcp")
    endpoint = _endpoint(data, ("apps", "richat", "quic", "endpoint"), "richat apps.richat.quic.endpoint")
    if endpoint is not None:
        _fixed_local(b, endpoint, "richat apps.richat.quic.endpoint", "udp")
    grpc = _endpoint(data, ("apps", "grpc", "server", "endpoint"), "richat apps.grpc.server.endpoint")
    if grpc is not None:
        port = _listener(b, "consumer", grpc, "richat apps.grpc.server.endpoint")
        if port is not None and not _has_token(_dig(data, ("apps", "grpc", "x_tokens"))):
            b.unauthenticated.append({"name": "richat-grpc (no x_tokens)", "proto": "tcp", "port": port})
    pubsub = _endpoint(data, ("apps", "pubsub", "endpoint"), "richat apps.pubsub.endpoint")
    if pubsub is not None:
        _listener(b, "consumer", pubsub, "richat apps.pubsub.endpoint")
    if grpc is None and pubsub is None:
        _invalid(
            "richat", "has neither apps.grpc.server.endpoint nor apps.pubsub.endpoint: is it a richat-setting.yml?"
        )


def _add_yellowstone(b, data):
    """geyser.json of the Yellowstone plugin: gRPC is a consumer port."""
    endpoint = _endpoint(data, ("grpc", "address"), "yellowstone grpc.address")
    if endpoint is None:
        _invalid("yellowstone", "has no grpc.address: is it the geyser.json of the Yellowstone plugin?")
    port = _listener(b, "consumer", endpoint, "yellowstone grpc.address")
    grpc = _dig(data, ("grpc",))
    token = grpc.get("x_token", grpc.get("x_tokens"))
    if port is not None and not _has_token(token):
        b.unauthenticated.append({"name": "yellowstone-grpc (no x_token)", "proto": "tcp", "port": port})
    endpoint = _endpoint(data, ("prometheus", "address"), "yellowstone prometheus.address")
    if endpoint is not None:
        _listener(b, "metrics", endpoint, "yellowstone prometheus.address")


def _add_of1(b, text):
    """Old Faithful: a consumer port that relays unknown methods and has no authentication."""
    port = _listener(b, "consumer", text, "of1-listen")
    if port is not None:
        b.unauthenticated.append({"name": "old-faithful (relays unknown methods)", "proto": "tcp", "port": port})


def _listener_record(proto, ports, klass, sources=None):
    record = {"proto": proto, "ports": _merge(ports), "class": klass}
    if sources is not None:
        record["sources"] = _net_strings(sources)
    return record


def _apply_components(b, components):
    """Add the ports of the opt-in components; returns (records, wireguard)."""
    records = []
    wireguard = {"enabled": False, "iface": None, "subnet": None}
    for comp in components:
        cid = comp["id"]
        record = {"id": cid, "class": comp["class"], "listeners": [], "iface_rules": []}
        if cid == "rpc-gateway":
            b.tcp_consumer.append((8889, 8889))
            b.local_udp.append((20000, 20000))
            b.unauthenticated.append({"name": "rpc-gateway (no authentication)", "proto": "tcp", "port": 8889})
            record["listeners"] = [
                _listener_record("tcp", [(8889, 8889)], "consumer"),
                _listener_record("udp", [(20000, 20000)], "local_only"),
            ]
        elif cid == "shred-relay":
            b.local_tcp.append((19999, 19999))
            b.udp_allow.append({"component": cid, "ports": [[20001, 20001]], "sources": _net_strings(comp["sources"])})
            record["listeners"] = [
                _listener_record("udp", [(20001, 20001)], "allowlist", comp["sources"]),
                _listener_record("tcp", [(19999, 19999)], "local_only"),
            ]
        elif cid == "wireguard":
            b.udp_pub.append((51820, 51820))
            wireguard = {"enabled": True, "iface": WIREGUARD_IFACE, "subnet": WIREGUARD_SUBNET}
            record["listeners"] = [_listener_record("udp", [(51820, 51820)], "public")]
        elif cid == "gateway":
            b.tcp_wg_only.append((20026, 20026))
            record["listeners"] = [_listener_record("tcp", [(20026, 20026)], "wg_only")]
        elif cid == "nginx":
            b.tcp_public.extend([(80, 80), (443, 443)])
            record["listeners"] = [_listener_record("tcp", [(80, 80), (443, 443)], "public")]
        elif cid == "libvirt":
            record["iface_rules"] = [
                {"iifname": "virbr*", "proto": "udp", "ports": [[53, 53], [67, 67]]},
                {"iifname": "virbr*", "proto": "tcp", "ports": [[53, 53]]},
            ]
        records.append(record)
    return records, wireguard


# ---------------------------------------------------------------------------
# Deriving the model
# ---------------------------------------------------------------------------


def _derive_agave(prof, role, args, inp, b):
    low, high = args["range"] or DEFAULT_RANGE  # [low, high)
    if high - low < prof.min_range_width:
        raise ModelError(
            "range_too_narrow",
            "--dynamic-port-range %d-%d is %d ports wide; %s needs at least %d"
            % (low, high, high - low, prof.id, prof.min_range_width),
        )
    rpc = args["rpc_port"]
    gossip = args["gossip_port"]
    # The only TCP socket agave itself binds inside the dynamic port range is the ip-echo
    # listener on the gossip port, and it is bound before the RPC service starts.  Without
    # --gossip-port that port is the first one of the range (UDP and TCP both free).  So,
    # of agave's own sockets, the RPC and pubsub listeners fail to bind only when --rpc-port
    # or --rpc-port + 1 is that port; overlapping the UDP sockets of the range does not
    # collide.  A Geyser plugin binds ports of its own.
    ip_echo_port = gossip if gossip is not None else low
    if rpc is not None and ip_echo_port in (rpc, rpc + 1):
        where = (
            "--gossip-port"
            if gossip is not None
            else "the first port of --dynamic-port-range %d-%d, where gossip binds without --gossip-port" % (low, high)
        )
        raise ModelError(
            "rpc_port_in_range",
            "--rpc-port %d (pubsub %d) asks for port %d, which the gossip ip-echo listener already holds (%s)"
            % (rpc, rpc + 1, ip_echo_port, where),
        )
    b.udp_public.append((low, high - 1))
    if gossip is not None:
        b.udp_public.append((gossip, gossip))
    if inp["ip_echo_public"]:
        if gossip is None:
            raise ModelError(
                "gossip_port_unpinned",
                "ip_echo_public needs --gossip-port: without it the ip-echo TCP port is "
                "chosen at start somewhere in the dynamic port range",
            )
        b.tcp_public.append((gossip, gossip))
    if rpc is not None:
        _add_rpc(b, role, rpc, _agave_rpc_loopback(args))
    return {"xdp_bind_address": None}


def _derive_frankendancer(prof, role, cfg, inp, b):
    low, high = cfg["range"]
    if high - low < prof.min_range_width:
        raise ModelError(
            "range_too_narrow",
            "dynamic_port_range %d-%d is %d ports wide; %s needs at least %d"
            % (low, high, high - low, prof.id, prof.min_range_width),
        )
    fixed = (
        ("[gossip].port", cfg["gossip_port"]),
        ("[tiles.shred].shred_listen_port", cfg["shred_port"]),
        ("[tiles.quic].regular_transaction_listen_port", cfg["tpu_port"]),
        ("[tiles.quic].quic_transaction_listen_port", cfg["tpu_quic_port"]),
    )
    for name, port in fixed:
        if low <= port < high:
            raise ModelError(
                "fd_fixed_port_in_range",
                "%s = %d is inside dynamic_port_range %d-%d; fixed ports must be outside it" % (name, port, low, high),
            )
    provider = cfg["net_provider"]
    if provider not in prof.net_providers:
        raise ModelError(
            "fd_provider_unknown",
            "[net].provider = %r is not one of %s for %s" % (provider, ", ".join(sorted(prof.net_providers)), prof.id),
        )
    b.udp_public.append((low, high - 1))
    b.udp_public.extend((port, port) for _, port in fixed)
    if prof.net_providers[provider] == "bypass":
        b.udp_xdp.extend((p, p) for p in (cfg["shred_port"], cfg["tpu_port"], cfg["tpu_quic_port"]))
    if inp["ip_echo_public"]:
        b.tcp_public.append((cfg["gossip_port"], cfg["gossip_port"]))
    if cfg["rpc_port"]:
        _add_rpc(b, role, cfg["rpc_port"], _fd_rpc_loopback(cfg))
    if cfg["gui_enabled"]:
        if _is_loopback(cfg["gui_address"]):
            b.local_tcp.append((cfg["gui_port"], cfg["gui_port"]))
        else:
            b.tcp_mgmt.append((cfg["gui_port"], cfg["gui_port"]))
    if _is_loopback(cfg["metric_address"]):
        b.local_tcp.append((cfg["metric_port"], cfg["metric_port"]))
    else:
        b.tcp_metrics.append((cfg["metric_port"], cfg["metric_port"]))
    return {"xdp_bind_address": cfg["net_bind_address"] or None}


def _mgmt_sources(inp):
    """mgmt = admin; with controller-only and no admin it is the controller alone."""
    mode, admin, controller = inp["ssh_mode"], inp["admin"], inp["controller_ip"]
    if admin[0] or admin[1]:
        if mode != "public-rate-limited" and controller is not None and not _ip_in(admin, controller):
            raise ModelError(
                "controller_not_in_admin",
                "the address this run connects from (%s) is not in admin_ips; add it to "
                "admin_ips or run from an address that is" % controller,
            )
        return admin, False
    if mode == "refuse":
        raise ModelError(
            "admin_empty_refused",
            "admin_ips is empty and ssh_mode is refuse; set admin_ips, or choose "
            "controller-only or public-rate-limited on purpose",
        )
    if mode == "controller-only":
        if controller is None:
            raise ModelError(
                "controller_unknown",
                "admin_ips is empty and the address this run connects from is unknown",
            )
        net = ipaddress.ip_network(controller)
        return ([net], []) if net.version == 4 else ([], [net]), True
    return ([], []), False


# bridges that the host makes for containers and VMs, known by name even when host_facts.bridges
# does not list them
_BRIDGE_NAMES = ("docker0", "virbr*")


def _host_section(facts):
    default_route = set(facts["default_route_ifaces"])
    bridges = set(facts["bridges"])

    def bridge_without_route(name):
        named = name in bridges or any(fnmatch.fnmatchcase(name, pattern) for pattern in _BRIDGE_NAMES)
        return named and name not in default_route

    # what "the host could not tell" covers: every interface but lo and the bridges that carry
    # no default route
    others = [name for name in facts["ifaces"] if name != "lo" and not bridge_without_route(name)]

    def covered(key):
        if facts[key] is not None:
            return list(facts[key]), False
        if not others:
            _invalid(
                "host_facts.ifaces",
                "no interface besides lo and the bridges without a default route to cover %s" % key,
            )
        return others, True

    dhcp4, undetermined4 = covered("dhcp4_ifaces")
    dhcp6, undetermined6 = covered("dhcp6_ifaces")
    ra, ra_undetermined = covered("ra_ifaces")
    return {
        "bridges": list(facts["bridges"]),
        "dhcp4_ifaces": dhcp4,
        "dhcp6_ifaces": dhcp6,
        "dhcp_undetermined": undetermined4 or undetermined6,
        "ra_ifaces": ra,
        "ra_undetermined": ra_undetermined,
    }


def _ssh_ports(inp, facts):
    ports = set(facts["sshd_ports"]) | set(facts["ssh_socket_ports"]) | set(facts["sshd_listen_ports"])
    if inp["ssh_connection_port"] is not None:
        ports.add(inp["ssh_connection_port"])
    ports.add(inp["ansible_port"] if inp["ansible_port"] is not None else 22)
    return _merge((p, p) for p in ports)


def _port_text(intervals):
    return ", ".join(str(lo) if lo == hi else "%d-%d" % (lo, hi) for lo, hi in intervals)


def _shared_ports(first, second):
    """The first closed interval that two merged interval lists have in common, or None."""
    for lo_a, hi_a in first:
        for lo_b, hi_b in second:
            lo, hi = max(lo_a, lo_b), min(hi_a, hi_b)
            if lo <= hi:
                return [lo, hi]
    return None


def _port_classes(model):
    """Every set of ports of the model, as (protocol, name, intervals): the sets the table has a
    rule for, including the DHCP reply rules of the host, and the local-only sets, which it has
    none for.

    Narrowest first, so that an overlap reads "<narrow class> and in <wider class>".
    """
    udp, tcp, local, host = model["udp"], model["tcp"], model["local_only"], model["host"]
    classes = [("udp", "local_only.udp", local["udp"])]
    for entry in udp["allowlist"]:
        classes.append(("udp", "udp.allowlist (%s)" % entry["component"], entry["ports"]))
    for component in model["components"]:
        for rule in component["iface_rules"]:
            classes.append((rule["proto"], "%s rule for %s" % (component["id"], rule["iifname"]), rule["ports"]))
    # the table accepts a DHCP reply on the client port of each interface the host names
    if host["dhcp6_ifaces"]:
        classes.append(("udp", "host DHCPv6 client rule", [[546, 546]]))
    if host["dhcp4_ifaces"]:
        classes.append(("udp", "host DHCPv4 client rule", [[68, 68]]))
    classes += [
        ("udp", "udp.pub", udp["pub"]),
        ("udp", "udp.public", udp["public"]),
        ("udp", "udp.xdp", udp["xdp"]),
        ("tcp", "local_only.tcp", local["tcp"]),
        ("tcp", "tcp.wg_only", tcp["wg_only"]),
        ("tcp", "tcp.mgmt", tcp["mgmt"]),
        ("tcp", "tcp.ssh", tcp["ssh"]),
        ("tcp", "tcp.metrics", tcp["metrics"]),
        ("tcp", "tcp.consumer", tcp["consumer"]),
        ("tcp", "tcp.public", tcp["public"]),
    ]
    return classes


# udp.xdp is the part of udp.public that a Frankendancer net tile with a bypass provider takes
# before netfilter sees it: the same ports for the same sources, so the two are meant to overlap.
_SAME_SOURCES = {("udp.public", "udp.xdp")}


def _class_overlap(model):
    """The first port that two classes of the model hold, or None.

    Returns (protocol, name, other name, the shared interval, the ports of the other class).
    """
    classes = [(proto, name, _merge(ports)) for proto, name, ports in _port_classes(model)]
    for index, (proto, name, ports) in enumerate(classes):
        for other_proto, other_name, other_ports in classes[index + 1 :]:
            if proto != other_proto or (name, other_name) in _SAME_SOURCES:
                continue
            shared = _shared_ports(ports, other_ports)
            if shared:
                return proto, name, other_name, shared, other_ports
    return None


def _refuse_class_overlap(model):
    """Stop when one port is in two classes of the model (see "Output" in the module docstring)."""
    hit = _class_overlap(model)
    if hit:
        proto, name, other_name, shared, other_ports = hit
        raise ModelError(
            "class_overlap",
            "%s port %s is in %s and in %s (%s). The table opens a port to the sources of each "
            "class that holds it, and the model does not say which class the node means. Move one "
            "of them: the dynamic port range, a component's port or the other listener."
            % (proto, _port_text([shared]), name, other_name, _port_text(other_ports)),
        )


def slv_listen_model(rendered, profile, inputs, host_facts):
    """Derive the listen model, or raise ModelError (see the module docstring)."""
    prof_in = _profile_input(profile)
    role, rpc_type = prof_in["role"], prof_in["rpc_type"]
    prof = _find_profile(prof_in["client"], prof_in["version"])
    inp = _inputs(inputs)
    facts = _host_facts(host_facts)
    items = _rendered_items(rendered, prof, role, prof_in["network"], rpc_type)

    b = _Buckets()
    if prof.family == "agave":
        extra = _derive_agave(prof, role, _parse_agave_args(items["agave-args"]), inp, b)
    else:
        extra = _derive_frankendancer(prof, role, _parse_fd_config(items["fd-toml"]), inp, b)
    b.tcp_metrics.append((NODE_EXPORTER_PORT, NODE_EXPORTER_PORT))
    if "richat" in items:
        _add_richat(b, items["richat"])
    if "yellowstone" in items:
        _add_yellowstone(b, items["yellowstone"])
    if "of1-listen" in items:
        _add_of1(b, items["of1-listen"])

    warnings = []

    def warn(code, detail, **more):
        entry = {"code": code, "detail": detail}
        entry.update(more)
        warnings.append(entry)

    # Receive XDP: packets that AF_XDP delivers to a socket without the kernel showing them
    # to netfilter.
    rx_bypass = []
    if prof.rx_xdp:
        unit = items["unit"]  # _rendered_items made sure it is there
        if _unit_may_grant(unit, "CAP_BPF") and _unit_may_grant(unit, "CAP_PERFMON"):
            if not inp["accept_xdp_rx_bypass"]:
                raise ModelError(
                    "xdp_rx_bypass_unacknowledged",
                    "the unit grants CAP_BPF and CAP_PERFMON, so %s can receive %d UDP sockets "
                    "with AF_XDP past netfilter; set accept_xdp_rx_bypass to accept that, or "
                    "remove the two capabilities from the unit" % (prof.id, len(prof.rx_xdp)),
                )
            rx_bypass = sorted(prof.rx_xdp)
            warn(
                "xdp_rx_bypass_accepted",
                "no deny rule or rate limit applies to a packet that XDP delivers to the receive-XDP "
                "sockets: %s" % ", ".join(rx_bypass),
                sockets=rx_bypass,
            )

    components, wireguard = _apply_components(b, inp["components"])
    mgmt, controller_only = _mgmt_sources(inp)
    overlap = _overlaps(inp["deny"], mgmt) or _overlaps(inp["deny"], inp["lb"]) or _overlaps(inp["deny"], inp["scrape"])
    if overlap:
        raise ModelError(
            "deny_overlaps_allow",
            "deny_ips %s overlaps %s, which is allowed on mgmt, consumer or metrics ports" % (overlap[0], overlap[1]),
        )
    uplinks = sorted(
        u for u in facts["default_route_ifaces"] for t in inp["trusted_ifaces"] if fnmatch.fnmatchcase(u, t)
    )
    if uplinks:
        raise ModelError(
            "trusted_iface_is_uplink",
            "trusted_ifaces matches the default-route interface %s; everything from the "
            "internet would be treated as mgmt" % ", ".join(uplinks),
        )

    consumer = _merge(b.tcp_consumer)
    consumer_public = bool(inp["public_rpc"] and consumer)
    if role == "rpc" and not (inp["lb"][0] or inp["lb"][1]) and not inp["public_rpc"]:
        warn(
            "lb_empty_fail_closed",
            "lb_ips is empty and public_rpc is false: consumer ports (%s) are reachable only from "
            "mgmt and from what the table treats like it (trusted_ifaces, the WireGuard tunnel)"
            % _port_text(consumer),
        )
    if consumer_public and b.unauthenticated:
        listeners = sorted(b.unauthenticated, key=lambda x: (x["port"], x["name"]))
        warn(
            "public_rpc_unauthenticated",
            "public_rpc exposes listeners without authentication: %s"
            % ", ".join("%s %d/%s" % (x["name"], x["port"], x["proto"]) for x in listeners),
            listeners=listeners,
        )
    if inp["public_rpc"] and not consumer:
        warn("public_rpc_no_effect", "public_rpc is true but this node has no consumer port")
    if not mgmt[1] and facts["has_global_v6"]:
        warn(
            "admin_without_v6",
            "the host has a global IPv6 address but no IPv6 address is allowed for mgmt; "
            "a client that reaches the host over IPv6 is locked out of SSH and the mgmt ports, unless it "
            "arrives on a trusted interface or ssh_mode is public-rate-limited (which keeps SSH open)",
        )
    if facts["bridges"]:
        warn(
            "bridges_present",
            "bridge interfaces exist (%s); their traffic is not trusted unless trusted_ifaces names them"
            % ", ".join(facts["bridges"]),
            bridges=list(facts["bridges"]),
        )
    if controller_only:
        warn(
            "controller_only_mgmt",
            "admin_ips is empty: the mgmt sources are the address this run connects from (%s) and no "
            "other address" % inp["controller_ip"],
        )

    public_ssh = inp["ssh_mode"] == "public-rate-limited"
    model = {
        "schema": SCHEMA,
        "profile": {
            "id": prof.id,
            "family": prof.family,
            "client": prof_in["client"],
            "version": prof_in["version"],
            "role": role,
            "network": prof_in["network"],
            "rpc_type": rpc_type,
        },
        "udp": {
            "public": _merge(b.udp_public),
            "xdp": _merge(b.udp_xdp),
            "xdp_rx_bypass": rx_bypass,
            "xdp_bind_address": extra["xdp_bind_address"],
            "pub": _merge(b.udp_pub),
            "allowlist": sorted(b.udp_allow, key=lambda x: x["component"]),
        },
        "tcp": {
            "public": _merge(b.tcp_public),
            "consumer": consumer,
            "mgmt": _merge(b.tcp_mgmt),
            "metrics": _merge(b.tcp_metrics),
            "ssh": _ssh_ports(inp, facts),
            "wg_only": _merge(b.tcp_wg_only),
        },
        "local_only": {"tcp": _merge(b.local_tcp), "udp": _merge(b.local_udp)},
        "sources": {
            "mgmt": _net_strings(mgmt),
            "lb": _net_strings(inp["lb"]),
            "scrape": _net_strings(inp["scrape"]),
            "deny": _net_strings(inp["deny"]),
        },
        "ssh": {
            "mode": inp["ssh_mode"],
            "public": public_ssh,
            "rate": dict(SSH_RATE) if public_ssh else None,
            "controller_only": controller_only,
        },
        "consumer_public": consumer_public,
        "trusted_ifaces": list(inp["trusted_ifaces"]),
        "wireguard": wireguard,
        "host": _host_section(facts),
        "components": components,
        "warnings": sorted(warnings, key=lambda w: (w["code"], w["detail"])),
    }
    _refuse_class_overlap(model)
    return _seal(model)


# ---------------------------------------------------------------------------
# Union of two models, and the filter wrappers
# ---------------------------------------------------------------------------

_UNION_FIELDS = (
    ("udp", "public"),
    ("udp", "xdp"),
    ("udp", "pub"),
    ("tcp", "public"),
    ("tcp", "consumer"),
    ("tcp", "mgmt"),
    ("tcp", "metrics"),
    ("tcp", "ssh"),
    ("tcp", "wg_only"),
    ("local_only", "tcp"),
    ("local_only", "udp"),
)


def _model_copy(model, what):
    if not isinstance(model, dict) or model.get("schema") != SCHEMA:
        _invalid(what, "is not a %s model" % SCHEMA)
    try:
        copy = json.loads(json.dumps(model))
    except (TypeError, ValueError) as exc:
        _invalid(what, "is not JSON compatible: %s" % exc)
    if "model_sha256" in copy and _seal(copy)["model_sha256"] != copy["model_sha256"]:
        _invalid(what, "model_sha256 does not match its content")
    return copy


def _holders(proto, name, shared, models):
    """Which of the models hold the shared ports in the class: the applied model, the new one or both.

    models is [(label, model)].
    """
    labels = []
    for label, model in models:
        for other_proto, other_name, ports in _port_classes(model):
            if (other_proto, other_name) == (proto, name) and _shared_ports([shared], _merge(ports)):
                labels.append(label)
                break
    if len(labels) == 2:
        return "both models"
    return "the %s model" % labels[0] if labels else "neither model"


def slv_listen_model_union(old, new):
    """For each port set in _UNION_FIELDS, the ports of both models; everything else, the
    allowlist included, comes from the new one.

    The union is checked like a model (class_overlap). A port that is in one class of the old
    model and in another of the new one would be open to the sources of both classes in the
    table that carries the ports of both, so the union stops: the change is applied in two
    steps, first a configuration without that port, then the new configuration.
    """
    old_copy = _model_copy(old, "old model")
    new_copy = _model_copy(new, "new model")
    for label, model in (("applied", old_copy), ("new", new_copy)):
        hit = _class_overlap(model)
        if hit:
            proto, name, other_name, shared, _ = hit
            raise ModelError(
                "class_overlap",
                "the %s model itself holds %s port %s in %s and in %s, which this version refuses to "
                "derive. Apply a configuration without that port first."
                % (label, proto, _port_text([shared]), name, other_name),
            )
    result = _model_copy(new, "new model")
    for group, key in _UNION_FIELDS:
        try:
            result[group][key] = _merge(old_copy[group][key] + result[group][key])
        except (KeyError, TypeError, ValueError):
            _invalid("model", "%s.%s is missing or not a list of port intervals" % (group, key))
    hit = _class_overlap(result)
    if hit:
        proto, name, other_name, shared, _ = hit
        models = [("applied", old_copy), ("new", new_copy)]
        raise ModelError(
            "class_overlap",
            "%s port %s is in %s of %s and in %s of %s, so the table that carries the ports of both "
            "models would open it to the sources of both classes. Apply the change in two steps: first a "
            "configuration without that port, then the new configuration."
            % (
                proto,
                _port_text([shared]),
                name,
                _holders(proto, name, shared, models),
                other_name,
                _holders(proto, other_name, shared, models),
            ),
        )
    return _seal(result)


# ---------------------------------------------------------------------------
# The header of an nft file
# ---------------------------------------------------------------------------

_TIMESTAMP_RE = re.compile(
    r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]{1,9})?(?:Z|\+00:00)"
)


def _meta_text(value, what):
    """A string without a control character (a newline would end the comment it is written into)."""
    if not isinstance(value, str):
        raise ModelError("invalid_meta", "%s must be a string, got %r" % (what, value))
    for char in value:
        category = unicodedata.category(char)
        if category[0] == "C" or category in ("Zl", "Zp"):
            raise ModelError("invalid_meta", "%s contains a control character (U+%04X)" % (what, ord(char)))
    return value


def slv_listen_model_meta(meta):
    """Check slv_fw_meta before it is written into the header comment of an nft file.

    generated_at is required and has to be an ISO-8601 UTC timestamp (2026-01-01T00:00:00Z, with
    optional fraction of a second, or +00:00 for Z); controller_ip is optional and has to be an
    IP address. Neither may contain a control character, and no other key is accepted. Anything
    else stops with invalid_meta. Returns {"generated_at", "controller_ip"}: the timestamp as it
    was given and the address as the ipaddress module writes it ("" when there is none).
    """
    if not isinstance(meta, dict):
        raise ModelError("invalid_meta", "slv_fw_meta must be a mapping with generated_at and controller_ip")
    extra = sorted(str(k) for k in meta if k not in ("generated_at", "controller_ip"))
    if extra:
        raise ModelError("invalid_meta", "slv_fw_meta has unknown keys: %s" % ", ".join(extra))
    stamp = meta.get("generated_at")
    if stamp is None or stamp == "":
        raise ModelError("invalid_meta", "slv_fw_meta.generated_at is required")
    stamp = _meta_text(stamp, "slv_fw_meta.generated_at")
    match = _TIMESTAMP_RE.fullmatch(stamp)
    try:
        if not match:
            raise ValueError("not in that form")
        datetime.datetime(*(int(part) for part in match.groups()))
    except ValueError:
        raise ModelError(
            "invalid_meta",
            "slv_fw_meta.generated_at %r is not an ISO-8601 UTC timestamp such as 2026-01-01T00:00:00Z" % (stamp,),
        )
    address = meta.get("controller_ip")
    if address is None or address == "":
        return {"generated_at": stamp, "controller_ip": ""}
    address = _meta_text(address, "slv_fw_meta.controller_ip")
    try:
        if "%" in address:
            raise ValueError("a scope id")
        ip = ipaddress.ip_address(address)
    except ValueError:
        raise ModelError("invalid_meta", "slv_fw_meta.controller_ip %r is not an IP address" % (address,))
    return {"generated_at": stamp, "controller_ip": str(ip)}


def _ansible_filter_error():
    try:
        from ansible.errors import AnsibleFilterError
    except ImportError:
        return None
    return AnsibleFilterError


def _wrap(function):
    """Raise AnsibleFilterError instead of ModelError when Ansible can be imported."""

    def wrapper(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except ModelError as exc:
            error_class = _ansible_filter_error()
            if error_class is None:
                raise
            raise error_class(str(exc)) from exc

    wrapper.__name__ = function.__name__
    wrapper.__doc__ = function.__doc__
    return wrapper


class FilterModule(object):
    def filters(self):
        return {
            "slv_listen_model": _wrap(slv_listen_model),
            "slv_listen_model_union": _wrap(slv_listen_model_union),
            "slv_listen_model_meta": _wrap(slv_listen_model_meta),
            "slv_listen_model_canonical_json": canonical_json,
        }
