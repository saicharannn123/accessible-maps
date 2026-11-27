// Links that come from map data (OpenStreetMap "website" tags, Wikidata articles and photos) are
// written by strangers. Anyone can edit OpenStreetMap, so a "website" could be a javascript: or
// data: link that runs code when tapped. Only ordinary web links get through; anything else is
// dropped. Bare domains, which OpenStreetMap often has ("www.example.com"), become https:// links
// instead of being treated as a page on our own site.
export function safeWebUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // Some tags hold several links separated by ";". Use the first.
  let s = raw.split(';')[0].trim()
  if (!s || /\s/.test(s) || s.length > 2000) return undefined
  if (!/^[a-z][a-z\d+.-]*:/i.test(s)) {
    // No scheme: accept only something that looks like a host name.
    if (s.startsWith('//')) s = s.slice(2)
    if (!/^[a-z\d-]+(\.[a-z\d-]+)+(:\d+)?([/?#]|$)/i.test(s)) return undefined
    s = `https://${s}`
  }
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    if (u.username || u.password) return undefined // hides the real host, e.g. https://bank.com@evil.test
    return u.href
  } catch {
    return undefined
  }
}

// Phone links: keep only digits and a leading +.
export function telHref(raw: string): string | undefined {
  const n = raw.split(';')[0].replace(/[^+\d]/g, '').replace(/(?!^)\+/g, '')
  return n.replace('+', '').length >= 3 ? `tel:${n}` : undefined
}
