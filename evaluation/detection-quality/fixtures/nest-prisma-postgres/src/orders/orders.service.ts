import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  // INSECURE: unbounded read.
  async listAll() {
    return this.prisma.order.findMany({ where: { status: "open" } });
  }

  // SECURE control: paginated read.
  async listPage(cursor?: string) {
    return this.prisma.order.findMany({ take: 50, cursor: cursor ? { id: cursor } : undefined });
  }

  // INSECURE: one query per order — N+1.
  async enrich(orderIds: string[]) {
    const results = [];
    for (const orderId of orderIds) {
      results.push(await this.prisma.order.findUnique({ where: { id: orderId } }));
    }
    return results;
  }

  // INSECURE: two writes with no $transaction.
  async cancel(orderId: string, userId: string) {
    await this.prisma.order.update({ where: { id: orderId }, data: { status: "cancelled" } });
    await this.prisma.user.update({ where: { id: userId }, data: { name: "cancelled-by" } });
  }

  // SECURE control: writes grouped into one transaction.
  async checkout(orderId: string, userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { status: "paid" } });
      await tx.user.update({ where: { id: userId }, data: { name: "paid-by" } });
    });
  }
}
