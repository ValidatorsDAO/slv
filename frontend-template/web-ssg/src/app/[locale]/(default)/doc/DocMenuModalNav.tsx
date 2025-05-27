'use client'

import { ListBulletIcon } from '@radix-ui/react-icons'
import { Button } from '@/components/ui/button'
import { usePathname } from '@/i18n/routing'

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger
} from '@/components/ui/sheet'
import LogoHorizontalLink from '@/components/common/LogoHorizontalLink'
import { useTranslations } from 'next-intl'

import { useEffect, useState } from 'react'
import {
  DiscordIconLink,
  GitHubLink,
  TwitterIconLink
} from '@/components/common/icons'
import DocMenu from './DocMenu'
import { LanguageToggle } from '@/components/config/LanguageToggle'

export default function DocMenuModalNav() {
  const [open, setOpen] = useState(false)
  const t = useTranslations()
  const pathname = usePathname()
  useEffect(() => {
    setOpen(false)
  }, [pathname])

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 lg:hidden"
            onClick={() => setOpen(true)}
            aria-label={t('common.toggleNavigationMenu')}
          >
            <ListBulletIcon className="h-5 w-5" />
            <span className="ml-1 text-xs">{t('doc.nav.title')}</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="top" className="flex h-screen flex-col p-5">
          <SheetTitle className="sr-only">
            {t('common.navigationMenu')}
          </SheetTitle>
          <nav className="grid gap-2 text-lg font-medium">
            <div className="mb-6 flex flex-row items-start">
              <LogoHorizontalLink
                className="w-24"
                onClick={() => {
                  setOpen(false)
                }}
              />
            </div>
            <p className="text-xs">{t('doc.nav.title')}</p>
            <DocMenu />
          </nav>
          <div className="mt-auto">
            <div className="flex flex-row items-center gap-3">
              <LanguageToggle />
              <GitHubLink />
              <TwitterIconLink />
              <DiscordIconLink />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
