#!/usr/bin/env bash
# Verdict cases for the tables that render_matrix.yml writes: each case loads a table into a
# network namespace and sends real packets at it.
#
#   sudo netns_verdicts.sh <directory that render_matrix.yml wrote> [case id...]
#
# Case ids (b05, b09, ...) select the cases to run; without them every case runs.
#
# Needs root, ip(8), nft(8), python3 with scapy, and optionally conntrack(8). Everything it
# loads or sets stays inside three network namespaces, which it removes on exit; still, run it
# on a CI runner or a throwaway machine, never on a production host. The namespaces:
#
#   peer --p0 === h0-- host --h1 === f0-- far
#
# `host` gets the table under test. `peer` owns the addresses the cases send from (lb, mgmt,
# other, unseen); `far` is where `host` forwards to. The addresses and interface names come
# from verdict/topology.env, the same numbers the tables were rendered with.
#
# A case prints `PASS <name>` or `FAIL <name>` and, on failure, what it saw. Every case
# runs even when one fails. The script exits 1 if any case failed.

set -u
export LC_ALL=C

# shellcheck disable=SC2154  # the variables of topology.env
DIR=${1:-}
[ "$#" -gt 0 ] && shift
SELECTED=("$@")

CASES=(
  "b05_sol_udp_from_an_unseen_source:case_b05"
  "b06_consumer_tcp_only_from_lb_and_mgmt:case_b06"
  "b07_refuse_mode_ssh_only_from_mgmt:case_b07"
  "b08_public_rate_limited_ssh_limit:case_b08"
  "b09_deny_cuts_an_established_flow:case_b09"
  "b10_ndp_hop_limit_and_router_advertisement:case_b10"
  "b11_icmp_errors_for_untracked_udp_get_in:case_b11"
  "b12_forwarded_udp_is_masqueraded:case_b12"
  "b13_spoofed_own_address_is_dropped:case_b13"
  "b14_dhcp4_reply_only_on_dhcp_interfaces:case_b14"
  "b15_fallback_table_keeps_ssh_and_udp_only:case_b15"
  "b16_fallback_keeps_the_wireguard_udp_port_only:case_b16"
  "b17_metrics_port_is_closed_to_other_sources:case_b17"
  "b18_fallback_lets_the_tunnel_reach_ssh_only:case_b18"
  "b19_fallback_closes_the_metrics_port:case_b19"
)

PASSED=0
FAILED=0
WORK=""
SERVE_PID=""

say_all_failed() {
  local entry
  for entry in "${CASES[@]}"; do
    echo "FAIL ${entry%%:*}"
    echo "    $1"
  done
  echo "netns verdicts: 0 passed, ${#CASES[@]} failed"
  exit 1
}

if [ -z "$DIR" ]; then
  say_all_failed "usage: netns_verdicts.sh <directory that render_matrix.yml wrote>"
fi
if [ ! -d "$DIR" ]; then
  say_all_failed "$DIR does not exist: the render did not run or did not finish"
fi
if [ "$(id -u)" -ne 0 ]; then
  say_all_failed "needs root: run it with sudo"
fi
if [ ! -f "$DIR/verdict/topology.env" ]; then
  say_all_failed "$DIR/verdict/topology.env is missing: the render did not run or did not finish"
fi
# shellcheck source=/dev/null
. "$DIR/verdict/topology.env"
for name in CONSUMER_PORT FAR_V4 HOST_FAR_V4 HOST_LL HOST_V4 HOST_V6 IF_FAR IF_HOST_FAR IF_HOST_PEER \
  IF_PEER IF_WG IF_WG_PEER LB_V4 METRICS_PORT MGMT_V4 MGMT_V6 NS_FAR NS_HOST NS_PEER OTHER_V4 PEER_LL \
  PEER_V4 PEER_V6 PUB_UDP_PORT SOL_UDP_PORT SSH_PORT UNSEEN_V4 WG_HOST_V4 WG_PEER_V4 WG_UDP_PORT; do
  if [ -z "${!name:-}" ]; then
    say_all_failed "$DIR/verdict/topology.env does not set $name"
  fi
done

T_REFUSE=$DIR/verdict/refuse/slv.nft
T_RATE=$DIR/verdict/public-rate-limited/slv.nft
T_DENY=$DIR/verdict/deny/slv.nft
T_FALLBACK=$DIR/verdict/refuse/slv-fallback.nft
T_WG=$DIR/verdict/wireguard/slv.nft
T_WG_FALLBACK=$DIR/verdict/wireguard/slv-fallback.nft
for file in "$T_REFUSE" "$T_RATE" "$T_DENY" "$T_FALLBACK" "$T_WG" "$T_WG_FALLBACK"; do
  [ -f "$file" ] || say_all_failed "$file is missing: the render did not write the table this script loads"
done
for tool in ip nft python3; do
  command -v "$tool" >/dev/null 2>&1 || say_all_failed "$tool is not installed"
done
python3 -c 'import scapy.layers.inet6' >/dev/null 2>&1 || say_all_failed "python3 cannot import scapy (apt install python3-scapy)"

# the link-local addresses of the far link (not part of any table)
HOST_LL_FAR=fe80::11
FAR_LL=fe80::12

WORK=$(mktemp -d)

