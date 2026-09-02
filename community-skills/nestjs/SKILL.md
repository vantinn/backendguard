---
name: NestJS Architecture
description: Structure NestJS modules, controllers, providers, guards, interceptors, pipes, and exception filters correctly.
---

# NestJS Architecture

Use this skill when the repo contains NestJS evidence such as `@nestjs/core`, `*.module.ts`, or `nest-cli.json`.

## Workflow

1. Identify which module owns the change. A new feature usually gets its own module (`feature.module.ts`) with a controller, service, and DTOs — avoid dumping unrelated logic into `AppModule`.
2. Use constructor-based dependency injection for every provider. Don't `new` a service manually or import across module boundaries without exporting it.
3. Keep controllers thin: validate input via DTOs, delegate business logic to a service, and return a response DTO — never the raw ORM entity.
4. Apply guards/interceptors/pipes at the right scope: a route-level `@UseGuards()` for endpoint-specific checks, a module-level provider for cross-cutting concerns.
5. Use `HttpException` subclasses (or a global exception filter) for error responses instead of throwing plain errors from a controller.
6. Verify with the project's test command for the affected module (unit test for the service, e2e test for the controller when one exists).
