import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Order } from "../orders/order.entity";
import { User } from "../users/user.entity";

@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(User) private readonly usersRepo: Repository<User>,
    @InjectRepository(Order) private readonly ordersRepo: Repository<Order>
  ) {}

  // INSECURE: two writes with no transaction boundary.
  async capture(userId: string, orderId: string, amount: number) {
    const user = await this.usersRepo.findOne({ where: { id: userId } });
    await this.usersRepo.save(user);
    const order = await this.ordersRepo.findOne({ where: { id: orderId } });
    order.status = "paid";
    await this.ordersRepo.save(order);
    return { amount };
  }
}