cleanup() {
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null
  local ns
  for ns in "${NS_PEER:-}" "${NS_HOST:-}" "${NS_FAR:-}"; do
    [ -n "$ns" ] && ip netns del "$ns" 2>/dev/null
  done
  [ -n "$WORK" ] && rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# The helper that runs inside the namespaces: sockets and raw packets
# ---------------------------------------------------------------------------

cat > "$WORK/pkt.py" <<'__PKT_PY__'
#!/usr/bin/env python3
"""Sockets and raw packets for netns_verdicts.sh, run inside its network namespaces.

Every subcommand prints one line the script matches on and exits 0, unless the
arguments are wrong.  scapy is imported only by `inject`.
"""
import argparse
import os
import select
import socket
import sys
import threading
import time


def tcp_connect(a):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(a.timeout)
    try:
        s.bind((a.src, 0))
        s.connect((a.dst, a.port))
        print("OK")
    except TimeoutError:
        print("TIMEOUT")
    except ConnectionRefusedError:
        print("REFUSED")
    except OSError as exc:
        print("ERROR %s" % exc)
    finally:
        s.close()


def tcp_burst(a):
    socks = []
    for _ in range(a.count):
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setblocking(False)
        s.bind((a.src, 0))
        try:
            s.connect((a.dst, a.port))
        except BlockingIOError:
            pass
        socks.append(s)
    pending = set(socks)
    ok = failed = 0
    deadline = time.time() + a.wait
    while pending and time.time() < deadline:
        _, writable, _ = select.select([], list(pending), [], max(0.0, deadline - time.time()))
        for s in writable:
            pending.discard(s)
            if s.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0:
                ok += 1
            else:
                failed += 1
    print("OK=%d FAILED=%d SILENT=%d" % (ok, failed, len(pending)))


def tcp_flow(a):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(a.timeout)
    try:
        s.bind((a.src, 0))
        s.connect((a.dst, a.port))
        s.sendall(b"ping1")
        first = s.recv(16)
    except OSError as exc:
        print("NOFLOW %s" % exc)
        return
    if first != b"ping1":
        print("NOFLOW the first echo was %r" % first)
        return
    open(a.ready, "w").close()
    start = time.time()
    while not os.path.exists(a.go):
        if time.time() - start > 60:
            print("NOGO")
            return
        time.sleep(0.05)
    try:
        s.sendall(b"ping2")
        print("ECHO" if s.recv(16) == b"ping2" else "SILENT")
    except OSError:
        print("SILENT")


def echo(conn):
    try:
        while True:
            data = conn.recv(4096)
            if not data:
                break
            conn.sendall(data)
    except OSError:
        pass
    finally:
        conn.close()


def accept_loop(listener):
    while True:
        conn, _ = listener.accept()
        threading.Thread(target=echo, args=(conn,), daemon=True).start()


def udp_loop(sock, log):
    while True:
        _, addr = sock.recvfrom(2048)
        with open(log, "a") as handle:
            handle.write("%s:%d\n" % addr)


def serve(a):
    for port in a.tcp:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("0.0.0.0", port))
        listener.listen(128)
        threading.Thread(target=accept_loop, args=(listener,), daemon=True).start()
    for port in a.udp:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.bind(("0.0.0.0", port))
        threading.Thread(target=udp_loop, args=(sock, a.udp_log), daemon=True).start()
    open(a.ready, "w").close()
    threading.Event().wait()


def udp_send(a):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.bind((a.src, a.sport))
        for _ in range(a.count):
            s.sendto(b"slv-verdict", (a.dst, a.dport))
        print("SENT %d" % a.count)
    except OSError as exc:
        print("ERROR %s" % exc)
    finally:
        s.close()


def udp_recv(a):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(a.timeout)
    try:
        s.bind(("0.0.0.0", a.port))
        open(a.ready, "w").close()
        _, addr = s.recvfrom(2048)
        print("SRC=%s:%d" % addr)
    except TimeoutError:
        print("NONE")
    except OSError as exc:
        print("ERROR %s" % exc)
    finally:
        s.close()


def frame(a):
    """The Ethernet frame for `inject`, built from the arguments (scapy 2.5)."""
    from scapy.layers.inet import ICMP, IP, UDP, IPerror, UDPerror
    from scapy.layers.inet6 import (
        ICMPv6ND_NA, ICMPv6ND_NS, ICMPv6ND_RA, ICMPv6NDOptDstLLAddr, ICMPv6NDOptSrcLLAddr,
        ICMPv6PacketTooBig, IPv6, IPerror6,
    )
    from scapy.layers.l2 import Ether
    from scapy.packet import Raw

    src_mac = a.src_mac
    if a.kind == "ns":
        l3 = IPv6(src=a.src, dst=a.dst, hlim=a.hlim) / ICMPv6ND_NS(tgt=a.dst) / ICMPv6NDOptSrcLLAddr(lladdr=src_mac)
    elif a.kind == "na":
        l3 = (IPv6(src=a.src, dst=a.dst, hlim=a.hlim)
              / ICMPv6ND_NA(tgt=a.src, R=0, S=1, O=1) / ICMPv6NDOptDstLLAddr(lladdr=src_mac))
    elif a.kind == "ra":
        l3 = (IPv6(src=a.src, dst=a.dst, hlim=a.hlim)
              / ICMPv6ND_RA(routerlifetime=0) / ICMPv6NDOptSrcLLAddr(lladdr=src_mac))
    elif a.kind == "icmp-frag":
        l3 = (IP(src=a.src, dst=a.dst) / ICMP(type=3, code=4, nexthopmtu=1400)
              / IPerror(src=a.quote_src, dst=a.quote_dst, proto=17)
              / UDPerror(sport=a.sport, dport=a.dport) / Raw(b"x" * 8))
    elif a.kind == "icmp6-ptb":
        l3 = (IPv6(src=a.src, dst=a.dst, hlim=a.hlim) / ICMPv6PacketTooBig(mtu=1280)
              / IPerror6(src=a.quote_src, dst=a.quote_dst, nh=17)
              / UDPerror(sport=a.sport, dport=a.dport) / Raw(b"x" * 8))
    elif a.kind == "udp":
        l3 = IP(src=a.src, dst=a.dst) / UDP(sport=a.sport, dport=a.dport) / Raw(b"slv-verdict")
    else:
        sys.exit("unknown packet kind %s" % a.kind)
    return Ether(src=src_mac, dst=a.dst_mac) / l3


