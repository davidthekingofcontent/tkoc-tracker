import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { getSession } from '@/lib/auth'
import { matchClientToCreators, type ClientContactData, type CreatorProfileData } from '@/lib/matching-engine'
import { randomUUID } from 'crypto'
import { RelationshipType } from '@/generated/prisma/client'

const VALID_RELATIONSHIP_TYPES = new Set(Object.values(RelationshipType))

export async function POST(request: NextRequest) {
  try {
    const session = await getSession(request)
    if (!session) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const body = await request.json()
    const { contacts } = body

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return NextResponse.json(
        { error: 'contacts array is required and must not be empty' },
        { status: 400 }
      )
    }

    // Validate each contact has at least contactName
    for (let i = 0; i < contacts.length; i++) {
      if (!contacts[i].contactName || typeof contacts[i].contactName !== 'string' || !contacts[i].contactName.trim()) {
        return NextResponse.json(
          { error: `Contact at index ${i} is missing required field: contactName` },
          { status: 400 }
        )
      }
    }

    const importBatchId = randomUUID()

    // 1. Import all contacts
    const createdContacts = await prisma.$transaction(
      contacts.map((c: Record<string, unknown>) =>
        prisma.clientContact.create({
          data: {
            userId: session.id,
            source: 'CSV_IMPORT',
            importBatchId,
            contactName: (c.contactName as string).trim(),
            contactEmail: (c.contactEmail as string) || null,
            companyName: (c.companyName as string) || null,
            companyDomain: (c.companyDomain as string) || null,
            socialHandles: (c.socialHandles as Record<string, string>) || null,
            phone: (c.phone as string) || null,
            tags: Array.isArray(c.tags) ? (c.tags as string[]) : [],
            relationshipType: VALID_RELATIONSHIP_TYPES.has(c.relationshipType as RelationshipType) ? (c.relationshipType as RelationshipType) : 'CUSTOMER',
            relationshipStatus: 'ACTIVE',
          },
        })
      )
    )

    // 2. Fetch all creator profiles with platform profiles for matching
    const creatorProfiles = await prisma.creatorProfile.findMany({
      where: { isSuppressed: false },
      select: {
        id: true,
        displayName: true,
        contactEmail: true,
        websiteUrl: true,
        geoCity: true,
        geoCountry: true,
        platformProfiles: {
          select: {
            platform: true,
            username: true,
            bio: true,
          },
        },
      },
    })

    const creatorsData: CreatorProfileData[] = creatorProfiles.map((cp) => ({
      id: cp.id,
      displayName: cp.displayName,
      contactEmail: cp.contactEmail,
      websiteUrl: cp.websiteUrl,
      geoCity: cp.geoCity,
      geoCountry: cp.geoCountry,
      platformProfiles: cp.platformProfiles.map((pp) => ({
        platform: pp.platform,
        username: pp.username,
        bio: pp.bio,
      })),
    }))

    // 3. Run matching for each imported contact
    let matchesFound = 0

    for (const contact of createdContacts) {
      const contactData: ClientContactData = {
        id: contact.id,
        contactName: contact.contactName,
        contactEmail: contact.contactEmail,
        companyName: contact.companyName,
        companyDomain: contact.companyDomain,
        socialHandles: contact.socialHandles as Record<string, string> | null,
        phone: contact.phone,
      }

      const matchResults = matchClientToCreators(contactData, creatorsData)

      // 4. Create ClientCreatorMatch records for any matches
      if (matchResults.length > 0) {
        await prisma.$transaction(
          matchResults.map((match) =>
            prisma.clientCreatorMatch.create({
              data: {
                userId: session.id,
                clientContactId: match.clientContactId,
                creatorProfileId: match.creatorProfileId,
                confidenceScore: match.confidenceScore,
                confidenceLevel: match.confidenceLevel,
                matchSignals: JSON.parse(JSON.stringify(match.signals)),
                matchStatus: 'AUTO_DETECTED',
              },
            })
          )
        )
        matchesFound += matchResults.length
      }
    }

    // 5. Return summary
    return NextResponse.json(
      {
        imported: createdContacts.length,
        matchesFound,
        batchId: importBatchId,
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Import client contacts error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
