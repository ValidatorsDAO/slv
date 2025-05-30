import { Command } from '@cliffy'
import { colors } from '@cliffy/colors'
import { exec } from '@elsoul/child-process'

const text = `Get Command`

export const getCmd = new Command()
  .description(text)
  .action(function () {
    this.showHelp()
    return
  })
  .command('ip', 'IP - 📡 Get Local')
  .action(async () => {
    const cmd = `curl ipinfo.io/ip`
    const ip = await exec(cmd)
    console.log(colors.white(`${ip.message.trim()}`))
    return
  })