def inject(a):
    from scapy.arch import get_if_hwaddr
    from scapy.config import conf
    from scapy.sendrecv import sendp

    conf.verb = 0
    if not a.src_mac:
        a.src_mac = get_if_hwaddr(a.iface)
    sendp(frame(a), iface=a.iface, count=a.count, verbose=0)
    print("SENT %s %d" % (a.kind, a.count))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("tcp-connect")
    c.add_argument("--src", required=True)
    c.add_argument("--dst", required=True)
    c.add_argument("--port", type=int, required=True)
    c.add_argument("--timeout", type=float, default=2.0)
    c.set_defaults(fn=tcp_connect)

    c = sub.add_parser("tcp-burst")
    c.add_argument("--src", required=True)
    c.add_argument("--dst", required=True)
    c.add_argument("--port", type=int, required=True)
    c.add_argument("--count", type=int, default=20)
    c.add_argument("--wait", type=float, default=3.0)
    c.set_defaults(fn=tcp_burst)

    c = sub.add_parser("tcp-flow")
    c.add_argument("--src", required=True)
    c.add_argument("--dst", required=True)
    c.add_argument("--port", type=int, required=True)
    c.add_argument("--ready", required=True)
    c.add_argument("--go", required=True)
    c.add_argument("--timeout", type=float, default=3.0)
    c.set_defaults(fn=tcp_flow)

    c = sub.add_parser("serve")
    c.add_argument("--tcp", type=lambda t: [int(x) for x in t.split(",") if x], default=[])
    c.add_argument("--udp", type=lambda t: [int(x) for x in t.split(",") if x], default=[])
    c.add_argument("--udp-log", required=True)
    c.add_argument("--ready", required=True)
    c.set_defaults(fn=serve)

    c = sub.add_parser("udp-send")
    c.add_argument("--src", required=True)
    c.add_argument("--sport", type=int, default=0)
    c.add_argument("--dst", required=True)
    c.add_argument("--dport", type=int, required=True)
    c.add_argument("--count", type=int, default=1)
    c.set_defaults(fn=udp_send)

    c = sub.add_parser("udp-recv")
    c.add_argument("--port", type=int, required=True)
    c.add_argument("--timeout", type=float, default=5.0)
    c.add_argument("--ready", required=True)
    c.set_defaults(fn=udp_recv)

    c = sub.add_parser("inject")
    c.add_argument("--kind", required=True)
    c.add_argument("--iface", required=True)
    c.add_argument("--dst-mac", required=True)
    c.add_argument("--src-mac", default="")
    c.add_argument("--src", default="")
    c.add_argument("--dst", default="")
    c.add_argument("--hlim", type=int, default=255)
    c.add_argument("--sport", type=int, default=0)
    c.add_argument("--dport", type=int, default=0)
    c.add_argument("--quote-src", default="")
    c.add_argument("--quote-dst", default="")
    c.add_argument("--count", type=int, default=1)
    c.set_defaults(fn=inject)

    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
__PKT_PY__

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

nsx() {
  local ns=$1
  shift
  ip netns exec "$ns" "$@"
}
hx() { nsx "$NS_HOST" "$@"; }
pkt() {
  local ns=$1
  shift
  timeout 60 ip netns exec "$ns" python3 "$WORK/pkt.py" "$@"
}

# packets of a counter of the table under test, or of the probe table
cval() {
  local v
  v=$(hx nft list counter inet slv "$1" 2>/dev/null | awk '/packets/ {print $2; exit}')
  echo "${v:-0}"
}
pval() {
  local v
  v=$(hx nft list counter inet slvprobe "$1" 2>/dev/null | awk '/packets/ {print $2; exit}')
  echo "${v:-0}"
}
mac_of() { # mac_of <netns> <interface>
  ip -n "$1" link show "$2" 2>/dev/null | awk '/link\/ether/ {print $2; exit}'
}

# ---------------------------------------------------------------------------
# The topology
# ---------------------------------------------------------------------------

SETUP_ERROR=""

