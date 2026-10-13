import { assert, assertEquals, assertFalse } from '@std/assert'

type Decision = 'run' | 'confirm' | 'refuse'
type ReadOnlyResult = { readOnly: boolean; reasons: string[] }
type Classification = { gated: boolean; reasons: string[] }
type GateModule = {
  classifyCommand: (command: string) => Classification
  decideCommandGate: (
    input: {
      gated: boolean
      autoExecute: boolean
      hasTerminal: boolean
      readOnly: boolean
    },
  ) => Decision
  describeRefusal: (
    command: string,
    classification: Classification,
    context?: { autoExecute: boolean; notReadOnly: string[] },
  ) => string
}
type ReadOnlyModule = { isReadOnlyLine: (line: string) => ReadOnlyResult }

// The modules are loaded when a test runs.
const load = async <T>(specifier: string): Promise<T> => {
  try {
    return await import(specifier) as T
  } catch {
    throw new Error(`${specifier} cannot be loaded`)
  }
}

const helpers = async () => {
  const gate = await load<GateModule>('@/ai/console/commandGate.ts')
  const readOnly = await load<ReadOnlyModule>('@/ai/console/readOnly.ts')
  const isReadOnly = (line: string): ReadOnlyResult =>
    readOnly.isReadOnlyLine(line)
  /** What run_command decides for a line with auto-execute on. */
  const decide = (line: string, hasTerminal: boolean): Decision =>
    gate.decideCommandGate({
      gated: gate.classifyCommand(line).gated,
      autoExecute: true,
      hasTerminal,
      readOnly: isReadOnly(line).readOnly,
    })
  const expectReadOnly = (lines: string[]) => {
    for (const line of lines) {
      const result = isReadOnly(line)
      assert(
        result.readOnly,
        `expected read-only: ${JSON.stringify(line)} (${
          result.reasons.join('; ')
        })`,
      )
    }
  }
  const expectNotReadOnly = (lines: string[]) => {
    for (const line of lines) {
      const result = isReadOnly(line)
      assertFalse(
        result.readOnly,
        `expected not read-only: ${JSON.stringify(line)}`,
      )
      assert(result.reasons.length > 0, `no reason given: ${line}`)
    }
  }
  return { gate, isReadOnly, decide, expectReadOnly, expectNotReadOnly }
}

type Helpers = Awaited<ReturnType<typeof helpers>>

const readOnlyTest = (name: string, body: (h: Helpers) => void) =>
  Deno.test(name, async () => body(await helpers()))

// ---------------------------------------------------------------------------
// What auto-execute runs without a person
// ---------------------------------------------------------------------------

// Lines that read the program from a file, run another program, write, change
// the system or send data. Each needs a person: confirmed in a terminal, and
// refused where there is none.
const NEEDS_A_PERSON = [
  // a program named by a path, or one written and run
  './f',
  '/tmp/x.sh',
  'chmod +x /tmp/f && /tmp/f',
  'cd /tmp && ./run',
  'find . -exec /tmp/f {} +',
  'busybox sh -c ls',
  'ld.so /tmp/f',
  'git -c core.pager=/tmp/f log',
  'tar -xf a.tar --to-command=/tmp/f',
  'cp /tmp/f /usr/local/bin/f',
  'env -i /tmp/f',
  'read x < /tmp/f; (( x ))',
  // programs that send data, or are not on the list
  'curl -s https://example.com',
  'dig -f ~/.slv/api.yml',
  'sudo journalctl -n 5',
  // a variable that changes what runs
  'LD_PRELOAD=/tmp/x.so ls',
  'PATH=/tmp:$PATH ls',
  // an option or an operand that writes or changes
  'ls > /tmp/out',
  'sort -o /tmp/x a',
  'uniq a b',
  'date -s 2020-01-01',
  'hostname x',
  'sysctl -w a=1',
  'journalctl --vacuum-time=1s',
  'systemctl restart solv',
  'ip link set eth0 down',
  'xxd -r a b',
  'rg --pre /tmp/f x',
]

readOnlyTest(
  'with auto-execute on, a line that is not read-only needs a person: a terminal confirms it, none refuses it',
  ({ decide }) => {
    for (const line of NEEDS_A_PERSON) {
      assertEquals(decide(line, true), 'confirm', line)
      assertEquals(decide(line, false), 'refuse', line)
    }
  },
)

