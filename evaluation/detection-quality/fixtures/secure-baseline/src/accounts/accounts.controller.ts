import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../common/jwt-auth.guard";
import { AccountsService } from "./accounts.service";
import { CreateAccountDto } from "./dto/create-account.dto";
import { AccountResponseDto } from "./dto/account-response.dto";

@Controller("accounts")
@UseGuards(JwtAuthGuard)
export class AccountsController {
  constructor(private readonly accountsService: AccountsService) {}

  @Get()
  async list(@Query("page") page = 0): Promise<AccountResponseDto[]> {
    return this.accountsService.list(Number(page));
  }

  @Post()
  async create(@Body() dto: CreateAccountDto): Promise<AccountResponseDto> {
    return this.accountsService.create(dto);
  }
}
