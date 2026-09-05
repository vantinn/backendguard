import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Order } from "./order.entity";

@Injectable()
export class OrdersService {
  constructor(@InjectRepository(Order) private readonly ordersRepo: Repository<Order>) {}

  // INSECURE: one query per item — a textbook N+1.
  async summarize(items: Array<{ orderId: string }>) {
    const rows = [];
    for (const item of items) {
      const order = await this.ordersRepo.findOne({ where: { id: item.orderId } });
      rows.push(order);
    }
    return rows;
  }
}
