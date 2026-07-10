/**
 * Brand Connect invite token helpers.
 * The invite is a JWT signed with JWT_SECRET (30d) carrying
 * { ownerUserId, brandId, brandName, brandLogo?, purpose: 'brand_connect' }.
 */

import jwt from 'jsonwebtoken'

export interface BrandConnectInvitePayload {
  ownerUserId: string
  brandId: string
  brandName: string
  brandLogo?: string
  purpose: string
}

/**
 * Verify signature + expiry + purpose claim. Returns null on any failure.
 */
export function verifyBrandConnectToken(token: string): BrandConnectInvitePayload | null {
  const secret = process.env.JWT_SECRET
  if (!secret) return null
  try {
    const decoded = jwt.verify(token, secret) as BrandConnectInvitePayload
    if (decoded.purpose !== 'brand_connect') return null
    if (!decoded.ownerUserId || !decoded.brandId) return null
    return decoded
  } catch {
    return null
  }
}
