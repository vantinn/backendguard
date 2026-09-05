import { Product } from "../product.entity";

export class ProductResponseDto {
  id: string;
  name: string;
  price: string;

  static from(product: Product): ProductResponseDto {
    const dto = new ProductResponseDto();
    dto.id = product.id;
    dto.name = product.name;
    dto.price = product.price;
    return dto;
  }
}
