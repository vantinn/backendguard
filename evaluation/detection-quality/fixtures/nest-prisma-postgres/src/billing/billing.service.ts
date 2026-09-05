import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  // INSECURE: raw SQL through the explicitly unsafe API.
  async report(status: string) {
    return this.prisma.$queryRawUnsafe(`SELECT * FROM "Order" WHERE status = '${status}'`);
  }

  // INSECURE: three levels of include with no select.
  async invoice(orderId: string) {
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        user: { include: { orders: { include: { items: true } } } },
        items: true
      }
    });
  }
}