setup_topology() {
  local ns pair ifc a
  for ns in "$NS_PEER" "$NS_HOST" "$NS_FAR"; do
    ip netns del "$ns" 2>/dev/null
    ip netns add "$ns" || return 1
  done
  ip link add "$IF_PEER" type veth peer name "$IF_HOST_PEER" || return 1
  ip link set "$IF_PEER" netns "$NS_PEER" || return 1
  ip link set "$IF_HOST_PEER" netns "$NS_HOST" || return 1
  ip link add "$IF_HOST_FAR" type veth peer name "$IF_FAR" || return 1
  ip link set "$IF_HOST_FAR" netns "$NS_HOST" || return 1
  ip link set "$IF_FAR" netns "$NS_FAR" || return 1

  for ns in "$NS_PEER" "$NS_HOST" "$NS_FAR"; do
    nsx "$ns" ip link set lo up || return 1
    nsx "$ns" sysctl -qw net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.default.rp_filter=0 || return 1
  done
  for pair in "$NS_PEER:$IF_PEER" "$NS_HOST:$IF_HOST_PEER" "$NS_HOST:$IF_HOST_FAR" "$NS_FAR:$IF_FAR"; do
    ns=${pair%%:*}
    ifc=${pair#*:}
    nsx "$ns" sysctl -qw "net.ipv4.conf.$ifc.rp_filter=0" "net.ipv6.conf.$ifc.accept_dad=0" \
      "net.ipv6.conf.$ifc.autoconf=0" "net.ipv6.conf.$ifc.accept_ra=0" \
      "net.ipv6.conf.$ifc.router_solicitations=0" || return 1
    nsx "$ns" ip link set "$ifc" up || return 1
  done

  # peer <-> host
  nsx "$NS_HOST" ip addr add "$HOST_V4/24" dev "$IF_HOST_PEER" || return 1
  nsx "$NS_PEER" ip addr add "$PEER_V4/24" dev "$IF_PEER" || return 1
  for a in "$LB_V4" "$MGMT_V4" "$OTHER_V4" "$UNSEEN_V4"; do
    nsx "$NS_PEER" ip addr add "$a/32" dev "$IF_PEER" || return 1
  done
  nsx "$NS_HOST" ip route add 198.51.100.0/24 dev "$IF_HOST_PEER" || return 1
  nsx "$NS_PEER" ip route add default via "$HOST_V4" || return 1
  nsx "$NS_HOST" ip addr add "$HOST_V6/64" dev "$IF_HOST_PEER" nodad || return 1
  nsx "$NS_PEER" ip addr add "$PEER_V6/64" dev "$IF_PEER" nodad || return 1
  nsx "$NS_HOST" ip addr add "$HOST_LL/64" dev "$IF_HOST_PEER" nodad || return 1
  nsx "$NS_PEER" ip addr add "$PEER_LL/64" dev "$IF_PEER" nodad || return 1
  # host <-> far
  nsx "$NS_HOST" ip addr add "$HOST_FAR_V4/24" dev "$IF_HOST_FAR" || return 1
  nsx "$NS_FAR" ip addr add "$FAR_V4/24" dev "$IF_FAR" || return 1
  nsx "$NS_HOST" ip addr add "$HOST_LL_FAR/64" dev "$IF_HOST_FAR" nodad || return 1
  nsx "$NS_FAR" ip addr add "$FAR_LL/64" dev "$IF_FAR" nodad || return 1
  nsx "$NS_HOST" sysctl -qw net.ipv4.ip_forward=1 || return 1

  # the topology has to work before any table is loaded
  nsx "$NS_PEER" ping -c 1 -W 2 -I "$PEER_V4" "$HOST_V4" >/dev/null 2>&1 || {
    SETUP_ERROR="peer cannot ping host at $HOST_V4 before any table is loaded"
    return 1
  }
  nsx "$NS_PEER" ping -c 1 -W 2 -I "$MGMT_V4" "$HOST_V4" >/dev/null 2>&1 || {
    SETUP_ERROR="peer cannot ping host from $MGMT_V4 before any table is loaded"
    return 1
  }
  nsx "$NS_PEER" ping -6 -c 1 -W 2 -I "$PEER_V6" "$HOST_V6" >/dev/null 2>&1 || {
    SETUP_ERROR="peer cannot ping host at $HOST_V6 before any table is loaded"
    return 1
  }
  nsx "$NS_HOST" ping -c 1 -W 2 -I "$HOST_FAR_V4" "$FAR_V4" >/dev/null 2>&1 || {
    SETUP_ERROR="host cannot ping far at $FAR_V4 before any table is loaded"
    return 1
  }

  # what the cases talk to: TCP listeners that echo, and a UDP listener that logs the senders
  rm -f "$WORK/serve.ready"
  nsx "$NS_HOST" python3 "$WORK/pkt.py" serve --tcp "$SSH_PORT,$CONSUMER_PORT,$METRICS_PORT" --udp "$SOL_UDP_PORT" \
    --udp-log "$WORK/udp.log" --ready "$WORK/serve.ready" >"$WORK/serve.out" 2>&1 &
  SERVE_PID=$!
  for _ in $(seq 1 50); do
    [ -f "$WORK/serve.ready" ] && return 0
    sleep 0.1
  done
  SETUP_ERROR="the listeners in $NS_HOST did not start: $(cat "$WORK/serve.out" 2>/dev/null)"
  return 1
}

# with no table loaded every port answers: a case that expects silence is then about the table
check_untouched_host() {
  local port r
  for port in "$SSH_PORT" "$CONSUMER_PORT" "$METRICS_PORT"; do
    r=$(pkt "$NS_PEER" tcp-connect --src "$OTHER_V4" --dst "$HOST_V4" --port "$port" --timeout 2)
    if [ "$r" != "OK" ]; then
      SETUP_ERROR="with no table loaded, a connection from $OTHER_V4 to $HOST_V4:$port gave $r, expected OK"
      return 1
    fi
  done
  : > "$WORK/udp.log"
  pkt "$NS_PEER" udp-send --src "$OTHER_V4" --sport 40000 --dst "$HOST_V4" --dport "$SOL_UDP_PORT" >/dev/null
  sleep 0.3
  if ! grep -q "^$OTHER_V4:40000\$" "$WORK/udp.log"; then
    SETUP_ERROR="with no table loaded, a datagram from $OTHER_V4 to $HOST_V4:$SOL_UDP_PORT did not arrive"
    return 1
  fi
  return 0
}

if ! setup_topology || ! check_untouched_host; then
  [ -n "$SETUP_ERROR" ] || SETUP_ERROR="building the namespaces failed (ip netns, veth or sysctl)"
  say_all_failed "$SETUP_ERROR"
fi

HOST_MAC_PEER=$(mac_of "$NS_HOST" "$IF_HOST_PEER")
HOST_MAC_FAR=$(mac_of "$NS_HOST" "$IF_HOST_FAR")
if [ -z "$HOST_MAC_PEER" ] || [ -z "$HOST_MAC_FAR" ]; then
  say_all_failed "cannot read the MAC addresses of $IF_HOST_PEER and $IF_HOST_FAR in $NS_HOST"
fi

# ---------------------------------------------------------------------------
# Loading a table, and probes that tell whether a packet got past it
# ---------------------------------------------------------------------------

# Each probe is `<id>|<match>`. A copy of the match with a counter sits in front of the table
# under test (a_<id>: the packet arrived) and another behind it (s_<id>: the packet survived).
# A table that accepts a packet lets it reach the second copy; a table that drops it does not.
PROBES=(
  "ns255|iifname \"$IF_HOST_PEER\" icmpv6 type nd-neighbor-solicit ip6 hoplimit 255"
  "ns64|iifname \"$IF_HOST_PEER\" icmpv6 type nd-neighbor-solicit ip6 hoplimit 64"
  "na255|iifname \"$IF_HOST_PEER\" icmpv6 type nd-neighbor-advert ip6 hoplimit 255"
  "ra_ll_peer|iifname \"$IF_HOST_PEER\" icmpv6 type nd-router-advert ip6 saddr fe80::/10"
  "ra_global_peer|iifname \"$IF_HOST_PEER\" icmpv6 type nd-router-advert ip6 saddr != fe80::/10"
  "ra_ll_far|iifname \"$IF_HOST_FAR\" icmpv6 type nd-router-advert ip6 saddr fe80::/10"
  "dhcp_peer|iifname \"$IF_HOST_PEER\" meta nfproto ipv4 udp sport 67 udp dport 68"
  "dhcp_far|iifname \"$IF_HOST_FAR\" meta nfproto ipv4 udp sport 67 udp dport 68"
  "frag|iifname \"$IF_HOST_PEER\" icmp type destination-unreachable icmp code frag-needed"
  "ptb|iifname \"$IF_HOST_PEER\" icmpv6 type packet-too-big"
  "spoof|iifname \"$IF_HOST_PEER\" ip saddr $HOST_V4 udp dport $SOL_UDP_PORT"
  "wg_udp|iifname \"$IF_HOST_PEER\" udp dport $WG_UDP_PORT"
  "pub_udp_other|iifname \"$IF_HOST_PEER\" udp dport $PUB_UDP_PORT"
)

install_probes() {
  local entry id
  {
    echo "table inet slvprobe {"
    for entry in "${PROBES[@]}"; do
      id=${entry%%|*}
      echo "  counter a_$id { }"
      echo "  counter s_$id { }"
    done
    echo "  chain pre {"
    echo "    type filter hook input priority -10; policy accept;"
    for entry in "${PROBES[@]}"; do
      echo "    ${entry#*|} counter name \"a_${entry%%|*}\""
    done
    echo "  }"
    echo "  chain post {"
    echo "    type filter hook input priority 10; policy accept;"
    for entry in "${PROBES[@]}"; do
      echo "    ${entry#*|} counter name \"s_${entry%%|*}\""
    done
    echo "  }"
    echo "}"
  } > "$WORK/probe.nft"
  hx nft -f "$WORK/probe.nft" || {
    echo "  loading the probe table failed"
    return 1
  }
}

# prepare <table file> [probes]: a clean host with the table under test (and the probes) loaded
prepare() {
  hx nft delete table inet slvprobe 2>/dev/null
  hx nft delete table ip slvnat 2>/dev/null
  hx sysctl -qw "net.ipv4.conf.$IF_HOST_PEER.accept_local=0" net.ipv4.conf.all.accept_local=0
  hx conntrack -F >/dev/null 2>&1
  : > "$WORK/udp.log"
  hx nft -f "$1" || {
    echo "  nft -f $1 failed in $NS_HOST"
    return 1
  }
  if [ "${2:-}" = "probes" ]; then
    install_probes || return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# The cases
# ---------------------------------------------------------------------------

case_b05() {
  prepare "$T_REFUSE" || return 1
  local rc=0 before after got
  before=$(cval c_sol_udp)
  pkt "$NS_PEER" udp-send --src "$UNSEEN_V4" --sport 40005 --dst "$HOST_V4" --dport "$SOL_UDP_PORT" --count 3 >/dev/null
  sleep 0.5
  after=$(cval c_sol_udp)
  if [ $((after - before)) -lt 3 ]; then
    echo "  c_sol_udp rose by $((after - before)) after 3 datagrams from $UNSEEN_V4 to $HOST_V4:$SOL_UDP_PORT, expected 3"
    rc=1
  fi
  got=$(grep -c "^$UNSEEN_V4:40005\$" "$WORK/udp.log")
  if [ "$got" -lt 3 ]; then
    echo "  the listener on $HOST_V4:$SOL_UDP_PORT received $got of 3 datagrams from $UNSEEN_V4"
    rc=1
  fi
  return $rc
}

case_b06() {
  prepare "$T_REFUSE" || return 1
  local rc=0 r before
  r=$(pkt "$NS_PEER" tcp-connect --src "$OTHER_V4" --dst "$HOST_V4" --port "$CONSUMER_PORT" --timeout 1.5)
  if [ "$r" != "TIMEOUT" ]; then
    echo "  a connection from $OTHER_V4 (neither lb nor mgmt) to the consumer port $CONSUMER_PORT: $r, expected TIMEOUT"
    rc=1
  fi
  before=$(cval c_consumer_lb)
  r=$(pkt "$NS_PEER" tcp-connect --src "$LB_V4" --dst "$HOST_V4" --port "$CONSUMER_PORT" --timeout 2)
  if [ "$r" != "OK" ]; then
    echo "  a connection from the lb address $LB_V4 to the consumer port $CONSUMER_PORT: $r, expected OK"
    rc=1
  fi
  if [ $(($(cval c_consumer_lb) - before)) -lt 1 ]; then
    echo "  c_consumer_lb did not rise after the connection from $LB_V4"
    rc=1
  fi
  before=$(cval c_consumer_mgmt)
  r=$(pkt "$NS_PEER" tcp-connect --src "$MGMT_V4" --dst "$HOST_V4" --port "$CONSUMER_PORT" --timeout 2)
  if [ "$r" != "OK" ]; then
    echo "  a connection from the mgmt address $MGMT_V4 to the consumer port $CONSUMER_PORT: $r, expected OK"
    rc=1
  fi
  if [ $(($(cval c_consumer_mgmt) - before)) -lt 1 ]; then
    echo "  c_consumer_mgmt did not rise after the connection from $MGMT_V4"
    rc=1
  fi
  return $rc
}

case_b07() {
  prepare "$T_REFUSE" || return 1
  local rc=0 r before
  before=$(cval c_mgmt)
  r=$(pkt "$NS_PEER" tcp-connect --src "$MGMT_V4" --dst "$HOST_V4" --port "$SSH_PORT" --timeout 2)
  if [ "$r" != "OK" ]; then
    echo "  SSH from the mgmt address $MGMT_V4 in mode refuse: $r, expected OK"
    rc=1
  fi
  if [ $(($(cval c_mgmt) - before)) -lt 1 ]; then
    echo "  c_mgmt did not rise after the SSH connection from $MGMT_V4"
    rc=1
  fi
  for src in "$OTHER_V4" "$LB_V4"; do
    r=$(pkt "$NS_PEER" tcp-connect --src "$src" --dst "$HOST_V4" --port "$SSH_PORT" --timeout 1.5)
    if [ "$r" != "TIMEOUT" ]; then
      echo "  SSH from $src in mode refuse: $r, expected TIMEOUT"
      rc=1
    fi
  done
  return $rc
}

case_b08() {
  prepare "$T_RATE" || return 1
  local rc=0 r ok silent before
  before=$(cval c_ssh_rl)
  r=$(pkt "$NS_PEER" tcp-burst --src "$OTHER_V4" --dst "$HOST_V4" --port "$SSH_PORT" --count 20 --wait 3)
  ok=$(echo "$r" | sed -n 's/.*OK=\([0-9]*\).*/\1/p')
  silent=$(echo "$r" | sed -n 's/.*SILENT=\([0-9]*\).*/\1/p')
  if [ -z "$ok" ] || [ "$ok" -lt 1 ] || [ "$ok" -gt 8 ]; then
    echo "  20 new SSH connections from $OTHER_V4 (limit: burst 5, 10 a minute): $r, expected between 1 and 8 to connect"
    rc=1
  fi
  if [ -z "$silent" ] || [ "$silent" -lt 10 ]; then
    echo "  20 new SSH connections from $OTHER_V4: $r, expected at least 10 to get no answer"
    rc=1
  fi
  if [ $(($(cval c_ssh_rl) - before)) -lt 10 ]; then
    echo "  c_ssh_rl rose by $(($(cval c_ssh_rl) - before)), expected at least 10 dropped SYNs"
    rc=1
  fi
  r=$(pkt "$NS_PEER" tcp-burst --src "$MGMT_V4" --dst "$HOST_V4" --port "$SSH_PORT" --count 20 --wait 3)
  if [ "$r" != "OK=20 FAILED=0 SILENT=0" ]; then
    echo "  20 new SSH connections from the mgmt address $MGMT_V4: $r, expected OK=20 (mgmt is not limited)"
    rc=1
  fi
  return $rc
}

case_b09() {
  prepare "$T_REFUSE" || return 1
  local rc=0 r pid
  rm -f "$WORK/flow.ready" "$WORK/flow.go" "$WORK/flow.out"
  pkt "$NS_PEER" tcp-flow --src "$LB_V4" --dst "$HOST_V4" --port "$CONSUMER_PORT" \
    --ready "$WORK/flow.ready" --go "$WORK/flow.go" --timeout 3 >"$WORK/flow.out" 2>&1 &
  pid=$!
  for _ in $(seq 1 60); do
    [ -f "$WORK/flow.ready" ] && break
    sleep 0.1
  done
  if [ ! -f "$WORK/flow.ready" ]; then
    echo "  the flow from $LB_V4 was not established before the reload: $(cat "$WORK/flow.out")"
    kill "$pid" 2>/dev/null
    return 1
  fi
  # the same address moves from lb to deny, and the table is loaded again
  hx nft -f "$T_DENY" || {
    echo "  loading the deny table failed"
    kill "$pid" 2>/dev/null
    return 1
  }
  touch "$WORK/flow.go"
  wait "$pid"
  r=$(head -n 1 "$WORK/flow.out")
  if [ "$r" != "SILENT" ]; then
    echo "  the open flow from $LB_V4 after $LB_V4 moved to deny: $r, expected SILENT"
    rc=1
  fi
  if [ "$(cval c_deny)" -lt 1 ]; then
    echo "  c_deny stayed at $(cval c_deny) after the reload, expected the flow's packets to be counted"
    rc=1
  fi
  return $rc
}

# inject <netns> <interface> <destination mac> <kind> <args...>
inject() {
  local ns=$1 ifc=$2 mac=$3 kind=$4
  shift 4
  pkt "$ns" inject --iface "$ifc" --dst-mac "$mac" --kind "$kind" "$@" >/dev/null
}

case_b10() {
  prepare "$T_REFUSE" probes || return 1
  local rc=0
  inject "$NS_PEER" "$IF_PEER" "$HOST_MAC_PEER" ns --src "$PEER_LL" --dst "$HOST_LL" --hlim 255
  inject "$NS_PEER" "$IF_PEER" "$HOST_MAC_PEER" ns --src "$PEER_LL" --dst "$HOST_LL" --hlim 64
  inject "$NS_PEER" "$IF_PEER" "$HOST_MAC_PEER" na --src "$PEER_LL" --dst "$HOST_LL" --hlim 255
  inject "$NS_PEER" "$IF_PEER" "$HOST_MAC_PEER" ra --src "$PEER_LL" --dst "$HOST_LL" --hlim 255
  inject "$NS_PEER" "$IF_PEER" "$HOST_MAC_PEER" ra --src "$PEER_V6" --dst "$HOST_LL" --hlim 255
  inject "$NS_FAR" "$IF_FAR" "$HOST_MAC_FAR" ra --src "$FAR_LL" --dst "$HOST_LL_FAR" --hlim 255
  sleep 0.5
  # got <id>: how often the packet of the probe arrived (a) and got past the table (s)
  if [ "$(pval s_ns255)" -lt 1 ]; then
    echo "  a neighbour solicitation with hop limit 255 did not get through (arrived $(pval a_ns255), passed $(pval s_ns255))"
    rc=1
  fi
  if [ "$(pval a_ns64)" -lt 1 ] || [ "$(pval s_ns64)" -ne 0 ]; then
    echo "  a neighbour solicitation with hop limit 64: arrived $(pval a_ns64), passed $(pval s_ns64); expected it to arrive and be dropped"
    rc=1
  fi
  if [ "$(pval s_na255)" -lt 1 ]; then
    echo "  a neighbour advertisement with hop limit 255 did not get through (arrived $(pval a_na255), passed $(pval s_na255))"
    rc=1
  fi
  if [ "$(pval a_ra_global_peer)" -lt 1 ] || [ "$(pval s_ra_global_peer)" -ne 0 ]; then
    echo "  a router advertisement from a source that is not link-local: arrived $(pval a_ra_global_peer), passed $(pval s_ra_global_peer); expected it to arrive and be dropped"
    rc=1
  fi
  if [ "$(pval s_ra_ll_peer)" -lt 1 ]; then
    echo "  a router advertisement from fe80::/10 on $IF_HOST_PEER, which is in ra_ifaces, did not get through (arrived $(pval a_ra_ll_peer), passed $(pval s_ra_ll_peer))"
    rc=1
  fi
  if [ "$(pval a_ra_ll_far)" -lt 1 ] || [ "$(pval s_ra_ll_far)" -ne 0 ]; then
    echo "  a router advertisement from fe80::/10 on $IF_HOST_FAR, which is not in ra_ifaces: arrived $(pval a_ra_ll_far), passed $(pval s_ra_ll_far); expected it to arrive and be dropped"
    rc=1
  fi
  return $rc
}

case_b11() {
  prepare "$T_REFUSE" probes || return 1
  local rc=0 before
  # an untracked flow of this host: a datagram that leaves from a port of sol_udp
  pkt "$NS_HOST" udp-send --src "$HOST_V4" --sport $((SOL_UDP_PORT + 1)) --dst "$PEER_V4" --dport 40011 >/dev/null
  sleep 0.3
  before=$(cval c_icmp_err)
  inject "$NS_PEER" "$IF_PEER" "$HOST_MAC_PEER" icmp-frag --src "$PEER_V4" --dst "$HOST_V4" \
    --quote-src "$HOST_V4" --quote-dst "$PEER_V4" --sport $((SOL_UDP_PORT + 1)) --dport 40011
  inject "$NS_PEER" "$IF_PEER" "$HOST_MAC_PEER" icmp6-ptb --src "$PEER_V6" --dst "$HOST_V6" --hlim 64 \
    --quote-src "$HOST_V6" --quote-dst "$PEER_V6" --sport $((SOL_UDP_PORT + 1)) --dport 40011
  sleep 0.5
  if [ "$(pval s_frag)" -lt 1 ]; then
    echo "  the ICMP fragmentation-needed error did not get through (arrived $(pval a_frag), passed $(pval s_frag))"
    rc=1
  fi
  if [ "$(pval s_ptb)" -lt 1 ]; then
    echo "  the ICMPv6 packet-too-big error did not get through (arrived $(pval a_ptb), passed $(pval s_ptb))"
    rc=1
  fi
  if [ $(($(cval c_icmp_err) - before)) -lt 2 ]; then
    echo "  c_icmp_err rose by $(($(cval c_icmp_err) - before)) after the two errors, expected at least 2 (c_invalid is at $(cval c_invalid))"
    rc=1
  fi
  return $rc
}

case_b12() {
  prepare "$T_REFUSE" || return 1
  local rc=0 r
  hx nft -f - <<__NAT__ || { echo "  loading the masquerade table failed"; return 1; }
table ip slvnat {
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    oifname "$IF_HOST_FAR" masquerade
  }
}
__NAT__
  rm -f "$WORK/far.ready" "$WORK/far.out"
  pkt "$NS_FAR" udp-recv --port "$SOL_UDP_PORT" --timeout 6 --ready "$WORK/far.ready" >"$WORK/far.out" 2>&1 &
  local pid=$!
  for _ in $(seq 1 50); do
    [ -f "$WORK/far.ready" ] && break
    sleep 0.1
  done
  pkt "$NS_PEER" udp-send --src "$PEER_V4" --sport 40012 --dst "$FAR_V4" --dport "$SOL_UDP_PORT" >/dev/null
  wait "$pid"
  r=$(head -n 1 "$WORK/far.out")
  case "$r" in
    "SRC=$HOST_FAR_V4:"*) ;;
    *)
      echo "  far saw the forwarded datagram from: $r, expected the address of host on the far link ($HOST_FAR_V4)"
      rc=1
      ;;
  esac
  return $rc
}

