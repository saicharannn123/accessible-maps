import { describe, expect, it } from 'vitest'
import { safeWebUrl, telHref } from '../safeUrl'

describe('safeWebUrl', () => {
  it('keeps ordinary web links', () => {
    expect(safeWebUrl('https://example.com/menu?x=1')).toBe('https://example.com/menu?x=1')
    expect(safeWebUrl('http://example.com')).toBe('http://example.com/')
  })
  it('turns bare domains into https links', () => {
    expect(safeWebUrl('www.example.com')).toBe('https://www.example.com/')
    expect(safeWebUrl('example.co.uk/shop')).toBe('https://example.co.uk/shop')
    expect(safeWebUrl('//example.com')).toBe('https://example.com/')
  })
  it('uses the first of several links', () => {
    expect(safeWebUrl('https://a.example;https://b.example')).toBe('https://a.example/')
  })
  it('drops links that could run code or hide where they go', () => {
    for (const bad of [
      'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
      'data:text/html,<script>alert(1)</script>', 'vbscript:x', 'file:///etc/passwd',
      'https://bank.example@evil.example/', 'not a link', 'alert(1)', '', undefined, 42,
    ]) expect(safeWebUrl(bad), String(bad)).toBeUndefined()
  })
})

describe('telHref', () => {
  it('keeps digits and a leading plus', () => {
    expect(telHref('+1 (973) 555-0100')).toBe('tel:+19735550100')
    expect(telHref('973-555-0100; 973-555-0101')).toBe('tel:9735550100')
    expect(telHref('javascript:alert(1)')).toBeUndefined()
  })
})
