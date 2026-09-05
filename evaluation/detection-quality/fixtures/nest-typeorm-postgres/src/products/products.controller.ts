import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { ProductsService } from "./products.service";
import { ProductResponseDto } from "./dto/product-response.dto";

// SECURE control: guarded controller, paginated reads, DTO-mapped responses.
@Controller("products")
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  async list(@Query("page") page = 0): Promise<ProductResponseDto[]> {
    return this.productsService.list(Number(page));
  }
}
