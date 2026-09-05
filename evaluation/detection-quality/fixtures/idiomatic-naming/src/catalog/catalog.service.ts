import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Product } from "./product.entity";

// Fields named after the domain, not after the word "repository" — the naming
// used by most real NestJS codebases.
@Injectable()
export class CatalogService {
  constructor(@InjectRepository(Product) private readonly products: Repository<Product>) {}

  // INSECURE: unbounded read.
  async listAll(): Promise<Product[]> {
    return this.products.find();
  }

  // INSECURE: one query per iteration.
  async bySkus(skus: string[]) {
    const rows = [];
    for (const sku of skus) {
      rows.push(await this.products.findOne({ where: { sku } }));
    }
    return rows;
  }

  // SECURE control: paginated.
  async page(offset: number): Promise<Product[]> {
    return this.products.find({ take: 50, skip: offset });
  }
}
