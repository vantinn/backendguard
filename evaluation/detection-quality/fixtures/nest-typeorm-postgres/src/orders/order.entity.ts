import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from "typeorm";
import { User } from "../users/user.entity";

@Entity()
export class Order {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  // INSECURE: a foreign key relation with no index, and eager loading on top.
  @ManyToOne(() => User, (user) => user.orders, { eager: true })
  user: User;

  @Column()
  status: string;

  @Column("numeric")
  total: string;
}
