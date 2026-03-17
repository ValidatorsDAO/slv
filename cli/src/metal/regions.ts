export const REGIONS = [
  'amsterdam',
  'frankfurt',
  'london',
  'ny',
  'chicago',
  'singapore',
  'tokyo',
  'stockholm',
  'saltlakecity',
  'sydney',
  'losangeles',
  'hongkong',
  'dublin',
] as const

export type Region = typeof REGIONS[number]

export const REGION_LABELS: Record<Region, string> = {
  amsterdam: '🇳🇱 Amsterdam',
  frankfurt: '🇩🇪 Frankfurt',
  london: '🇬🇧 London',
  ny: '🇺🇸 New York',
  chicago: '🇺🇸 Chicago',
  singapore: '🇸🇬 Singapore',
  tokyo: '🇯🇵 Tokyo',
  stockholm: '🇸🇪 Stockholm',
  saltlakecity: '🇺🇸 Salt Lake City',
  sydney: '🇦🇺 Sydney',
  losangeles: '🇺🇸 Los Angeles',
  hongkong: '🇭🇰 Hong Kong',
  dublin: '🇮🇪 Dublin',
}
