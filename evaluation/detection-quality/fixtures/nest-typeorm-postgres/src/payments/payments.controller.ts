import { Body, Controller, Post } from "@nestjs/common";
import { PaymentsService } from "./payments.service";
import { CapturePaymentDto } from "./dto/capture-payment.dto";

@Controller("payments")
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // INSECURE: no guard on a money-moving endpoint, and the raw error is returned.
  @Post("capture")
  async capture(@Body() dto: CapturePaymentDto) {
    try {
      return await this.paymentsService.capture(dto.userId, dto.orderId, dto.amount);
    } catch (error) {
      return { ok: false, message: error.message };
    }
  }
}
