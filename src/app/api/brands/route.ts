import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { sendBrandAssignmentEmail } from '@/lib/email'

function generateId(): string {
  return `brand_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

// ============ DUPLICATE BRAND DETECTION ============
// Exact-match checks let "VILEDA" and "Vileda España" coexist — the same brand
// twice, which splits campaigns and Meta connections. Compare normalized names
// (lowercase, accent-stripped, whitespace-collapsed) and also treat containment
// as a duplicate: "vileda" ⊂ "vileda españa" → same brand.

function normalizeBrandName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isSameBrandName(a: string, b: string): boolean {
  const na = normalizeBrandName(a)
  const nb = normalizeBrandName(b)
  if (!na || !nb) return false
  if (na === nb) return true
  // Containment needs a minimum length so short generic words don't collide
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na]
  return shorter.length >= 4 && longer.includes(shorter)
}

interface BrandData {
  id: string
  name: string
  website?: string
  logo?: string
  assignedEmployees: string[]
  brandUserId?: string
  createdBy: string
  createdAt: string
}

// ============ WHICH SETTING IS A BRAND ============
// The settings table also holds stored keys, report configurations and cron
// stamps. PATCH and DELETE used to rewrite or delete ANY row whose key they
// were given as brandId (12 Nov 2026). A brand is a `brand_` key outside the
// other `brand_` families whose JSON document carries that same id and a name.

const NOT_A_BRAND_PREFIXES = ['brand_assignment_', 'brand_user_', 'brand_ig_', 'brand_connect']

async function findBrandSetting(brandId: unknown): Promise<BrandData | null> {
  if (typeof brandId !== 'string' || !brandId.startsWith('brand_') || NOT_A_BRAND_PREFIXES.some((p) => brandId.startsWith(p))) {
    return null
  }
  const row = await prisma.setting.findUnique({ where: { key: brandId } })
  if (!row) return null
  try {
    const data = JSON.parse(row.value) as BrandData | null
    return data && typeof data === 'object' && data.id === brandId && typeof data.name === 'string' ? data : null
  } catch {
    return null
  }
}

// GET: Returns all brands with their campaign count and assigned employees
export async function GET(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    // Fetch all brand settings
    const brandSettings = await prisma.setting.findMany({
      where: { key: { startsWith: 'brand_' } },
    })

    // Filter out non-brand entries (like brand_assignment_, brand_user_ or brand_ig_)
    const brandEntries = brandSettings.filter(
      (s) =>
        !s.key.startsWith('brand_assignment_') &&
        !s.key.startsWith('brand_user_') &&
        !s.key.startsWith('brand_ig_')
    )

    const brands: Array<{
      id: string
      name: string
      logo?: string
      website?: string
      assignedEmployees: Array<{ id: string; name: string }>
      campaignCount: number
      brandUserId?: string
      createdBy: string
      createdAt: string
    }> = []

    // Fetch campaign-brand mappings
    const campaignBrandSettings = await prisma.setting.findMany({
      where: { key: { startsWith: 'campaign_brand_' } },
    })
    const campaignBrandMap = new Map<string, string>()
    for (const s of campaignBrandSettings) {
      // key = campaign_brand_{campaignId}, value = brandId
      campaignBrandMap.set(s.value, (campaignBrandMap.get(s.value) || '') + ',1')
    }

    // Count campaigns per brand
    const brandCampaignCounts = new Map<string, number>()
    for (const s of campaignBrandSettings) {
      const brandId = s.value
      brandCampaignCounts.set(brandId, (brandCampaignCounts.get(brandId) || 0) + 1)
    }

    // Collect all employee IDs we need to resolve
    const allEmployeeIds = new Set<string>()

    for (const setting of brandEntries) {
      try {
        const data: BrandData = JSON.parse(setting.value)
        if (data.assignedEmployees) {
          data.assignedEmployees.forEach((id) => allEmployeeIds.add(id))
        }
        if (data.createdBy) allEmployeeIds.add(data.createdBy)
      } catch {
        /* skip malformed */
      }
    }

    // Fetch employee names in bulk
    const employees = allEmployeeIds.size > 0
      ? await prisma.user.findMany({
          where: { id: { in: Array.from(allEmployeeIds) } },
          select: { id: true, name: true },
        })
      : []
    const employeeMap = new Map(employees.map((e) => [e.id, e.name || 'Unknown']))

    for (const setting of brandEntries) {
      try {
        const data: BrandData = JSON.parse(setting.value)
        // A document without a name is not a brand: listing it made the sort
        // below throw, and every brand list answered 500 to everybody
        if (!data || typeof data !== 'object' || typeof data.name !== 'string') continue

        // ADMIN sees all brands
        // EMPLOYEE sees only brands they're assigned to or created
        // BRAND sees only brands linked to them
        if (session.role === 'EMPLOYEE') {
          const isAssigned = data.assignedEmployees?.includes(session.id)
          const isCreator = data.createdBy === session.id
          if (!isAssigned && !isCreator) continue
        } else if (session.role === 'BRAND') {
          if (data.brandUserId !== session.id) continue
        }

        brands.push({
          id: data.id,
          name: data.name,
          logo: data.logo,
          website: data.website,
          assignedEmployees: (data.assignedEmployees || []).map((id) => ({
            id,
            name: employeeMap.get(id) || 'Unknown',
          })),
          campaignCount: brandCampaignCounts.get(data.id) || 0,
          brandUserId: data.brandUserId,
          createdBy: data.createdBy,
          createdAt: data.createdAt,
        })
      } catch {
        /* skip malformed entries */
      }
    }

    // Sort by name
    brands.sort((a, b) => a.name.localeCompare(b.name))

    return NextResponse.json({ brands })
  } catch (error) {
    console.error('List brands error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST: Create a new brand
export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role !== 'ADMIN' && session.role !== 'EMPLOYEE') {
      return NextResponse.json(
        { error: 'Only admins and employees can create brands' },
        { status: 403 }
      )
    }

    const body = await request.json()
    const { name, website, logo } = body

    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'Brand name is required' }, { status: 400 })
    }

    // Check for duplicate brand name (case-insensitive)
    const existingBrands = await prisma.setting.findMany({
      where: {
        key: { startsWith: 'brand_' },
        NOT: [
          { key: { startsWith: 'brand_assignment_' } },
          { key: { startsWith: 'brand_user_' } },
          { key: { startsWith: 'brand_ig_' } },
        ],
      },
    })

    for (const existing of existingBrands) {
      try {
        const data = JSON.parse(existing.value) as BrandData
        if (isSameBrandName(data.name, name)) {
          return NextResponse.json(
            {
              error: `Ya existe una marca igual o muy similar: "${data.name}". Usa esa marca o renómbrala antes de crear otra — duplicarla dividiría las campañas y la conexión de Instagram.`,
            },
            { status: 409 }
          )
        }
      } catch {
        /* skip malformed */
      }
    }

    const brandId = generateId()
    const brandData: BrandData = {
      id: brandId,
      name: name.trim(),
      website: website?.trim() || undefined,
      logo: logo?.trim() || undefined,
      assignedEmployees: [session.id],
      createdBy: session.id,
      createdAt: new Date().toISOString(),
    }

    await prisma.setting.create({
      data: {
        key: brandId,
        value: JSON.stringify(brandData),
      },
    })

    return NextResponse.json({ brand: brandData }, { status: 201 })
  } catch (error) {
    console.error('Create brand error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// PATCH: Update a brand (ADMIN only)
export async function PATCH(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only admins can update brands' },
        { status: 403 }
      )
    }

    const body = await request.json()
    const { brandId, name, website, assignedEmployees, brandUserId } = body

    if (!brandId) {
      return NextResponse.json({ error: 'brandId is required' }, { status: 400 })
    }

    // Only a brand document (never another settings row)
    const found = await findBrandSetting(brandId)
    if (!found) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404 })
    }
    const brandData: BrandData = found

    // Types first: nothing is saved before every field is valid
    if (name !== undefined && name !== null && typeof name !== 'string') {
      return NextResponse.json({ error: 'El nombre de la marca debe ser texto.' }, { status: 400 })
    }
    if (website !== undefined && website !== null && typeof website !== 'string') {
      return NextResponse.json({ error: 'La web de la marca debe ser texto.' }, { status: 400 })
    }
    if (
      assignedEmployees !== undefined &&
      (!Array.isArray(assignedEmployees) || assignedEmployees.length > 200 || !assignedEmployees.every((id: unknown) => typeof id === 'string' && id.length > 0 && id.length <= 64))
    ) {
      return NextResponse.json({ error: 'assignedEmployees debe ser una lista de ids de usuarios.' }, { status: 400 })
    }
    // Newly assigned people must be real users of the agency or the client (never a creator account)
    if (assignedEmployees !== undefined) {
      const before = new Set(brandData.assignedEmployees || [])
      const added = Array.from(new Set((assignedEmployees as string[]).filter((id) => !before.has(id))))
      if (added.length > 0) {
        const valid = await prisma.user.count({ where: { id: { in: added }, role: { in: ['ADMIN', 'EMPLOYEE', 'BRAND'] } } })
        if (valid !== added.length) {
          return NextResponse.json({ error: 'Alguno de los usuarios asignados no existe o no es del equipo.' }, { status: 400 })
        }
      }
    }
    // The client login linked to the brand must be a BRAND user
    if (brandUserId !== undefined && brandUserId !== null && brandUserId !== '') {
      const brandUser = typeof brandUserId === 'string' && brandUserId.length <= 64
        ? await prisma.user.findUnique({ where: { id: brandUserId }, select: { role: true } })
        : null
      if (!brandUser || brandUser.role !== 'BRAND') {
        return NextResponse.json({ error: 'brandUserId debe ser un usuario cliente (rol BRAND).' }, { status: 400 })
      }
    }

    // If renaming, check uniqueness
    if (name && name.trim().toLowerCase() !== brandData.name.toLowerCase()) {
      const allBrands = await prisma.setting.findMany({
        where: {
          key: { startsWith: 'brand_' },
          NOT: [
            { key: { startsWith: 'brand_assignment_' } },
            { key: { startsWith: 'brand_user_' } },
            { key: { startsWith: 'brand_ig_' } },
            { key: brandId },
          ],
        },
      })

      for (const b of allBrands) {
        try {
          const d = JSON.parse(b.value) as BrandData
          if (isSameBrandName(d.name, name)) {
            return NextResponse.json(
              {
                error: `Ya existe una marca igual o muy similar: "${d.name}". Duplicarla dividiría las campañas y la conexión de Instagram.`,
              },
              { status: 409 }
            )
          }
        } catch {
          /* skip */
        }
      }
      brandData.name = name.trim()
    }

    if (website !== undefined) brandData.website = website?.trim() || undefined

    // Track newly assigned employees for notification
    const previousEmployees = brandData.assignedEmployees || []
    if (assignedEmployees !== undefined) brandData.assignedEmployees = assignedEmployees
    if (brandUserId !== undefined) brandData.brandUserId = brandUserId || undefined

    await prisma.setting.update({
      where: { key: brandId },
      data: { value: JSON.stringify(brandData) },
    })

    // Send email to newly assigned employees
    if (assignedEmployees !== undefined) {
      const newlyAssigned = assignedEmployees.filter((id: string) => !previousEmployees.includes(id))
      if (newlyAssigned.length > 0) {
        const adminUser = await prisma.user.findUnique({ where: { id: session.id }, select: { name: true } })
        const newUsers = await prisma.user.findMany({
          where: { id: { in: newlyAssigned } },
          select: { email: true, name: true },
        })
        for (const user of newUsers) {
          try {
            await sendBrandAssignmentEmail({
              to: user.email,
              employeeName: user.name || 'Equipo',
              brandName: brandData.name,
              assignedBy: adminUser?.name || 'Admin',
            })
          } catch (emailErr) {
            console.error(`[Brands] Failed to send assignment email to ${user.email}:`, emailErr)
          }
        }
      }
    }

    return NextResponse.json({ brand: brandData })
  } catch (error) {
    console.error('Update brand error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE: Delete a brand (ADMIN only)
export async function DELETE(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    if (session.role !== 'ADMIN') {
      return NextResponse.json(
        { error: 'Only admins can delete brands' },
        { status: 403 }
      )
    }

    const { searchParams } = new URL(request.url)
    const brandId = searchParams.get('brandId')

    if (!brandId) {
      return NextResponse.json({ error: 'brandId is required' }, { status: 400 })
    }

    // Only a brand document (never another settings row)
    if (!(await findBrandSetting(brandId))) {
      return NextResponse.json({ error: 'Brand not found' }, { status: 404 })
    }

    // Delete the brand
    await prisma.setting.delete({ where: { key: brandId } })

    // Also clean up campaign-brand associations pointing to this brand
    const campaignBrandSettings = await prisma.setting.findMany({
      where: { key: { startsWith: 'campaign_brand_' } },
    })
    for (const s of campaignBrandSettings) {
      if (s.value === brandId) {
        await prisma.setting.delete({ where: { key: s.key } })
      }
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete brand error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
