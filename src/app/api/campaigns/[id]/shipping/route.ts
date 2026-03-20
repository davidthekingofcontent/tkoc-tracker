import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'

// GET /api/campaigns/[id]/shipping — Export shipping CSV in fulfillment format
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const { id } = await params

    const campaign = await prisma.campaign.findUnique({
      where: { id },
      include: {
        influencers: {
          where: { status: 'SHIPPING' },
          include: {
            influencer: {
              select: { username: true, displayName: true, email: true, phone: true },
            },
          },
        },
      },
    })

    if (!campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
    }

    // CSV headers matching the fulfillment format
    const headers = [
      'OrderNumber',
      'CompanyName',
      'Customer',
      'Address1',
      'Address2',
      'Town',
      'PostCode',
      'Country',
      'Telephone',
      'Email',
      'Product',
      'Quantity',
      'Comments',
      'ShippingMethod',
      'VATNumber',
      'EORINumber',
      'PIDNumber',
      'IOSSNumber',
      'RecipientType',
    ]

    const rows = campaign.influencers.map((ci, index) => {
      const orderNum = `${campaign.name.replace(/[^a-zA-Z0-9]/g, '').substring(0, 8).toUpperCase()}${String(index + 1).padStart(3, '0')}`
      const customerName = ci.shippingName || ci.influencer.displayName || ci.influencer.username
      return [
        orderNum,
        '', // CompanyName
        customerName,
        ci.shippingAddress1 || '',
        ci.shippingAddress2 || '',
        ci.shippingCity || '',
        ci.shippingPostCode || '',
        ci.shippingCountry || '',
        ci.shippingPhone || ci.influencer.phone || '',
        ci.shippingEmail || ci.influencer.email || '',
        ci.shippingProduct || '',
        ci.shippingQty?.toString() || '1',
        ci.shippingComments || '',
        '', // ShippingMethod — to be filled by fulfillment
        '', // VATNumber
        '', // EORINumber
        '', // PIDNumber
        '', // IOSSNumber
        '', // RecipientType
      ]
    })

    // Build CSV
    const escapeCsv = (val: string) => {
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return `"${val.replace(/"/g, '""')}"`
      }
      return val
    }

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(escapeCsv).join(',')),
    ].join('\n')

    const filename = `shipping_${campaign.name.replace(/[^a-zA-Z0-9]/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`

    return new NextResponse(csvContent, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (error) {
    console.error('Shipping export error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
