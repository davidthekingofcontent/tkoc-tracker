# prisma/additive: schema changes applied by hand

Every file here is SQL that changes the production schema. Nothing runs it
automatically: no build, deploy or start script mentions this folder
(`tests/unit/additive-sql.test.ts` fails if one does).

| File | What it is |
| --- | --- |
| `2026-11-12-person-profiles.sql` | Delivery 1 (a creator is a person with several profiles): 2 new tables, 6 nullable columns, 4 indexes, 2 foreign keys. Additive only. |
| `2026-11-12-person-profiles.down.sql` | Its inverse. Destructive. Never run automatically; read its header before thinking about it. |

## DEPLOY

### Why the build no longer touches the database (12 Nov 2026)

Until 12 Nov 2026 `npm run build` was
`prisma generate && prisma db push --accept-data-loss || echo 'db push skipped (no DATABASE_URL)' && … next build`.
`db push --accept-data-loss` makes the database EQUAL to the schema of the
commit being built, dropping whatever that schema lacks, with its data and
without asking. A build of an older commit, of a branch cut before a schema
change, or a local build with `DATABASE_URL` pointing at production would have
dropped `persons`, `person_logs` and the new columns.

The build is now `prisma generate && NODE_OPTIONS='--max-old-space-size=4096' next build`.
In production nothing changes: the Railway build (Dockerfile) never had a
`DATABASE_URL` (no build `ARG`, `.env` is in `.dockerignore`), so its push was
always skipped. The consequence to remember: **a schema change reaches
production only when someone applies its SQL by hand, as below.** The headers
of the `2026-11-12` scripts quote the old build command as history; this file
is the current procedure.

Never run `prisma db push` (and never `--accept-data-loss`) against production.

### Order: SQL first, code second

The old code ignores the new nullable columns, so the SQL can go in at any time
before the deploy. The new code selects the new columns in every Media and
Influencer query and fails without them. So:

1. apply and verify the SQL in production (steps below);
2. only then deploy the code.

### 1. Rehearse on the local copy

The local copy is `postgresql://tkoc:local-only@localhost:54329/tkoc_copy`.

```sh
export LOCAL_URL='postgresql://tkoc:local-only@localhost:54329/tkoc_copy'

# Preview (read-only): what the database lacks compared with the schema.
# It must print exactly the statements of the file, nothing else.
DATABASE_URL="$LOCAL_URL" npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script

# Apply, all or nothing
psql "$LOCAL_URL" -v ON_ERROR_STOP=1 --single-transaction -f prisma/additive/2026-11-12-person-profiles.sql

# Verify: the same preview now prints no statement (-- This is an empty migration.)
DATABASE_URL="$LOCAL_URL" npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script
```

Then run the tests and the rehearsal (`tests/`, see `tests/package.json`).

### 2. Apply in production

Take the production URL from Railway into a shell variable for this session
only. Never write it into `.env`.

1. **Backup.** A Railway backup of the database, or
   `pg_dump "$PROD_URL" -Fc -f tkoc-before-person-profiles.dump`.
2. **Preview (read-only).**
   `DATABASE_URL="$PROD_URL" npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
   It must print exactly the statements of the file. If it prints anything
   else (a `DROP`, an `ALTER COLUMN`, another table), production has drifted
   from the schema: stop and find out why before applying anything.
3. **Apply.**
   `psql "$PROD_URL" -v ON_ERROR_STOP=1 --single-transaction -f prisma/additive/2026-11-12-person-profiles.sql`
   One transaction: an error leaves the database as it was.
4. **Verify.** The preview of step 2 now prints no statement, and:

   ```sql
   SELECT table_name, column_name, is_nullable
   FROM information_schema.columns
   WHERE table_schema = 'public' AND (table_name, column_name) IN (
     ('influencers', 'personId'), ('influencers', 'addedById'), ('influencers', 'addedByName'),
     ('campaign_influencers', 'addedById'), ('campaign_influencers', 'addedByName'),
     ('media', 'publishedByInfluencerId'))
   ORDER BY 1, 2;
   -- 6 rows, every is_nullable = YES

   SELECT to_regclass('public.persons') AS persons, to_regclass('public.person_logs') AS person_logs;
   -- both not null

   SELECT count(*) FROM persons;      -- 0 right after applying
   SELECT count(*) FROM person_logs;  -- 0 right after applying
   ```

   And the row counts of `influencers`, `media` and `campaign_influencers` are
   the same as before step 3.
5. **Deploy the code.**

### Rolling back

1. **First undo every fold in force, with the code that is running now.** An
   ADMIN lists them with `GET /api/admin/fold-twins` (field `folds`, newest
   first) and undoes each one, newest first, with
   `POST /api/admin/fold-twins {"undo": "<logId>"}`. Check that `folds` comes
   back empty and that the twin members are back (`twins`). The previous code
   does not know linked profiles: with a fold in force, its daily TikTok pass
   and its manual route see the creator's Instagram member without a TikTok
   member and create a second member again (`source 'tiktok_link:<id>'`) on
   the next video or pasted link, so the campaign counts her twice again with
   her pieces split across two rows; and its overview estimates the folded
   TikTok pieces with the Instagram followers.
2. Redeploy the previous image in Railway. The new tables and columns stay and
   the old code ignores them. The TikTok pieces stored since the deploy under a
   creator's Instagram row (with a "published by" profile) stay in that row:
   the old code counts them for her, as published from her own profile.

Do not run the `.down.sql` to roll back the application: it deletes every
linked profile, the audit log and every "published by" marker for good. It
exists only for removing the tables themselves, by hand, after a backup (see
its header).

### A new schema change

1. Change `prisma/schema.prisma` additively only: new tables, new NULLABLE
   columns (or with a default), new indexes, new foreign keys. No rename, no
   drop, no type change, no new required column.
2. Generate the SQL offline, with no database connection:
   `npx prisma migrate diff --from-schema <file with the schema of the base commit> --to-schema prisma/schema.prisma --script > prisma/additive/<date>-<name>.sql`
   (`git show <base>:prisma/schema.prisma > /tmp/base-schema.prisma` gives that file).
3. Check that it only contains `CREATE TABLE`, `ALTER TABLE … ADD COLUMN`,
   `CREATE INDEX` and `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY`, and extend
   `tests/unit/additive-sql.test.ts` to read the new file.
4. Follow steps 1 and 2 above with the new file.
