// "Seeed Studio", "seeed studio" and "Seeed-Studio" are the same organisation
// when checking what's already been added, suggested or dismissed.
export const orgKey = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
