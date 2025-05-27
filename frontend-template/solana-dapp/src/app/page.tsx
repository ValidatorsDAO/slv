import { getTranslations } from 'next-intl/server'
import { defaultLocale, locales } from '@/app/config'
import appInfo from '@appInfo'
import { redirect } from 'next/navigation'

export async function generateMetadata() {
  const locale = defaultLocale
  const jsonNamespaces = ['(home)']

  // Might be created wrong type. It's working.
  // @ts-ignore
  const t = await getTranslations({
    locale,
    namespaces: [...jsonNamespaces, 'metadata']
  })

  return {
    title: `${t('(home).title') || t('metadata.defaultTitle')} | ${t('metadata.appTitle')}`,
    metadataBase: new URL(
      process.env.NODE_ENV === 'production'
        ? `https://${appInfo.domain}`
        : 'http://localhost:4242'
    ),
    generator: appInfo.copyright,
    keywords: t('metadata.keywords'),
    applicationName: t('metadata.appTitle'),
    description: `${t('(home).description') || t('metadata.defaultDescription')}`,
    alternates: {
      languages: locales.reduce(
        (acc, lang) => {
          acc[lang] = `https://${appInfo.domain}/${lang}`
          return acc
        },
        {} as Record<string, string>
      )
    },
    openGraph: {
      title: `${t('(home).title')} | ${t('metadata.appTitle')}`,
      description: `${t('(home).description')}`,
      url: `https://${appInfo.domain}`,
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
      title: `${t('(home).title')} | ${t('metadata.appTitle')}`,
      description: `${t('(home).description')}`,
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
      index: false,
      follow: true
    }
  }
}

export default function RootPage() {
  redirect(`/${defaultLocale}`)
}
