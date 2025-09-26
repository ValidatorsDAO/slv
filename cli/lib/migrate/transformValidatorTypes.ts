// transformValidatorType.ts
import { parse, stringify } from '@std/yaml'
import { getInventoryPath } from '@cmn/constants/path.ts'

function transformValidatorTypes(obj: any): any {
  if (typeof obj !== 'object' || obj === null) return obj

  for (const key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      transformValidatorTypes(obj[key])
    }

    if (key === 'validator_type') {
      if (obj[key] === 'firedancer') {
        obj[key] = 'firedancer-agave'
      } else if (obj[key] === 'agave') {
        obj[key] = 'agave'
      }
    }
    if (key === 'solana_cli') {
      // Remove solana_cli field
      delete obj[key]
    }
  }
  return obj
}

/**
 * Transforms the validator_type fields in a YAML file.
 */
export async function transformValidatorTypeFile(): Promise<void> {
  const filePath = getInventoryPath('testnet_validators')
  const inputText = await Deno.readTextFile(filePath)
  const data = parse(inputText)
  const transformed = transformValidatorTypes(data)
  const outputText = stringify(transformed)
  await Deno.writeTextFile(filePath, outputText)
}
