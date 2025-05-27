import { getTranslations } from 'next-intl/server'
import { locales } from '@/app/config'
import appInfo from '@appInfo'

export type PageProps = {
  params: Promise<{
    locale: string
  }>
}

export type CreateMetadataProps = {
  locale: string
  jsonNamespaces: string[]
  pathname: string
}

export async function createMetadata({
  locale,
  jsonNamespaces,
  pathname
}: CreateMetadataProps) {
  // Might be created wrong type. It's working.
  // @ts-ignore
  const t = await getTranslations({
    locale,
    namespaces: [...jsonNamespaces, 'metadata']
  })

  return {
    title: `${t(`${jsonNamespaces[0]}.title`) || `${t('metadata.defaultTitle')}`} | ${t(`metadata.appTitle`)}`,
    metadataBase: new URL(
      process.env.NODE_ENV === 'production'
        ? `https://${appInfo.domain}`
        : 'http://localhost:4242'
    ),
    generator: appInfo.copyright,
    keywords: t('metadata.keywords'),
    applicationName: t('metadata.appTitle'),
    description: `${t(`${jsonNamespaces[0]}.description`) ?? t('metadata.defaultDescription')}`,
    alternates: {
      canonical: `https://${appInfo.domain}/${locale}${pathname}`,
      languages: locales.reduce(
        (acc, lang) => {
          acc[lang] = `https://${appInfo.domain}/${lang}${pathname}`
          return acc
        },
        {} as Record<string, string>
      )
    },
    openGraph: {
      title: `${t(`${jsonNamespaces[0]}.title`)} | ${t(`metadata.appTitle`)}`,
      description: `${t(`${jsonNamespaces[0]}.description`)}`,
      locale,
      type: 'website',
      images: [
        new URL(
          process.env.NODE_ENV === 'production'
            ? `https://${appInfo.domain}/opengraph-image.jpg`
            : 'http://localhost:4242/opengraph-image.jpg'
        )
      ]
    },
    twitter: {
      card: 'summary_large_image',
      title: `${t(`${jsonNamespaces[0]}.title`)} | ${t(`metadata.appTitle`)}`,
      description: `${t(`${jsonNamespaces[0]}.description`)}`,
      creator: appInfo.twitterId,
      site: appInfo.twitterId,
      images: [
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
}
