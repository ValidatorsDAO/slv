'use client'

import { CaretDownIcon } from '@radix-ui/react-icons'
import { Button } from '@/components/ui/button'

import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger
} from '@/components/ui/sheet'
import LogoHorizontalLink from '@/components/common/LogoHorizontalLink'
import { useTranslations } from 'next-intl'

import { useState } from 'react'
import { DiscordIconLink, TwitterIconLink } from '@/components/common/icons'
import ScrollSyncToc from '@/components/articles/ScrollSyncToc'
import { LanguageToggle } from '../config/LanguageToggle'
import { VisuallyHidden } from '@radix-ui/react-visually-hidden'

type Props = {
  articleContent: string
}

export default function TocMenuModalNav({ articleContent }: Props) {
  const [open, setOpen] = useState(false)
  const t = useTranslations()

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 md:hidden"
            onClick={() => setOpen(true)}
            aria-label={t('common.toggleNavigationMenu')}
          >
            <span className="text-xs">{t('common.toc')}</span>
            <CaretDownIcon className="h-5 w-5" />
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
            <ScrollSyncToc
              rawMarkdownBody={articleContent}
              modalFunction={setOpen}
            />
          </nav>
          <div className="mt-auto">
            <div className="flex flex-row items-center gap-3">
              <LanguageToggle />
              <TwitterIconLink />
              <DiscordIconLink />
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
