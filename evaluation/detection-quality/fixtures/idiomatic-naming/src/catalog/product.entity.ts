import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity({ name: "products" })
export class Product {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ unique: true })
  sku!: string;

  @Column({ type: "int" })
  priceCents!: number;
}
