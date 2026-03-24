# Ad Permissions Schema Migration Plan

## Current Implementation (Temporary)

Permissions are stored in the `Setting` table as JSON blobs with key pattern:
```
ad_permissions_{campaignId}_{creatorId}
```

Each value is a JSON array of `AdPermission` objects.

## Target Schema: AdPermission Model

Add the following model to `prisma/schema.prisma` during the next schema migration:

```prisma
enum AdPermissionStatus {
  PENDING
  GRANTED
  REVOKED
}

enum AdPermissionType {
  spark_ads
  partnership_ads
  brandconnect
}

model AdPermission {
  id                String              @id @default(cuid())
  creatorId         String
  campaignId        String
  platform          String              // TIKTOK, INSTAGRAM, YOUTUBE
  permissionType    AdPermissionType
  authorizationCode String?             // TikTok Spark Ads auth code
  status            AdPermissionStatus  @default(PENDING)
  grantedAt         DateTime?
  revokedAt         DateTime?
  expiresAt         DateTime?
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt

  creator           User                @relation("CreatorAdPermissions", fields: [creatorId], references: [id])
  campaign          Campaign            @relation("CampaignAdPermissions", fields: [campaignId], references: [id])

  @@unique([creatorId, campaignId, platform, permissionType])
  @@index([creatorId])
  @@index([campaignId])
  @@index([status])
  @@map("ad_permissions")
}
```

## Required Relation Additions

Add to the `User` model:
```prisma
adPermissions AdPermission[] @relation("CreatorAdPermissions")
```

Add to the `Campaign` model:
```prisma
adPermissions AdPermission[] @relation("CampaignAdPermissions")
```

## Migration Steps

1. Add the model and relations to `schema.prisma`
2. Run `npx prisma migrate dev --name add_ad_permissions`
3. Write a migration script to move data from `Setting` table JSON to the new `AdPermission` table
4. Update `src/app/api/creators/ad-permissions/route.ts` to use `prisma.adPermission` instead of `prisma.setting`
5. Clean up old `ad_permissions_*` keys from the `Setting` table

## Fields Reference

| Field | Type | Description |
|-------|------|-------------|
| id | String (cuid) | Primary key |
| creatorId | String (FK) | References User.id |
| campaignId | String (FK) | References Campaign.id |
| platform | String | TIKTOK, INSTAGRAM, or YOUTUBE |
| permissionType | Enum | spark_ads, partnership_ads, or brandconnect |
| authorizationCode | String? | TikTok Spark Ads authorization code (32-char alphanumeric) |
| status | Enum | PENDING, GRANTED, or REVOKED |
| grantedAt | DateTime? | When the creator granted permission |
| revokedAt | DateTime? | When the permission was revoked |
| expiresAt | DateTime? | When the permission expires (30 days for Spark Ads) |
| createdAt | DateTime | Record creation timestamp |
| updatedAt | DateTime | Last update timestamp |
