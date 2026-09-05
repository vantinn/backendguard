import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class Product {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ unique: true })
  sku: string;

  @Column()
  name: string;

  @Column("numeric")
  price: string;
}
