---
name: Redis
description: Add and debug Redis caching, TTLs, sessions, queues, rate limits, and cache invalidation.
---

# Redis

Use this skill when the repo has Redis evidence such as `redis`, `ioredis`, BullMQ, session stores, or cache modules.

## Workflow

1. Inspect Redis client setup, cache keys, TTL policy, and invalidation paths.
2. Confirm whether Redis is used for cache, queue, session, rate limit, or pub/sub behavior.
3. Patch the smallest client/service boundary and preserve existing key conventions.
4. Verify with focused tests or a local command that exercises the Redis path.
