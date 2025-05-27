'use client'

import '@solana/wallet-adapter-react-ui/styles.css'
import { ReactNode, useCallback, useMemo } from 'react'
import {
  ConnectionProvider,
  WalletProvider
} from '@solana/wallet-adapter-react'
import { WalletAdapterNetwork, WalletError } from '@solana/wallet-adapter-base'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'

import type { Adapter } from '@solana/wallet-adapter-base'
import { toast } from 'sonner'
import { ExclamationTriangleIcon } from '@radix-ui/react-icons'

type Props = {
  children: ReactNode
}

export const solanaNetwork = WalletAdapterNetwork.Mainnet
export const solanaEndpoint =
  process.env.NEXT_PUBLIC_SOLANA_ENDPOINT ??
  'https://api.mainnet-beta.solana.com'

export default function SolanaWalletProvider({ children }: Props) {
  const wallets = useMemo(() => [], [])

  const onError = useCallback(
    (error: WalletError) => {
      if (
        !error.message.includes('user rejected the request.') &&
        !error.message.includes('User rejected the request.')
      ) {
        toast(error.name, {
          description: error.message,
          icon: <ExclamationTriangleIcon />
        })
        console.error(error)
      }
    },
    []
  )

  const autoConnect = useCallback(
    async (adapter: Adapter) => {
      adapter.autoConnect().catch(async (e) => {
        if (e instanceof Error) {
          if (
            !e.message.includes('user rejected the request.') &&
            !e.message.includes('User rejected the request.')
          ) {
            toast(e.name, {
              description: e.message,
              icon: <ExclamationTriangleIcon />
            })
          }
        }
      })
      return false
    },
    []
  )

  return (
    <>
      <ConnectionProvider
        endpoint={solanaEndpoint}
        config={{ commitment: 'finalized' }}
      >
        <WalletProvider
          wallets={wallets}
          onError={onError}
          autoConnect={autoConnect}
        >
          {/* Might be created wrong type. It's working. */}
          {/* @ts-ignore */}
          <WalletModalProvider>{children}</WalletModalProvider>
        </WalletProvider>
      </ConnectionProvider>
    </>
  )
}
