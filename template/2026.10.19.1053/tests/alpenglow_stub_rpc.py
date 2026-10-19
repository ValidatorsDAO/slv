#!/usr/bin/env python3
"""A stub Solana JSON-RPC server for the Alpenglow state probe tests.

    alpenglow_stub_rpc.py REQUEST_LOG

Prints the port it listens on (127.0.0.1, chosen by the system) and serves until
it is killed. The first segment of the request path names the scenario, so one
server answers every case: POST http://127.0.0.1:PORT/window

It answers the calls the probe and the dead primary checks make, and nothing else:

  getAgGenesisCert  the genesis certificate, or null
  getAccountInfo    only for the Alpenglow feature account, only as base64 with a
                    one byte dataSlice at processed commitment
  getEpochInfo      only at processed commitment
  getClusterNodes   the nodes in gossip: ending the path with nodes=none|target|other|
                    both|error|http500 puts the identity (id=NAME, default the staked key
                    of the rigs) at the address of the target (ip=, default 10.9.9.9), at
                    another one (other=, default 10.1.1.1), at both, or nowhere; also=IP
                    adds one more entry of the identity at IP to any of the first four;
                    bam=IP puts the tpuQuic and tpuForwardsQuic sockets of the entries of the
                    identity at IP, as a validator connected to BAM advertises them, while
                    its gossip socket stays at the address of the entry
  getVoteAccounts   only for one vote account at processed commitment with
                    keepUnstakedDelinquents: vote=current:N or delinquent:N gives it a
                    last vote N, vote=current:N:STEP (or delinquent:N:STEP) gives it N the
                    first time it is asked on a path and STEP more each later time (a vote
                    account whose node votes; the default is current:1000:25),
                    vote=missing leaves it out, vote=error|http500 fail
  getSlot           at commitment finalized, the finalized slot of the node (scenario
                    "local"): slot=N (default 1000); at commitment processed, the current
                    slot of the cluster: now=N (default 100000). Both take error|http500|
                    garbage in place of N

Any other question is a JSON-RPC error, so a client that asks something else cannot
pass by luck. Every request is appended to REQUEST_LOG as one JSON line.
"""
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

FEATURE = "A1pengvuM6JEcyNuTnMqepBKhwHE3N6PmUrdATGawhJS"
FEATURE_PROGRAM = "Feature111111111111111111111111111111111111"
EPOCH_LENGTH = 432000
FAR = 200000  # slots left in the epoch when a scenario does not say

CERTIFICATE = {
    "block": {"slot": 444625255, "blockId": [7] * 32},
    "signature": {"signature": [9] * 48, "bitmap": [0, 229, 1]},
}

# name -> (what getAgGenesisCert answers, what the feature account holds)
#   cert:    "null" | "certificate" | "rpc-error" | "http-500" | "garbage" | "string" | "empty-object"
#   feature: "absent" | "inactive" | "active" | "rpc-error" | "http-500" | "garbage"
#            | "wrong-owner" | "wrong-data" | "no-context"
SCENARIOS = {
    "towerbft": ("null", "absent"),
    "towerbft-pending": ("null", "inactive"),
    "absent-near": ("null", "absent"),
    "local": ("null", "absent"),
    "window": ("null", "active"),
    "alpenglow": ("certificate", "active"),
    "alpenglow-no-feature-call": ("certificate", "http-500"),
    "unknown-http500": ("http-500", "http-500"),
    "unknown-rpc-error": ("rpc-error", "active"),
    "unknown-garbage": ("garbage", "active"),
    "unknown-string": ("string", "active"),
    "unknown-empty-object": ("empty-object", "active"),
    "unknown-feature-rpc-error": ("null", "rpc-error"),
    "unknown-feature-http500": ("null", "http-500"),
    "unknown-feature-garbage": ("null", "garbage"),
    "unknown-feature-wrong-owner": ("null", "wrong-owner"),
    "unknown-feature-wrong-data": ("null", "wrong-data"),
    "unknown-feature-no-context": ("null", "no-context"),
}

# The feature is pending (its account exists, not activated) and the epoch ends soon:
#   pending-N             N slots are left in the epoch
#   pending-epoch-KIND    getEpochInfo answers badly: rpc-error | http-500 | garbage
#                         | no-fields | bad-types | inverted
EPOCH_BAD = {"rpc-error", "http-500", "garbage", "no-fields", "bad-types", "inverted"}

# flaky-NAME answers each method with HTTP 503 the first time it is asked on a path
# and then like NAME (end the path with a name of your own to start over)
FLAKY = {"flaky-window": "window", "flaky-towerbft": "towerbft"}

