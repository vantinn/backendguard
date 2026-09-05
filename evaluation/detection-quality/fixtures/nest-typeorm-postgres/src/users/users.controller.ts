import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { UsersService } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // INSECURE: returns the raw User entity, which carries passwordHash/refreshToken.
  @Get(":id")
  async findOne(@Param("id") id: string) {
    const user = await this.usersService.findById(id);
    return user;
  }

  // INSECURE: unauthenticated state-changing route with an untyped body.
  @Post()
  async create(@Body() body: any) {
    return body;
  }
}
