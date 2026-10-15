#!/usr/bin/env bash
set -euo pipefail

# Keep the recipe portable across the three native host families. GNU
# readlink/sha256sum are not assumed on macOS; recorded identities use Python.
PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || {
  echo "python3 is a required native build prerequisite" >&2
  exit 65
}
python_version="$($PYTHON -c 'import sys; print(".".join(map(str, sys.version_info[:3])))')"
"$PYTHON" - <<'PYEOF' || {
import sys
raise SystemExit(0 if sys.version_info >= (3, 11) else 1)
PYEOF
  echo "Python 3.11 or newer is required for the lock guard" >&2
  exit 65
}
canonical_path() {
  "$PYTHON" - "$1" <<'PYEOF'
import os
import sys
print(os.path.realpath(sys.argv[1]))
PYEOF
}
sha256_file() {
  "$PYTHON" - "$1" <<'PYEOF'
import hashlib
import pathlib
import sys
path = pathlib.Path(sys.argv[1])
hash = hashlib.sha256()
with path.open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        hash.update(chunk)
print(hash.hexdigest())
PYEOF
}
resource_snapshot() {
  "$PYTHON" - "$1" <<'PYEOF'
import json
import resource
import shutil
import sys
usage = shutil.disk_usage(sys.argv[1])
children = resource.getrusage(resource.RUSAGE_CHILDREN)
print(json.dumps({
    'disk_total_bytes': usage.total,
    'disk_free_bytes': usage.free,
    'disk_used_bytes': usage.used,
    'children_max_rss': children.ru_maxrss,
}, sort_keys=True, separators=(',', ':')))
PYEOF
}

# MACOS_BUILD_OBSERVER_BEGIN
# This observer owns each fixed metadata utility in a short-lived session.  Its
# records remain ordinary recipe stdout so the existing tee retains them.
start_macos_build_observer() {
  local build_pid="$1"
  local selected_log="$2"
  local interval="${3:-45}"
  [[ "$interval" =~ ^[1-9][0-9]*$ && "$interval" -le 45 ]] || return 64
  "$PYTHON" - "$build_pid" "$output" "$selected_log" "$interval" <<'PYEOF' &
import json, math, os, re, selectors, signal, subprocess, sys, time
from datetime import datetime, timezone

root_pid, output, log_path, period = int(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4])
RECORD_LIMIT, BYTE_LIMIT, LINE_LIMIT, ROW_LIMIT, TREE_ROW_LIMIT = 512, 2 * 1024 * 1024, 4096, 32, 4
LOCAL_SECONDS, CLEANUP_RESERVE, STOP_SECONDS = 5.0, 0.5, 1.0
started, records, total, truncated = time.monotonic(), 0, 0, False
stopping, stop_deadline, stop_cause = False, None, None
active, cached = [], None

ANCHOR = r"""
import os, signal, subprocess, sys, time
completion_fd, release_fd = int(sys.argv[1]), int(sys.argv[2])
argv = sys.argv[3:]
def hold(_signum, _frame): pass
for item in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP): signal.signal(item, hold)
def defaults():
 for item in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP): signal.signal(item, signal.SIG_DFL)
try:
 child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=int(os.environ['SLV_OBSERVER_STDOUT_FD']), stderr=int(os.environ['SLV_OBSERVER_STDERR_FD']), close_fds=True, preexec_fn=defaults)
 # The worker owns its copied streams; keeping these descriptors in the anchor
 # would postpone EOF and turn a completed sample into an unbounded drain.
 os.close(int(os.environ['SLV_OBSERVER_STDOUT_FD']))
 os.close(int(os.environ['SLV_OBSERVER_STDERR_FD']))
except OSError:
 os.write(completion_fd, b'125\n'); os.close(completion_fd); raise SystemExit(125)
def cleanup_held_group():
 try: os.killpg(os.getpgrp(), signal.SIGTERM)
 except OSError: pass
 time.sleep(.25)
 try: os.killpg(os.getpgrp(), signal.SIGKILL)
 except OSError: pass
while child.poll() is None:
 import select
 ready, _, _ = select.select([release_fd], [], [], .05)
 if ready:
  try: release = os.read(release_fd, 1)
  except OSError: release = b''
  # Any release before terminal worker status, including EOF after parent
  # loss, makes this held anchor the bounded original-group cleanup owner.
  cleanup_held_group()
  raise SystemExit(125)
status = child.returncode
os.write(completion_fd, (str(status)+'\n').encode('ascii'))
os.close(completion_fd)
while True:
 try: release = os.read(release_fd, 1)
 except OSError: release = b''
 if release == b'R': raise SystemExit(status)
 if not release:
  cleanup_held_group()
  raise SystemExit(125)
"""

def clipped(value, limit):
    return value[:limit].decode('utf-8', 'replace')

def ask_stop(cause):
    global stopping, stop_deadline, stop_cause
    if not stopping:
        stopping, stop_cause, stop_deadline = True, cause, time.monotonic() + STOP_SECONDS

def held_identity(handle):
    anchor, pid = handle['anchor'], handle['pid']
    if anchor.poll() is not None:
        return False
    try:
        return os.getpgid(pid) == pid and os.getsid(pid) == pid
    except OSError:
        return False

def signal_group(handle, item):
    # The anchor is deliberately kept alive as the group/SID reservation.  Do
    # not turn a stale numeric PID into a group signal after it has disappeared.
    if not held_identity(handle):
        return False
    try: os.killpg(handle['pid'], item); return True
    except ProcessLookupError: return False
    except OSError: return False

def close_streams(handle):
    for stream in (handle.get('out'), handle.get('err'), handle.get('completion')):
        try: stream.close()
        except Exception: pass
    release_write = handle.get('release_write')
    if release_write is not None:
        try: os.close(release_write)
        except OSError: pass
        handle['release_write'] = None

