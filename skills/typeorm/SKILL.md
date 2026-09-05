---
name: TypeORM
description: Debug TypeORM entities, relations, repositories, QueryBuilder, transactions, and migrations.
---

# TypeORM

Use this skill when the repo contains TypeORM evidence such as `typeorm`/`@nestjs/typeorm`, `*.entity.ts` files, or a `src/migrations/` directory.

## Workflow

1. Inspect the entity definitions and relation decorators (`@OneToMany`, `@ManyToOne`, `@ManyToMany`) involved, noting whether relations are `eager` or lazily loaded.
2. Classify the issue: entity shape, relation loading, query performance, transaction boundary, or migration.
3. Prefer `QueryBuilder` or explicit `relations`/`select` options over loading a full entity graph when only a few fields are needed — avoid `eager: true` unless the relation is needed on every load.
4. Wrap multi-step writes in a transaction (`dataSource.transaction(...)` or a query runner) when partial failure would leave data inconsistent.
5. For migrations, verify the generated SQL is additive/backward-compatible and test it with a dry run against a disposable database before it ships.
6. Verify with the relevant test, typecheck, or a migration dry run.