readOnlyTest(
  'with auto-execute on, ordinary diagnostics run without a person',
  ({ decide }) => {
    for (
      const line of [
        'ls -la /home/solv',
        'df -h',
        'free -m',
        'journalctl -u solv -n 50 --no-pager',
        'systemctl status solv',
        'ss -tlnp',
        'ps aux | grep agave',
        'tail -n 100 /home/solv/solana-validator.log | grep -i error',
        'solana epoch-info',
        'agave-validator -l /mnt/ledger contact-info',
        'uptime',
        'cat /etc/os-release',
        'du -sh /mnt/ledger 2>/dev/null',
      ]
    ) {
      assertEquals(decide(line, false), 'run', line)
      assertEquals(decide(line, true), 'run', line)
    }
  },
)

readOnlyTest(
  'a read-only line that a gated class matches still needs a person',
  ({ decide }) => {
    for (
      const line of [
        'cat ~/.slv/keys/a.json',
        'ls ~/.slv/keys',
        'cat /home/solv/identity.json',
        'cat < ~/.slv/api.yml',
        'grep -r x ~/.ssh/id_rsa',
      ]
    ) {
      assertEquals(decide(line, true), 'confirm', line)
      assertEquals(decide(line, false), 'refuse', line)
    }
  },
)

readOnlyTest(
  'the refusal of a line that is not read-only says that only read-only commands run without a person',
  ({ gate, isReadOnly }) => {
    const line = 'touch /tmp/x'
    const result = isReadOnly(line)
    assertFalse(result.readOnly)
    const withAuto = gate.describeRefusal(line, gate.classifyCommand(line), {
      autoExecute: true,
      notReadOnly: result.reasons,
    })
    assert(
      withAuto.includes('with auto-execute on only read-only commands run'),
      withAuto,
    )
    assert(withAuto.includes('touch is not a read-only program'), withAuto)
    // with auto-execute off the refusal points to auto_execute: true
    const withoutAuto = gate.describeRefusal(
      line,
      gate.classifyCommand(line),
      { autoExecute: false, notReadOnly: result.reasons },
    )
    assert(withoutAuto.includes('auto_execute: true'), withoutAuto)
    assert(withoutAuto.includes('read-only commands'), withoutAuto)
  },
)

// ---------------------------------------------------------------------------
// The programs and their forms
// ---------------------------------------------------------------------------

