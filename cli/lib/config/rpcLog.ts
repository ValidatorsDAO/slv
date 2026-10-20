import { colors } from '@cliffy/colors'
import { ERPC_DASHBOARD_URL } from '@cmn/constants/url.ts'

const loginLiners = (ansibleHosts: string[]) => {
  let contenxt = ''
  if (ansibleHosts.length === 1) {
    contenxt = `ssh solv@${ansibleHosts[0]}`
  } else {
    contenxt = ansibleHosts.map((ip) => `ssh solv@${ip}`).join('\n')
  }
  return contenxt
}

const rpcLog = (ansibleHosts = ['<your-node-ip>']) => {
  const monitorLog = `You can monitor your Node with the following steps:

Log in to your server with SSH:
${colors.white(loginLiners(ansibleHosts))}

Then, run the following command to monitor your node:
${colors.white(`$ solv m`)}`
  console.log(colors.yellow(monitorLog))
  console.log(
    colors.cyan(
      `Optional: run ${colors.white('slv login')} to sign in to ERPC in your browser.\n` +
        `Manage RPC API keys separately at ${colors.white(ERPC_DASHBOARD_URL)}.`,
    ),
  )
}

export default rpcLog
