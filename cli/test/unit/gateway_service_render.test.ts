import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { renderSystemdUnit } from '/src/gateway/service/systemd.ts'
import {
  LAUNCHD_LABEL,
  renderLaunchdPlist,
} from '/src/gateway/service/launchd.ts'

// Golden-ish tests for the generated unit/plist files. We don't snap
// the entire output (comment tweaks would be churn) — we assert the
// invariants that MATTER for the service manager to accept the file
// and for the gateway to run correctly under it.

const baseOpts = {
  execPath: '/usr/local/bin/slv',
  execArgs: ['gateway', 'run'],
  stdoutLog: '/home/u/.slv/gateway/logs/gateway.log',
  stderrLog: '/home/u/.slv/gateway/logs/gateway.err.log',
}

Deno.test('systemd unit: required sections + ExecStart + restart policy', () => {
  const unit = renderSystemdUnit(baseOpts)

  // Required sections
  assertStringIncludes(unit, '[Unit]')
  assertStringIncludes(unit, '[Service]')
  assertStringIncludes(unit, '[Install]')

  // ExecStart correctly quotes and sequences argv
  assertStringIncludes(unit, 'ExecStart=/usr/local/bin/slv gateway run')

  // Restart policy: always, but NOT on config error (78)
  assertStringIncludes(unit, 'Restart=always')
  assertStringIncludes(unit, 'RestartPreventExitStatus=78')

  // Log redirection uses the caller-supplied paths
  assertStringIncludes(
    unit,
    'StandardOutput=append:/home/u/.slv/gateway/logs/gateway.log',
  )
  assertStringIncludes(
    unit,
    'StandardError=append:/home/u/.slv/gateway/logs/gateway.err.log',
  )

  // User-target install — no system-level install
  assertStringIncludes(unit, 'WantedBy=default.target')

  // Kill behavior reaches tool-call shell children
  assertStringIncludes(unit, 'KillMode=control-group')
})

Deno.test('systemd unit: argv with spaces or shell chars is quoted', () => {
  const unit = renderSystemdUnit({
    ...baseOpts,
    execPath: '/opt/my apps/slv',
    execArgs: ['gateway', 'run'],
  })
  // The path-with-space must be wrapped so systemd's ExecStart
  // tokenizer keeps it as a single argument.
  assertStringIncludes(unit, 'ExecStart="/opt/my apps/slv" gateway run')
})

Deno.test('launchd plist: required keys + argv + log paths', () => {
  const plist = renderLaunchdPlist(baseOpts)

  // Plist envelope
  assertStringIncludes(plist, '<?xml version="1.0"')
  assertStringIncludes(plist, '<plist version="1.0">')

  // Label matches our exported constant (clients and uninstall
  // depend on the same value)
  assertStringIncludes(plist, `<string>${LAUNCHD_LABEL}</string>`)

  // ProgramArguments sequence
  assertStringIncludes(plist, '<string>/usr/local/bin/slv</string>')
  assertStringIncludes(plist, '<string>gateway</string>')
  assertStringIncludes(plist, '<string>run</string>')

  // RunAtLoad + KeepAlive — launchd boots + respawns us
  assertStringIncludes(plist, '<key>RunAtLoad</key>\n  <true/>')
  assertStringIncludes(plist, '<key>KeepAlive</key>\n  <true/>')

  // Log paths set
  assertStringIncludes(
    plist,
    '<string>/home/u/.slv/gateway/logs/gateway.log</string>',
  )
  assertStringIncludes(
    plist,
    '<string>/home/u/.slv/gateway/logs/gateway.err.log</string>',
  )
})

Deno.test('launchd plist: XML-escapes problematic chars in paths', () => {
  const plist = renderLaunchdPlist({
    ...baseOpts,
    stdoutLog: '/tmp/out & err <weird>.log',
  })
  // Ampersand must be &amp; to keep the plist parseable.
  assertStringIncludes(plist, '&amp;')
  assertStringIncludes(plist, '&lt;weird&gt;')
  // Raw unescaped forms must NOT appear inside the <string>.
  assert(!/\<string>[^<]*\&\ [^<]*\<\/string>/.test(plist))
})

Deno.test('launchd label is stable (clients + install/uninstall share)', () => {
  // Hard-assert to lock against accidental rename. A rename would
  // silently orphan existing installs.
  assertEquals(LAUNCHD_LABEL, 'global.slv.gateway')
})
