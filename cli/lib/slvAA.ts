import { colors } from '@cliffy/colors'

const sk1 = (s: string) => colors.rgb24(s, 0xc44e52)
const sk2 = (s: string) => colors.rgb24(s, 0xd4756a)
const sk3 = (s: string) => colors.rgb24(s, 0xe8a87c)
const sk4 = (s: string) => colors.rgb24(s, 0xf0c88e)
const snow = (s: string) => colors.bold.rgb24(s, 0xffffff)
const fuji = (s: string) => colors.rgb24(s, 0x3d5a80)
const fujiD = (s: string) => colors.rgb24(s, 0x2c3e6b)
const moon = (s: string) => colors.bold.rgb24(s, 0xffeebb)
const pine = (s: string) => colors.rgb24(s, 0x2d5a27)
const pineD = (s: string) => colors.rgb24(s, 0x1a3a18)
const trunk = (s: string) => colors.rgb24(s, 0x8b5e3c)
const cloud = (s: string) => colors.rgb24(s, 0xe0d6c8)
const grn = (s: string) => colors.rgb24(s, 0x4a7c59)
const grnD = (s: string) => colors.rgb24(s, 0x355e3b)
const sea = (s: string) => colors.rgb24(s, 0x4a90a8)
const seaL = (s: string) => colors.rgb24(s, 0x6bb5c9)
const seaD = (s: string) => colors.rgb24(s, 0x2e6e82)
const sand = (s: string) => colors.rgb24(s, 0xc2956b)
const neko = (s: string) => colors.rgb24(s, 0xf0d870)
const star = (s: string) => colors.bold.rgb24(s, 0xffd700)
const shell = (s: string) => colors.bold.rgb24(s, 0xff69b4)

export const slvAA = (version: string) => {
  const header = `${colors.bold.rgb24(`Welcome to SLV v${version}`, 0x14f195)}
${
    colors.rgb24(
      '…………………………………………………………………………………………………………………………………………………………',
      0x555555,
    )
  }`

  const art = `
${header}
${sk1('     ')}${star('*')}${sk1('                    ')}${snow('▄▄')}${
    sk1('              ')
  }${moon('▄████▄')}${sk1('        ')}
${sk1('                        ')}${snow('▄████▄')}${sk1('            ')}${
    moon('██████')
  }${sk1('        ')}
${sk2('            ')}${star('*')}${sk2('         ')}${snow('▄██████▄')}${
    sk2('            ')
  }${moon('▀████▀')}${sk2('        ')}
${sk2('    ')}${pine('▄██▄')}${sk2('           ')}${snow('▄████')}${
    fuji('████')
  }${snow('██▄')}${sk2('                    ')}${star('*')}${sk2('   ')}
${sk3('     ')}${trunk('█')}${pine('▄███▄')}${sk3('      ')}${fuji('▄██')}${
    fujiD('████████████')
  }${fuji('▄')}${sk3('                       ')}
${sk3(' ')}${pine('▄███▄')}${trunk('█')}${sk3('    ')}${cloud('▄▄▄')}${
    sk3(' ')
  }${fuji('▄██')}${fujiD('████████████████')}${fuji('██▄')}${sk3('    ')}${
    cloud('▄▄▄')
  }${sk3('      ')}
${sk4('     ')}${trunk('█')}${pine('▄██▄')}${cloud('▀▀▀▀▀')}${
    fujiD('▄████████████████████████')
  }${fujiD('▄')}${cloud('▀▀▀▀▀▀')}${sk4('   ')}
${grn('▄▄▄▄')}${trunk('█')}${grnD('▄▄▄▄')}${
    fujiD('▄████████████████████████████')
  }${grnD('▄▄▄▄▄')}${grn('▄▄▄▄▄▄')}
${grn('████')}${trunk('█')}${grn('███')}${
    grnD('██████████████████████████████████████')
  }${grn('██████████')}
${sea('~~')}${seaL('~~~')}${sea('~~')}${seaL('~~~')}${sea('~~')}${seaL('~~~')}${
    sea('~~')
  }${seaL('~~~')}${sea('~~')}${seaL('~~~')}${sea('~~')}${seaL('~~~')}${
    sea('~~')
  }${seaL('~~~')}${sea('~~')}${seaL('~~~')}${sea('~~')}${seaL('~~')}${
    seaL('~~')
  }${seaL('~~')}${seaL('~~')}${seaL('~~')}${seaL('~~')}${seaL('~~')}
${seaD('~~')}${sea('~~~')}${seaD('~~')}${sea('~~~')}${seaD('~~')}${sea('~~~')}${
    seaD('~~')
  }${sea('~~~')}${seaD('~~')}${sea('~~~')}${seaD('~~')}${sea('~~~')}${
    seaD('~~')
  }${sea('~~~')}${seaD('~~')}${sea('~~~')}${seaD('~~')}${sea('~~')}${
    seaL('~~')
  }${seaL('~~')}${seaL('~~')}${seaL('~~')}${seaL('~~')}${seaL('~~')}
${sand('·:·.·:·')}${neko('▄█')}${sand('·····')}${neko('█▄')}${
    sand('·:·.·:·.·:·.·:·.·:·.·:·.·:·.·:·.·:·.·:·')
  }
${sand('·:·.·:·')}${neko('█████████')}${
    sand(':·.·:·.·:·.·:·.·:·.·:·.·:·.·:·.·:·.·:·.·')
  }
${sand('·:·.·:·')}${neko('██▄███▄██')}${sand(':·.·:·.·:·.·:·.·:·.·:·')}${
    shell('☆')
  }${sand('·')}${shell('@')}${sand('·:·.·:·.·:·')}
${sand('…………………')}${neko('█████████')}${
    sand('……………………………………………………………………………………………………………')
  }`

  console.log(art)
}

export const installClientMessage = () => {
  console.log(
    colors.bold.rgb24('\nSLV', 0x14f195) +
      colors.rgb24(' - Solana Validator Tool', 0xffffff),
  )

  const msg = `
${colors.yellow('$ slv metal product')}   - BareMetal Servers for Solana
${colors.yellow('$ slv storage product')} - Global Cloud Storage powered by R2

${colors.bold.underline('Quick Start:')}

$ slv validator init
$ slv validator deploy -n testnet

$ slv --help for more information
`
  console.log(colors.rgb24(msg, 0xffffff))
}
