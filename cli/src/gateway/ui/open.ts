import { colors } from '@cliffy/colors'
import { loadGatewayConfig } from '/src/gateway/config.ts'
import { errToString } from '/lib/errToString.ts'

/**
 * Open the browser-based SLV Chat UI at
 * `http://127.0.0.1:<port>/ui/`. On macOS uses `open`, on Linux
 * uses `xdg-open`; if neither is available we print the URL so
 * the user can paste it themselves. No failure is fatal — the
 * point is ergonomics, not correctness.
 */
export const openUiAction = async (): Promise<boolean> => {
  let cfg
  try {
    cfg = await loadGatewayConfig()
  } catch (err) {
    console.error(
      colors.red(
        `❌ gateway config not found — run \`slv gateway start\` first (${
          errToString(err)
        })`,
      ),
    )
    return false
  }
  const url = `http://127.0.0.1:${cfg.port}/ui/`
  console.log(colors.gray(`→ ${url}`))

  const launcher = Deno.build.os === 'darwin'
    ? 'open'
    : Deno.build.os === 'linux'
    ? 'xdg-open'
    : null
  if (!launcher) {
    console.log(
      colors.yellow(
        '  Open the URL above in your browser (auto-launch not supported on this OS).',
      ),
    )
    return true
  }
  try {
    const child = new Deno.Command(launcher, {
      args: [url],
      stdin: 'null',
      stdout: 'null',
      stderr: 'piped',
    }).spawn()
    const result = await child.output()
    if (!result.success) {
      console.log(
        colors.yellow(
          `  Couldn't auto-launch the browser (${launcher} exit ${result.code}). Open the URL above manually.`,
        ),
      )
    }
  } catch (err) {
    console.log(
      colors.yellow(
        `  Couldn't auto-launch the browser: ${errToString(err)}. Open the URL above manually.`,
      ),
    )
  }
  return true
}
