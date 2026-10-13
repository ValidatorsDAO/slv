const embeddedNoticeUrl = new URL(
  '../../../dist/release-inputs/THIRD_PARTY_NOTICES',
  import.meta.url,
)

/** Return the exact notice bytes embedded in the compiled SLV executable. */
export async function embeddedLicenses(
  source: URL = embeddedNoticeUrl,
): Promise<Uint8Array> {
  return await Deno.readFile(source)
}

export type ByteWriter = {
  write(chunk: Uint8Array): Promise<number>
}

export async function writeAll(
  writer: ByteWriter,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const written = await writer.write(bytes.subarray(offset))
    if (
      !Number.isSafeInteger(written) || written <= 0 ||
      written > bytes.length - offset
    ) {
      throw new Error('license output writer made no valid progress')
    }
    offset += written
  }
}

/** `slv licenses` intentionally emits no banner so its output is byte-stable. */
export async function printEmbeddedLicenses(
  writer: ByteWriter = Deno.stdout,
  source: URL = embeddedNoticeUrl,
): Promise<void> {
  await writeAll(writer, await embeddedLicenses(source))
}