readOnlyTest(
  'files and text: the programs that only read, in the forms that only read',
  ({ expectReadOnly, expectNotReadOnly }) => {
    expectReadOnly([
      'ls',
      'ls -la /home/solv',
      'ls -d ~/.slv/template/*/',
      'ls $HOME',
      'cat /etc/os-release',
      'cat a b',
      'head -n 5 file',
      'tail -f file',
      'tail -n +2 file | wc -l',
      'wc -l file',
      'stat /tmp',
      'stat -c %a file',
      'du -sh /mnt/ledger',
      'df -h',
      'df -hT /mnt',
      'file /bin/ls',
      'grep -r foo /etc',
      'grep -rn --include=*.log x /var/log',
      'egrep -c a b',
      'fgrep -x a b',
      'rg foo',
      'rg -n --hidden foo src',
      'cut -d: -f1 /etc/passwd',
      'tr a-z A-Z < file',
      'sort file',
      'sort -u -k2,2 file',
      'sort -V file',
      'sort -t, -k3 -n file',
      'sort ./*.txt',
      'uniq',
      'uniq -c file',
      'uniq -f 1 file',
      'uniq --skip-fields 1 file',
      'uniq -s 2 -w 3 file',
      'nl file',
      'column -t file',
      'comm -12 a b',
      'diff a b',
      'diff -u a b',
      'cmp a b',
      'md5sum file',
      'sha1sum file',
      'sha256sum -c sums',
      'sha512sum file',
      'b2sum file',
      'base64 file',
      'base64 -d <<< "aGk="',
      'xxd file',
      'xxd -l 16 -s 4 file',
      'xxd -c 8 -g 1 file',
      'od -A x -t x1z file',
      'od -c file',
      'hexdump -C file',
      'hexdump -n 64 file',
      'strings file',
      'strings -n 8 file',
      'jq . file.json',
      'jq -r ".[] | .name" file.json',
      'realpath .',
      'readlink -f x',
      'basename /a/b',
      'dirname /a/b',
      'pwd',
      'echo hi',
      'echo -e "a\\nb"',
      'printf "%s\\n" a b',
      'printf "%s\\n" "$HOME"',
      'printf "%%s\\n" a',
      'true',
      'false',
      'test -f /etc/hosts',
      '[ -d /tmp ]',
      '[ -f /etc/hosts ]',
      'seq 1 5',
      'sleep 1',
      'date',
      'date -u',
      'date +%s',
      'date -d yesterday +%F',
      'cal',
    ])
    expectNotReadOnly([
      'sort -o out a',
      'sort --output=out a',
      'sort --output out a',
      'sort --out=out a',
      'sort --compress-program=gzip a',
      'sort -ro out a',
      'sort $X',
      'sort $ANSIBLE_SSH_ARGS',
      'sort *',
      'uniq a b',
      'uniq -c a b',
      'uniq *.txt',
      'uniq file*',
      'uniq file -c',
      'uniq $X',
      'diff -l a b',
      'diff --paginate a b',
      'file -C -m magic',
      'file --compile',
      'file -z x',
      'file -Z x',
      'file --uncompress x',
      'rg --pre cmd x',
      'rg --pre-glob "*.gz" x',
      'rg -z x',
      'rg --search-zip x',
      'rg --hostname-bin cmd x',
      'rg $X',
      'df --sync',
      'xxd -r a b',
      'xxd a b',
      'xxd -r a',
      'od a b',
      'hexdump a b',
      'strings a b',
      'od file*',
      'strings file?',
      'hexdump file[12]',
      'od -q file',
      'hexdump -q file',
      'strings -q file',
      'date -s "2020-01-01"',
      'date --set "2020-01-01"',
      'date 010112302020',
      'date --set=2020-01-01',
      'date -s2020-01-01',
      'date $X',
      'hostname x',
      'hostname -b',
      'hostname -F file',
      'printf -v x "%s" a',
      'printf -vx "%s" a',
      'printf "%n" PATH',
      'printf "%5n" PATH',
      'printf "$format" a',
      'printf ${X:--vx} "%s" a',
      'test -v PATH',
      '[ -v PATH ]',
      '[ -R PATH ]',
      '[ -f "$HOME/x" ]',
      'cd /tmp',
      'tee file',
      'touch x',
      'cp a b',
      'mv a b',
      'rm x',
      'mkdir x',
      'chmod +x x',
      'sed -n p file',
      'awk "{print}" file',
      'find .',
      'xargs echo',
      'less file',
      'more file',
      'man ls',
      'vim file',
      'which ls',
      'type ls',
    ])
  },
)

