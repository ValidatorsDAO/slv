import { Section } from '@/lib/articles'

export const docMenuData: Section[] = [
  {
    title: 'doc.nav.general.getting-started',
    route: '/doc/general/getting-started',
    items: [
      {
        title: 'doc.nav.testnet-validator.title',
        subItems: [
          {
            title: 'doc.nav.testnet-validator.quickstart',
            route: '/doc/testnet-validator/quickstart'
          },
          {
            title: 'doc.nav.testnet-validator.update',
            route: '/doc/testnet-validator/update'
          },
          {
            title: 'doc.nav.testnet-validator.migrate',
            route: '/doc/testnet-validator/migrate'
          }
        ]
      },
      {
        title: 'doc.nav.mainnet-validator.title',
        subItems: [
          {
            title: 'doc.nav.mainnet-validator.quickstart',
            route: '/doc/mainnet-validator/quickstart'
          },
          {
            title: 'doc.nav.mainnet-validator.update',
            route: '/doc/mainnet-validator/update'
          },
          {
            title: 'doc.nav.mainnet-validator.migrate',
            route: '/doc/mainnet-validator/migrate'
          },
          {
            title: 'doc.nav.mainnet-validator.relayer',
            route: '/doc/mainnet-validator/relayer'
          }
        ]
      },
      {
        title: 'doc.nav.mainnet-rpc.title',
        subItems: [
          {
            title: 'doc.nav.mainnet-rpc.quickstart',
            route: '/doc/mainnet-rpc/quickstart'
          },
          {
            title: 'doc.nav.mainnet-rpc.update',
            route: '/doc/mainnet-rpc/update'
          },
          {
            title: 'doc.nav.mainnet-rpc.jupiter',
            route: '/doc/mainnet-rpc/jupiter'
          }
        ]
      },
      {
        title: 'doc.nav.metal.title',
        subItems: [
          {
            title: 'doc.nav.metal.quickstart',
            route: '/doc/metal/quickstart'
          }
        ]
      },
      {
        title: 'doc.nav.geyser-grpc.title',
        subItems: [
          {
            title: 'doc.nav.geyser-grpc.test',
            route: '/doc/geyser-grpc/test'
          }
        ]
      },
      {
        title: 'doc.nav.shredstream.title',
        subItems: [
          {
            title: 'doc.nav.shredstream.test',
            route: '/doc/shredstream/test'
          }
        ]
      },
      {
        title: 'doc.nav.app.title',
        subItems: [
          {
            title: 'doc.nav.app.solana-dapp',
            route: '/doc/app/solana-dapp'
          },
          {
            title: 'doc.nav.app.web-ssg',
            route: '/doc/app/web-ssg'
          },
          {
            title: 'doc.nav.app.react-tailwind-email',
            route: '/doc/app/react-tailwind-email'
          }
        ]
      },
      {
        title: 'doc.nav.bot.title',
        subItems: [
          {
            title: 'doc.nav.bot.quickstart',
            route: '/doc/bot/quickstart'
          }
        ]
      }
    ]
  }
]