case_b13() {
  prepare "$T_REFUSE" probes || return 1
  local rc=0 spoof_before sol_before
  hx sysctl -qw "net.ipv4.conf.$IF_HOST_PEER.accept_local=1" "net.ipv4.conf.$IF_HOST_PEER.rp_filter=0"
  spoof_before=$(cval c_spoof)
  sol_before=$(cval c_sol_udp)
  inject "$NS_PEER" "$IF_PEER" "$HOST_MAC_PEER" udp --src "$HOST_V4" --dst "$HOST_V4" \
    --sport 40013 --dport "$SOL_UDP_PORT" --count 3
  sleep 0.5
  if [ "$(pval a_spoof)" -lt 1 ]; then
    echo "  the datagram with the source $HOST_V4 never reached the input hook (the kernel dropped it even with accept_local=1)"
    rc=1
  fi
  if [ $(($(cval c_spoof) - spoof_before)) -lt 3 ]; then
    echo "  c_spoof rose by $(($(cval c_spoof) - spoof_before)) after 3 datagrams with the host's own source address, expected 3"
    rc=1
  fi
  if [ "$(cval c_sol_udp)" -ne "$sol_before" ] || [ "$(pval s_spoof)" -ne 0 ]; then
    echo "  a datagram with the host's own source address got past the table (c_sol_udp +$(($(cval c_sol_udp) - sol_before)), passed $(pval s_spoof))"
    rc=1
  fi
  return $rc
}