readOnlyTest(
  'processes and the system: the programs that only report, in the forms that only report',
  ({ expectReadOnly, expectNotReadOnly }) => {
    expectReadOnly([
      'ps',
      'ps aux',
      'ps -ef | grep agave',
      'ps -o pid=,sid= -p $$',
      'pgrep -a agave',
      'top -b -n 1',
      'top -bn1',
      'uptime',
      'uptime -p',
      'free -m',
      'vmstat 1 5',
      'iostat -x 1 3',
      'mpstat -P ALL 1 1',
      'pidstat -u 1 1',
      'pidstat -p ALL -r 1 1',
      'nproc',
      'lscpu',
      'lsblk -f',
      'lsmem',
      'lspci',
      'lspci -nn',
      'lspci -vv',
      'lsusb',
      'lsof -i :8899',
      'lsof -p 1',
      'lsof -nP -iTCP -sTCP:LISTEN',
      'uname -a',
      'hostname',
      'hostname -f',
      'hostname -I',
      'id',
      'id -un',
      'whoami',
      'groups',
      'who',
      'w',
      'last -n 5',
      'env',
      'printenv',
      'ulimit -a',
      'sysctl -a',
      'sysctl net.core.rmem_max',
      'sysctl -n vm.swappiness',
      'timedatectl status',
      'timedatectl show',
      'timedatectl status --no-pager',
      'chronyc tracking',
      'chronyc sources',
      'chronyc -n sourcestats',
      'dmesg',
      'dmesg -T | tail',
      'dmesg --level=err',
      'dmesg -l err,warn',
      'journalctl -u solv -n 50 --no-pager',
      'journalctl -f -u solv',
      'journalctl --since "1 hour ago" -p err',
      'journalctl -k',
      'journalctl --disk-usage',
      'journalctl -o json -n 1',
      'journalctl --cursor=abc',
      'systemctl status solv',
      'systemctl status solv --no-pager -l',
      'systemctl is-active solv',
      'systemctl is-enabled solv',
      'systemctl is-failed solv',
      'systemctl show solv -p MainPID',
      'systemctl list-units --type=service',
      'systemctl list-unit-files',
      'systemctl list-timers --all',
      'systemctl list-sockets',
      'systemctl cat solv',
      'systemctl --user status x',
      'systemctl status solv*',
      'ss',
      'ss -tlnp',
      'ss -tulpn | grep 8899',
      'ss -s',
      'netstat -tulpn',
      'ip a',
      'ip addr',
      'ip address show',
      'ip -br a',
      'ip -4 addr show dev eth0',
      'ip link',
      'ip -s link show eth0',
      'ip route',
      'ip route get 1.1.1.1',
      'ip r show table main',
      'ip neigh',
      'ip rule show',
      'ip maddr',
      'ethtool eth0',
      'ethtool -i eth0',
      'ethtool -k eth0',
      'ethtool -g eth0',
      'ethtool -l eth0',
      'ethtool -S eth0',
      'ethtool -a eth0',
      'ethtool -c eth0',
      'ethtool -x eth0',
      'ethtool -T eth0',
    ])
    expectNotReadOnly([
      'top',
      'top -n 1',
      'top -o %CPU',
      'env FOO=1 ls',
      'env ls',
      'env -i ls',
      'printenv HOME',
      'ulimit -n 1000',
      'ulimit',
      'sysctl -w a=1',
      'sysctl -w kernel.hostname',
      'sysctl vm.swappiness=1',
      'sysctl -p',
      'sysctl -p /etc/sysctl.conf',
      'sysctl --system',
      'sysctl --load=x',
      'sysctl -f',
      'timedatectl set-time 12:00',
      'timedatectl set-timezone UTC',
      'timedatectl',
      'timedatectl status -H root@h',
      'timedatectl --host=root@h status',
      'timedatectl -Hroot@h status',
      'timedatectl -M c status',
      'chronyc makestep',
      'chronyc -a tracking',
      'chronyc -h host tracking',
      'chronyc',
      'dmesg -C',
      'dmesg --clear',
      'dmesg -c',
      'dmesg -D',
      'dmesg -E',
      'dmesg -n 1',
      'dmesg --console-level=1',
      'dmesg --read-clear',
      'journalctl --vacuum-time=1s',
      'journalctl --vacuum-size=1M',
      'journalctl --rotate',
      'journalctl --flush',
      'journalctl --sync',
      'journalctl --relinquish-var',
      'journalctl --setup-keys',
      'journalctl --update-catalog',
      'journalctl --cursor-file=x',
      'journalctl -H root@host',
      'journalctl -M c',
      'journalctl --host=h',
      'journalctl -u $UNIT',
      'systemctl restart solv',
      'systemctl start x',
      'systemctl stop x',
      'systemctl daemon-reload',
      'systemctl',
      'systemctl list-dependencies x',
      'systemctl show-environment',
      'systemctl -H root@h status x',
      'systemctl status x -H h',
      'systemctl status $UNIT',
      'ss -K',
      'ss --kill',
      'ss -D out',
      'ss --diag=out',
      'ip link set eth0 down',
      'ip addr add 1.2.3.4/24 dev eth0',
      'ip addr flush dev eth0',
      'ip route add x via y',
      'ip route del x',
      'ip neigh flush all',
      'ip -batch file',
      'ip -force addr',
      'ip addr show -j',
      'ip -n ns addr',
      'ip netns list',
      'ip tunnel show',
      'ip',
      'ethtool',
      'ethtool -K eth0 rx off',
      'ethtool -G eth0 rx 4096',
      'ethtool -L eth0 combined 8',
      'ethtool -A eth0 rx off',
      'ethtool -C eth0 rx-usecs 1',
      'ethtool -X eth0 equal 4',
      'ethtool -s eth0 speed 100',
      'ethtool -i',
      'ethtool -i eth0 eth1',
      'ethtool -r eth0',
      'ethtool -p eth0',
      'ethtool -t eth0',
      'lspci -q',
      'lspci -Q',
      'lspci -M',
      'lspci -xxx',
      'lspci -x -x',
      'pidstat -e echo hi',
      'pidstat -dre 1 1',
      'pidstat ${X:--e} echo',
      'lsof -D u',
      'lsof -Du',
      'lsof +D /tmp',
      'lsof ${X:--Du}',
      'lsof -i @host',
      'lsof +m',
      'lsof -e /x',
      'lsof -O',
      'nvme list',
      'smartctl -a /dev/nvme0',
      'mount',
      'dpkg -l',
      'ping -c 1 1.1.1.1',
      'nc -z host 1',
      'dig example.com',
      'host example.com',
      'nslookup example.com',
      'openssl version',
    ])
  },
)

