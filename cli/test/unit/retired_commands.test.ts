import { assert, assertFalse, assertRejects } from '@std/assert'
import { Command } from '@cliffy'
import { validatorCmd } from '@/validator/index.ts'
import { rpcCmd } from '@/rpc/index.ts'

const retired = [
  'setup:doublezero',
  'doublezero:keygen',
  'doublezero:connect',
  'doublezero:disconnect',
  'doublezero:start',
  'doublezero:stop',
  'doublezero:status',
  'doublezero:update',
  'doublezero:publish',
  'doublezero:deposit',
  'doublezero:withdraw',
]

Deno.test('validator and RPC help omit DoubleZero and all aliases reject its retired operations', async () => {
  const cli = new Command().name('slv').noExit()
  cli.command('validator', validatorCmd).alias('v')
  cli.command('rpc', rpcCmd).alias('r')

  for (const group of [validatorCmd, rpcCmd]) {
    assert(group.getCommand('deploy'))
    assert(group.getCommand('init'))
    assert(group.getCommand('patch:sha256'))
    // Assert absence before parsing so a regression cannot run a node action.
    for (const verb of retired) assertFalse(Boolean(group.getCommand(verb)))
  }
  for (const namespace of ['validator', 'v', 'rpc', 'r']) {
    for (const verb of retired) {
      await assertRejects(
        () => cli.parse([namespace, verb]),
        Error,
        'Unknown command',
      )
    }
  }
  for (const group of [validatorCmd, rpcCmd]) {
    assertFalse(/doublezero/i.test(group.getHelp()))
  }
})