case_b14() {
  prepare "$T_REFUSE" probes || return 1
  local rc=0
  pkt "$NS_PEER" udp-send --src "$PEER_V4" --sport 67 --dst "$HOST_V4" --dport 68 >/dev/null
  pkt "$NS_FAR" udp-send --src "$FAR_V4" --sport 67 --dst "$HOST_FAR_V4" --dport 68 >/dev/null
  sleep 0.5
  if [ "$(pval s_dhcp_peer)" -lt 1 ]; then
    echo "  a DHCPv4 reply (67 -> 68) on $IF_HOST_PEER, which is in dhcp4_ifaces, did not get through (arrived $(pval a_dhcp_peer), passed $(pval s_dhcp_peer))"
    rc=1
  fi
  if [ "$(pval a_dhcp_far)" -lt 1 ] || [ "$(pval s_dhcp_far)" -ne 0 ]; then
    echo "  a DHCPv4 reply (67 -> 68) on $IF_HOST_FAR, which is not in dhcp4_ifaces: arrived $(pval a_dhcp_far), passed $(pval s_dhcp_far); expected it to arrive and be dropped"
    rc=1
  fi
  return $rc
}

case_b15() {
  prepare "$T_FALLBACK" || return 1
  local rc=0 r before
  r=$(pkt "$NS_PEER" tcp-connect --src "$MGMT_V4" --dst "$HOST_V4" --port "$SSH_PORT" --timeout 2)
  if [ "$r" != "OK" ]; then
    echo "  SSH from the mgmt address $MGMT_V4 against the fallback table: $r, expected OK"
    rc=1
  fi
  before=$(cval c_sol_udp)
  pkt "$NS_PEER" udp-send --src "$UNSEEN_V4" --sport 40015 --dst "$HOST_V4" --dport "$SOL_UDP_PORT" --count 2 >/dev/null
  sleep 0.5
  if [ $(($(cval c_sol_udp) - before)) -lt 2 ]; then
    echo "  c_sol_udp rose by $(($(cval c_sol_udp) - before)) against the fallback table, expected 2"
    rc=1
  fi
  for src in "$LB_V4" "$MGMT_V4"; do
    r=$(pkt "$NS_PEER" tcp-connect --src "$src" --dst "$HOST_V4" --port "$CONSUMER_PORT" --timeout 1.5)
    if [ "$r" != "TIMEOUT" ]; then
      echo "  a connection from $src to the consumer port $CONSUMER_PORT against the fallback table: $r, expected TIMEOUT"
      rc=1
    fi
  done
  return $rc
}

