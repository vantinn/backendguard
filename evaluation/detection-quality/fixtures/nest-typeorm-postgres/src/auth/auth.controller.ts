import { Body, Controller, Post } from "@nestjs/common";
import { LoginDto } from "./dto/login.dto";

@Controller("auth")
export class AuthController {
  // AMBIGUOUS: login is legitimately public, but it accepts credentials and has
  // no rate limiting.
  @Post("login")
  async login(@Body() dto: LoginDto) {
    return { accessToken: "..." , dto };
  }
}
