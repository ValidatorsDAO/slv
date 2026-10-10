import Cloudflare from 'npm:cloudflare'
import '@std/dotenv/load'
import { VERSION } from '@cmn/constants/version.ts'
import { SLV_STORAGE_URL } from '@cmn/constants/url.ts'

const CLOUDFLARE_EMAIL = Deno.env.get('CLOUDFLARE_PURGE_EMAIL')
const CLOUDFLARE_API_TOKEN = Deno.env.get('CLOUDFLARE_PURGE_API_TOKEN')
const CLOUDFLARE_ZONE_ID = Deno.env.get('CLOUDFLARE_ZONE_ID')
const version = VERSION
const templateFilePath =
  `${SLV_STORAGE_URL}/slv/template/${version}/template.tar.gz`
const exeFilePaths = [
  `${SLV_STORAGE_URL}/slv/${version}/x86_64-apple-darwin-exe.tar.gz`,
  `${SLV_STORAGE_URL}/slv/${version}/x86_64-unknown-linux-gnu-exe.tar.gz`,
  `${SLV_STORAGE_URL}/slv/${version}/aarch64-apple-darwin-exe.tar.gz`,
  `${SLV_STORAGE_URL}/slv/${version}/aarch64-unknown-linux-gnu-exe.tar.gz`,
  `${SLV_STORAGE_URL}/slv/${version}/SHA256SUMS`,
]

if (
  !CLOUDFLARE_EMAIL || !CLOUDFLARE_API_TOKEN ||
  !CLOUDFLARE_ZONE_ID
) {
  throw new Error(
    'Missing Cloudflare credentials: CLOUDFLARE_EMAIL, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID',
  )
}

const client = new Cloudflare({
  apiEmail: CLOUDFLARE_EMAIL,
  apiKey: CLOUDFLARE_API_TOKEN,
})

const response = await client.cache.purge({
  zone_id: CLOUDFLARE_ZONE_ID,
  files: [`${SLV_STORAGE_URL}/slv/install`, templateFilePath, ...exeFilePaths],
})

console.log(response)