readOnlyTest(
  'the node: solana, agave-validator and slv in the forms that only report',
  ({ expectReadOnly, expectNotReadOnly }) => {
    expectReadOnly([
      'solana --version',
      'solana -V',
      'solana --help',
      'solana',
      'solana balance',
      'solana balance 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
      'solana epoch-info',
      'solana catchup --our-localhost',
      'solana validators',
      'solana gossip',
      'solana slot',
      'solana cluster-version',
      'solana vote-account addr',
      'solana stake-account addr',
      'solana config get',
      'solana feature status',
      'solana --output json-compact epoch-info',
      'solana --commitment finalized slot',
      'solana-validator --version',
      'agave-validator --version',
      'agave-validator -V',
      'agave-validator --help',
      'agave-validator contact-info',
      'agave-validator monitor',
      'agave-validator -l /mnt/ledger contact-info',
      'agave-validator --ledger /mnt/ledger monitor',
      'agave-validator --ledger=/mnt/ledger monitor',
      'solana-validator -l /mnt/ledger monitor',
      'slv --version',
      'slv -V',
      'slv --help',
    ])
    expectNotReadOnly([
      'solana -u mainnet-beta balance',
      'solana --url x balance',
      'solana --url=x balance',
      'solana --ws x logs',
      'solana -k k.json balance',
      'solana --keypair k.json balance',
      'solana -C c.yml balance',
      'solana --config c.yml balance',
      'solana balance --fee-payer x',
      'solana balance --signer x',
      'solana account X -o /tmp/f',
      'solana account X -ofile',
      'solana account X --output-file /tmp/f',
      'solana account X --output-f /tmp/f',
      'solana transfer a 1',
      'solana airdrop 1',
      'solana config set --url x',
      'solana config set --commitment finalized',
      'solana ping',
      'solana program deploy x',
      'solana a-subcommand-nobody-knows',
      'solana-keygen new',
      'agave-validator exit',
      'agave-validator set-identity k',
      'agave-validator -l /x set-identity k',
      'agave-validator',
      'agave-validator monitor extra',
      'agave-validator contact-info --output json',
      'agave-validator -h',
      'agave-validator -l',
      'fdctl monitor',
      'fdctl --version',
      'firedancer',
      'slv v list',
      'slv v deploy',
      'slv',
      'slv --version extra',
      'slv check grpc',
    ])
  },
)

// ---------------------------------------------------------------------------
// The line around the programs
// ---------------------------------------------------------------------------