def session_snapshot(handle, deadline):
    result = {'complete': True, 'owned': [], 'outside': [], 'rows': [], 'reason': None}
    def incomplete(reason):
        result['complete'] = False
        if result['reason'] is None: result['reason'] = reason
    if time.monotonic() >= deadline or not held_identity(handle):
        incomplete('identity-or-deadline')
        return result
    try:
        proc = subprocess.Popen(['/bin/ps', '-axo', 'pid=,pgid='], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True)
    except OSError as error:
        incomplete('ps-'+type(error).__name__)
        return result
    selector, data, anchor_seen = selectors.DefaultSelector(), bytearray(), False
    read_deadline = max(time.monotonic(), deadline - .10)
    selector.register(proc.stdout, selectors.EVENT_READ)
    try:
        while selector.get_map() and time.monotonic() < read_deadline:
            for key, _ in selector.select(min(.02, max(0.0, read_deadline-time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj); continue
                if len(data)+len(chunk) > 65536:
                    incomplete('ps-overflow'); break
                data.extend(chunk)
        if selector.get_map(): incomplete('ps-timeout')
        if proc.poll() is None:
            terminal_until = min(read_deadline, time.monotonic() + .05)
            while proc.poll() is None and time.monotonic() < terminal_until: time.sleep(.005)
        if proc.poll() is None:
            try: proc.terminate()
            except OSError: pass
        term_until = max(time.monotonic(), deadline - .05)
        while proc.poll() is None and time.monotonic() < term_until: time.sleep(.005)
        if proc.poll() is None:
            try: proc.kill()
            except OSError: pass
        while proc.poll() is None and time.monotonic() < deadline: time.sleep(.005)
        code = proc.poll()
        if code is None: incomplete('ps-reap')
        elif code != 0: incomplete('ps-exit')
        raw_rows = data.decode('utf-8','replace').splitlines()
        if len(raw_rows) > 4096:
            incomplete('ps-row-overflow'); raw_rows=raw_rows[:4096]
        for raw in raw_rows:
            fields=raw.split()
            if len(fields) != 2:
                incomplete('ps-malformed'); continue
            try: pid,pgid=int(fields[0]),int(fields[1])
            except ValueError:
                incomplete('ps-malformed'); continue
            if pid <= 0:
                incomplete('ps-malformed'); continue
            try: sid=os.getsid(pid)
            except ProcessLookupError: continue
            except OSError as error:
                incomplete('getsid-'+str(error.errno)); continue
            if sid != handle['pid']: continue
            if pgid <= 0:
                incomplete('ps-malformed'); continue
            row={'pid':pid,'pgid':pgid,'sid':sid}
            result['rows'].append(row)
            if pid == handle['pid']:
                anchor_seen=True; continue
            if pgid == handle['pid']: result['owned'].append(row)
            else: result['outside'].append(row)
        if not anchor_seen: incomplete('ps-anchor-missing')
        if len(result['rows']) > ROW_LIMIT:
            result['rows']=result['rows'][:ROW_LIMIT]; incomplete('residue-overflow')
    except Exception as error:
        incomplete('ps-'+type(error).__name__)
    finally:
        selector.close()
        try:
            if proc.poll() is None:
                proc.kill()
                while proc.poll() is None and time.monotonic() < deadline: time.sleep(.005)
            if proc.poll() is None: incomplete('ps-reap')
        except Exception:
            incomplete('ps-reap')
    return result

def release_anchor(handle, deadline):
    complete = True
    release_write = handle.get('release_write')
    if release_write is None:
        complete = False
    else:
        try: os.write(release_write, b'R')
        except OSError: complete=False
        try: os.close(release_write)
        except OSError: pass
        handle['release_write'] = None
    anchor=handle['anchor']
    while anchor.poll() is None and time.monotonic() < min(deadline,time.monotonic()+.05): time.sleep(.005)
    if anchor.poll() is None: complete=False
    close_streams(handle)
    if handle in active: active.remove(handle)
    return complete

def reap_handle(handle, deadline, reason, graceful=False):
    """Observe and clean only the held original group; never an observed subgroup."""
    anchor = handle['anchor']
    complete = True
    if graceful:
        observed=session_snapshot(handle,min(deadline,time.monotonic()+.25))
        if observed['complete'] and not observed['owned'] and not observed['outside']:
            return release_anchor(handle,deadline)
        if observed['outside'] and not observed['owned']:
            # A same-SID escaped group is evidence of incomplete cleanup.  It is
            # not ours to signal, but the held anchor may now be released.
            release_anchor(handle,deadline)
            return False
        if not observed['complete']: complete=False
    if anchor.poll() is None:
        if not signal_group(handle, signal.SIGTERM): complete=False
        term_until=min(deadline,time.monotonic()+.35)
        while anchor.poll() is None and time.monotonic() < term_until: time.sleep(.01)
    observed=session_snapshot(handle,min(deadline,time.monotonic()+.25)) if anchor.poll() is None else {'complete':False,'owned':[],'outside':[],'rows':[],'reason':'anchor-gone'}
    if observed['outside']: complete=False
    if not observed['complete']: complete=False
    if anchor.poll() is not None:
        close_streams(handle)
        if handle in active: active.remove(handle)
        return complete
    if not observed['owned'] and not observed['outside'] and observed['complete']:
        return complete and release_anchor(handle,deadline)
    # This is the last group signal.  The anchored original group is still held
    # and was revalidated above; never signal any observed secondary PGID.
    if not signal_group(handle, signal.SIGKILL): complete=False
    while anchor.poll() is None and time.monotonic() < deadline: time.sleep(.01)
    if anchor.poll() is None: complete=False
    close_streams(handle)
    if handle in active: active.remove(handle)
    return complete

def launch(argv, deadline):
    if stopping or time.monotonic() >= deadline:
        return None, {'ok': False, 'reason': 'observer-stopped' if stopping else 'sample-deadline', 'tool': os.path.basename(argv[0])}
    out_r, out_w = os.pipe(); err_r, err_w = os.pipe(); completion_r, completion_w = os.pipe(); release_r, release_w = os.pipe()
    env = os.environ.copy(); env['SLV_OBSERVER_STDOUT_FD'] = str(out_w); env['SLV_OBSERVER_STDERR_FD'] = str(err_w)
    try:
        anchor = subprocess.Popen([sys.executable, '-c', ANCHOR, str(completion_w), str(release_r), *argv], stdin=subprocess.DEVNULL, close_fds=True, pass_fds=(out_w, err_w, completion_w, release_r), start_new_session=True, env=env)
    except OSError as error:
        for fd in (out_r,out_w,err_r,err_w,completion_r,completion_w,release_r,release_w):
            try: os.close(fd)
            except OSError: pass
        return None, {'ok': False, 'reason': type(error).__name__, 'tool': os.path.basename(argv[0])}
    for fd in (out_w, err_w, completion_w, release_r): os.close(fd)
    handle = {'anchor': anchor, 'pid': anchor.pid, 'out': os.fdopen(out_r, 'rb', buffering=0), 'err': os.fdopen(err_r, 'rb', buffering=0), 'completion': os.fdopen(completion_r, 'rb', buffering=0), 'release_write': release_w}
    active.append(handle)
    # A cancellation that won the registration race gets ownership first, then
    # immediate bounded cleanup; it never permits a later acquisition.
    if stopping:
        reap_handle(handle, stop_deadline, 'stop-race')
        return None, {'ok': False, 'reason': 'observer-stopped', 'tool': os.path.basename(argv[0])}
    return handle, None

def run(argv, deadline, out_limit=8192, err_limit=1024):
    start = time.monotonic(); deadline = min(deadline, start + LOCAL_SECONDS)
    handle, failure = launch(argv, deadline)
    if failure: return failure
    selector, data, eof, overflow, timed_out, read_error = selectors.DefaultSelector(), {}, set(), False, False, None
    for name in ('out', 'err', 'completion'):
        stream = handle[name]; data[stream] = bytearray(); selector.register(stream, selectors.EVENT_READ, name)
    code = None
    try:
        while selector.get_map():
            if stopping:
                return {'ok': False, 'reason': 'observer-stopped', 'tool': os.path.basename(argv[0])}
            local_cleanup = min(deadline, start + LOCAL_SECONDS) - CLEANUP_RESERVE
            if time.monotonic() >= local_cleanup:
                timed_out = True; break
            for key, _ in selector.select(min(.05, max(0.0, local_cleanup - time.monotonic()))):
                try: chunk = os.read(key.fileobj.fileno(), 4096)
                except OSError as error: read_error = type(error).__name__; break
                if not chunk:
                    selector.unregister(key.fileobj); eof.add(key.data); continue
                limit = out_limit if key.data == 'out' else err_limit if key.data == 'err' else 16
                if len(data[key.fileobj]) + len(chunk) > limit:
                    overflow = True; break
                data[key.fileobj].extend(chunk)
            if overflow or read_error: break
        raw = bytes(data[handle['completion']])
        if raw.count(b'\n') == 1 and raw.endswith(b'\n') and len(raw) <= 16:
            try: code = int(raw[:-1].decode('ascii'))
            except ValueError: code = None
        cleanup_deadline = min(deadline, stop_deadline if stopping else deadline)
        complete_cleanup = reap_handle(handle, cleanup_deadline, 'normal', eof == {'out','err','completion'} and not overflow and not read_error and not timed_out)
        if timed_out: return {'ok': False, 'reason': 'timeout', 'tool': os.path.basename(argv[0])}
        if overflow: return {'ok': False, 'reason': 'oversized-output', 'tool': os.path.basename(argv[0])}
        if read_error: return {'ok': False, 'reason': 'read-'+read_error, 'tool': os.path.basename(argv[0])}
        if eof != {'out','err','completion'}: return {'ok': False, 'reason': 'eof-incomplete', 'tool': os.path.basename(argv[0])}
        if not complete_cleanup: return {'ok': False, 'reason': 'cleanup-incomplete', 'tool': os.path.basename(argv[0])}
        return {'ok': code == 0, 'stdout': clipped(data[handle['out']], out_limit), 'stderr': clipped(data[handle['err']], err_limit), 'tool': os.path.basename(argv[0]), 'exit_code': code}
    finally:
        selector.close()
        if handle in active: reap_handle(handle, min(deadline, stop_deadline if stopping else deadline), 'finally')

def bounded_text(value, limit=96):
    value = str(value)
    return value[:limit]

def phase_marker():
    result = {'available': False, 'quality': 'unavailable', 'last_observed': None}
    try:
        info = os.stat(log_path)
        result.update({'log_size_bytes': info.st_size, 'log_mtime_epoch_seconds': info.st_mtime})
        start = max(0, info.st_size - 65536)
        with open(log_path, 'rb') as source:
            if start:
                source.seek(start - 1)
                data = source.read(65537)
            else:
                source.seek(0)
                data = source.read(65536)
        partial = False
        if start:
            if not data or data[0:1] != b'\n':
                partial = True
                cut = data.find(b'\n')
                data = b'' if cut < 0 else data[cut + 1:]
            else:
                data = data[1:]
        complete_lines = data.split(b'\n')
        if data.endswith(b'\n'):
            complete_lines = complete_lines[:-1]
        elif data:
            partial = True
            complete_lines = complete_lines[:-1]
        latest = None
        for raw in complete_lines:
            if len(raw) > 512:
                partial = True
                continue
            try:
                value = raw.decode('utf-8', 'strict')
            except UnicodeDecodeError:
                partial = True
                continue
            if value.startswith('SLV_MAC_BUILD_PHASE '):
                candidate = value[len('SLV_MAC_BUILD_PHASE '):]
                if candidate in ('lock-generate-start', 'lock-generate-finished', 'lock-validation-start', 'lock-validation-finished', 'cargo-build-start', 'cargo-build-finished'):
                    latest = candidate
                else:
                    partial = True
        result['last_observed'] = latest
        if latest is not None:
            result.update({'available': True, 'quality': 'partial' if partial else 'complete'})
            if partial:
                result['reason'] = 'log-tail-partial'
        else:
            result.update({'quality': 'partial' if partial else 'unavailable', 'reason': 'log-tail-partial' if partial else 'phase-marker-absent'})
    except FileNotFoundError:
        result['reason'] = 'log-absent'
    except OSError as error:
        result['reason'] = 'log-'+type(error).__name__
    return result

def process_tree(deadline):
    result = run(['/bin/ps', '-axo', 'pid=,ppid=,%cpu=,rss=,comm='], deadline, 65536)
    base = {'available': False, 'scope': 'supplied-supervisor-and-observable-descendants', 'scope_quality': 'unavailable', 'parse_quality': 'unavailable', 'selected_count': None, 'parsed_count': 0, 'rejected_count': 0, 'processes': [], 'cpu_percent_ps_sum': None, 'rss_sum_bytes': None, 'units': {'rss': 'bytes-per-process-sum', 'cpu_percent_ps': 'percent-as-reported-by-ps'}}
    if not result.get('ok'):
        base['reason'] = result.get('reason', 'ps-failed')
        return base
    rows, rejected = [], 0
    for raw in result.get('stdout', '').splitlines():
        fields = raw.split(None, 4)
        if len(fields) != 5:
            rejected += 1
            continue
        try:
            pid, ppid, cpu, rss = int(fields[0]), int(fields[1]), float(fields[2]), int(fields[3])
            if pid <= 0 or ppid < 0 or rss < 0 or cpu < 0 or not math.isfinite(cpu):
                raise ValueError('invalid-process-fields')
        except ValueError:
            rejected += 1
            continue
        rows.append({'pid': pid, 'ppid': ppid, 'cpu_percent_ps': cpu, 'rss_bytes': rss * 1024, 'basename': os.path.basename(fields[4])[:48]})
    by_pid = {}
    duplicate = False
    for row in rows:
        if row['pid'] in by_pid:
            duplicate = True
            rejected += 1
        else:
            by_pid[row['pid']] = row
    children = {}
    for row in by_pid.values():
        children.setdefault(row['ppid'], []).append(row['pid'])
    excluded = {os.getpid()}
    pending = [os.getpid()]
    while pending:
        parent = pending.pop()
        for pid in children.get(parent, []):
            if pid not in excluded:
                excluded.add(pid)
                pending.append(pid)
    if root_pid not in by_pid or root_pid in excluded:
        base.update({'parsed_count': len(by_pid), 'rejected_count': rejected, 'parse_quality': 'partial' if rejected or duplicate else 'complete', 'reason': 'root-missing-or-observer-overlap'})
        return base
    selected, pending = {root_pid}, [root_pid]
    while pending:
        parent = pending.pop()
        for pid in children.get(parent, []):
            if pid in excluded:
                continue
            if pid not in selected:
                selected.add(pid)
                pending.append(pid)
    tree = [row for row in by_pid.values() if row['pid'] in selected]
    tree.sort(key=lambda row: (-row['rss_bytes'], -row['cpu_percent_ps'], row['pid']))
    partial = rejected > 0 or duplicate or os.getpid() not in by_pid
    base.update({'available': True, 'scope_quality': 'partial' if partial else 'complete', 'parse_quality': 'partial' if rejected or duplicate else 'complete', 'selected_count': len(tree), 'parsed_count': len(by_pid), 'rejected_count': rejected, 'processes': tree[:TREE_ROW_LIMIT], 'cpu_percent_ps_sum': sum(row['cpu_percent_ps'] for row in tree), 'rss_sum_bytes': sum(row['rss_bytes'] for row in tree)})
    if partial:
        base['reason'] = 'ps-rows-partial' if rejected or duplicate else 'observer-identity-not-observed'
    return base

def memory(deadline):
    vm = run(['/usr/bin/vm_stat'], deadline)
    if stopping:
        return {'units': {'pages': 'reported-pages', 'memory': 'bytes'}, 'vm_stat': {'available': False, 'quality': 'unavailable', 'reason': 'observer-stopped'}, 'physical_memory_bytes': None, 'swap': {'available': False, 'quality': 'unavailable', 'reason': 'observer-stopped'}}
    ram = run(['/usr/sbin/sysctl', '-n', 'hw.memsize'], deadline)
    if stopping:
        return {'units': {'pages': 'reported-pages', 'memory': 'bytes'}, 'vm_stat': {'available': False, 'quality': 'unavailable', 'reason': 'observer-stopped'}, 'physical_memory_bytes': None, 'swap': {'available': False, 'quality': 'unavailable', 'reason': 'observer-stopped'}}
    swap = run(['/usr/sbin/sysctl', '-n', 'vm.swapusage'], deadline)
    result = {'units': {'pages': 'reported-pages', 'memory': 'bytes'}, 'vm_stat': {'available': False, 'quality': 'unavailable'}, 'physical_memory_bytes': None, 'swap': {'available': False, 'quality': 'unavailable'}}
    if vm.get('ok'):
        page = re.search(r'page size of (\d+) bytes', vm.get('stdout', ''))
        counts = {name.strip().lower().replace(' ', '_'): int(value) for name, value in re.findall(r'Pages ([^:]+):\s*(\d+)\.?', vm.get('stdout', ''))}
        counters = {name.lower(): int(value) for name, value in re.findall(r'^(Pageins|Pageouts|Swapins|Swapouts):\s*(\d+)\.?', vm.get('stdout', ''), re.MULTILINE)}
        if page:
            result['vm_stat'] = {'available': True, 'quality': 'complete' if counts else 'partial', 'page_size_bytes': int(page.group(1)), 'page_counts': counts, 'counters': counters, 'counter_units': 'reported-count'}
            if not counts:
                result['vm_stat']['reason'] = 'page-counts-absent'
        else:
            result['vm_stat'] = {'available': False, 'quality': 'unavailable', 'reason': 'page-size-parse'}
    else:
        result['vm_stat'] = {'available': False, 'quality': 'unavailable', 'reason': vm.get('reason', 'vm-stat-failed')}
    if ram.get('ok'):
        try:
            value = int(ram.get('stdout', '').strip())
            if value < 0:
                raise ValueError('negative-memsize')
            result['physical_memory_bytes'] = value
        except ValueError:
            result['physical_memory_reason'] = 'memsize-parse'
    else:
        result['physical_memory_reason'] = ram.get('reason', 'sysctl-failed')
    if swap.get('ok'):
        parsed, malformed = {}, set()
        for name, value, unit in re.findall(r'(total|used|free) = ([0-9.]+)([MG])', swap.get('stdout', '')):
            try:
                number = float(value)
                if number < 0 or not math.isfinite(number):
                    raise ValueError('invalid-swap-number')
            except ValueError:
                malformed.add(name)
                continue
            parsed[name] = {'available': True, 'value': number, 'unit': unit, 'bytes': int(number * {'M': 1024 * 1024, 'G': 1024 * 1024 * 1024}[unit])}
        fields = {}
        for name in ('total', 'used', 'free'):
            if name in parsed:
                fields[name] = parsed[name]
            elif name in malformed:
                fields[name] = {'available': False, 'reason': 'value-parse'}
            else:
                fields[name] = {'available': False, 'reason': 'field-absent'}
        complete = set(parsed) == {'total', 'used', 'free'}
        result['swap'] = {'available': bool(parsed), 'quality': 'complete' if complete else 'partial', 'fields': fields}
        if not complete:
            result['swap']['reason'] = 'incomplete-swap-fields'
    else:
        result['swap'] = {'available': False, 'quality': 'unavailable', 'reason': swap.get('reason', 'sysctl-failed'), 'fields': {}}
    return result

def progress():
    path = os.path.join(output, 'target', 'release', 'gn_out', '.ninja_log')
    base = {'available': False, 'path': 'target/release/gn_out/.ninja_log'}
    try:
        info = os.stat(path)
        base.update({'exists': True, 'size_bytes': info.st_size, 'mtime_epoch_seconds': info.st_mtime})
        start = max(0, info.st_size - 4096)
        with open(path, 'rb') as source:
            if start:
                source.seek(start - 1)
                tail = source.read(4097)
            else:
                source.seek(0)
                tail = source.read(4096)
        partial, reasons = False, []
        if start:
            if not tail or tail[0:1] != b'\n':
                partial, reasons = True, ['window-begins-midline']
                cut = tail.find(b'\n')
                tail = b'' if cut < 0 else tail[cut + 1:]
            else:
                tail = tail[1:]
        final_complete = tail.endswith(b'\n')
        if not final_complete and tail:
            partial = True
            reasons.append('final-line-incomplete')
        lines = tail.split(b'\n')
        if not final_complete:
            lines = lines[:-1]
        else:
            lines = lines[:-1]
        entry = None
        for raw in reversed(lines):
            if raw.startswith(b'#'):
                continue
            if not raw:
                continue
            if len(raw) > 2048:
                partial = True
                reasons.append('row-too-long')
                continue
            try:
                fields = raw.decode('utf-8', 'strict').split('\t')
                if len(fields) != 5 or not fields[4]:
                    raise ValueError('invalid-field-count-or-hash')
                start_ms, end_ms, restat_mtime = int(fields[0]), int(fields[1]), int(fields[2])
                if start_ms < 0 or end_ms < start_ms or restat_mtime < 0:
                    raise ValueError('invalid-time-row')
                detail = os.path.basename(fields[3])[:128]
                if not detail:
                    raise ValueError('empty-output')
                entry = {'start_time_ms': start_ms, 'end_time_ms': end_ms, 'restat_mtime': restat_mtime, 'output_basename': detail}
                break
            except (UnicodeDecodeError, ValueError):
                partial = True
                reasons.append('row-malformed')
        if entry is None:
            base.update({'quality': 'partial' if partial else 'unavailable', 'reason': reasons[0] if reasons else 'no-complete-parseable-row'})
        else:
            base.update({'available': True, 'quality': 'partial' if partial else 'complete', 'latest_complete': entry, 'time_units': 'ninja-log milliseconds for start_time_ms/end_time_ms; restat_mtime as recorded'})
            if partial:
                base['reason'] = reasons[0]
    except FileNotFoundError:
        base.update({'exists': False, 'quality': 'unavailable', 'reason': 'ninja-log-absent'})
    except OSError as error:
        base.update({'quality': 'unavailable', 'reason': type(error).__name__})
    return base

def compact_item(item):
    def encoded(value):
        return ('SLV_MAC_BUILD_OBSERVATION '+json.dumps(value, sort_keys=True, separators=(',', ':'))).encode('utf-8')
    line = encoded(item)
    if len(line) <= LINE_LIMIT:
        return item, line
    item['trimmed'] = True
    item['trim_reason'] = 'sample-line-budget'
    item['process_tree']['processes'] = []
    latest = item['progress'].get('latest_complete')
    if isinstance(latest, dict):
        latest.pop('output_basename', None)
    line = encoded(item)
    if len(line) <= LINE_LIMIT:
        return item, line
    tree, vm, swap, ninja, marker = item['process_tree'], item['memory']['vm_stat'], item['memory']['swap'], item['progress'], item['command_phase']
    core = {'schema_version': 1, 'kind': 'slv-macos-build-observation', 'utc': item['utc'], 'elapsed_seconds_monotonic': item['elapsed_seconds_monotonic'], 'phase': item['phase'], 'root_pid': item['root_pid'], 'trimmed': True, 'trim_reason': 'sample-line-budget', 'command_phase': {'available': marker.get('available'), 'quality': marker.get('quality'), 'last_observed': marker.get('last_observed'), 'reason': bounded_text(marker.get('reason', ''), 64) or None}, 'process_tree': {'available': tree.get('available'), 'scope': tree.get('scope'), 'scope_quality': tree.get('scope_quality'), 'parse_quality': tree.get('parse_quality'), 'selected_count': tree.get('selected_count'), 'parsed_count': tree.get('parsed_count'), 'rejected_count': tree.get('rejected_count'), 'cpu_percent_ps_sum': tree.get('cpu_percent_ps_sum'), 'rss_sum_bytes': tree.get('rss_sum_bytes'), 'reason': bounded_text(tree.get('reason', ''), 64) or None}, 'memory': {'units': item['memory']['units'], 'vm_stat': {'available': vm.get('available'), 'quality': vm.get('quality'), 'page_size_bytes': vm.get('page_size_bytes'), 'reason': bounded_text(vm.get('reason', ''), 64) or None}, 'physical_memory_bytes': item['memory'].get('physical_memory_bytes'), 'swap': {'available': swap.get('available'), 'quality': swap.get('quality'), 'reason': bounded_text(swap.get('reason', ''), 64) or None}}, 'progress': {'available': ninja.get('available'), 'exists': ninja.get('exists'), 'size_bytes': ninja.get('size_bytes'), 'mtime_epoch_seconds': ninja.get('mtime_epoch_seconds'), 'quality': ninja.get('quality'), 'reason': bounded_text(ninja.get('reason', ''), 64) or None}}
    line = encoded(core)
    if len(line) <= LINE_LIMIT:
        return core, line
    # Keep coordinate and quality fields if an unexpected value makes the
    # compact core too large; this is still a valid complete JSON record.
    core = {'schema_version': 1, 'kind': 'slv-macos-build-observation', 'utc': item['utc'], 'elapsed_seconds_monotonic': item['elapsed_seconds_monotonic'], 'phase': item['phase'], 'root_pid': item['root_pid'], 'trimmed': True, 'trim_reason': 'sample-line-budget', 'observation_error': 'encoded-core-over-limit'}
    return core, encoded(core)

def emit(phase):
    global records, total, truncated, cached
    if truncated or stopping: return
    deadline = time.monotonic() + 15
    item = {'schema_version': 1, 'kind': 'slv-macos-build-observation', 'utc': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), 'elapsed_seconds_monotonic': round(time.monotonic()-started, 3), 'phase': phase, 'root_pid': root_pid, 'command_phase': phase_marker(), 'process_tree': process_tree(deadline), 'memory': memory(deadline), 'progress': progress()}
    cached = item
    if stopping: return
    item, line = compact_item(item)
    cached = item
    marker = b'SLV_MAC_BUILD_OBSERVATION {"schema_version":1,"kind":"slv-macos-build-observation","phase":"truncated","truncated":true,"reason":"record-or-byte-limit"}'
    if records >= RECORD_LIMIT-1 or total+len(line)+1+len(marker)+1 > BYTE_LIMIT:
        sys.stdout.buffer.write(marker+b'\n'); sys.stdout.flush(); records += 1; truncated = True; return
    sys.stdout.buffer.write(line+b'\n'); sys.stdout.flush(); records += 1; total += len(line)+1

def stop(signum, _frame):
    ask_stop('signal-'+str(signum))
for item in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(item, stop)
emit('build-child-start')
next_sample = time.monotonic()+period
while not stopping:
    if os.getppid()==1:
        ask_stop('parent-unavailable'); break
    time.sleep(min(.1,max(0,next_sample-time.monotonic())))
    if not stopping and time.monotonic()>=next_sample:
        emit('running'); next_sample=time.monotonic()+period
if stopping:
    deadline = stop_deadline
    for handle in tuple(active): reap_handle(handle, deadline, 'stop')
# Terminal output must use cached state and never acquire a new process sample.
if not truncated and cached is not None:
    terminal = {'schema_version':1,'kind':'slv-macos-build-observation','phase':'observer-stop','reason':stop_cause,'cached':True}
    sys.stdout.write('SLV_MAC_BUILD_OBSERVATION '+json.dumps(terminal,sort_keys=True,separators=(',',':'))+'\n'); sys.stdout.flush()
PYEOF
  macos_observer_pid="$!"
}

