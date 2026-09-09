import { colors } from '@cliffy/colors'
import { ERPC_DASHBOARD_URL } from '/lib/slvCloudMcp.ts'

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
  const lighting = `${colors.yellow('⚡️⚡️⚡️')}`
  const msg = `${
    colors.blue(
      `${lighting} Enhanced Solana RPC Connection API Key ${lighting}`,
    )
  }

Create your API key on the ERPC dashboard:

${colors.white(ERPC_DASHBOARD_URL)}

Then run ${colors.white(`$ slv login`)} to save it on this machine 🚀
`
  console.log(colors.cyan(msg))
  const monitorLog = `You can monitor your Node with the following steps:

Log in to your server with SSH:
${colors.white(loginLiners(ansibleHosts))}

Then, run the following command to monitor your node:
${colors.white(`$ solv m`)}`
  console.log(colors.yellow(monitorLog))
}

export default rpcLog