# flip-K answers towerbft to the first K probes on a path and window to every later
# one (a probe is one request of each method)
FLIP = re.compile(r"^flip-([0-9]+)$")
# aflip-K answers alpenglow to the first K probes and window to every later one, and
# tflip-K answers towerbft to the first K probes and alpenglow to every later one
AFLIP = re.compile(r"^aflip-([0-9]+)$")
TFLIP = re.compile(r"^tflip-([0-9]+)$")
# hiccup-K-N answers towerbft to the first K requests of each method on a path, HTTP 503 to
# the next N, and towerbft again after that (N = 999999: the cluster stays out of reach);
# ahiccup-K-N does the same with alpenglow in place of towerbft, and phiccup-K-N with
# towerbft-pending (the feature account exists and the epoch has far to go)
HICCUP = re.compile(r"^([ap]?)hiccup-([0-9]+)-([0-9]+)$")
PENDING = re.compile(r"^pending-([0-9]+)$")

lock = threading.Lock()
seen = {}
log_path = sys.argv[1]


def path_options(path):
    """key=value segments of the path after the scenario name."""
    segments = urlsplit(path).path.strip("/").split("/")[1:]
    return dict(segment.split("=", 1) for segment in segments if "=" in segment)


def gossip_node(pubkey, ip, bam=None):
    quic = bam or ip
    return {
        "pubkey": pubkey,
        "gossip": f"{ip}:8001",
        "tvu": f"{ip}:8002",
        "tpu": None,
        "tpuQuic": f"{quic}:8009",
        "tpuForwards": None,
        "tpuForwardsQuic": f"{quic}:8010",
        "tpuVote": f"{ip}:8004",
        "serveRepair": f"{ip}:8008",
        "rpc": None,
        "pubsub": None,
        "version": "4.4.0-beta.1",
        "clientId": "Agave",
        "featureSet": 1,
        "shredVersion": 1,
    }


def feature_value(kind):
    account = {
        "data": ["AA==", "base64"],
        "executable": False,
        "lamports": 695960,
        "owner": FEATURE_PROGRAM,
        "rentEpoch": 18446744073709551615,
        "space": 9,
    }
    if kind == "inactive":
        return account
    if kind == "active":
        return dict(account, data=["AQ==", "base64"])
    if kind == "wrong-owner":
        return dict(account, owner="11111111111111111111111111111111", data=["AQ==", "base64"])
    if kind == "wrong-data":
        return dict(account, data=["AAECAwQFBgcI", "base64"])
    return None


def epoch_info(slot_index, slots_in_epoch):
    return {
        "absoluteSlot": 457000000 + slot_index,
        "blockHeight": 440000000,
        "epoch": 1063,
        "slotIndex": slot_index,
        "slotsInEpoch": slots_in_epoch,
        "transactionCount": 1,
    }


