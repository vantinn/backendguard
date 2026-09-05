import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class Account {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Index()
  @Column({ unique: true })
  email: string;

  @Column()
  passwordHash: string;

  @Index()
  @Column({ nullable: true })
  refreshTokenHash: string;
}
