import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkSlug from 'remark-slug'
import ReactMarkdown from 'react-markdown'
import { AspectRatio } from '@/components/ui/aspect-ratio'
import { Pluggable } from 'unified'
import { CodeBlock } from './CodeBlock'
import { cn, getYouTubeVideoId, isYouTubeUrl } from '@/lib/utils'
import Image from 'next/image'

type Props = {
  content: string
}

export default function ArticleContents({ content }: Props) {
  return (
    <>
      <div className="prose dark:prose-invert my-8 w-full break-words">
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
              return <div className="my-4">{children}</div>
            },
            div({ children }) {
              return <div className="my-4">{children}</div>
            },
            a({ children, href, ...props }) {
              if (!href) return null
              const isYouTube = isYouTubeUrl(href)
              const videoId = getYouTubeVideoId(href)
              if (isYouTube && videoId) {
                return (
                  <>
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

              return (
                <a
                  className="underline hover:opacity-70"
                  id={props.id}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {children as React.ReactNode}
                </a>
              )
            },

            code({ node, className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '')
              const fileMatch = /:(.*)/.exec(className || '')

              if (!match) {
                return (
                  <code className={cn(className)} {...props}>
                    {children}
                  </code>
                )
              }

              return (
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
