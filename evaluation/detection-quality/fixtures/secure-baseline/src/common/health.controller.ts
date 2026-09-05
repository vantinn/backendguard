import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get()
  liveness() {
    return { status: "ok" };
  }

  @Get("readiness")
  readiness() {
    return { status: "ready" };
  }
}
