import { Body, Controller, Post } from "@nestjs/common";

// SECURE control: public by necessity, route declared on the controller.
// Authenticated by signature, not by a guard.
@Controller("webhooks/stripe")
export class StripeWebhookController {
  @Post()
  async receive(@Body() body: unknown) {
    return { received: true, body };
  }
}
