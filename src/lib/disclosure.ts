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

export function captionHasDisclosure(caption: string | null | undefined): boolean {
  if (!caption) return false
  const lower = caption.toLowerCase()
  return AD_MARKERS.some(marker => lower.includes(marker))
}

export function isDisclosed(m: { caption?: string | null; isAdDisclosed?: boolean | null; isPaidPartnership?: boolean | null }): boolean {
  return !!m.isAdDisclosed || !!m.isPaidPartnership || captionHasDisclosure(m.caption)
}
