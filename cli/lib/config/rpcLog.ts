import { colors } from '@cliffy/colors'

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

We're excited to offer a free API key exclusively for the Validators DAO community 🎉
It's our way of supporting the community and empowering you with fast, reliable connections.

To get your Free API key, simply join us through the link below:

Validators DAO: ${colors.white('`https://discord.gg/X4BgkBHavp`')}

Unlock fast connections and elevate your experience with your very own API key 🚀
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
