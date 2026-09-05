import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Product } from "./product.entity";
import { ProductResponseDto } from "./dto/product-response.dto";

@Injectable()
export class ProductsService {
  constructor(@InjectRepository(Product) private readonly productsRepo: Repository<Product>) {}

  // SECURE control: bounded query, mapped to a response DTO.
  async list(page: number): Promise<ProductResponseDto[]> {
    const rows = await this.productsRepo.find({ take: 50, skip: page * 50 });
    return rows.map((row) => ProductResponseDto.from(row));
  }
}
