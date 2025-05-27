function extractSpecValue(input: string, key: 'CPU' | 'RAM' | 'Disk' | 'NIC' | 'Region'): string | null {
  const pattern = new RegExp(`${key}\\s*-\\s*([^|]+)`);
  const match = input.match(pattern);
  return match ? match[1].trim() : null;
}

export { extractSpecValue }