def resolve(scenario, count):
    """-> (cert kind, feature kind, slots left or an EPOCH_BAD kind) for this request."""
    if scenario in FLAKY:
        if count == 1:
            return None
        scenario = FLAKY[scenario]
    flip = FLIP.match(scenario)
    if flip:
        scenario = "towerbft" if count <= int(flip.group(1)) else "window"
    aflip = AFLIP.match(scenario)
    if aflip:
        scenario = "alpenglow" if count <= int(aflip.group(1)) else "window"
    tflip = TFLIP.match(scenario)
    if tflip:
        scenario = "towerbft" if count <= int(tflip.group(1)) else "alpenglow"
    hiccup = HICCUP.match(scenario)
    if hiccup:
        first, failures = int(hiccup.group(2)), int(hiccup.group(3))
        if first < count <= first + failures:
            return None
        scenario = {"a": "alpenglow", "p": "towerbft-pending"}.get(hiccup.group(1), "towerbft")
    pending = PENDING.match(scenario)
    if pending:
        return ("null", "inactive", int(pending.group(1)))
    if scenario.startswith("pending-epoch-") and scenario[len("pending-epoch-"):] in EPOCH_BAD:
        return ("null", "inactive", scenario[len("pending-epoch-"):])
    if scenario == "absent-near":
        return ("null", "absent", 100)
    if scenario in SCENARIOS:
        cert, feature = SCENARIOS[scenario]
        return (cert, feature, FAR)
    raise KeyError(scenario)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *args):
        pass

    def send(self, status, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        scenario = urlsplit(self.path).path.strip("/").split("/")[0]
        length = int(self.headers.get("Content-Length") or 0)
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            self.send(400, {"error": "bad request"})
            return
        method = request.get("method")
        params = request.get("params") or []
        with lock:
            with open(log_path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps({"path": self.path, "scenario": scenario, "method": method, "params": params}) + "\n")
            count = seen[(self.path, method)] = seen.get((self.path, method), 0) + 1
        try:
            resolved = resolve(scenario, count)
        except KeyError:
            self.send(404, {"error": "no such scenario"})
            return
        if resolved is None:
            self.send(503, {"error": "busy"})
            return
        cert, feature, left = resolved
        envelope = {"jsonrpc": "2.0", "id": request.get("id")}

        if method == "getAgGenesisCert":
            kind = cert
        elif method == "getAccountInfo":
            kind = feature
            options = params[1] if len(params) > 1 and isinstance(params[1], dict) else {}
            asked_right = (
                params[:1] == [FEATURE]
                and options.get("encoding") == "base64"
                and options.get("dataSlice") == {"offset": 0, "length": 1}
                and options.get("commitment") == "processed"
            )
            if not asked_right:
                self.send(200, dict(envelope, error={"code": -32602, "message": "unexpected question"}))
                return
        elif method == "getEpochInfo":
            if params != [{"commitment": "processed"}]:
                self.send(200, dict(envelope, error={"code": -32602, "message": "unexpected question"}))
                return
            kind = left if left in EPOCH_BAD else "left"
        elif method == "getClusterNodes":
            options = path_options(self.path)
            mode = options.get("nodes", "none")
            if mode == "http500":
                self.send(500, {"error": "server error"})
                return
            if mode == "error":
                self.send(200, dict(envelope, error={"code": -32005, "message": "no"}))
                return
            identity = options.get("id", "StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA")
            nodes = [gossip_node("SOMEOTHERNODE1", "10.7.7.1"), gossip_node("SOMEOTHERNODE2", "10.7.7.2")]
            bam = options.get("bam")
            if mode in ("target", "both"):
                nodes.append(gossip_node(identity, options.get("ip", "10.9.9.9"), bam))
            if mode in ("other", "both"):
                nodes.append(gossip_node(identity, options.get("other", "10.1.1.1"), bam))
            if mode != "none" and "also" in options:
                nodes.append(gossip_node(identity, options["also"], bam))
            self.send(200, dict(envelope, result=nodes))
            return
        elif method == "getVoteAccounts":
            options = path_options(self.path)
            config = params[0] if params and isinstance(params[0], dict) else {}
            asked_right = (
                len(params) == 1
                and isinstance(config.get("votePubkey"), str)
                and config.get("votePubkey") != ""
                and config.get("commitment") == "processed"
                and config.get("keepUnstakedDelinquents") is True
            )
            if not asked_right:
                self.send(200, dict(envelope, error={"code": -32602, "message": "unexpected question"}))
                return
            mode, _, rest = options.get("vote", "current:1000:25").partition(":")
            if mode == "http500":
                self.send(500, {"error": "server error"})
                return
            if mode == "error":
                self.send(200, dict(envelope, error={"code": -32005, "message": "no"}))
                return
            start, _, step = rest.partition(":")
            last_vote = int(start or 0) + int(step or 0) * (count - 1)
            entry = {
                "votePubkey": config["votePubkey"],
                "nodePubkey": options.get("id", "StakedKeyForTheRigsAAAAAAAAAAAAAAAAAA"),
                "activatedStake": 1,
                "commission": 0,
                "epochVoteAccount": True,
                "epochCredits": [],
                "lastVote": last_vote,
                "rootSlot": max(last_vote - 3, 0),
            }
            self.send(
                200,
                dict(envelope, result={"current": [entry] if mode == "current" else [], "delinquent": [entry] if mode == "delinquent" else []}),
            )
            return
        elif method == "getSlot":
            options = path_options(self.path)
            if params == [{"commitment": "finalized"}]:
                slot = options.get("slot", "1000")
            elif params == [{"commitment": "processed"}]:
                slot = options.get("now", "100000")
            else:
                self.send(200, dict(envelope, error={"code": -32602, "message": "unexpected question"}))
                return
            if slot == "http500":
                self.send(500, {"error": "server error"})
            elif slot == "error":
                self.send(200, dict(envelope, error={"code": -32005, "message": "no"}))
            elif slot == "garbage":
                self.send(200, b"<html>not json</html>", "text/html")
            else:
                self.send(200, dict(envelope, result=int(slot)))
            return
        else:
            self.send(200, dict(envelope, error={"code": -32601, "message": "Method not found"}))
            return

        if kind == "http-500":
            self.send(500, {"error": "server error"})
        elif kind == "garbage":
            self.send(200, b"<html>not json</html>", "text/html")
        elif kind == "rpc-error":
            self.send(200, dict(envelope, error={"code": -32601 if method == "getAgGenesisCert" else -32005, "message": "no"}))
        elif method == "getAgGenesisCert":
            result = {
                "null": None,
                "certificate": CERTIFICATE,
                "string": "certificate",
                "empty-object": {},
            }[kind]
            self.send(200, dict(envelope, result=result))
        elif method == "getEpochInfo":
            if kind == "no-fields":
                result = {"epoch": 1063}
            elif kind == "bad-types":
                result = dict(epoch_info(5, EPOCH_LENGTH), slotIndex="5", slotsInEpoch=True)
            elif kind == "inverted":
                result = epoch_info(EPOCH_LENGTH + 10, EPOCH_LENGTH)
            else:
                result = epoch_info(EPOCH_LENGTH - left, EPOCH_LENGTH)
            self.send(200, dict(envelope, result=result))
        else:
            context = {"apiVersion": "4.3.0", "slot": 457689875}
            result = {"value": feature_value(kind)} if kind == "no-context" else {"context": context, "value": feature_value(kind)}
            self.send(200, dict(envelope, result=result))


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)
server.serve_forever()
