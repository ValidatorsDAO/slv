import { colors } from '@cliffy/colors'
import { pickGatewayService } from '/src/gateway/service/pick.ts'
import { errToString } from '/lib/errToString.ts'

type Verb = 'start' | 'stop' | 'restart'
// English doubles the final consonant for stop→stopping (CVC rule) but
// not for start/restart (both end in consonant clusters). Explicit table
// keeps this out of the hot path.
const verbToIng: Record<Verb, string> = {
  start: 'starting',
  stop: 'stopping',
  restart: 'restarting',
}
const verbToPast: Record<Verb, string> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
}

export const runLifecycle = async (verb: Verb): Promise<boolean> => {
  let service
  try {
    service = pickGatewayService()
  } catch (err) {
    console.error(colors.red(`❌ ${errToString(err)}`))
    return false
  }
  console.log(
    colors.cyan(`⚙️  ${verbToIng[verb]} gateway via ${service.name}...`),
  )
  try {
    await service[verb]()
  } catch (err) {
    console.error(colors.red(`❌ ${verb} failed: ${errToString(err)}`))
    console.error(
      colors.white(
        `   Run 'slv gateway install' first if this is a fresh machine.`,
      ),
    )
    return false
  }
  console.log(colors.green(`✅ gateway ${verbToPast[verb]}`))
  return true
}
