/**
 * Ad-disclosure detection (Ley 13/2022 + AUTOCONTROL code): a piece is
 * considered correctly identified when the platform flagged it as a paid
 * partnership, a PM marked it, or its caption carries a disclosure marker.
 * Shared by the compliance endpoint and the report checklist.
 */
export const AD_MARKERS = [
  '#ad', '#publi', '#publicidad', '#sponsored', '#colaboración', '#colaboracion', '#collab',
  '#anuncio', '#patrocinado', 'partnership', 'paid partnership', 'colaboración pagada', 'colaboracion pagada',
  'publicidad', 'contenido patrocinado',
]

/**
 * Bare words that count as a disclosure when they stand alone (David 2026-09-14:
 * "Publi." or "Publi //" at the start of a caption is how many creators tag
 * an ad). Word boundaries keep "publicó" / "público" out; "publicidad" is
 * covered by AD_MARKERS.
 */
const AD_WORD_PATTERNS = [/(^|[^\p{L}\p{N}_])publi(?=$|[^\p{L}\p{N}_])/iu, /(^|[^\p{L}\p{N}_])publicidad(?=$|[^\p{L}\p{N}_])/iu]

export function captionHasDisclosure(caption: string | null | undefined): boolean {
  if (!caption) return false
  const lower = caption.toLowerCase()
  if (AD_MARKERS.some(marker => lower.includes(marker))) return true
  return AD_WORD_PATTERNS.some(re => re.test(caption))
}

export function isDisclosed(m: { caption?: string | null; isAdDisclosed?: boolean | null; isPaidPartnership?: boolean | null }): boolean {
  return !!m.isAdDisclosed || !!m.isPaidPartnership || captionHasDisclosure(m.caption)
}
