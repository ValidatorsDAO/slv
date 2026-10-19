import { assertEquals, assertNotEquals } from '@std/assert'
import { Command } from '@cliffy'
import { registerKeylessCommands } from '/src/validator/keys/register.ts'

const registered = (): Command => {
  const parent = new Command()
  registerKeylessCommands(parent)
  return parent
}

const flagsOf = (parent: Command, name: string): string[] =>
  parent.getCommand(name)!.getOptions().flatMap((option) => option.flags)

Deno.test('keys:gen, keys:import, keys:check, keys:try and hosts:pin are added to a command with the options an operator types, and nothing else is added', () => {
  const parent = registered()
  assertEquals(
    parent.getCommands().map((command) => command.getName()).sort(),
    ['hosts:pin', 'keys:check', 'keys:gen', 'keys:import', 'keys:try'],
  )
  assertEquals(flagsOf(parent, 'keys:gen').filter((f) => !f.startsWith('-h')), [
    '-n',
    '--network',
    '--title',
  ])
  assertEquals(
    flagsOf(parent, 'keys:import').filter((f) => !f.startsWith('-h')),
    [
      '-n',
      '--network',
      '-p',
      '--pubkey',
      '--file',
    ],
  )
  assertEquals(
    flagsOf(parent, 'keys:check').filter((f) => !f.startsWith('-h')),
    [
      '-n',
      '--network',
      '-p',
      '--host',
      '--ref',
      '--pubkey',
    ],
  )
  assertEquals(flagsOf(parent, 'keys:try').filter((f) => !f.startsWith('-h')), [
    '-n',
    '--network',
    '-p',
    '--pubkey',
    '--ref',
  ])
  assertEquals(
    flagsOf(parent, 'hosts:pin').filter((f) => !f.startsWith('-h')),
    [
      '-n',
      '--network',
      '-p',
      '--pubkey',
    ],
  )
  // The network defaults to testnet in every one of them.
  for (
    const name of [
      'keys:gen',
      'keys:import',
      'keys:check',
      'keys:try',
      'hosts:pin',
    ]
  ) {
    const network = parent.getCommand(name)!.getOptions().find((option) =>
      option.name === 'network'
    )
    assertNotEquals(network, undefined, name)
    assertEquals(network!.default, 'testnet', name)
  }
})
