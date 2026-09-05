---
name: Prisma
description: Debug Prisma schemas, migrations, generated client issues, relations, transactions, and slow ORM queries.
---

# Prisma

Use this skill when the repo contains Prisma evidence such as `prisma/schema.prisma`, `@prisma/client`, or `prisma`.

## Workflow

1. Inspect `prisma/schema.prisma`, generated client usage, migrations, and package scripts.
2. Determine whether the issue is schema shape, migration state, generated types, query logic, or transaction behavior.
3. Patch the schema or service layer in the smallest compatible step.
4. Verify with Prisma generate/migrate checks and the relevant test or typecheck.
