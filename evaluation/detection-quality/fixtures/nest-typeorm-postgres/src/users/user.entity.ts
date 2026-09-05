import { Column, Entity, Index, OneToMany, PrimaryGeneratedColumn } from "typeorm";
import { Order } from "../orders/order.entity";

@Entity()
export class User {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  // INSECURE: a login lookup column with no unique constraint and no index.
  @Column()
  email: string;

  @Column()
  passwordHash: string;

  @Column({ nullable: true })
  refreshToken: string;

  @Column({ default: "user" })
  role: string;

  @OneToMany(() => Order, (order) => order.user)
  orders: Order[];
}
