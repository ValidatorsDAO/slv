import { VERSION } from '@cmn/constants/version.ts'
import { SLV_STORAGE_URL } from '@cmn/constants/url.ts'

/**
 * Uploads the executable files to Cloudflare R2 using the Cloudflare API
 * This is more reliable than using the AWS CLI
 */
const uploadExe = async () => {
  const version = VERSION
  const compileTargets = [
    'x86_64-apple-darwin',
    'x86_64-unknown-linux-gnu',
  ]
  console.log(`Uploading slv v${version} to Cloudflare R2`)

  // Get environment variables for authentication
  const accountId = Deno.env.get('CLOUDFLARE_ACCOUNT_ID')
  const apiToken = Deno.env.get('CLOUDFLARE_API_TOKEN')
  const apiKey = Deno.env.get('CLOUDFLARE_API_KEY')
  const email = Deno.env.get('CLOUDFLARE_EMAIL')

  // Check for required authentication credentials
  if (!accountId) {
    throw new Error(
      'Missing required environment variable: CLOUDFLARE_ACCOUNT_ID',
    )
  }

  if (!apiToken && (!apiKey || !email)) {
    throw new Error(
      'Missing required authentication credentials. Either CLOUDFLARE_API_TOKEN or both CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL must be provided.',
    )
  }

  // Prepare authentication headers
  let authHeaders: Record<string, string> = {}

  if (apiToken) {
    console.log('Using API Token authentication')
    authHeaders = {
      'Authorization': `Bearer ${apiToken}`,
    }
  } else if (apiKey && email) {
    console.log('Using API Key authentication')
    authHeaders = {
      'X-Auth-Email': email,
      'X-Auth-Key': apiKey,
    }
  }

  // Process each target sequentially to handle errors better
  for (const target of compileTargets) {
    try {
      // Check if the file exists
      const filePath = `./dist/slv-${target}-exe.tar.gz`

      try {
        // Check if file exists by getting its stats
        await Deno.stat(filePath)
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          console.log(
            `⚠️ File not found: ${filePath} - skipping upload for ${target}`,
          )
          continue // Skip this target and move to the next one
        }
        throw error // Re-throw other errors
      }

      console.log(`Reading file: ${filePath}`)
      const fileContent = await Deno.readFile(filePath)

      // Upload to R2 using Cloudflare API
      const bucketName = 'slv'
      const objectKey = `slv/${version}/${target}-exe.tar.gz`
      const url =
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects/${objectKey}`

      console.log(`Uploading to: ${url}`)
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename=install',
        },
        body: fileContent,
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to upload ${target} executable: ${response.status} ${response.statusText} - ${errorText}`,
        )
      }

      console.log(
        `✅ Successfully uploaded ${target} executable to ${SLV_STORAGE_URL}/slv/${version}/${target}-exe.tar.gz`,
      )
    } catch (error) {
      // Handle the error with proper type checking
      if (error instanceof Error) {
        console.error(`❌ Error processing ${target}: ${error.message}`)
      } else {
        console.error(`❌ Error processing ${target}: ${String(error)}`)
      }
      // Continue with other targets even if one fails
    }
  }

  // Upload SHA256SUMS file after binaries.
  const checksumsPath = './dist/SHA256SUMS'
  try {
    await Deno.stat(checksumsPath)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`SHA256SUMS file not found at ${checksumsPath}. Run 'deno task generate:checksums' first.`)
    }
    throw error
  }

  console.log(`Reading file: ${checksumsPath}`)
  const checksumsContent = await Deno.readFile(checksumsPath)

  const bucketName = 'slv'
  const objectKey = `slv/${version}/SHA256SUMS`
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects/${objectKey}`

  console.log(`Uploading SHA256SUMS to: ${url}`)
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      ...authHeaders,
      'Content-Type': 'text/plain',
    },
    body: checksumsContent,
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Failed to upload SHA256SUMS: ${response.status} ${response.statusText} - ${errorText}`,
    )
  }

  console.log(
    `✅ Successfully uploaded SHA256SUMS to ${SLV_STORAGE_URL}/slv/${version}/SHA256SUMS`,
  )
}

await uploadExe()