stop_macos_build_observer() {
  local observer_pid="$1" attempt=0
  [[ -n "$observer_pid" ]] || return 0
  kill -TERM "$observer_pid" 2>/dev/null || true
  while kill -0 "$observer_pid" 2>/dev/null && [[ "$attempt" -lt 50 ]]; do
    sleep 0.02
    attempt=$((attempt + 1))
  done
  kill -KILL "$observer_pid" 2>/dev/null || true
  wait "$observer_pid" 2>/dev/null || true
}
# MACOS_BUILD_OBSERVER_END

# ARM_EVIDENCE_RAW_CAPTURE_BEGIN
capture_arm_raw_evidence() {
  [[ -n "$evidence_out" && "${BUILD_TARGET:-}" == "aarch64-unknown-linux-gnu" ]] || return 0
  "$PYTHON" - "$evidence_out" "$1" "$2" <<'PYEOF'
import hashlib,json,pathlib,sys,os
directory=pathlib.Path(sys.argv[1])
contexts={'host':pathlib.Path(sys.argv[2]),'consumer':pathlib.Path(sys.argv[3])}
limits,records,errors={'args':256*1024,'ninja':512*1024},{},[]
def digest(path):
 h=hashlib.sha256()
 with path.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
 return h.hexdigest()
def capture(source,destination,limit):
 try:
  info=source.lstat()
  if source.is_symlink() or not source.is_file() or info.st_size>limit: raise RuntimeError('invalid-or-oversized')
  with source.open('rb') as src,destination.open('wb') as out:
   while True:
    chunk=src.read(1024*1024)
    if not chunk: break
    out.write(chunk)
  return {'status':'captured','size':info.st_size,'sha256':digest(destination)}
 except Exception as error:
  errors.append('raw-copy:'+type(error).__name__)
  return {'status':'unavailable','reason':type(error).__name__}
def write(path,value):
 temporary=path.with_name(path.name+'.tmp-'+str(os.getpid()))
 try:
  temporary.write_text(value,encoding='utf-8'); temporary.replace(path); return True
 except Exception as error:
  errors.append('raw-write:'+type(error).__name__)
  try: temporary.unlink()
  except Exception: pass
  return False
for name,out in contexts.items():
 records[name]={'args':capture(out/'args.gn',directory/(name+'-args.gn'),limits['args']),'ninja':capture(out/'obj'/'rusty_v8.ninja',directory/(name+'-rusty_v8.ninja'),limits['ninja'])}
status='raw-capture-complete' if not errors and all(v.get('status')=='captured' for x in records.values() for v in x.values()) else 'raw-capture-incomplete'
write(directory/'raw-capture.json',json.dumps({'schema_version':1,'kind':'slv-arm-snapshot-raw-capture','status':status,'raw_bundle_copy':'absent','contexts':records,'capture_errors':errors[:16]},sort_keys=True,separators=(',',':'))+'\n')
if errors:
 attribution={}
 try:
  raw_context=json.loads(os.environ.get('SLV_ARM_OBSERVATION_CONTEXT',''))
  if isinstance(raw_context,dict):
   for key in ('source_commit','source_receipt_sha256','recipe_sha256','target','variant'):
    value=raw_context.get(key)
    if isinstance(value,str) and len(value)<=128: attribution[key]=value
   producer_context=raw_context.get('producer_context')
   if isinstance(producer_context,dict):
    for key in ('run_id','job_id'):
     value=producer_context.get(key)
     if isinstance(value,str) and len(value)<=128: attribution[key]=value
 except Exception:
  pass
 print('SLV_ARM_OBSERVATION_CAPTURE_ERROR '+json.dumps({'phase':'raw-capture','errors':errors[:16],'attribution':attribution},sort_keys=True),file=sys.stderr)
 raise SystemExit(1)
PYEOF
}
# ARM_EVIDENCE_RAW_CAPTURE_END
# ARM_OBSERVATION_STATE_BEGIN
arm_observation_latch=()
arm_observation_latch_error() {
  local code="$1"
  [[ "$code" =~ ^[A-Za-z0-9_.:-]{1,128}$ ]] || code="observation-invalid-code"
  local existing
  for existing in "${arm_observation_latch[@]}"; do [[ "$existing" == "$code" ]] && return 0; done
  [[ "${#arm_observation_latch[@]}" -lt 16 ]] && arm_observation_latch+=("$code")
}
arm_observation_state() {
  local operation="$1" phase="${2:-}" source_status="${3:-}" raw_status="${4:-}"
  [[ -n "$evidence_out" && "${BUILD_TARGET:-}" == "aarch64-unknown-linux-gnu" ]] || return 0
  local latch="${arm_observation_latch[*]}"
  SLV_ARM_STATE_OPERATION="$operation" SLV_ARM_STATE_PHASE="$phase" \
    SLV_ARM_STATE_SOURCE_STATUS="$source_status" SLV_ARM_STATE_RAW_STATUS="$raw_status" \
    SLV_ARM_STATE_LATCH="$latch" "$PYTHON" - "$evidence_out/compilation-state.json" <<'PYEOF'
import datetime,json,math,os,pathlib,re,stat,sys,time
path=pathlib.Path(sys.argv[1])
operation=os.environ['SLV_ARM_STATE_OPERATION']; phase=os.environ['SLV_ARM_STATE_PHASE']
source_status=os.environ.get('SLV_ARM_STATE_SOURCE_STATUS','')
raw_status=os.environ.get('SLV_ARM_STATE_RAW_STATUS','')
latch=[x for x in os.environ.get('SLV_ARM_STATE_LATCH','').split() if re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',x)][:16]
required=('source_commit','source_receipt_sha256','recipe_sha256','target','build_host','variant','producer_context')
def fail(code):
 attribution={}
 try:
  raw_context=json.loads(os.environ.get('SLV_ARM_OBSERVATION_CONTEXT',''))
  if isinstance(raw_context,dict):
   for key in ('source_commit','source_receipt_sha256','recipe_sha256','target','variant'):
    value=raw_context.get(key)
    if isinstance(value,str) and len(value)<=128: attribution[key]=value
   producer_context=raw_context.get('producer_context')
   if isinstance(producer_context,dict):
    for key in ('run_id','job_id'):
     value=producer_context.get(key)
     if isinstance(value,str) and len(value)<=128: attribution[key]=value
 except Exception:
  pass
 print('SLV_ARM_OBSERVATION_CAPTURE_ERROR '+json.dumps({'phase':phase or operation,'error':code,'attribution':attribution},sort_keys=True),file=sys.stderr)
 raise SystemExit(1)
def atomic(value):
 if path.exists() and (path.is_symlink() or not path.is_file()): fail('state-not-regular')
 temporary=path.with_name(path.name+'.tmp-'+str(os.getpid()))
 try:
  temporary.write_text(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n',encoding='utf-8'); temporary.replace(path)
 except Exception as error:
  try: temporary.unlink()
  except Exception: pass
  fail('state-write-'+type(error).__name__)
def finite_number(value):
 return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)
def code(value):
 return isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_.:-]{1,128}',value) is not None
def producer(value):
 if value is None:return True
 if not isinstance(value,dict) or set(value)!= {'schema_version','kind','repository','workflow','run_id','run_attempt','job_id'}:return False
 return finite_number(value.get('schema_version')) and value.get('schema_version')==1 and value.get('kind')=='slv-native-producer-context' and value.get('repository')=='ValidatorsDAO/slv' and isinstance(value.get('workflow'),str) and value['workflow'].startswith('ValidatorsDAO/slv/') and isinstance(value.get('run_id'),str) and re.fullmatch(r'[1-9][0-9]*',value['run_id']) and isinstance(value.get('run_attempt'),str) and re.fullmatch(r'[1-9][0-9]*',value['run_attempt']) and isinstance(value.get('job_id'),str) and bool(value['job_id'])
def binding_from_context():
 raw=os.environ.get('SLV_ARM_OBSERVATION_CONTEXT')
 if raw is None or len(raw.encode())>16*1024: raise ValueError('context-size')
 binding=json.loads(raw)
 if not isinstance(binding,dict) or set(binding)!=set(required): raise ValueError('context-shape')
 if not isinstance(binding['source_commit'],str) or not re.fullmatch(r'[0-9a-f]{40}',binding['source_commit']): raise ValueError('source-commit')
 if not all(isinstance(binding[k],str) and re.fullmatch(r'[0-9a-f]{64}',binding[k]) for k in ('source_receipt_sha256','recipe_sha256')): raise ValueError('hash')
 if binding['target']!='aarch64-unknown-linux-gnu' or binding['build_host']!={'os':'linux','arch':'x64'} or binding['variant'] not in ('baseline','modified') or not producer(binding['producer_context']): raise ValueError('identity')
 return binding
def initial_state(phase_name):
 return {'schema_version':1,'kind':'slv-arm-snapshot-build-observation-state','status':'incomplete','phase':phase_name,'last_observed_phase':phase_name,'started_at':datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00','Z'),'monotonic_started':time.monotonic(),'unknown_fields':{'derived_relink_cargo_lock_sha256':'unavailable-before-cargo','runtime_sha256':'unavailable-before-cargo'},'capture_errors':latch}
if operation=='initial':
 state=initial_state('initial')
 try:
  state['binding']=binding_from_context(); state['status']='started'
 except Exception as error:
  state['identity_status']='unavailable'; state['capture_error']='initial-'+type(error).__name__
 atomic(state)
 if state['status']!='started': fail('initial-identity')
 raise SystemExit(0)
try:
 info=path.lstat()
 if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size>65536: fail('state-not-regular')
 state=json.loads(path.read_text())
 if not isinstance(state,dict): fail('state-invalid')
except FileNotFoundError:
 if not latch: fail('state-missing')
 try:
  state=initial_state('unavailable')
  state['binding']=binding_from_context()
  state['capture_error']='state-missing'
  state['capture_errors']=(latch+['state-missing',operation+'-state'])[:16]
  if re.fullmatch(r'[0-9]+',source_status): state['original_build_exit_code']=int(source_status)
  if raw_status: state['raw_capture_status']=raw_status
  atomic(state)
 except SystemExit: raise
 except Exception as error: fail('state-recovery-'+type(error).__name__)
 fail('state-missing')
except SystemExit: raise
except Exception as error: fail('state-read-'+type(error).__name__)
phases={'initial','guarded-cargo-start','guarded-cargo-finished','raw-capture','unavailable','finished'}
if operation not in {'phase','raw'} or phase not in phases or (operation=='raw' and phase!='raw-capture'):
 fail('state-operation')
capture_error=state.get('capture_error')
capture_errors=state.get('capture_errors')
has_binding='binding' in state
binding=state.get('binding')
if (
 not finite_number(state.get('schema_version')) or state.get('schema_version')!=1 or
 state.get('kind')!='slv-arm-snapshot-build-observation-state' or
 not isinstance(state.get('status'),str) or state['status'] not in {'started','incomplete','complete'} or
 not isinstance(state.get('phase'),str) or state['phase'] not in phases or
 ('last_observed_phase' in state and (not isinstance(state['last_observed_phase'],str) or state['last_observed_phase'] not in phases)) or
 not finite_number(state.get('monotonic_started')) or state['monotonic_started']<0 or
 ('monotonic_elapsed_seconds' in state and (not finite_number(state['monotonic_elapsed_seconds']) or state['monotonic_elapsed_seconds']<0)) or
 ('capture_error' in state and not code(capture_error)) or
 ('capture_errors' in state and (not isinstance(capture_errors,list) or len(capture_errors)>16 or not all(code(value) for value in capture_errors) or len(set(capture_errors))!=len(capture_errors))) or
 (has_binding and not isinstance(binding,dict)) or
 (not has_binding and state.get('identity_status')!='unavailable')
):
 fail('state-invalid')
errors=[]
for item in ([capture_error] if 'capture_error' in state else [])+(capture_errors if 'capture_errors' in state else [])+latch:
 if item not in errors and len(errors)<16: errors.append(item)
if state['status']=='incomplete' and 'state-incomplete' not in errors and len(errors)<16: errors.append('state-incomplete')
if state.get('identity_status')=='unavailable' and 'identity-unavailable' not in errors and len(errors)<16: errors.append('identity-unavailable')
state['capture_errors']=errors
state['status']='incomplete' if errors else state['status']
state['phase']=phase; state['last_observed_phase']=phase
state['monotonic_elapsed_seconds']=max(0.0,time.monotonic()-state['monotonic_started'])
if source_status: state['original_build_exit_code']=int(source_status)
if raw_status: state['raw_capture_status']=raw_status
atomic(state)
PYEOF
}
# ARM_OBSERVATION_STATE_END


# MACOS_BINDGEN_PREFLIGHT_BEGIN
write_macos_bindgen_preflight() {
  local preflight_dir="$1"
  local receipt="$preflight_dir/preflight.json"
  local diagnostics_log="$preflight_dir/diagnostics.log"
  mkdir -p "$preflight_dir"
  [[ ! -e "$receipt" && ! -e "$diagnostics_log" ]] || {
    echo "macOS bindgen preflight output already exists: $preflight_dir" >&2
    return 65
  }
  "$PYTHON" - "$receipt" "$diagnostics_log" "$libclang" "$apple_sdk_path" "$apple_sdk_version" "$apple_link_target" "$BINDGEN_EXTRA_CLANG_ARGS" <<'PYEOF'
import ctypes
import hashlib
import json
import pathlib
import shlex
import sys

receipt_path = pathlib.Path(sys.argv[1])
diagnostics_path = pathlib.Path(sys.argv[2])
library_path = pathlib.Path(sys.argv[3]).resolve()
sdk_path = pathlib.Path(sys.argv[4]).resolve()
sdk_version = sys.argv[5]
target = sys.argv[6]
serialized_args = sys.argv[7]
diagnostics = []
required_headers = ('stdlib.h', 'stdint.h', 'stddef.h', 'sys/types.h')
max_diagnostic_text_bytes = 4096
max_recorded_diagnostics = 32
record = {
    'schema_version': 1,
    'kind': 'slv-macos-bindgen-preflight',
    'status': 'failed',
    'libclang': {
        'path': str(library_path),
        'sha256': None,
    },
    'sdk': {
        'path': str(sdk_path),
        'version': sdk_version,
    },
    'target': target,
    'bindgen_extra_clang_args': serialized_args,
    'parsed_args': [],
    'headers': {},
    'diagnostics': diagnostics,
    'diagnostic_limits': {
        'text_bytes': max_diagnostic_text_bytes,
        'recorded_count': max_recorded_diagnostics,
    },
}

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()

def bounded_text(value):
    raw = value.encode('utf-8', 'replace')
    if len(raw) <= max_diagnostic_text_bytes:
        return raw.decode('utf-8', 'replace')
    suffix = b'...[truncated]'
    return (raw[:max_diagnostic_text_bytes - len(suffix)] + suffix).decode('utf-8', 'replace')

def file_binding(path):
    return {
        'path': str(path),
        'size': path.stat().st_size,
        'sha256': digest(path),
    }

def write(status):
    record['status'] = status
    diagnostics_path.write_text(
        json.dumps(diagnostics, sort_keys=True, indent=2) + '\n',
        encoding='utf-8',
    )
    record['logs'] = {
        'diagnostics.log': {
            'sha256': digest(diagnostics_path),
            'size': diagnostics_path.stat().st_size,
        },
    }
    receipt_path.write_text(
        json.dumps(record, sort_keys=True, indent=2) + '\n',
        encoding='utf-8',
    )
    envelope = {
        'schema_version': 1,
        'kind': 'slv-macos-bindgen-preflight-evidence',
        'preflight': record,
        'files': {
            'receipt': file_binding(receipt_path),
            'diagnostics': file_binding(diagnostics_path),
        },
    }
    sys.stdout.write(
        'SLV_MACOS_BINDGEN_PREFLIGHT_EVIDENCE=' +
        json.dumps(envelope, sort_keys=True, separators=(',', ':')) + '\n',
    )
    sys.stdout.flush()

index = None
translation_unit = None
try:
    record['libclang']['sha256'] = digest(library_path)
    record['parsed_args'] = shlex.split(serialized_args)
    if not sdk_path.is_dir():
        raise RuntimeError('selected macOS SDK is not a directory: ' + str(sdk_path))
    for header in required_headers:
        path = sdk_path / 'usr/include' / header
        record['headers'][header] = path.is_file()
    missing = [name for name, present in record['headers'].items() if not present]
    if missing:
        raise RuntimeError('selected macOS SDK lacks required headers: ' + ', '.join(missing))

    source_path = receipt_path.with_name('headers.c')
    source_path.write_text(
        '#include <stdlib.h>\n'
        '#include <stdint.h>\n'
        '#include <stddef.h>\n'
        '#include <sys/types.h>\n'
        'int main(void) { size_t bytes = sizeof(uintptr_t); void *memory = malloc(bytes); free(memory); return 0; }\n',
        encoding='utf-8',
    )
    record['source_sha256'] = digest(source_path)

    class CXString(ctypes.Structure):
        _fields_ = [('data', ctypes.c_void_p), ('private_flags', ctypes.c_uint)]

    libclang = ctypes.CDLL(str(library_path))

    def c_api(name, argtypes, restype):
        function = getattr(libclang, name)
        function.argtypes = argtypes
        function.restype = restype
        return function

    clang_createIndex = c_api(
        'clang_createIndex', [ctypes.c_int, ctypes.c_int], ctypes.c_void_p,
    )
    clang_parseTranslationUnit2 = c_api(
        'clang_parseTranslationUnit2',
        [
            ctypes.c_void_p,
            ctypes.c_char_p,
            ctypes.POINTER(ctypes.c_char_p),
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint,
            ctypes.c_uint,
            ctypes.POINTER(ctypes.c_void_p),
        ],
        ctypes.c_uint,
    )
    clang_getNumDiagnostics = c_api(
        'clang_getNumDiagnostics', [ctypes.c_void_p], ctypes.c_uint,
    )
    clang_getDiagnostic = c_api(
        'clang_getDiagnostic', [ctypes.c_void_p, ctypes.c_uint], ctypes.c_void_p,
    )
    clang_getDiagnosticSeverity = c_api(
        'clang_getDiagnosticSeverity', [ctypes.c_void_p], ctypes.c_uint,
    )
    clang_getDiagnosticSpelling = c_api(
        'clang_getDiagnosticSpelling', [ctypes.c_void_p], CXString,
    )
    clang_disposeString = c_api(
        'clang_disposeString', [CXString], None,
    )
    clang_disposeDiagnostic = c_api(
        'clang_disposeDiagnostic', [ctypes.c_void_p], None,
    )
    clang_disposeTranslationUnit = c_api(
        'clang_disposeTranslationUnit', [ctypes.c_void_p], None,
    )
    clang_disposeIndex = c_api(
        'clang_disposeIndex', [ctypes.c_void_p], None,
    )

    index = clang_createIndex(0, 0)
    if not index:
        raise RuntimeError('libclang did not create an index')
    encoded_args = [argument.encode('utf-8') for argument in record['parsed_args']]
    argv = (ctypes.c_char_p * len(encoded_args))(*encoded_args)
    parsed = ctypes.c_void_p()
    parse_code = clang_parseTranslationUnit2(
        index,
        str(source_path).encode('utf-8'),
        argv,
        len(encoded_args),
        None,
        0,
        0,
        ctypes.byref(parsed),
    )
    record['parse_error_code'] = parse_code
    translation_unit = parsed.value
    if parse_code != 0 or not translation_unit:
        raise RuntimeError('libclang could not parse macOS bindgen header probe')
    diagnostic_count = clang_getNumDiagnostics(translation_unit)
    record['diagnostic_count'] = diagnostic_count
    record['diagnostics_truncated'] = diagnostic_count > max_recorded_diagnostics
    has_error_diagnostic = False
    error_diagnostic_count = 0
    for position in range(diagnostic_count):
        diagnostic = clang_getDiagnostic(translation_unit, position)
        try:
            severity = clang_getDiagnosticSeverity(diagnostic)
            has_error_diagnostic = has_error_diagnostic or severity >= 3
            if severity >= 3:
                error_diagnostic_count += 1
            if position < max_recorded_diagnostics or severity >= 3:
                spelling = clang_getDiagnosticSpelling(diagnostic)
                try:
                    text = ctypes.cast(spelling.data, ctypes.c_char_p).value
                    entry = {
                        'severity': severity,
                        'spelling': bounded_text(
                            '' if text is None else text.decode('utf-8', 'replace'),
                        ),
                    }
                    if position < max_recorded_diagnostics:
                        diagnostics.append(entry)
                    elif len(diagnostics) >= max_recorded_diagnostics:
                        diagnostics[-1] = entry
                    else:
                        diagnostics.append(entry)
                finally:
                    clang_disposeString(spelling)
        finally:
            clang_disposeDiagnostic(diagnostic)
    record['error_diagnostic_count'] = error_diagnostic_count
    if has_error_diagnostic:
        raise RuntimeError('libclang reported an error or fatal diagnostic')
except Exception as error:
    diagnostics.append({
        'severity': 'probe-failure',
        'spelling': bounded_text(str(error)),
    })
    write('failed')
    raise SystemExit(65)
finally:
    if translation_unit:
        clang_disposeTranslationUnit(translation_unit)
    if index:
        clang_disposeIndex(index)

write('passed')
PYEOF
}
# MACOS_BINDGEN_PREFLIGHT_END

# Stage 2: build the unmodified denort package from a clean assembly.  The
# assembly remains read-only evidence: Cargo runs in a copied work directory,
# its target/cache live under OUTPUT, and the local v8 path patch produces a
# separately recorded derived lock.
#
# Usage:
#   build-baseline-denort.sh [--resume] [--evidence-out ABSOLUTE_DIR] EXTRACTED_SOURCE_ROOT OUTPUT
#
# A resumed diagnostic target is allowed only to repair a declared environment
# failure.  Copy this script to OUTPUT/recipe/ and execute that copied hash;
# never edit a script while its process is still draining build jobs.

resume=false
evidence_out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume)
      [[ "$resume" == false ]] || { echo "--resume may appear only once" >&2; exit 64; }
      resume=true
      shift
      ;;
    --evidence-out)
      [[ -z "$evidence_out" && $# -ge 2 ]] || { echo "--evidence-out requires one directory" >&2; exit 64; }
      evidence_out="$2"
      shift 2
      ;;
    *) break ;;
  esac
done
if [[ $# -ne 2 ]]; then
  echo "usage: $0 [--resume] [--evidence-out ABSOLUTE_DIR] EXTRACTED_SOURCE_ROOT OUTPUT" >&2
  exit 64
fi

root="$(cd "$1" && pwd -P)"
output="$2"
mkdir -p "$output"
output="$(cd "$output" && pwd -P)"
if [[ -n "$evidence_out" ]]; then
  [[ "$evidence_out" == /* && ! -e "$evidence_out" ]] || {
    echo "--evidence-out must be a fresh absolute path" >&2
    exit 64
  }
  mkdir -p "$evidence_out"
  [[ -d "$evidence_out" && ! -L "$evidence_out" ]] || {
    echo "--evidence-out is not a real directory" >&2
    exit 65
  }
  evidence_out="$(cd "$evidence_out" && pwd -P)"
  if ! arm_observation_state initial initial; then
    arm_observation_latch_error initial-state
  fi
fi
resource_start="$(resource_snapshot "$output")"
deno_source="${DENO_SOURCE_DIR:-$root/deno}"
rusty_v8_source="${RUSTY_V8_SOURCE_DIR:-$root/rusty_v8}"
cargo_vendor="${CARGO_VENDOR_DIR:-$root/cargo-vendor}"
for path in "$deno_source/Cargo.lock" "$rusty_v8_source/Cargo.toml" "$cargo_vendor"; do
  [[ -e "$path" ]] || { echo "missing clean source material: $path" >&2; exit 65; }
done

rust_bin="${RUST_BIN:?set RUST_BIN to the task-local Rust 1.95.0 bin directory}"
cargo="${CARGO:-$rust_bin/cargo}"
rustc="${RUSTC:-$rust_bin/rustc}"
[[ -x "$cargo" && -x "$rustc" ]] || { echo "missing task-local cargo or rustc" >&2; exit 65; }
[[ "$(canonical_path "$cargo")" == "$(canonical_path "$rust_bin/cargo")" && "$(canonical_path "$rustc")" == "$(canonical_path "$rust_bin/rustc")" ]] || {
  echo "CARGO and RUSTC must resolve to the declared task-local Rust toolchain" >&2
  exit 65
}
"$rustc" --version | grep -q '^rustc 1\.95\.0 ' || {
  echo "Rust 1.95.0 is required for the pinned Deno 2.9.3 rebuild" >&2
  exit 65
}

: "${GN:?set GN to a task-local GN binary}"
: "${NINJA:?set NINJA to a task-local Ninja binary}"
: "${CLANG_BASE_PATH:?set CLANG_BASE_PATH to the pinned Chromium Clang prefix}"
: "${SLV_LINKER:?set SLV_LINKER to the checksum-pinned LLVM linker}"
: "${LIBCLANG_PATH:?set LIBCLANG_PATH to the paired task-local libclang directory}"
: "${CHROMIUM_RUST_TOOLCHAIN:?set CHROMIUM_RUST_TOOLCHAIN to the recorded Chromium Rust prerequisite}"
pinned_ninja="$(canonical_path "$NINJA")"
clang="$CLANG_BASE_PATH/bin/clang"
[[ -x "$GN" && -x "$pinned_ninja" && -x "$clang" && -x "$SLV_LINKER" && -x "$CHROMIUM_RUST_TOOLCHAIN/bin/rustc" ]] || {
  echo "GN, Ninja, Clang, pinned LLVM linker, and Chromium Rust prerequisite must be executable" >&2
  exit 65
}
case "$(uname -s)" in
  Linux) libclang="$LIBCLANG_PATH/libclang.so" ;;
  Darwin) libclang="$LIBCLANG_PATH/libclang.dylib" ;;
  *) echo "unsupported native host OS: $(uname -s)" >&2; exit 65 ;;
esac
[[ -e "$libclang" ]] || {
  echo "LIBCLANG_PATH lacks the paired platform libclang: $libclang" >&2
  exit 65
}
[[ "$(canonical_path "$(dirname "$LIBCLANG_PATH")/bin/clang")" == "$(canonical_path "$clang")" ]] || {
  echo "LIBCLANG_PATH must have the same paired clang as CLANG_BASE_PATH" >&2
  exit 65
}
resource_dir="$($clang -print-resource-dir)"
[[ -f "$resource_dir/include/stdarg.h" && -f "$resource_dir/include/stddef.h" ]] || {
  echo "the selected Clang resource directory lacks required C headers: $resource_dir" >&2
  exit 65
}

apple_xcode=""
apple_sdk_path=""
apple_sdk_version=""
if [[ "$(uname -s)" == "Darwin" ]]; then
  : "${DEVELOPER_DIR:?macOS proof requires DEVELOPER_DIR=/Applications/Xcode_16.2.app/Contents/Developer}"
  : "${SLV_APPLE_SDK_PATH:?macOS proof requires SLV_APPLE_SDK_PATH from Xcode 16.2}"
  [[ "$DEVELOPER_DIR" == "/Applications/Xcode_16.2.app/Contents/Developer" ]] || {
    echo "macOS proof requires the recorded Xcode 16.2 developer directory" >&2
    exit 65
  }
  apple_xcode="$(xcodebuild -version | tr '\n' ';')"
  [[ "$apple_xcode" == Xcode\ 16.2* ]] || {
    echo "macOS proof requires Xcode 16.2: $apple_xcode" >&2
    exit 65
  }
  apple_sdk_path="$(xcrun --sdk macosx --show-sdk-path)"
  apple_sdk_version="$(xcrun --sdk macosx --show-sdk-version)"
  [[ "$apple_sdk_path" == "$SLV_APPLE_SDK_PATH" && "$apple_sdk_version" == "15.2" ]] || {
    echo "macOS proof requires selected SDK 15.2 at declared path" >&2
    exit 65
  }
fi

linux_target=false
linux_arch=""
denolib=""
denosyslib=""
shim_dir=""
memfd_shim=""
math_shim=""
if [[ "$(uname -s)" == "Linux" ]]; then
  linux_target=true
  : "${BUILD_TARGET:?Linux source rebuild requires an explicit BUILD_TARGET}"
  : "${DENO_SYSROOT:?Linux source rebuild requires the pinned Deno ABI sysroot}"
  : "${DENO_SYSROOT_SHA256:?Linux source rebuild requires the pinned Deno ABI sysroot digest}"
  : "${V8_SYSROOT_AMD64:?Linux source rebuild requires the pinned V8 AMD64 sysroot}"
  : "${V8_SYSROOT_ARM64:?Linux source rebuild requires the pinned V8 ARM64 sysroot}"
  : "${V8_SYSROOT_AMD64_SHA256:?Linux source rebuild requires the pinned V8 AMD64 sysroot digest}"
  : "${V8_SYSROOT_ARM64_SHA256:?Linux source rebuild requires the pinned V8 ARM64 sysroot digest}"
  [[ "$resume" == false ]] || { echo "Linux ABI compatibility builds must start from a fresh work directory" >&2; exit 65; }
  case "$BUILD_TARGET" in
    x86_64-unknown-linux-gnu)
      [[ "$(uname -m)" == "x86_64" ]] || { echo "x86_64 target must build on x86_64 Linux" >&2; exit 65; }
      linux_arch=x86_64-linux-gnu
      ;;
    aarch64-unknown-linux-gnu)
      [[ "$(uname -m)" == "x86_64" ]] || { echo "only x86_64 Linux to aarch64 Linux cross-build is supported" >&2; exit 65; }
      linux_arch=aarch64-linux-gnu
      : "${CROSS_LINKER:?Linux ARM cross build requires the checksum-pinned target linker}"
      [[ -x "$CROSS_LINKER" ]] || { echo "cross linker is unavailable" >&2; exit 65; }
      ;;
    *) echo "unsupported Linux BUILD_TARGET: $BUILD_TARGET" >&2; exit 65 ;;
  esac
  [[ -f "$DENO_SYSROOT/.env" && -f "$DENO_SYSROOT/usr/include/features.h" && -f "$DENO_SYSROOT/usr/lib/$linux_arch/crt1.o" && -f "$DENO_SYSROOT/lib/$linux_arch/libc-2.27.so" ]] || {
    echo "pinned Deno ABI sysroot lacks required target headers, CRT, or glibc 2.27" >&2
    exit 65
  }
  [[ -d "$V8_SYSROOT_AMD64" && -d "$V8_SYSROOT_ARM64" ]] || {
    echo "pinned V8 Chromium sysroot extraction is unavailable" >&2
    exit 65
  }
  denolib="$DENO_SYSROOT/lib/$linux_arch"
  denosyslib="$DENO_SYSROOT/usr/lib/$linux_arch"
fi

work="$output/work"
if [[ "$resume" == false ]]; then
  if [[ -e "$work" ]]; then
    echo "output work directory already exists: $work" >&2
    exit 65
  fi
  mkdir -p "$work"
  cp -R "$deno_source" "$work/deno"
  cp -R "$rusty_v8_source" "$work/rusty_v8"
  mkdir -p "$work/deno/.cargo" "$output/cargo-home" "$output/target"

  # This link names a separately recorded compiler prerequisite.  It is made
  # only in the disposable build worktree because rusty_v8's upstream helper
  # requires that location; it is never accepted by the pure-source gate.
  ln -s "$CHROMIUM_RUST_TOOLCHAIN" "$work/rusty_v8/third_party/rust-toolchain"
  if [[ "$linux_target" == true ]]; then
    # rusty_v8 149.4.0 checks historical sid aliases while GN's recursive
    # installer reads the Bullseye names. Both names are local aliases to the
    # separately pinned Chromium 2.31 sysroots; Deno itself uses DENO_SYSROOT.
    mkdir -p "$work/rusty_v8/build/linux"
    ln -s "$V8_SYSROOT_AMD64" "$work/rusty_v8/build/linux/debian_sid_amd64-sysroot"
    ln -s "$V8_SYSROOT_ARM64" "$work/rusty_v8/build/linux/debian_sid_arm64-sysroot"
    ln -s "$V8_SYSROOT_AMD64" "$work/rusty_v8/build/linux/debian_bullseye_amd64-sysroot"
    ln -s "$V8_SYSROOT_ARM64" "$work/rusty_v8/build/linux/debian_bullseye_arm64-sysroot"

    shim_dir="$output/linux-abi-shims"
    mkdir -p "$shim_dir"
    memfd_source="$work/deno/tools/memfd_create_shim.c"
    math_source="$work/deno/tools/glibc_math_shim.c"
    [[ "$(sha256_file "$memfd_source")" == "82d1a89315445969e7451311f1e3d6735df568e312b9debecd2f3ae1390dbbe7" ]] || {
      echo "memfd compatibility shim differs from the pinned Deno source" >&2; exit 65;
    }
    [[ "$(sha256_file "$math_source")" == "69eba0766d139305978e347fd7289f41252c492a677003a21173797f24e9413f" ]] || {
      echo "glibc math compatibility shim differs from the pinned Deno source" >&2; exit 65;
    }
    memfd_shim="$shim_dir/memfd_create_shim.o"
    math_shim="$shim_dir/glibc_math_shim.o"
    "$clang" --target="$BUILD_TARGET" --sysroot="$DENO_SYSROOT" -fPIC -c "$memfd_source" -o "$memfd_shim"
    "$clang" --target="$BUILD_TARGET" --sysroot="$DENO_SYSROOT" -fPIC -c "$math_source" -o "$math_shim"
  fi
  # Preserve the pinned Deno Cargo configuration verbatim, especially its
  # macOS 12 deployment target and target-specific weak-framework/linker
  # flags. Only append the reviewable offline vendor and local-v8 overrides.
  upstream_cargo_config="$work/deno/.cargo/config.toml"
  upstream_cargo_config_sha="$(sha256_file "$upstream_cargo_config")"
  [[ "$upstream_cargo_config_sha" == "5fdfe697f7511c9b4d4ae5a3446bb13398da11d12c43ae5d0e55246465a453d4" ]] || {
    echo "pinned Deno Cargo configuration differs from f39575e" >&2; exit 65;
  }
  cat >> "$upstream_cargo_config" <<EOF

# SLV source rebuild overrides: append-only to retain the pinned upstream
# target configuration, including macOS deployment and linker settings.
[source.crates-io]
replace-with = "vendored-sources"

[source.vendored-sources]
directory = "$cargo_vendor"

[net]
offline = true

[patch.crates-io]
v8 = { path = "$work/rusty_v8" }
EOF
else
  [[ -f "$work/deno/Cargo.lock" && -f "$work/deno/.cargo/config.toml" && -L "$work/rusty_v8/third_party/rust-toolchain" && -d "$output/target" ]] || {
    echo "resume requires the existing isolated worktree, derived config, toolchain link, and target" >&2
    exit 65
  }
fi

source_lock="$deno_source/Cargo.lock"
source_lock_sha="$(sha256_file "$source_lock")"
assert_only_local_v8_relink() {
  "$PYTHON" - "$source_lock" "$work/deno/Cargo.lock" <<'PY'
import json
import sys
import tomllib

original = tomllib.load(open(sys.argv[1], 'rb')).get('package', [])
derived = tomllib.load(open(sys.argv[2], 'rb')).get('package', [])
registry = 'registry+https://github.com/rust-lang/crates.io-index'

def canonical(package):
    return json.dumps(package, sort_keys=True, separators=(',', ':'))

original_v8 = [p for p in original if p.get('name') == 'v8' and p.get('version') == '149.4.0' and p.get('source') == registry]
derived_v8 = [p for p in derived if p.get('name') == 'v8' and p.get('version') == '149.4.0' and 'source' not in p and 'checksum' not in p]
if len(original_v8) != 1 or len(derived_v8) != 1:
    raise SystemExit('derived lock must replace exactly one registry v8 149.4.0 entry with one local path entry')
if original_v8[0].get('dependencies') != derived_v8[0].get('dependencies'):
    raise SystemExit('local v8 path override changed the v8 dependency list')

remaining_original = sorted(canonical(p) for p in original if p is not original_v8[0])
remaining_derived = sorted(canonical(p) for p in derived if p is not derived_v8[0])
if remaining_original != remaining_derived:
    raise SystemExit('derived lock changed packages other than the approved local v8 path override')
PY
}
if [[ "$resume" == true ]]; then
  log="$output/baseline-denort-resume.log"
  receipt="$output/baseline-denort-resume-receipt.env"
else
  log="$output/baseline-denort.log"
  receipt="$output/baseline-denort-receipt.env"
fi
for forbidden in RUSTFLAGS CARGO_ENCODED_RUSTFLAGS RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER CC CXX AR LD RANLIB CFLAGS CXXFLAGS LDFLAGS SCCACHE_CACHE_SIZE SCCACHE_DIR CCACHE_DIR; do
  [[ -z "${!forbidden:-}" ]] || { echo "ambient compiler override is forbidden: $forbidden" >&2; exit 65; }
done
if [[ -n "${GN_ARGS+x}" && "$GN_ARGS" != "use_glib=false" ]]; then
  echo "GN_ARGS must be exactly use_glib=false" >&2
  exit 65
fi
if [[ -n "${EXTRA_GN_ARGS+x}" && "$EXTRA_GN_ARGS" != "use_lld=true" ]]; then
  echo "EXTRA_GN_ARGS must be exactly use_lld=true" >&2
  exit 65
fi
jobs="${JOBS:-2}"
# CI calls the driver with JOBS=2.  A reviewer may use up to eight isolated
# local jobs; accepting a bounded local override does not alter CI evidence.
[[ "$jobs" =~ ^([1-9]|1[0-6])$ ]] || { echo "JOBS must be an integer from 1 through 16" >&2; exit 65; }
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export PATH="$rust_bin:$CLANG_BASE_PATH/bin:/usr/bin:/bin"
export RUSTC="$rustc"
export CARGO_HOME="$output/cargo-home"
export CARGO_TARGET_DIR="$output/target"
export CARGO_NET_OFFLINE=true
export V8_FROM_SOURCE=true
unset RUSTY_V8_ARCHIVE
# NINJA_LAUNCHER_GENERATOR_BEGIN
write_ninja_launcher() {
  local launcher="$output/pinned-ninja-launcher.py"
  "$PYTHON" - "$launcher" "$pinned_ninja" <<'PYEOF'
import pathlib
import sys

launcher = pathlib.Path(sys.argv[1])
pinned_ninja = sys.argv[2]
launcher.write_text(
    f'''#!{sys.executable}
import os
import sys

pinned_ninja = {pinned_ninja!r}
environment = os.environ.copy()
for key in tuple(environment):
    if key == 'BINDGEN_EXTRA_CLANG_ARGS' or key.startswith('BINDGEN_EXTRA_CLANG_ARGS_'):
        del environment[key]
os.execve(pinned_ninja, [pinned_ninja, *sys.argv[1:]], environment)
''',
    encoding='utf-8',
)
PYEOF
  chmod 0755 "$launcher"
  printf '%s\n' "$launcher"
}
# NINJA_LAUNCHER_GENERATOR_END
ninja_launcher="$(write_ninja_launcher)"
[[ -x "$ninja_launcher" ]] || {
  echo "generated Ninja launcher is not executable: $ninja_launcher" >&2
  exit 65
}
NINJA="$ninja_launcher"
export GN NINJA CLANG_BASE_PATH LIBCLANG_PATH
export PYTHON
export PYTHONDONTWRITEBYTECODE=1
export GN_ARGS="use_glib=false"
if [[ "$linux_target" == true ]]; then
  # Use the pinned Chromium sysroot headers instead of host glibc headers.
  export GN_ARGS="$GN_ARGS use_sysroot=true"
fi
if [[ "${BUILD_TARGET:-}" == "aarch64-unknown-linux-gnu" ]]; then
  export GN_ARGS="$GN_ARGS v8_target_cpu=\"arm64\""
fi
export EXTRA_GN_ARGS="use_lld=true"
# rusty_v8 supplies its own ordered custom-libc++ arguments. Other vendored
# build scripts such as libsqlite3-sys call bindgen directly, so every bindgen
# caller receives the same pinned Clang resource headers and Linux ABI sysroot.
export BINDGEN_EXTRA_CLANG_ARGS="-isystem$resource_dir/include"
target_args=()
linker_driver_probe_log="$output/linker-driver-probe.log"
macos_bindgen_preflight_receipt=""
macos_bindgen_preflight_log=""
macos_bindgen_preflight_status=0
if [[ "$linux_target" == true ]]; then
  target_key="${BUILD_TARGET^^}"
  target_key="${target_key//-/_}"
  target_cc_flags="--target=$BUILD_TARGET --sysroot=$DENO_SYSROOT --ld-path=$SLV_LINKER -L$denolib -L$denosyslib"
  target_rust_flags="-C linker=$clang -C link-arg=--target=$BUILD_TARGET -C link-arg=--ld-path=$SLV_LINKER -C link-arg=--sysroot=$DENO_SYSROOT -C link-arg=-L$denolib -C link-arg=-L$denosyslib -C link-arg=$memfd_shim -C link-arg=$math_shim -C link-arg=-Wl,--wrap=expf -C link-arg=-Wl,--wrap=powf -C link-arg=-Wl,--wrap=exp2f -C link-arg=-Wl,--wrap=log2f -C link-arg=-Wl,--wrap=logf"
  export CARGO_BUILD_TARGET="$BUILD_TARGET"
  export "CARGO_TARGET_${target_key}_LINKER=$clang"
  export "CARGO_TARGET_${target_key}_RUSTFLAGS=$target_rust_flags"
  export "CC_${BUILD_TARGET//-/_}=$clang"
  export "CXX_${BUILD_TARGET//-/_}=$CLANG_BASE_PATH/bin/clang++"
  export "CFLAGS_${BUILD_TARGET//-/_}=$target_cc_flags"
  export "CXXFLAGS_${BUILD_TARGET//-/_}=$target_cc_flags"
  export BINDGEN_EXTRA_CLANG_ARGS="--target=$BUILD_TARGET --sysroot=$DENO_SYSROOT -isystem$resource_dir/include"
  "$clang" --target="$BUILD_TARGET" --sysroot="$DENO_SYSROOT" --ld-path="$SLV_LINKER" \
    -### -x c /dev/null -o "$output/linker-driver-probe" \
    > /dev/null 2>"$linker_driver_probe_log"
  grep -F -- "$SLV_LINKER" "$linker_driver_probe_log" >/dev/null || {
    echo "target C linker probe did not select the pinned LLVM ld.lld" >&2
    exit 65
  }
  target_args=(--target "$BUILD_TARGET")
  preflight_script="$(dirname "$0")/linux-sysroot-preflight.sh"
  [[ -x "$preflight_script" ]] || { echo "missing frozen Linux ABI preflight recipe: $preflight_script" >&2; exit 65; }
  export MEMFD_SHIM="$memfd_shim"
  export MATH_SHIM="$math_shim"
  "$preflight_script" "$output/linux-abi-preflight" "$work/deno"
  preflight_receipt="$output/linux-abi-preflight/preflight.json"
  [[ -f "$preflight_receipt" ]] || { echo "Linux ABI preflight did not emit receipt" >&2; exit 65; }
else
  preflight_receipt=""
  case "$(uname -m)" in
    x86_64) apple_link_target=x86_64-apple-darwin; apple_link_flags=() ;;
    arm64) apple_link_target=aarch64-apple-darwin; apple_link_flags=(-fuse-ld=lld) ;;
    *) echo "unsupported macOS architecture for linker receipt: $(uname -m)" >&2; exit 65 ;;
  esac
  # Bindgen reads this variable through shlex. Serialize its token list with
  # Python instead of relying on compiler-style concatenation, so the selected
  # SDK and paired Clang resource directory survive paths containing spaces.
  # MACOS_BINDGEN_ARGS_BEGIN
  apple_bindgen_args=(
    "--target=$apple_link_target"
    -isysroot
    "$SLV_APPLE_SDK_PATH"
    -isystem
    "$resource_dir/include"
  )
  BINDGEN_EXTRA_CLANG_ARGS="$("$PYTHON" - "${apple_bindgen_args[@]}" <<'PYEOF'
import shlex
import sys
print(shlex.join(sys.argv[1:]))
PYEOF
  )"
  export BINDGEN_EXTRA_CLANG_ARGS
  # MACOS_BINDGEN_ARGS_END
  # Preserve upstream Cargo flags as the actual Rust configuration. This
  # lightweight Clang trace records the effective native C driver selection
  # without asserting that x86_64 macOS must use the task-local lld.
  "$clang" -target "$apple_link_target" -isysroot "$SLV_APPLE_SDK_PATH" \
    ${apple_link_flags[@]+"${apple_link_flags[@]}"} -### -x c /dev/null -o "$output/linker-driver-probe" \
    > /dev/null 2>"$linker_driver_probe_log"
  macos_bindgen_preflight_dir="$output/macos-bindgen-preflight"
  macos_bindgen_preflight_receipt="$macos_bindgen_preflight_dir/preflight.json"
  macos_bindgen_preflight_log="$macos_bindgen_preflight_dir/diagnostics.log"
  if write_macos_bindgen_preflight "$macos_bindgen_preflight_dir"; then
    macos_bindgen_preflight_status=0
  else
    macos_bindgen_preflight_status=$?
  fi
  [[ -f "$macos_bindgen_preflight_receipt" && -f "$macos_bindgen_preflight_log" ]] || {
    echo "macOS bindgen preflight did not emit its receipt and diagnostics" >&2
    exit 65
  }
fi

# `generate-lockfile` happens only in the disposable copy.  It turns the
# upstream registry v8 entry into the local exact path entry; every subsequent
# build is locked and offline.  The source archive's original lock is checked
# again below and its hash is included in the receipt.


if [[ -n "$evidence_out" && "${BUILD_TARGET:-}" == "aarch64-unknown-linux-gnu" ]]; then
  if ! arm_observation_state phase guarded-cargo-start; then
    arm_observation_latch_error guarded-cargo-start
  fi
fi

# CARGO_BUILD_GUARD_BEGIN
# CARGO_BUILD_LIFECYCLE_HELPERS_BEGIN
write_macos_cargo_worker() {
  local worker="$output/slv-macos-cargo-worker.sh"
  {
    cat <<'BASH'
#!/usr/bin/env bash
set +e
source_lock="$1"
work="$2"
output="$3"
cargo="$4"
jobs="$5"
resume="$6"
shift 6
target_args=("$@")
phase_marker() {
  ( trap '' PIPE; printf 'SLV_MAC_BUILD_PHASE %s\n' "$1" ) 2>/dev/null || true
}
run_cargo() {
  "$@"
  local saved_status=$?
  return "$saved_status"
}
BASH
    declare -f assert_only_local_v8_relink
    cat <<'BASH'
original_directory="$PWD"
cd "$work/deno"
cd_status=$?
if [[ "$cd_status" -ne 0 ]]; then exit "$cd_status"; fi
if [[ "$resume" == true ]]; then
  phase_marker cargo-build-start
  run_cargo "$cargo" build --locked --offline --release "${target_args[@]}" -j "$jobs" -p denort
  saved_status=$?
  phase_marker cargo-build-finished
else
  phase_marker lock-generate-start
  run_cargo "$cargo" generate-lockfile --offline
  saved_status=$?
  phase_marker lock-generate-finished
  if [[ "$saved_status" -eq 0 ]]; then
    phase_marker lock-validation-start
    assert_only_local_v8_relink
    saved_status=$?
    phase_marker lock-validation-finished
  fi
  if [[ "$saved_status" -eq 0 ]]; then
    cp Cargo.lock "$output/derived-relink-Cargo.lock"
    saved_status=$?
  fi
  if [[ "$saved_status" -eq 0 ]]; then
    phase_marker cargo-build-start
    run_cargo "$cargo" build --locked --offline --release "${target_args[@]}" -j "$jobs" -p denort
    saved_status=$?
    phase_marker cargo-build-finished
  fi
fi
cd "$original_directory" >/dev/null 2>&1
exit "$saved_status"
BASH
  } > "$worker"
  chmod 0700 "$worker"
  printf '%s\n' "$worker"
}

write_macos_build_supervisor() {
  local supervisor="$output/slv-macos-cargo-supervisor.py"
  cat > "$supervisor" <<'PYEOF'
import errno
import json
import os
import selectors
import signal
import subprocess
import sys
import time

FINAL_SECONDS = 3.0
BUILD_CLEANUP_SECONDS = 2.0
PS_SECONDS = 0.25
MAX_PS_BYTES = 64 * 1024
MAX_PS_ROWS = 4096
MAX_RESIDUE = 32

worker, *worker_args = sys.argv[1:]
stopping = None
final_deadline = None

def now():
    return time.monotonic()

def remaining(deadline):
    return max(0.0, deadline - now())

def set_stop(signum):
    global stopping, final_deadline
    if stopping is None:
        stopping = signum
        final_deadline = now() + FINAL_SECONDS

def on_stop(signum, _frame):
    set_stop(signum)

for _sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(_sig, on_stop)

def bounded_wait(proc, deadline):
    while proc.poll() is None and remaining(deadline) > 0:
        time.sleep(min(0.02, remaining(deadline)))
    return proc.poll()

def snapshot(anchor_pid, original_pgid, deadline):
    """Observe one ps instant while the held anchor identity still exists."""
    result = {'complete': True, 'rows': [], 'outside': [], 'owned': [], 'reason': None, 'residue_total': 0, 'residue_truncated': False}
    def incomplete(reason):
        result['complete'] = False
        if result['reason'] is None: result['reason'] = reason
    if remaining(deadline) <= 0:
        incomplete('deadline')
        return result
    try:
        proc = subprocess.Popen(
            ['/bin/ps', '-axo', 'pid=,pgid='], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
        )
    except OSError as error:
        incomplete('ps-'+type(error).__name__)
        return result
    data, anchor_seen = bytearray(), False
    selector = selectors.DefaultSelector()
    read_deadline = max(now(), deadline - 0.10)
    selector.register(proc.stdout, selectors.EVENT_READ)
    try:
        while selector.get_map() and now() < read_deadline:
            for key, _ in selector.select(min(0.02, max(0.0, read_deadline - now()))):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if len(data) + len(chunk) > MAX_PS_BYTES:
                    incomplete('ps-overflow')
                    break
                data.extend(chunk)
        if selector.get_map():
            incomplete('ps-timeout')
        if proc.poll() is None:
            bounded_wait(proc, min(read_deadline, now() + 0.05))
        if proc.poll() is None:
            try:
                proc.terminate()
            except OSError:
                pass
        bounded_wait(proc, max(now(), deadline - 0.05))
        if proc.poll() is None:
            try:
                proc.kill()
            except OSError:
                pass
            bounded_wait(proc, deadline)
        if proc.poll() is None:
            incomplete('ps-reap')
        elif proc.returncode != 0:
            incomplete('ps-exit')
        raw_rows = data.decode('utf-8', 'replace').splitlines()
        if len(raw_rows) > MAX_PS_ROWS:
            incomplete('ps-row-overflow')
            raw_rows = raw_rows[:MAX_PS_ROWS]
        for raw in raw_rows:
            fields = raw.split()
            if len(fields) != 2:
                incomplete('ps-malformed')
                continue
            try:
                pid, pgid = int(fields[0]), int(fields[1])
            except ValueError:
                incomplete('ps-malformed')
                continue
            if pid <= 0:
                incomplete('ps-malformed')
                continue
            try:
                sid = os.getsid(pid)
            except ProcessLookupError:
                continue
            except OSError as error:
                incomplete('getsid-'+str(error.errno))
                continue
            if sid != anchor_pid:
                continue
            if pgid <= 0:
                incomplete('ps-malformed')
                continue
            result['residue_total'] += 1
            if len(result['rows']) >= MAX_RESIDUE:
                incomplete('residue-overflow'); result['residue_truncated'] = True
                continue
            row = {'pid': pid, 'pgid': pgid, 'sid': sid}
            result['rows'].append(row)
            if pid == anchor_pid:
                anchor_seen = True
                continue
            if pgid == original_pgid:
                result['owned'].append(row)
            else:
                result['outside'].append(row)
        if not anchor_seen:
            incomplete('ps-anchor-missing')
    except Exception as error:
        incomplete('ps-'+type(error).__name__)
    finally:
        selector.close()
        try:
            if proc.poll() is None:
                proc.kill()
                bounded_wait(proc, deadline)
            if proc.poll() is None:
                incomplete('ps-reap')
        except Exception:
            incomplete('ps-reap')
    return result

def held_identity(anchor, pgid):
    if anchor.poll() is not None:
        return False
    try:
        return os.getpgid(pgid) == pgid and os.getsid(pgid) == pgid
    except OSError:
        return False

def signal_group(anchor, pgid, signum):
    # Every signal is gated by the still-live held session leader.  If it has
    # gone away, the numeric PGID is no longer ours and must never be reused.
    if not held_identity(anchor, pgid):
        return False
    try:
        os.killpg(pgid, signum)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return False

def cleanup_anchor(anchor, anchor_pid, deadline, incoming=None):
    """Only signal the original held group; never discovered secondary groups."""
    outcome = {'complete': True, 'reason': None, 'residue': [], 'residue_total': 0, 'residue_truncated': False}
    if incoming is not None and not signal_group(anchor, anchor_pid, incoming):
        outcome.update(complete=False, reason='forward-signal')
    term_at = min(deadline, now() + 0.25)
    kill_at = min(deadline, now() + 0.75)
    # Anchor deliberately holds its own signal dispositions; TERM clears worker
    # descendants while preserving the group token for the required observation.
    if not signal_group(anchor, anchor_pid, signal.SIGTERM):
        outcome.update(complete=False, reason='term-signal')
    bounded_wait(anchor, term_at)
    if anchor.poll() is not None:
        outcome.update(complete=False, reason='anchor-reaped-before-observation')
        return outcome
    observed = snapshot(anchor_pid, anchor_pid, min(deadline, now() + PS_SECONDS))
    outcome['residue'] = observed['rows'][:MAX_RESIDUE]
    outcome['residue_total'] = observed['residue_total']
    outcome['residue_truncated'] = observed['residue_truncated']
    if not observed['complete'] or observed['outside']:
        outcome.update(complete=False, reason=observed.get('reason') or 'session-residue')
    # The held leader is expected until explicit release. Any remaining members
    # in the owned original group require the bounded final group kill.
    if observed['owned'] and now() < kill_at:
        if not signal_group(anchor, anchor_pid, signal.SIGKILL):
            outcome.update(complete=False, reason='kill-signal')
        bounded_wait(anchor, deadline)
    if anchor.poll() is None:
        try:
            os.write(release_write, b'R')
        except OSError:
            outcome.update(complete=False, reason='release-write')
        # Keep the final KILL and direct-child reap within this same cleanup
        # deadline; a broken release pipe cannot consume the last interval.
        bounded_wait(anchor, max(now(), deadline - 0.05))
    if anchor.poll() is None:
        # This is the last permitted group signal while identity is held.
        if not signal_group(anchor, anchor_pid, signal.SIGKILL):
            outcome.update(complete=False, reason='final-kill-signal')
        bounded_wait(anchor, deadline)
    if anchor.poll() is None:
        outcome.update(complete=False, reason='anchor-reap-timeout')
    return outcome

def emit_cleanup_incomplete(outcome):
    if outcome['complete']:
        return
    record = {
        'kind': 'slv-macos-cargo-cleanup',
        'status': 'incomplete',
        'reason': str(outcome.get('reason') or 'unknown')[:64],
        'residue': outcome['residue'][:MAX_RESIDUE],
        'residue_total': outcome['residue_total'],
        'residue_truncated': outcome['residue_truncated'],
    }
    try:
        print('SLV_MACOS_CARGO_CLEANUP_INCOMPLETE '+json.dumps(record, sort_keys=True, separators=(',',':')), flush=True)
    except Exception:
        pass

def anchor_main(completion_fd, release_fd, worker, worker_args):
    def hold(_signum, _frame):
        return None
    for item in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(item, hold)
    def defaults():
        for item in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
            signal.signal(item, signal.SIG_DFL)
    try:
        child = subprocess.Popen(
            ['/bin/bash', worker, *worker_args], stdin=subprocess.DEVNULL,
            close_fds=True, preexec_fn=defaults,
        )
    except OSError:
        os.write(completion_fd, b'125\n')
        os.close(completion_fd)
        return 125
    # Child inherited only normal recipe streams.  The anchor cannot retain data
    # pipes that would hide EOF from the recipe capture path.
    for fd in (1, 2):
        try: os.close(fd)
        except OSError: pass
    while child.poll() is None:
        try:
            ready, _, _ = select_select([release_fd], 0.05)
        except Exception:
            ready = []
        if ready:
            try: release = os.read(release_fd, 1)
            except OSError: release = b''
            if not release:
                try: os.killpg(os.getpgrp(), signal.SIGTERM)
                except OSError: pass
                time.sleep(0.25)
                try: os.killpg(os.getpgrp(), signal.SIGKILL)
                except OSError: pass
                return 125
    status = child.returncode
    try:
        os.write(completion_fd, (str(status) + '\n').encode('ascii'))
    except OSError:
        pass
    try: os.close(completion_fd)
    except OSError: pass
    # Explicit release follows bounded supervisor cleanup; EOF means parent loss
    # and requires this held owner to clean its original group itself.
    while True:
        try:
            ready, _, _ = select_select([release_fd], 0.1)
        except Exception:
            ready = []
        if not ready:
            continue
        try: release = os.read(release_fd, 1)
        except OSError: release = b''
        if release == b'R':
            return status
        if not release:
            try: os.killpg(os.getpgrp(), signal.SIGTERM)
            except OSError: pass
            time.sleep(0.25)
            try: os.killpg(os.getpgrp(), signal.SIGKILL)
            except OSError: pass
            return 125

def select_select(readers, timeout):
    import select
    return select.select(readers, [], [], timeout)

if sys.argv[1] == '--anchor':
    raise SystemExit(anchor_main(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5:]))

completion_read, completion_write = os.pipe()
release_read, release_write = os.pipe()
anchor = None
try:
    anchor = subprocess.Popen(
        [sys.executable, __file__, '--anchor', str(completion_write), str(release_read), worker, *worker_args],
        stdin=subprocess.DEVNULL, close_fds=True, pass_fds=(completion_write, release_read), start_new_session=True,
    )
    os.close(completion_write); completion_write = None
    os.close(release_read); release_read = None
    try:
        if os.getpgid(anchor.pid) != anchor.pid or os.getsid(anchor.pid) != anchor.pid:
            raise RuntimeError('anchor-identity')
    except OSError as error:
        raise RuntimeError('anchor-identity:'+type(error).__name__)
    selector = selectors.DefaultSelector(); selector.register(completion_read, selectors.EVENT_READ)
    payload = bytearray()
    while True:
        if stopping is not None:
            break
        # EOF without one bounded record is supervision-incomplete.  Do not
        # wait forever for a held anchor that is correctly awaiting release.
        if not selector.get_map() or anchor.poll() is not None:
            break
        ready = selector.select(0.03)
        for key, _ in ready:
            data = os.read(key.fd, 17 - len(payload))
            if not data:
                selector.unregister(key.fd)
                continue
            payload.extend(data)
            if len(payload) > 16:
                break
        if b'\n' in payload or len(payload) > 16:
            break
    if stopping is not None:
        primary = 128 + stopping
        final_deadline = final_deadline or now() + FINAL_SECONDS
    else:
        raw = bytes(payload)
        if raw.count(b'\n') != 1 or not raw.endswith(b'\n') or len(raw) > 16:
            primary = 125
        else:
            try:
                value = raw[:-1].decode('ascii')
                if not value or value.lstrip('-').isdigit() is False:
                    raise ValueError()
                primary = int(value)
            except ValueError:
                primary = 125
        final_deadline = now() + FINAL_SECONDS
    cleanup_deadline = min(final_deadline, now() + BUILD_CLEANUP_SECONDS)
    cleanup = cleanup_anchor(anchor, anchor.pid, cleanup_deadline, stopping)
    emit_cleanup_incomplete(cleanup)
    # A signal that arrives after a valid completion record still owns the
    # terminal shell status; it cannot be normalized into the saved worker 0.
    if stopping is not None:
        primary = 128 + stopping
    elif primary == 0 and not cleanup['complete']:
        primary = 125
    raise SystemExit(primary if primary >= 0 else 128 + (-primary))
except Exception as error:
    if anchor is not None:
        cleanup_anchor(anchor, anchor.pid, now() + BUILD_CLEANUP_SECONDS, stopping)
    print('macOS Cargo supervisor incomplete: '+type(error).__name__, file=sys.stderr)
    raise SystemExit(125)
finally:
    for fd in (completion_read, completion_write, release_read, release_write):
        if fd is not None:
            try: os.close(fd)
            except OSError: pass
PYEOF
  chmod 0700 "$supervisor"
  printf '%s\n' "$supervisor"
}

run_guarded_cargo_command() {
  "$@"
  local command_status=$?
  return "$command_status"
}

run_guarded_cargo_build() {
  local original_directory="$PWD" command_status
  cd "$work/deno"
  command_status=$?
  if [[ "$command_status" -ne 0 ]]; then
    return "$command_status"
  fi
  if [[ "$resume" == true ]]; then
    run_guarded_cargo_command "$cargo" build --locked --offline --release ${target_args[@]+"${target_args[@]}"} -j "$jobs" -p denort
    command_status=$?
  else
    run_guarded_cargo_command "$cargo" generate-lockfile --offline
    command_status=$?
    if [[ "$command_status" -eq 0 ]]; then
      assert_only_local_v8_relink
      command_status=$?
    fi
    if [[ "$command_status" -eq 0 ]]; then
      cp Cargo.lock "$output/derived-relink-Cargo.lock"
      command_status=$?
    fi
    if [[ "$command_status" -eq 0 ]]; then
      run_guarded_cargo_command "$cargo" build --locked --offline --release ${target_args[@]+"${target_args[@]}"} -j "$jobs" -p denort
      command_status=$?
    fi
  fi
  cd "$original_directory" >/dev/null 2>&1
  return "$command_status"
}

# CARGO_BUILD_LIFECYCLE_HELPERS_END
if [[ "$macos_bindgen_preflight_status" -ne 0 ]]; then
  status="$macos_bindgen_preflight_status"
  : > "$log"
  printf 'macOS bindgen preflight failed before Cargo (exit %s)\n' "$status" >> "$log"
else
  set +e
  if [[ "$(uname -s)" == "Darwin" ]]; then
    macos_worker="$(write_macos_cargo_worker)"
    macos_supervisor="$(write_macos_build_supervisor)"
    macos_build_pid=""
    macos_observer_pid=""
    macos_stop_cause=""
    macos_signal_latch() {
      local incoming="$1"
      if [[ -z "$macos_stop_cause" ]]; then
        macos_stop_cause="$incoming"
      fi
      # A trap can run after Python was launched but before $! was assigned.
      # Latch first; the launch path forwards the retained cause immediately
      # after registration instead of exiting and orphaning that supervisor.
      if [[ -n "$macos_build_pid" ]]; then
        kill -s "$macos_stop_cause" "$macos_build_pid" 2>/dev/null || true
      fi
      if [[ -n "$macos_observer_pid" ]]; then
        kill -s "$macos_stop_cause" "$macos_observer_pid" 2>/dev/null || true
      fi
      return 0
    }
    trap 'macos_signal_latch INT' INT
    trap 'macos_signal_latch TERM' TERM
    trap 'macos_signal_latch HUP' HUP
    if [[ -z "$macos_stop_cause" ]]; then
      "$PYTHON" "$macos_supervisor" "$macos_worker" "$source_lock" "$work" "$output" "$cargo" "$jobs" "$resume" ${target_args[@]+"${target_args[@]}"} > >(tee "$log") 2>&1 &
      macos_build_pid="$!"
    fi
    if [[ -n "$macos_build_pid" ]]; then
      if [[ -n "$macos_stop_cause" ]]; then
        kill -s "$macos_stop_cause" "$macos_build_pid" 2>/dev/null || true
      else
        start_macos_build_observer "$macos_build_pid" "$log"
        macos_observer_pid="$!"
        # Registration can race the first trap as well.
        if [[ -n "$macos_stop_cause" ]]; then
          kill -s "$macos_stop_cause" "$macos_build_pid" 2>/dev/null || true
          kill -s "$macos_stop_cause" "$macos_observer_pid" 2>/dev/null || true
        fi
      fi
      wait "$macos_build_pid"
      macos_supervisor_status=$?
      stop_macos_build_observer "$macos_observer_pid"
      if [[ -n "$macos_stop_cause" ]]; then
        status=$((128 + $(kill -l "$macos_stop_cause")))
      else
        status="$macos_supervisor_status"
      fi
    else
      status=$((128 + $(kill -l "$macos_stop_cause")))
    fi
    trap - INT TERM HUP
  else
    run_guarded_cargo_build > >(tee "$log") 2>&1
    status=$?
  fi
  set -e
fi
# CARGO_BUILD_GUARD_END
if [[ -n "$evidence_out" && "${BUILD_TARGET:-}" == "aarch64-unknown-linux-gnu" ]]; then
  if ! arm_observation_state phase guarded-cargo-finished "$status"; then
    arm_observation_latch_error guarded-cargo-finished
  fi
fi
if [[ "$status" -eq 0 ]]; then
  assert_only_local_v8_relink
fi
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
resource_end="$(resource_snapshot "$output")"

release_root="$output/target/release"
if [[ -n "${BUILD_TARGET:-}" ]]; then
  release_root="$output/target/$BUILD_TARGET/release"
fi
denort="$release_root/denort"
# rusty_v8's source build writes its GN output under Cargo's release target,
# rather than beneath Cargo's per-crate build directory.  Require these
# concrete outputs after a successful build so a receipt cannot claim a
# source-built runtime without the native archive and the GN link description.
v8_archive="$release_root/gn_out/obj/librusty_v8.a"
v8_ninja="$release_root/gn_out/obj/rusty_v8.ninja"
saved_source_status="$status"
raw_capture_status="raw-capture-complete"
if ! capture_arm_raw_evidence \
  "$output/target/release/gn_out" \
  "$output/target/${BUILD_TARGET:-}/release/gn_out"; then
  raw_capture_status="raw-capture-incomplete"
  arm_observation_latch_error raw-capture
fi
if ! arm_observation_state raw raw-capture "$saved_source_status" "$raw_capture_status"; then
  arm_observation_latch_error raw-state
fi
status="$saved_source_status"
linux_denort_abi_receipt=""
macos_denort_abi_receipt=""
if [[ "$status" -eq 0 && "$linux_target" == true ]]; then
  abi_dir="$output/linux-denort-abi"
  mkdir -p "$abi_dir"
  /usr/bin/readelf --version-info "$denort" >"$abi_dir/version-info.log"
  /usr/bin/readelf -d "$denort" >"$abi_dir/dynamic.log"
  "$PYTHON" - "$abi_dir" "$denort" <<'PYEOF'
import hashlib
import json
import pathlib
import re
import sys

directory = pathlib.Path(sys.argv[1])
binary = pathlib.Path(sys.argv[2])
version = (directory / 'version-info.log').read_text(errors='replace')
dynamic = (directory / 'dynamic.log').read_text(errors='replace')
if 'GLIBC_PRIVATE' in version:
    raise SystemExit('source-built denort imports GLIBC_PRIVATE')
observed = sorted({(int(a), int(b)) for a, b in re.findall(r'GLIBC_(\d+)\.(\d+)', version)})
if any(item > (2, 27) for item in observed):
    raise SystemExit('source-built denort imports GLIBC above 2.27: ' + repr(observed))
if re.search(r'\((?:RPATH|RUNPATH)\)', dynamic):
    raise SystemExit('source-built denort has RPATH/RUNPATH')
needed = re.findall(r'Shared library: \[([^]]+)\]', dynamic)
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
payload = {
    'schema_version': 1,
    'kind': 'slv-linux-denort-abi',
    'denort_sha256': digest(binary),
    'glibc_versions': [f'{a}.{b}' for a, b in observed],
    'glibc_private': 'absent',
    'rpath_or_runpath': 'absent',
    'needed': needed,
    'logs': {name: digest(directory / name) for name in ('version-info.log', 'dynamic.log')},
    'status': 'passed',
}
(directory / 'receipt.json').write_text(json.dumps(payload, sort_keys=True, indent=2) + '\n')
PYEOF
  linux_denort_abi_receipt="$abi_dir/receipt.json"
fi
if [[ "$status" -eq 0 && "$(uname -s)" == "Darwin" ]]; then
  abi_dir="$output/macos-denort-abi"
  mkdir -p "$abi_dir"
  otool -l "$denort" >"$abi_dir/load-commands.log"
  "$PYTHON" - "$abi_dir" "$denort" <<'PYEOF'
import hashlib
import json
import pathlib
import re
import sys

directory = pathlib.Path(sys.argv[1])
binary = pathlib.Path(sys.argv[2])
text = (directory / 'load-commands.log').read_text(errors='replace')
match = re.search(r'cmd LC_BUILD_VERSION.*?minos\s+([0-9.]+)', text, re.S)
if not match:
    raise SystemExit('Mach-O LC_BUILD_VERSION minos is missing')
if match.group(1) != '12.0':
    raise SystemExit('source-built denort does not retain macOS 12.0 floor: ' + match.group(1))
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
payload = {
    'schema_version': 1,
    'kind': 'slv-macos-denort-abi',
    'denort_sha256': digest(binary),
    'minimum_os': match.group(1),
    'load_commands_sha256': digest(directory / 'load-commands.log'),
    'status': 'passed',
}
(directory / 'receipt.json').write_text(json.dumps(payload, sort_keys=True, indent=2) + '\n')
PYEOF
  macos_denort_abi_receipt="$abi_dir/receipt.json"
fi
{
  printf 'schema_version=1\n'
  printf 'stage=baseline-denort\n'
  printf 'source_root=%s\n' "$root"
  printf 'source_deno=%s\n' "$(canonical_path "$deno_source")"
  printf 'source_rusty_v8=%s\n' "$(canonical_path "$rusty_v8_source")"
  printf 'cargo_vendor=%s\n' "$(canonical_path "$cargo_vendor")"
  printf 'run_mode=%s\n' "$([[ "$resume" == true ]] && printf resume || printf fresh)"
  printf 'recipe_path=%s\n' "$(canonical_path "$0")"
  printf 'recipe_sha256=%s\n' "$(sha256_file "$0")"
  printf 'source_selected_Cargo.lock_sha256=%s\n' "$source_lock_sha"
  printf 'upstream_Cargo.config_sha256=%s\n' "${upstream_cargo_config_sha:-$(sha256_file "$deno_source/.cargo/config.toml")}"
  printf 'work_Cargo.config_sha256=%s\n' "$(sha256_file "$work/deno/.cargo/config.toml")"
  printf 'work_relink_Cargo.lock_sha256=%s\n' "$(sha256_file "$work/deno/Cargo.lock")"
  printf 'python=%s\n' "$(canonical_path "$PYTHON")"
  printf 'python_version=%s\n' "$python_version"
  printf 'rustc=%s\n' "$("$rustc" --version)"
  printf 'cargo=%s\n' "$("$cargo" --version)"
  printf 'clang=%s\n' "$("$clang" --version | head -1)"
  printf 'clang_sha256=%s\n' "$(sha256_file "$clang")"
  printf 'libclang=%s\n' "$(canonical_path "$libclang")"
  printf 'libclang_sha256=%s\n' "$(sha256_file "$libclang")"
  printf 'clang_resource_dir=%s\n' "$resource_dir"
  printf 'bindgen_extra_clang_args=%s\n' "$BINDGEN_EXTRA_CLANG_ARGS"
  printf 'chromium_rust_toolchain=%s\n' "$CHROMIUM_RUST_TOOLCHAIN"
  printf 'chromium_rust_sentinel_sha256=%s\n' "$(sha256_file "$CHROMIUM_RUST_TOOLCHAIN/.rusty_v8_version")"
  printf 'gn_sha256=%s\n' "$(sha256_file "$GN")"
  printf 'ninja_sha256=%s\n' "$(sha256_file "$pinned_ninja")"
  printf 'ninja_path=%s\n' "$(canonical_path "$pinned_ninja")"
  printf 'ninja_launcher_path=%s\n' "$(canonical_path "$ninja_launcher")"
  printf 'ninja_launcher_sha256=%s\n' "$(sha256_file "$ninja_launcher")"
  printf 'ninja_environment_policy=remove-BINDGEN_EXTRA_CLANG_ARGS-and-BINDGEN_EXTRA_CLANG_ARGS_-prefix\n'
  printf 'gn_args=%s\n' "$GN_ARGS"
  printf 'extra_gn_args=%s\n' "$EXTRA_GN_ARGS"
  printf 'pinned_linker=%s\n' "$(canonical_path "$SLV_LINKER")"
  printf 'pinned_linker_sha256=%s\n' "$(sha256_file "$SLV_LINKER")"
  printf 'effective_linker_driver_probe_log=%s\n' "$linker_driver_probe_log"
  printf 'effective_linker_driver_probe_log_sha256=%s\n' "$(sha256_file "$linker_driver_probe_log")"
  printf 'build_target=%s\n' "${BUILD_TARGET:-native}"
  printf 'release_root=%s\n' "$release_root"
  printf 'host_os=%s\n' "$(uname -s)"
  printf 'host_arch=%s\n' "$(uname -m)"
  [[ -n "$apple_xcode" ]] && printf 'apple_xcode=%s\n' "$apple_xcode"
  [[ -n "$apple_sdk_path" ]] && printf 'apple_sdk_path=%s\n' "$apple_sdk_path"
  [[ -n "$apple_sdk_version" ]] && printf 'apple_sdk_version=%s\n' "$apple_sdk_version"
  if [[ -n "$macos_bindgen_preflight_receipt" ]]; then
    printf 'macos_bindgen_preflight_receipt=%s\n' "$macos_bindgen_preflight_receipt"
    printf 'macos_bindgen_preflight_receipt_sha256=%s\n' "$(sha256_file "$macos_bindgen_preflight_receipt")"
    printf 'macos_bindgen_preflight_diagnostics_log=%s\n' "$macos_bindgen_preflight_log"
    printf 'macos_bindgen_preflight_diagnostics_log_sha256=%s\n' "$(sha256_file "$macos_bindgen_preflight_log")"
    printf 'macos_bindgen_preflight_status=%s\n' "$macos_bindgen_preflight_status"
  fi
  if [[ "$linux_target" == true ]]; then
    printf 'deno_sysroot=%s\n' "$(canonical_path "$DENO_SYSROOT")"
    printf 'deno_sysroot_sha256=%s\n' "$DENO_SYSROOT_SHA256"
    printf 'deno_sysroot_env_sha256=%s\n' "$(sha256_file "$DENO_SYSROOT/.env")"
    printf 'deno_sysroot_target_arch=%s\n' "$linux_arch"
    printf 'v8_sysroot_amd64=%s\n' "$(canonical_path "$V8_SYSROOT_AMD64")"
    printf 'v8_sysroot_amd64_sha256=%s\n' "$V8_SYSROOT_AMD64_SHA256"
    printf 'v8_sysroot_arm64=%s\n' "$(canonical_path "$V8_SYSROOT_ARM64")"
    printf 'v8_sysroot_arm64_sha256=%s\n' "$V8_SYSROOT_ARM64_SHA256"
    printf 'rusty_v8_sysroot_alias_amd64=%s\n' "$(canonical_path "$work/rusty_v8/build/linux/debian_sid_amd64-sysroot")"
    printf 'rusty_v8_sysroot_alias_arm64=%s\n' "$(canonical_path "$work/rusty_v8/build/linux/debian_sid_arm64-sysroot")"
    printf 'rusty_v8_bullseye_sysroot_alias_amd64=%s\n' "$(canonical_path "$work/rusty_v8/build/linux/debian_bullseye_amd64-sysroot")"
    printf 'rusty_v8_bullseye_sysroot_alias_arm64=%s\n' "$(canonical_path "$work/rusty_v8/build/linux/debian_bullseye_arm64-sysroot")"
    printf 'memfd_shim_source_sha256=%s\n' "$(sha256_file "$work/deno/tools/memfd_create_shim.c")"
    printf 'memfd_shim_object_sha256=%s\n' "$(sha256_file "$memfd_shim")"
    printf 'glibc_math_shim_source_sha256=%s\n' "$(sha256_file "$work/deno/tools/glibc_math_shim.c")"
    printf 'glibc_math_shim_object_sha256=%s\n' "$(sha256_file "$math_shim")"
    [[ "$BUILD_TARGET" == "aarch64-unknown-linux-gnu" ]] && printf 'cross_linker=%s\n' "$(canonical_path "$CROSS_LINKER")"
    printf 'linux_preflight_receipt=%s\n' "$preflight_receipt"
    printf 'linux_preflight_receipt_sha256=%s\n' "$(sha256_file "$preflight_receipt")"
    [[ -n "$linux_denort_abi_receipt" ]] && printf 'linux_denort_abi_receipt=%s\n' "$linux_denort_abi_receipt"
    [[ -n "$linux_denort_abi_receipt" ]] && printf 'linux_denort_abi_receipt_sha256=%s\n' "$(sha256_file "$linux_denort_abi_receipt")"
  fi
  [[ -n "$macos_denort_abi_receipt" ]] && printf 'macos_denort_abi_receipt=%s\n' "$macos_denort_abi_receipt"
  [[ -n "$macos_denort_abi_receipt" ]] && printf 'macos_denort_abi_receipt_sha256=%s\n' "$(sha256_file "$macos_denort_abi_receipt")"
  printf 'command_env_allowlist=BINDGEN_EXTRA_CLANG_ARGS,BUILD_TARGET,CARGO,CARGO_BUILD_TARGET,CARGO_HOME,CARGO_NET_OFFLINE,CARGO_TARGET_DIR,CARGO_VENDOR_DIR,CHROMIUM_RUST_TOOLCHAIN,CLANG_BASE_PATH,CROSS_LINKER,DENO_SOURCE_DIR,EXTRA_GN_ARGS,DENO_SYSROOT,DENO_SYSROOT_SHA256,DEVELOPER_DIR,GN,GN_ARGS,HOME,JOBS,LIBCLANG_PATH,NINJA,PATH,PYTHON,PYTHONDONTWRITEBYTECODE,RUSTC,RUSTY_V8_SOURCE_DIR,SLV_APPLE_SDK_PATH,SLV_LINKER,V8_FROM_SOURCE,V8_SYSROOT_AMD64,V8_SYSROOT_AMD64_SHA256,V8_SYSROOT_ARM64,V8_SYSROOT_ARM64_SHA256\n'
  printf 'cleared_ambient_compiler_variables=RUSTFLAGS,CARGO_ENCODED_RUSTFLAGS,RUSTC_WRAPPER,RUSTC_WORKSPACE_WRAPPER,CC,CXX,AR,LD,RANLIB,CFLAGS,CXXFLAGS,LDFLAGS,SCCACHE_CACHE_SIZE,SCCACHE_DIR,CCACHE_DIR\n'
  printf 'command=%s\n' "cargo generate-lockfile --offline && cargo build --locked --offline --release [--target BUILD_TARGET] -j $jobs -p denort"
  printf 'started_at=%s\n' "$started"
  printf 'finished_at=%s\n' "$finished"
  printf 'resource_start=%s\n' "$resource_start"
  printf 'resource_end=%s\n' "$resource_end"
  printf 'exit_code=%s\n' "$status"
  printf 'log_sha256=%s\n' "$(sha256_file "$log")"
  [[ -f "$output/derived-relink-Cargo.lock" ]] && printf 'derived_relink_Cargo.lock_sha256=%s\n' "$(sha256_file "$output/derived-relink-Cargo.lock")"
  [[ -f "$denort" ]] && printf 'denort_sha256=%s\n' "$(sha256_file "$denort")"
  [[ -f "$v8_archive" ]] && printf 'librusty_v8_archive=%s\n' "$v8_archive"
  [[ -f "$v8_archive" ]] && printf 'librusty_v8_sha256=%s\n' "$(sha256_file "$v8_archive")"
  [[ -f "$v8_ninja" ]] && printf 'rusty_v8_ninja=%s\n' "$v8_ninja"
  [[ -f "$v8_ninja" ]] && printf 'rusty_v8_ninja_sha256=%s\n' "$(sha256_file "$v8_ninja")"
} > "$receipt"

if [[ "$status" -ne 0 ]]; then
  exit "$status"
fi
[[ -x "$denort" ]] || exit 66
[[ -f "$v8_archive" && -f "$v8_ninja" ]] || {
  echo "source build did not produce required V8 archive/Ninja evidence" >&2
  exit 66
}
