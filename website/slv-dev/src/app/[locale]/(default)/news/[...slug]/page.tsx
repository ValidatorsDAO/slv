import { setRequestLocale } from 'next-intl/server'
import {
  ArticlePageProps,
  getArticleBySlug,
  getArticleForIndex,
  getDataForArticlePageByGroupDir
} from '@/lib/articles'
import NewsMobileHeader from '../NewsMobileHeader'
import ScrollSyncToc from '@/components/articles/ScrollSyncToc'
import { cn } from '@/lib/utils'
import ArticleContents from '@/components/articles/ArticleContents'
import Image from 'next/image'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import ArticleIndex from '@/components/articles/ArticleIndex'
import ArticlePager from '@/components/articles/ArticlePager'
import { getPagerData } from '@/lib/getPagerData'
import VideoJsonLd from '@/components/articles/VideoJsonLd'

const groupDir = 'news'
const { generateMetadata, generateStaticParams, getArticlePaths } =
  getDataForArticlePageByGroupDir(groupDir)
export { generateMetadata, generateStaticParams }

export default async function NewsArticlePage({ params }: ArticlePageProps) {
  const { locale, slug } = await params
  setRequestLocale(locale)
  const articleData = getArticleBySlug(
    slug,
    ['title', 'category', 'thumbnail', 'date', 'content'],
    groupDir,
    locale
  )
  const articlesData = getArticleForIndex(
    groupDir,
    ['title', 'thumbnail', 'date'],
    locale
  )
  const pagerData = getPagerData({
    slug,
    groupDir,
    locale,
    articlePaths: getArticlePaths()
  })

  const { title, content, thumbnail, date } = articleData as {
    title: string
    content: string
    thumbnail: string
    date: string
  }

  return (
    <>
      <VideoJsonLd content={content} title={title} date={date} />
      <NewsMobileHeader articleTitle={title} articleContent={content} />
      <div className="mx-auto max-w-4xl p-3 py-8 pt-24 text-center">
        <time
          dateTime={articleData.date as string}
          className="text-zinc-500 dark:text-zinc-400"
        >
          {articleData.date}
        </time>
        <h1 className="py-6 text-4xl font-medium tracking-tight md:text-5xl">
          {articleData.title}
        </h1>
      </div>
      <div className="mx-auto max-w-5xl p-3 md:py-6">
        {/* Might be created wrong type. It's working. */}
        {/* @ts-ignore */}
        <AspectRatio ratio={16 / 9}>
          <Image
            src={thumbnail}
            unoptimized
            width={160}
            height={90}
            alt={date}
            className="w-full rounded-xl"
          />
        </AspectRatio>
      </div>
      <div className="mx-auto max-w-4xl p-3">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="p-4 md:col-span-2">
            <ArticleContents content={content} />
            <div className="my-16">
              <ArticlePager pagerData={pagerData} />
            </div>
          </div>
          <div className="max-h-full p-4 md:col-span-1">
            <div
              className={cn(
                'scrollbar-thumb-rounded-full scrollbar-track-rounded-full scrollbar-thin scrollbar-track-white scrollbar-thumb-zinc-300 dark:scrollbar-track-zinc-950 dark:scrollbar-thumb-zinc-600 overflow-auto',
                'hidden max-h-[calc(100vh-10rem)] md:sticky md:top-32 md:block'
              )}
            >
              <ScrollSyncToc rawMarkdownBody={content} />
            </div>
          </div>
        </div>
      </div>
      <div className="my-16">
        <ArticleIndex articlesData={articlesData} showItemsNum={3} />
      </div>
    </>
  )
}