readOnlyTest(
  'a line is read-only only when nothing around its programs writes, runs or assigns',
  ({ expectReadOnly, expectNotReadOnly }) => {
    expectReadOnly([
      'ls | sort | uniq -c',
      'ls; echo done',
      'ls && echo ok || echo no',
      '(ls; echo)',
      '{ ls; echo; }',
      '{ ls; } 2>/dev/null',
      'ls 2>&1',
      'ls >&2',
      'ls 2>/dev/null',
      'ls &>/dev/null',
      'ls > /dev/null 2>&1',
      'ls >> /dev/null',
      'ls |& grep x',
      'cat < /etc/hosts',
      'cat <<< hello',
      'cat < ~/notes',
      'cat <&3',
      'cat <<EOF\nplain text\nEOF',
      "cat <<'EOF'\n$(date)\nEOF",
      'ls # a comment',
      'ls\nls',
      'ls -la "$HOME"',
      'ls $HOME',
      'echo ${HOME}',
      'echo ${HOME:-x}',
      'echo $? $$',
      'echo \'a b\' "c d"',
      'ls ~/x',
      'ls /var/log/*.log',
      'ls *.txt',
      'ls FOO=bar',
      'command -v ls',
      'true && false || true',
    ])
    expectNotReadOnly([
      // a substitution, an expansion that evaluates, arithmetic
      'echo $(date)',
      'echo `date`',
      'echo "$(date)"',
      'echo "`date`"',
      'cat <(ls)',
      'ls >(cat)',
      'echo ${x@P}',
      'echo ${!x}',
      'echo ${y:$x}',
      'echo $((1+2))',
      'echo $(( 2 * 3 ))',
      'echo $[1+2]',
      '(( 1 ))',
      'let x=1',
      'cat <<EOF\n$(date)\nEOF',
      // an assignment
      'x=1',
      'x=1; ls',
      'FOO=bar ls',
      'ls ${x:=1}',
      'ls ${x=1}',
      // a redirection that writes
      'ls > out',
      'ls >> out',
      'ls >| out',
      'ls &> out',
      'ls &>> out',
      'ls 2> out',
      'ls >& out',
      'ls <> out',
      'ls > "$X"',
      '{ ls; } > out',
      '(ls) > out',
      'cat <<EOF > out\nx\nEOF',
      'ls > /dev/stderr',
      'ls > /dev/tcp/example.com/80',
      'cat < /dev/tcp/example.com/80',
      'cat < /dev/udp/example.com/53',
      'cat < ${X:-/dev}/tcp/example.com/80',
      'cat < "$HOME/notes"',
      'cat <&$X',
      // a background job, a function, a program that runs or sources
      'ls & ls',
      'ls &',
      'f() { ls; }',
      'f() { ls; }; f',
      'function f { ls; }',
      'eval ls',
      'source x',
      '. x',
      'exec ls',
      'trap : EXIT',
      'alias l=ls',
      'builtin ls',
      'command ls',
      'command -V ls',
      'command -v',
      'command',
      // a command named by a path, an expansion or a pattern
      '/bin/ls',
      './ls',
      '~/bin/ls',
      'ls*',
      '$X',
      '"$X"',
      '${X}',
      '{ls,cat}',
      'l[s]',
      '?s',
      // compound commands and what the reader cannot follow
      'if true; then ls; fi',
      'for i in 1; do ls; done',
      'while true; do ls; done',
      'case x in x) ls;; esac',
      'time ls',
      '! ls',
      'echo "unterminated',
      'ls )',
      'ls \\',
      // names that an object would answer to
      'constructor',
      'toString',
      '__proto__',
      'hasOwnProperty x',
      // built-ins that are not on the list
      'cd /',
      'read x',
      'exit',
      'kill 1',
      'set -e',
      'export X=1',
      'wait',
      'jobs',
      'hash ls',
    ])
  },
)

readOnlyTest(
  'a value that the reader cannot take is not read-only',
  ({ isReadOnly }) => {
    for (const value of [undefined, null, 5, {}]) {
      const result = isReadOnly(value as unknown as string)
      assertFalse(result.readOnly)
      assert(result.reasons.length > 0)
    }
  },
)

readOnlyTest(
  'a line that is not read-only says what keeps it from being so',
  ({ isReadOnly }) => {
    const reasonsOf = (line: string): string =>
      isReadOnly(line).reasons.join(' | ')
    const cases: Array<[string, string]> = [
      ['touch x', 'touch is not a read-only program'],
      ['ls | sudo tee x', 'sudo is not a read-only program'],
      ['FOO=bar ls', 'an assignment'],
      ['x=1', 'an assignment'],
      ['./f', 'a command named by a path'],
      ['/bin/ls', 'a command named by a path'],
      ['$X', 'a command named by an expansion or a pattern'],
      ['ls > out', 'a redirection (>) that writes to out'],
      ['ls > "$X"', 'a file known only at run time'],
      ['cat < /dev/tcp/h/80', 'a redirection to the network'],
      ['echo $(date)', 'a command substitution'],
      ['cat <(ls)', 'a process substitution'],
      ['ls &', 'a command run in the background'],
      ['sort -o x in', 'sort -o'],
      ['sort $X', 'only known when the shell runs'],
      ['systemctl status x --bogus', 'an option the gate cannot read'],
      ['systemctl restart x', 'systemctl other than a verb that only reports'],
    ]
    for (const [line, expected] of cases) {
      const reasons = reasonsOf(line)
      assert(
        reasons.includes(expected),
        `${JSON.stringify(line)}: ${JSON.stringify(reasons)} lacks ${
          JSON.stringify(expected)
        }`,
      )
    }
  },
)
