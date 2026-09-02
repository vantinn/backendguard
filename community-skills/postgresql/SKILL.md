---
name: PostgreSQL Engineering
description: Design indexes, constraints, transactions, and migration-safe schema changes; diagnose slow queries and N+1 patterns on PostgreSQL.
---

# PostgreSQL Engineering

Use this skill when the repo shows PostgreSQL evidence: a `pg` dependency, a Prisma schema with `provider = "postgresql"`, or a TypeORM `ormconfig`/migrations directory.

## Workflow

1. Classify the change: schema (indexes, constraints, foreign keys), query (filtering, joins, aggregation, pagination), transaction boundary, or migration.
2. Indexing: check that columns used in `WHERE`, `JOIN`, and `ORDER BY` clauses are indexed, and prefer a composite index over multiple single-column indexes when queries filter on more than one column together.
3. N+1 queries: look for relations loaded inside a loop (one query per row) instead of a single query with a join or `IN (...)` batch.
4. Transactions: wrap multi-step writes that must succeed or fail together in a transaction, and be explicit about isolation level when concurrent writers can race on the same rows.
5. Migrations: verify a new migration is additive and safe to run against a live database — avoid dropping/renaming a column the currently deployed application still reads, and prefer expand-and-contract for breaking schema changes.
6. Verify with `EXPLAIN ANALYZE` on the changed query, or the project's query/integration test suite when one exists.

## Non-negotiables

- Never run `SELECT *` in a code path serving production traffic — select only the columns actually used.
- Never build a query by string-concatenating user input — use parameterized queries or the ORM's query builder.
- Never assume a migration is safe on a live database without checking table size and lock behavior.
