import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkSlug from 'remark-slug'
import ReactMarkdown from 'react-markdown'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { Pluggable } from 'unified'
import { CodeBlock } from './CodeBlock'
import { cn, getYouTubeVideoId, isYouTubeUrl } from '@/lib/utils'
import Image from 'next/image'
import { Link } from '@/i18n/routing'
import { locales } from '@/app/config'

type Props = {
  content: string
}

export default function ArticleContents({ content }: Props) {
  return (
    <>
      <div className="prose dark:prose-invert my-8 w-full break-words">
        {/* Might be created wrong type. It's working. */}
        {/* @ts-ignore */}
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath, remarkSlug as Pluggable]}
          components={{
            h1({ children, ...props }) {
              return (
                <h1 className="tracking-tight" id={props.id}>
                  {children as React.ReactNode}
                </h1>
              )
            },
            h2({ children, ...props }) {
              return (
                <h2 className="tracking-tight" id={props.id}>
                  {children as React.ReactNode}
                </h2>
              )
            },
            h3({ children, ...props }) {
              return (
                <h3 className="tracking-tight" id={props.id}>
                  {children as React.ReactNode}
                </h3>
              )
            },
            h4({ children, ...props }) {
              return (
                <h4 className="tracking-tight" id={props.id}>
                  {children as React.ReactNode}
                </h4>
              )
            },

            img({ children, ...props }) {
              return (
                <>
                  <Image
                    className="mt-4 mb-6 rounded-lg"
                    alt={props.alt as string}
                    src={props.src as string}
                    width={1600}
                    height={900}
                  />
                </>
              )
            },
            p({ children }) {
              {/* Might be created wrong type. It's working. */}
              {/* @ts-ignore */}
              return <div className="my-4">{children}</div>
            },
            div({ children }) {
              {/* Might be created wrong type. It's working. */}
              {/* @ts-ignore */}
              return <div className="my-4">{children}</div>
            },
            a({ children, href, ...props }) {
              if (!href) return null
              const isYouTube = isYouTubeUrl(href)
              const videoId = getYouTubeVideoId(href)
              if (isYouTube && videoId) {
                return (
                  <>
                    {/* Might be created wrong type. It's working. */}
                    {/* @ts-ignore */}
                    <AspectRatio ratio={16 / 9}>
                      <iframe
                        src={`https://www.youtube.com/embed/${videoId}`}
                        allowFullScreen
                        className="h-full w-full rounded-xl object-cover"
                      />
                    </AspectRatio>
                  </>
                )
              }

              const localeRegex = new RegExp(`^/(${locales.join('|')})(?=/|$)`)
              const processedHref = localeRegex.test(href)
                ? href.replace(localeRegex, '')
                : href

              return (
                <Link
                  className="underline hover:opacity-70"
                  id={props.id}
                  href={processedHref}
                  target={
                    processedHref.startsWith('http') ? '_blank' : undefined
                  }
                  rel={
                    processedHref.startsWith('http')
                      ? 'noopener noreferrer'
                      : undefined
                  }
                >
                  {children as React.ReactNode}
                </Link>
              )
            },

            code({ node, className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '')
              const fileMatch = /:(.*)/.exec(className || '')

              if (!match) {
                return (
                  <code
                    className={cn(
                      className,
                      `rounded-sm bg-zinc-100 px-1.5 py-1 dark:bg-zinc-700`
                    )}
                    {...props}
                  >
                    {/* Might be created wrong type. It's working. */}
                    {/* @ts-ignore */}
                    {children}
                  </code>
                )
              }
              {/* Might be created wrong type. It's working. */}
              return (
                // @ts-ignore
                <CodeBlock
                  key={Math.random()}
                  language={(match && match[1]) || ''}
                  fileName={(fileMatch && fileMatch[1]) || ''}
                  value={String(children).replace(/\n$/, '')}
                  {...props}
                />
              )
            }
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </>
  )
}
