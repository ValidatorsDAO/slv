'use client'
import { cn } from '@/lib/utils'
import { useShowHeader } from '@/hooks/utils/useShowHeader'
import DocMenuModalNav from './DocMenuModalNav'
import TocMenuModalNav from '@/components/articles/TocMenuModalNav'

type Props = {
  articleContent: string
}

export default function DocMobileHeader({ articleContent }: Props) {
  const showHeader = useShowHeader()

  return (
    <>
      <div
        className={cn(
          'sticky top-16 z-10 -mt-8 mb-8 flex w-full flex-row gap-10 border-t border-b border-zinc-200 bg-white/60 px-6 py-2 backdrop-blur-xl transition-transform duration-300 ease-in-out lg:hidden dark:border-zinc-500 dark:bg-zinc-950/40',
          showHeader ? 'translate-y-0' : '-translate-y-96'
        )}
      >
        <div>
          <DocMenuModalNav />
        </div>
        <div className="flex flex-grow" />
        <div className="md:hidden">
          <TocMenuModalNav articleContent={articleContent} />
        </div>
      </div>
    </>
  )
}