# send_udp <destination port> <count>: datagrams from an address the host has never seen
send_udp() {
  pkt "$NS_PEER" udp-send --src "$UNSEEN_V4" --sport 40016 --dst "$HOST_V4" --dport "$1" --count "$2" >/dev/null
}

case_b16() {
  local rc=0
  # The full table opens both public UDP ports (the second was added to the model by hand);
  # without that the fallback below would prove nothing.
  prepare "$T_WG" probes || return 1
  send_udp "$WG_UDP_PORT" 2
  send_udp "$PUB_UDP_PORT" 2
  sleep 0.5
  if [ "$(pval s_wg_udp)" -lt 2 ] || [ "$(pval s_pub_udp_other)" -lt 2 ]; then
    echo "  the full table did not open both public UDP ports: $WG_UDP_PORT passed $(pval s_wg_udp) of 2, $PUB_UDP_PORT passed $(pval s_pub_udp_other) of 2"
    rc=1
  fi
  prepare "$T_WG_FALLBACK" probes || return 1
  send_udp "$WG_UDP_PORT" 2
  send_udp "$PUB_UDP_PORT" 2
  sleep 0.5
  if [ "$(pval s_wg_udp)" -lt 2 ]; then
    echo "  the fallback table did not let the WireGuard port $WG_UDP_PORT through (arrived $(pval a_wg_udp), passed $(pval s_wg_udp) of 2)"
    rc=1
  fi
  if [ "$(pval a_pub_udp_other)" -lt 2 ] || [ "$(pval s_pub_udp_other)" -ne 0 ]; then
    echo "  another public UDP port ($PUB_UDP_PORT) against the fallback table: arrived $(pval a_pub_udp_other), passed $(pval s_pub_udp_other); expected it to arrive and be dropped"
    rc=1
  fi
  return $rc
}

