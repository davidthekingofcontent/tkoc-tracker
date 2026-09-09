import { prisma } from '@/lib/db'

/**
 * Guarantees that a Contact row exists for (influencerId, userId).
 *
 * Every influencer whose data enters the platform must show up in the
 * Contacts page of the user who brought it in, so this is called after
 * every Influencer upsert (analyze, discovery, lists, campaign members).
 *
 * - Creates the Contact with status 'new' when it is missing.
 * - Leaves an existing Contact untouched (status, notes, tags preserved).
 * - Never throws: failures are logged and swallowed so the calling flow
 *   (scrape, list add, campaign add) is never broken by a contact hiccup.
 */
export async function ensureContact(influencerId: string, userId: string): Promise<void> {
  if (!influencerId || !userId) return
  try {
    await prisma.contact.upsert({
      where: { influencerId_userId: { influencerId, userId } },
      create: { influencerId, userId, status: 'new' },
      update: {},
    })
  } catch (error) {
    console.error(
      `[contacts] ensureContact failed for influencer=${influencerId} user=${userId}:`,
      error instanceof Error ? error.message : error
    )
  }
}

// ============ POSTAL ADDRESS (David 2026-09-08) ============
// "If we have entered the address at some point we should save it in Contacts
// automatically." The shipping modal of a campaign writes the address on the
// campaign member; this module copies it to the Contact so the next campaign
// can prefill it.

export type ContactAddressSource = 'shipping' | 'manual'

export interface ContactAddressInput {
  name?: string | null
  address1: string
  address2?: string | null
  city?: string | null
  postCode?: string | null
  country?: string | null
  phone?: string | null
  email?: string | null
}

export interface ContactAddress {
  name: string | null
  address1: string
  address2: string | null
  city: string | null
  postCode: string | null
  country: string | null
  phone: string | null
  email: string | null
}

export interface LatestContactAddress {
  address: ContactAddress
  updatedAt: Date
  source: ContactAddressSource | null
}

/** Trims a value; returns undefined for empty/non-string so the field is left untouched. */
function clean(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

/** Field names of the address block on the Contact model. */
export const CONTACT_ADDRESS_SELECT = {
  addressName: true,
  address1: true,
  address2: true,
  city: true,
  postCode: true,
  country: true,
  phone: true,
  email: true,
  addressUpdatedAt: true,
  addressSource: true,
} as const

type ContactAddressRow = {
  addressName: string | null
  address1: string | null
  address2: string | null
  city: string | null
  postCode: string | null
  country: string | null
  phone: string | null
  email: string | null
  addressUpdatedAt: Date | null
  addressSource: string | null
}

/** Maps a Contact row to the public address shape, or null when it holds no address. */
export function contactAddressFromRow(row: ContactAddressRow): LatestContactAddress | null {
  if (!row.address1 || !row.address1.trim()) return null
  const source = row.addressSource === 'shipping' || row.addressSource === 'manual' ? row.addressSource : null
  return {
    address: {
      name: row.addressName,
      address1: row.address1,
      address2: row.address2,
      city: row.city,
      postCode: row.postCode,
      country: row.country,
      phone: row.phone,
      email: row.email,
    },
    updatedAt: row.addressUpdatedAt ?? new Date(0),
    source,
  }
}

/**
 * Saves a postal address on the Contact (influencerId, userId), creating the
 * Contact when it is missing (same semantics as ensureContact).
 *
 * mode 'merge' (default) writes only non-empty fields, so a partial address
 * never blanks a field that was already known. mode 'replace' is for callers
 * that hold the COMPLETE address (the shipping modal): every optional field is
 * written, empty ones as null, so a floor or phone emptied on purpose does not
 * survive from the previous address. address1 is required in both modes:
 * without it nothing is saved. Never throws — the shipping save must not fail
 * because of this.
 *
 * Returns true when something was written.
 */
export async function saveContactAddress(
  influencerId: string,
  userId: string,
  address: ContactAddressInput,
  source: ContactAddressSource,
  mode: 'merge' | 'replace' = 'merge'
): Promise<boolean> {
  if (!influencerId || !userId) return false
  const address1 = clean(address.address1)
  if (!address1) return false

  const fields: Record<string, string | null> = { address1 }
  const put = (key: string, value: string | undefined) => {
    if (value) fields[key] = value
    else if (mode === 'replace') fields[key] = null
  }
  put('addressName', clean(address.name))
  put('address2', clean(address.address2))
  put('city', clean(address.city))
  put('postCode', clean(address.postCode))
  put('country', clean(address.country))
  put('phone', clean(address.phone))
  put('email', clean(address.email))

  const stamp = { addressUpdatedAt: new Date(), addressSource: source }

  try {
    await prisma.contact.upsert({
      where: { influencerId_userId: { influencerId, userId } },
      create: { influencerId, userId, status: 'new', ...fields, ...stamp },
      update: { ...fields, ...stamp },
    })
    return true
  } catch (error) {
    console.error(
      `[contacts] saveContactAddress failed for influencer=${influencerId} user=${userId}:`,
      error instanceof Error ? error.message : error
    )
    return false
  }
}

/**
 * Most recently updated postal address for an influencer across ALL users'
 * Contacts — the agency shares creators, so an address typed by one PM is
 * useful to every PM. Returns null when nobody has an address for them.
 * Never throws.
 */
export async function latestContactAddress(influencerId: string): Promise<LatestContactAddress | null> {
  if (!influencerId) return null
  try {
    const row = await prisma.contact.findFirst({
      where: { influencerId, address1: { not: null } },
      orderBy: [{ addressUpdatedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
      select: CONTACT_ADDRESS_SELECT,
    })
    if (!row) return null
    return contactAddressFromRow(row)
  } catch (error) {
    console.error(
      `[contacts] latestContactAddress failed for influencer=${influencerId}:`,
      error instanceof Error ? error.message : error
    )
    return null
  }
}
