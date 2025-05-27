import fs from 'fs'
import { glob } from 'glob'
import { join } from 'path'
import matter from 'gray-matter'
import { uniqueArray, truncateContent } from './utils'
import { locales } from '@/app/config'
import appInfo from '@appInfo'
import { getTranslations } from 'next-intl/server'

type Items = {
  [key: string]: string | string[]
}

export const getArticleBySlug = (
  slugArray: string[],
  fields: string[] = [],
  articleDirPrefix: string,
  locale: string
) => {
  const articlesDirectory = join(
    process.cwd(),
    `articles/${articleDirPrefix}/${locale}`
  )
  const matchedSlug = slugArray.join('/')
  const realSlug = matchedSlug.replace(/\.md$/, '')
  const fullPath = join(articlesDirectory, `${realSlug}.md`)
  const fileContents = fs.readFileSync(fullPath, 'utf8')
  const { data, content } = matter(fileContents)

  const items: Items = {}

  fields.forEach((field) => {
    if (field === 'content') {
      items[field] = content
    }

    if (field === 'date') {
      const date = slugArray[0] + '.' + slugArray[1] + '.' + slugArray[2]
      items[field] = date
    }

    if (data[field]) {
      items[field] = data[field]
    }
  })

  return items
}

export const getArticleContentByPath = (pathname: string) => {
  const articlePath = join(process.cwd(), pathname)

  const fileContents = fs.readFileSync(articlePath, 'utf8')
  const { content } = matter(fileContents)

  return content
}

export const getAllArticles = (articleDirPrefix: string) => {
  const entries = glob.sync(`articles/${articleDirPrefix}/**/*.md`)

  const slugs = entries
    .map((file) => file.split(articleDirPrefix).pop())
    .map((slug) => {
      const parts = (slug as string).replace(/\.md$/, '').split('/')
      parts.shift()
      parts.shift()
      return parts
    })
    .filter((slug) => slug.length > 0)

  return uniqueArray(slugs)
}

export type ArticlePageProps = {
  params: Promise<{
    locale: string
    slug: string[]
  }>
}

export const getDataForArticlePageByGroupDir = (groupDir: string) => {
  return {
    generateMetadata: async ({ params }: ArticlePageProps) => {
      const { locale, slug } = await params

      const metadata = getArticleBySlug(
        slug,
        ['title', 'thumbnail', 'content'],
        groupDir,
        locale
      )
      // Might be created wrong type. It's working.
      // @ts-ignore
      const t = await getTranslations({
        locale,
        namespaces: [groupDir, 'metadata']
      })

      const description = truncateContent(metadata.content, 160)
      const thumbnail = metadata.thumbnail
      const title = `${metadata.title} | ${t('metadata.appTitle')}`
      return {
        title,
        metadataBase: new URL(
          process.env.NODE_ENV === 'production'
            ? `https://${appInfo.domain}`
            : 'http://localhost:4242'
        ),
        generator: appInfo.copyright,
        keywords: t('metadata.keywords'),
        applicationName: t('metadata.appTitle'),
        description,
        alternates: {
          canonical: `https://${appInfo.domain}/${locale}/${groupDir}/${slug.join('/')}/`,
          languages: locales.reduce(
            (acc, lang) => {
              acc[lang] =
                `https://${appInfo.domain}/${lang}/${groupDir}/${slug.join('/')}/`
              return acc
            },
            {} as Record<string, string>
          )
        },
        openGraph: {
          title,
          description,
          locale,
          type: 'website',
          images: [
            thumbnail ??
              new URL(
                process.env.NODE_ENV === 'production'
                  ? `https://${appInfo.domain}/opengraph-image.jpg`
                  : 'http://localhost:4242/opengraph-image.jpg'
              )
          ]
        },
        twitter: {
          card: 'summary_large_image',
          title,
          description,
          creator: appInfo.twitterId,
          site: appInfo.twitterId,
          images: [
            thumbnail ??
              new URL(
                process.env.NODE_ENV === 'production'
                  ? `https://${appInfo.domain}/twitter-image.jpg`
                  : 'http://localhost:4242/twitter-image.jpg'
              )
          ]
        },
        robots: {
          index: true,
          follow: true
        }
      }
    },
    generateStaticParams: () => {
      const paths = locales.flatMap((locale) => {
        const articles = getAllArticles(groupDir)

        return articles.map((slug) => ({
          locale,
          slug
        }))
      })
      return paths
    },
    getArticlePaths: () => {
      const articles = getAllArticles(groupDir)
      return articles.map((slug) => `/${slug.join('/')}`)
    }
  }
}

export type ArticleData = { article: Items; url: string }

export const getArticleForIndex = (
  groupDir: string,
  matterArray: string[],
  locale: string
): ArticleData[] => {
  let slugs: string[][] = getAllArticles(groupDir)

  if (groupDir === 'news') {
    slugs = slugs.sort((a, b) => {
      const dateA = new Date(`${a[0]}-${a[1]}-${a[2]}`)
      const dateB = new Date(`${b[0]}-${b[1]}-${b[2]}`)
      return dateB.getTime() - dateA.getTime()
    })
  }

  const articles = slugs.map((slug) =>
    getArticleBySlug(slug, matterArray, groupDir, locale)
  )

  const urls = slugs.map((slug) => `/${groupDir}/${slug.join('/')}`)

  return articles.map((article, index) => ({
    article,
    url: urls[index]
  }))
}

export type SubItem = {
  title: string
  route: string
}

export type Item = {
  title: string
  route?: string
  subItems?: SubItem[]
}

export type Section = {
  title: string
  route: string
  items?: Item[]
}

export const getAllRoutes = (menuData: Section[]) => {
  const routes: string[] = []

  const collectRoutes = (items: any[]) => {
    items.forEach((item) => {
      if (item.route) {
        routes.push(item.route)
      }
      if (item.items) {
        collectRoutes(item.items)
      }
      if (item.subItems) {
        collectRoutes(item.subItems)
      }
    })
  }

  collectRoutes(menuData)

  return routes
}