case_b17() {
  prepare "$T_REFUSE" || return 1
  local rc=0 r src before
  # metrics_ips is empty in this scenario: no address is a scrape source, and mgmt is the only one let in
  for src in "$OTHER_V4" "$LB_V4"; do
    r=$(pkt "$NS_PEER" tcp-connect --src "$src" --dst "$HOST_V4" --port "$METRICS_PORT" --timeout 1.5)
    if [ "$r" != "TIMEOUT" ]; then
      echo "  a connection from $src (neither a scrape source nor mgmt) to the metrics port $METRICS_PORT: $r, expected TIMEOUT"
      rc=1
    fi
  done
  before=$(cval c_metrics)
  r=$(pkt "$NS_PEER" tcp-connect --src "$MGMT_V4" --dst "$HOST_V4" --port "$METRICS_PORT" --timeout 2)
  if [ "$r" != "OK" ]; then
    echo "  a connection from the mgmt address $MGMT_V4 to the metrics port $METRICS_PORT: $r, expected OK"
    rc=1
  fi
  if [ $(($(cval c_metrics) - before)) -lt 1 ]; then
    echo "  c_metrics did not rise after the connection from $MGMT_V4"
    rc=1
  fi
  return $rc
}

case_b18() {
  local rc=0 r before
  # The table matches the tunnel by the name of its interface. A pair of virtual links stands in
  # for it, and is checked with no table loaded so that a silence below is about the table.
  hx nft delete table inet slv 2>/dev/null
  hx ip link del "$IF_WG" 2>/dev/null
  hx ip link add "$IF_WG" type veth peer name "$IF_WG_PEER" || {
    echo "  creating the link pair $IF_WG - $IF_WG_PEER failed"
    return 1
  }
  hx ip link set "$IF_WG_PEER" netns "$NS_PEER" || return 1
  hx sysctl -qw "net.ipv6.conf.$IF_WG.disable_ipv6=1" || return 1
  nsx "$NS_PEER" sysctl -qw "net.ipv6.conf.$IF_WG_PEER.disable_ipv6=1" || return 1
  hx ip addr add "$WG_HOST_V4/24" dev "$IF_WG" || return 1
  nsx "$NS_PEER" ip addr add "$WG_PEER_V4/24" dev "$IF_WG_PEER" || return 1
  hx ip link set "$IF_WG" up || return 1
  nsx "$NS_PEER" ip link set "$IF_WG_PEER" up || return 1
  r=$(pkt "$NS_PEER" tcp-connect --src "$WG_PEER_V4" --dst "$WG_HOST_V4" --port "$SSH_PORT" --timeout 2)
  if [ "$r" != "OK" ]; then
    echo "  with no table loaded, a connection from $WG_PEER_V4 to $WG_HOST_V4:$SSH_PORT over $IF_WG gave $r, expected OK"
    return 1
  fi
  prepare "$T_WG_FALLBACK" || return 1
  before=$(cval c_mgmt)
  r=$(pkt "$NS_PEER" tcp-connect --src "$WG_PEER_V4" --dst "$WG_HOST_V4" --port "$SSH_PORT" --timeout 2)
  if [ "$r" != "OK" ]; then
    echo "  SSH from the tunnel address $WG_PEER_V4 over $IF_WG against the fallback table: $r, expected OK"
    rc=1
  fi
  if [ $(($(cval c_mgmt) - before)) -lt 1 ]; then
    echo "  c_mgmt did not rise after the SSH connection over $IF_WG"
    rc=1
  fi
  r=$(pkt "$NS_PEER" tcp-connect --src "$WG_PEER_V4" --dst "$WG_HOST_V4" --port "$CONSUMER_PORT" --timeout 1.5)
  if [ "$r" != "TIMEOUT" ]; then
    echo "  a connection from $WG_PEER_V4 over $IF_WG to the consumer port $CONSUMER_PORT against the fallback table: $r, expected TIMEOUT"
    rc=1
  fi
  hx ip link del "$IF_WG" 2>/dev/null
  return $rc
}

case_b19() {
  prepare "$T_FALLBACK" || return 1
  local rc=0 r src
  for src in "$MGMT_V4" "$LB_V4" "$OTHER_V4"; do
    r=$(pkt "$NS_PEER" tcp-connect --src "$src" --dst "$HOST_V4" --port "$METRICS_PORT" --timeout 1.5)
    if [ "$r" != "TIMEOUT" ]; then
      echo "  a connection from $src to the metrics port $METRICS_PORT against the fallback table: $r, expected TIMEOUT"
      rc=1
    fi
  done
  # the same table lets mgmt in on the SSH port, so the silence above is about the metrics port
  r=$(pkt "$NS_PEER" tcp-connect --src "$MGMT_V4" --dst "$HOST_V4" --port "$SSH_PORT" --timeout 2)
  if [ "$r" != "OK" ]; then
    echo "  SSH from the mgmt address $MGMT_V4 against the fallback table: $r, expected OK"
    rc=1
  fi
  return $rc
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

selected() { # selected <case name>: true when no ids were given, or the name starts with one of them
  local id
  [ "${#SELECTED[@]}" -eq 0 ] && return 0
  for id in "${SELECTED[@]}"; do
    case "$1" in
      "$id"*) return 0 ;;
    esac
  done
  return 1
}

for entry in "${CASES[@]}"; do
  name=${entry%%:*}
  fn=${entry#*:}
  selected "$name" || continue
  out=$("$fn" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "PASS $name"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL $name"
    printf '%s\n' "$out" | sed 's/^/    /'
    echo "    counters of the table under test, then of the probes:"
    hx nft list counters inet slv 2>/dev/null | awk '/counter/ {name=$2} /packets/ {printf "      %s %s\n", name, $2}'
    hx nft list counters inet slvprobe 2>/dev/null | awk '/counter/ {name=$2} /packets/ {printf "      %s %s\n", name, $2}'
    FAILED=$((FAILED + 1))
  fi
done

echo "netns verdicts: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
