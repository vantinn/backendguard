// INSECURE: used as a @Body() DTO but carries no class-validator decorators.
export class CapturePaymentDto {
  userId: string;
  orderId: string;
  amount: number;
}
